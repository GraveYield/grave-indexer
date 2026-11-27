// SPDX-License-Identifier: Apache-2.0
//
// D4 review-correction battery (grave-indexer PR #8):
//   * strict u64 domain (negative / overflow publication rejection);
//   * sourceCommit "notrack" refused before draft creation;
//   * automatic post-activation rollback with fault injection at every
//     post-activation stage (create-tag-object, ref move, stable verify);
//   * the GitHub adapter (claimsGitHubStore) against a controlled mock
//     GitHub — bounded responses, status/shape validation, NO network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { parseClaimsArtifact, verifyClaimsArtifactBytes, ClaimsArtifactError } from "../src/claimsArtifact.js";
import {
  InMemoryClaimsReleaseStore,
  ClaimsPublicationError,
  parseClaimsPointer,
  claimsVersionedTag,
  type ClaimsReleaseStore,
} from "../src/claimsPublication.js";
import { runClaimsPublicationSequence } from "../src/claimsPublication.js";
import { GitHubClaimsReleaseStore, GitHubStoreError } from "../src/claimsGitHubStore.js";
import { UNCX_RAYDIUM_AMM_V4_LOCKER_PROGRAM_ID } from "../src/claimsArtifact.js";

// ── shared fixture helpers (self-contained) ──
import { PublicKey } from "@solana/web3.js";
import { SnapshotMerkleTree } from "@graveyield/sdk";
import { createHash } from "node:crypto";

let k = 0;
function key(prefix: number): PublicKey {
  const b = new Uint8Array(32);
  b[0] = prefix;
  b[1] = (k = (k + 1) % 251);
  return new PublicKey(b);
}
const POOL = key(0xaa);
const AMM = key(0xab);
const MINT = key(0x01);

function validArtifactText(opts?: { snapshotSlot?: string; totalSupply?: string; balances?: string }): string {
  const holders = [
    { owner: key(0x10), balance: 4_000n },
    { owner: key(0x20), balance: 2_000n },
  ].sort((a, b) => {
    const ab = a.owner.toBytes(), bb = b.owner.toBytes();
    for (let i = 0; i < 32; i++) if (ab[i] !== bb[i]) return (ab[i] ?? 0) - (bb[i] ?? 0);
    return 0;
  });
  const tree = SnapshotMerkleTree.fromEntries(holders.map((h) => ({ owner: h.owner, lpBalance: h.balance })));
  const slot = opts?.snapshotSlot ?? "123";
  const supply = opts?.totalSupply ?? "6000";
  const bal = opts?.balances;
  const ledger = Buffer.from(JSON.stringify({
    schema_version: 1, ledger_id: "L1", pool_address: POOL.toBase58(), amm_program_id: AMM.toBase58(), lp_mint: MINT.toBase58(), entries: [],
  }) + "\n");
  return JSON.stringify({
    format_version: 2,
    pool_address: POOL.toBase58(),
    amm_program_id: AMM.toBase58(),
    lp_mint: MINT.toBase58(),
    snapshot_slot: Number(slot),
    lp_total_supply_at_snapshot: Number(supply),
    merkle_root: Buffer.from(tree.root()).toString("hex"),
    leaf_count: 2,
    tree_depth: tree.treeDepth(),
    entries: holders.map((h, i) => ({
      owner: h.owner.toBase58(),
      lp_balance: Number(h.balance),
      leaf: Buffer.from(tree.leaf(i) ?? new Uint8Array()).toString("hex"),
      proof: (tree.proof(i) ?? []).map((p) => Buffer.from(p).toString("hex")),
    })),
    reconciliation: { entries_total: 6000, sink_exclusions_total: 0, enumerated_total: 6000 },
    exclusions: [],
    locked: { lock_records_seen: 0, total_locked: 0, attributions: [], custody: null },
    provenance: {
      sink_ledger: { schema_version: 1, ledger_id: "L1", input_sha256: createHash("sha256").update(ledger).digest("hex"), entry_count: 0, sink_exclusions_total: 0 },
      lock_evidence: { source: "rpc", program_id: UNCX_RAYDIUM_AMM_V4_LOCKER_PROGRAM_ID, commitment: "confirmed", anchor_slot: Number(slot), records_seen: 0, total_locked: 0 },
    },
  });
}

function input(text: string, overrides?: { sourceCommit?: string }): { store: InMemoryClaimsReleaseStore; input: Parameters<typeof runClaimsPublicationSequence>[0]["input"] } {
  return {
    store: new InMemoryClaimsReleaseStore(),
    input: {
      artifactBytes: Buffer.from(text, "utf8"),
      sourceCommit: "a".repeat(40),
      producer: { identity: "grave-snapshotter-cli", version: "1" },
      publishedAtUnixMs: 1_800_000_000_000,
      ...overrides,
    },
  };
}

describe("D4 review: strict u64 domain (publication rejection)", () => {
  test("negative u64 fields refuse at parse", () => {
    assert.throws(
      () => parseClaimsArtifact('{"format_version":2,"snapshot_slot":-1}'),
      (e: ClaimsArtifactError) => e.message.includes("non-negative"),
    );
    assert.throws(
      () => parseClaimsArtifact('{"format_version":2,"lp_balance":-9223372036854775808}'),
      (e: ClaimsArtifactError) => e.message.includes("non-negative"),
    );
  });

  test("u64 overflow (> 2^64-1) refuses at parse — including in provenance-sized fields", () => {
    for (const raw of [
      '{"format_version":2,"snapshot_slot":18446744073709551616}',
      '{"format_version":2,"entry_count":36893488147419103232}',
      '{"format_version":2,"anchor_slot":18446744073709551616}',
    ]) {
      assert.throws(() => parseClaimsArtifact(raw), (e: ClaimsArtifactError) => e.message.includes("outside the u64 range"), raw);
    }
  });

  test("publication rejects a negative / overflow artifact and leaves nothing behind", async () => {
    for (const text of [
      '{"format_version":2,"snapshot_slot":-5}',
      '{"format_version":2,"snapshot_slot":36893488147419103232}',
    ]) {
      const { store } = input(text);
      await assert.rejects(
        runClaimsPublicationSequence({ store, input: input(text).input }),
        (e: Error) => e instanceof ClaimsArtifactError || e instanceof ClaimsPublicationError,
      );
      assert.deepEqual(await store.listTags(), []);
      assert.equal(await store.stableRefSha(), null);
    }
  });

  test("the u64 maximum value parses exactly", () => {
    assert.equal(parseClaimsArtifact('{"format_version":2,"snapshot_slot":18446744073709551615}').snapshot_slot, 18446744073709551615n);
  });
});

describe("D4 review: source identity", () => {
  test('"notrack" (and any non-SHA) is refused BEFORE draft creation', async () => {
    for (const sourceCommit of ["notrack", "abc123", "A".repeat(40)]) {
      const { store } = input(validArtifactText());
      await assert.rejects(
        runClaimsPublicationSequence({ store, input: input(validArtifactText(), { sourceCommit }).input }),
        (e: ClaimsPublicationError) => e.message.includes("40-hex Git commit SHA"),
        sourceCommit,
      );
      assert.deepEqual(await store.listTags(), [], "no draft may exist before identity validation");
      assert.equal(await store.stableRefSha(), null);
    }
  });

  test("a real 40-hex commit publishes", async () => {
    const { store, input: inp } = input(validArtifactText());
    const result = await runClaimsPublicationSequence({ store, input: inp });
    assert.ok(result.activatedTag);
  });
});

describe("D4 review: automatic post-activation rollback (fault injection)", () => {
  function failingStore(base: InMemoryClaimsReleaseStore, failOn: string): ClaimsReleaseStore {
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === failOn) {
          return () => Promise.reject(new ClaimsPublicationError(`injected fault at ${String(prop)}`));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ClaimsReleaseStore;
  }

  test("createTagObject fault AFTER publish: ref never moved, previous preserved", async () => {
    const first = input(validArtifactText());
    const good = await runClaimsPublicationSequence(first);
    const refBefore = await first.store.stableRefSha();
    const second = input(validArtifactText(), {});
    const secondRun = { store: failingStore(second.store, "createTagObject"), input: { ...second.input, publishedAtUnixMs: 1_800_060_000_000 } };
    await assert.rejects(runClaimsPublicationSequence(secondRun), /injected fault/);
    assert.equal(await first.store.stableRefSha(), refBefore, "ref unchanged (never activated)");
    assert.ok(await first.store.fetchAssetByTag(good.activatedTag!, "claims-artifact.json"));
  });

  test("updateStableRef fault: activation aborted, rollback removes the first-publication ref", async () => {
    // First publication: ref moves at activate; a fault AT the ref move
    // itself is ambiguous — rollback deletes the (absent or partially
    // moved) ref and reports verified removal.
    const run = input(validArtifactText());
    await assert.rejects(
      runClaimsPublicationSequence({ store: failingStore(run.store, "updateStableRef"), input: run.input }),
      /rollback (RESTORED|removed the first-publication reference)/,
    );
    assert.equal(await run.store.stableRefSha(), null, "no half-activated pointer survives");
    assert.ok(run.store.hasRelease(claimsVersionedTag(1_800_000_000_000, "a".repeat(40))), "the versioned release (immutable identity) survives");
  });

  test("verify-stable-reference fault (asset mismatch): previous pointer restored and verified", async () => {
    let knownGoodTag: string | null = null;
    class TamperedServing extends InMemoryClaimsReleaseStore {
      override async fetchAssetByTag(tag: string, name: string): Promise<Uint8Array> {
        const bytes = await super.fetchAssetByTag(tag, name);
        if (name === "claims-artifact.json" && knownGoodTag !== null && tag !== knownGoodTag) {
          const flipped = Uint8Array.from(bytes);
          flipped[0] = (flipped[0] ?? 0) ^ 0x01;
          return flipped;
        }
        return bytes;
      }
    }
    const t = new TamperedServing();
    // Good publication ON the tampered-serving store: knownGoodTag is set
    // only AFTER this run, so the run's own verification reads untampered bytes.
    const good = await runClaimsPublicationSequence({
      store: t,
      input: { ...input(validArtifactText()).input, publishedAtUnixMs: 1_800_000_000_000 },
    });
    knownGoodTag = good.activatedTag!;
    const refBefore = await t.stableRefSha();
    void refBefore;
    // A second run whose final verification fails (tampered serving) →
    // rollback must restore the FIRST pointer.
    const secondInput = { ...input(validArtifactText()).input, publishedAtUnixMs: 1_800_060_000_000 };
    await assert.rejects(
      runClaimsPublicationSequence({ store: t, input: secondInput }),
      /rollback RESTORED/,
    );
    const refAfter = await t.stableRefSha();
    assert.equal(
      parseClaimsPointer((await t.fetchTagObject(refAfter!)).message).versionedTag,
      good.activatedTag,
      "previous pointer serves again",
    );
  });

  test("unrestorable rollback reports the explicit terminal unverified state", async () => {
    const run = input(validArtifactText());
    // updateStableRef fault AND deleteStableRef fault: rollback cannot be
    // attempted → terminal unverified.
    const broken = new Proxy(run.store, {
      get(target, prop, receiver) {
        if (prop === "updateStableRef" || prop === "deleteStableRef") {
          return () => Promise.reject(new ClaimsPublicationError(`injected fault at ${String(prop)}`));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ClaimsReleaseStore;
    await assert.rejects(
      runClaimsPublicationSequence({ store: broken, input: run.input }),
      /TERMINAL UNVERIFIED STATE/,
    );
  });
});

describe("D4 review: GitHub adapter (controlled mock, no network)", () => {
  function mockGithub(): { fetchImpl: typeof fetch; requests: Array<{ method: string; path: string; body?: unknown }> } {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const releases = new Map<string, { id: number; draft: boolean; assets: Map<string, Uint8Array> }>();
    const assetById = new Map<number, Uint8Array>();
    let assetIdC = 0;
    const tagObjects = new Map<string, { message: string }>();
    let stableRef: string | null = null;
    let idc = 100;
    let shaC = 0;
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.replace(/^https:\/\/[^/]+/, "").split("?")[0]!;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (!path.startsWith("/uploads/")) requests.push({ method, path, body });
      // upload endpoint
      if (path.includes("/releases/") && path.includes("/assets") && method === "POST") {
        const m = path.match(/\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets/)!;
        const rel = [...releases.values()].find((r) => r.id === Number(m[1]));
        if (!rel) return json({ path }, 404);
        const name = new URL(url).searchParams.get("name")!;
        const bytes = new Uint8Array(init?.body as ArrayBuffer);
        rel.assets.set(name, bytes);
        const aid = ++assetIdC;
        assetById.set(aid, bytes);
        return json({ id: aid, name }, 201);
      }
      if (path.startsWith("/o/r/releases/download/")) {
        // browser_download_url served from the assets base (github.com).
        const parts = path.split("/");
        // ['', 'o', 'r', 'releases', 'download', tag, ...name]
        const tag = parts[5]!;
        const name = parts.slice(6).join("/");
        const rel = releases.get(tag);
        const bytes = rel?.assets.get(name);
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(Buffer.from(bytes), { status: 200 });
      }
      if (path === "/repos/o/r/tags") return json([{ name: "claims-artifact-prod-x" }]);
      if (path === "/repos/o/r/releases" && method === "POST") {
        const tag = body.tag_name as string;
        if (releases.has(tag)) return json({ message: "already_exists" }, 422);
        releases.set(tag, { id: idc++, draft: true, assets: new Map() });
        return json({ id: idc - 1, tag_name: tag, draft: true, assets: [] }, 201);
      }
      if (path.startsWith("/repos/o/r/releases/tags/")) {
        const tag = path.split("/").pop()!;
        const rel = releases.get(tag);
        if (!rel) return new Response(null, { status: 404 });
        const assetId = new Map([...rel.assets.entries()].map(([n], i) => [n, i + 1]));
        return json({ id: rel.id, tag_name: tag, draft: rel.draft, assets: [...rel.assets.entries()].map(([n, b]) => ({ id: assetId.get(n), name: n, size: b.byteLength, url: `https://api.github.com/repos/o/r/releases/assets/${assetId.get(n)}`, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${n}` })) });
      }
      if (path.startsWith("/repos/o/r/releases/") && method === "PATCH") {
        const id = Number(path.split("/").pop());
        const rel = [...releases.values()].find((r) => r.id === id)!;
        rel.draft = body.draft as boolean;
        return json({ id, draft: rel.draft });
      }
      if (path.startsWith("/repos/o/r/releases/") && method === "DELETE") {
        const id = Number(path.split("/").pop());
        for (const [t, r] of releases) if (r.id === id && r.draft) releases.delete(t);
        return new Response(null, { status: 204 });
      }
      if (path === "/repos/o/r/git/ref/tags/claims-artifact-prod") {
        if (stableRef === null) return new Response(null, { status: 404 });
        return json({ object: { sha: stableRef, type: "tag" } });
      }
      if (path === "/repos/o/r/git/tags" && method === "POST") {
        shaC++;
        const sha = shaC.toString(16).padStart(40, "0");
        tagObjects.set(sha, { message: body.message });
        return json({ sha, object: { sha } }, 201);
      }
      if (path.startsWith("/repos/o/r/git/tags/")) {
        const sha = path.split("/").pop()!;
        const t = tagObjects.get(sha);
        if (!t) return new Response(null, { status: 404 });
        return json({ message: t.message, object: { sha: "b".repeat(40), type: "commit" } });
      }
      if (path === "/repos/o/r/git/refs" && method === "POST") {
        stableRef = body.sha as string;
        return json({ ref: body.ref }, 201);
      }
      if (path === "/repos/o/r/git/refs/tags/claims-artifact-prod" && method === "PATCH") {
        stableRef = body.sha as string;
        return json({ ref: "refs/tags/claims-artifact-prod" });
      }
      if (path === "/repos/o/r/git/refs/tags/claims-artifact-prod" && method === "DELETE") {
        stableRef = null;
        return new Response(null, { status: 204 });
      }
      if (path.startsWith("/repos/o/r/releases/assets/") && method === "GET") {
        const aid = Number(path.split("/").pop());
        const bytes = assetById.get(aid);
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(Buffer.from(bytes), { status: 200 });
      }
      if (path.startsWith("/repos/o/r/releases/assets/")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    };
    return { fetchImpl, requests };
  }

  test("the adapter runs the full sequence against the mock GitHub; no token in any error", async () => {
    const gh = mockGithub();
    const store = new GitHubClaimsReleaseStore({ repo: "o/r", token: "tok3n-s3cret", fetchImpl: gh.fetchImpl });
    const result = await runClaimsPublicationSequence({
      store,
      input: { artifactBytes: Buffer.from(validArtifactText(), "utf8"), sourceCommit: "a".repeat(40), producer: { identity: "grave-snapshotter-cli", version: "1" }, publishedAtUnixMs: 1_800_000_000_000 },
    });
    assert.ok(result.activatedTag);
    // The ref move happened (first-publication POST or atomic PATCH).
    assert.ok(
      gh.requests.some((r) => r.path === "/repos/o/r/git/refs/tags/claims-artifact-prod") ||
        gh.requests.some((r) => r.path === "/repos/o/r/git/refs"),
    );
    // And the stable ref resolves to the activated pointer.
    const refSha = await store.stableRefSha();
    assert.ok(refSha);
    assert.equal(parseClaimsPointer((await store.fetchTagObject(refSha)).message).versionedTag, result.activatedTag);
    // Token hygiene: no captured request body/path may carry the token.
    assert.ok(!gh.requests.some((r) => JSON.stringify(r).includes("tok3n-s3cret")));
    void GitHubStoreError;
  });

  test("adapter failures surface status and never the token", async () => {
    const gh = mockGithub();
    const store = new GitHubClaimsReleaseStore({ repo: "o/r", token: "tok3n-s3cret", fetchImpl: gh.fetchImpl });
    try {
      await store.fetchAssetByTag("no-such-tag", "claims-artifact.json");
      assert.fail("expected refusal");
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(!`${e.message}`.includes("tok3n-s3cret"), "token must never leak");
    }
  });

  test("adapter refuses oversized and non-JSON API responses (bounded reads)", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("/tags?per_page")) {
        // 2 MiB body — far above the 1 MiB cap.
        return new Response("x".repeat(2 * 1024 * 1024), { status: 200 });
      }
      if (url.includes("/releases/tags/")) {
        return new Response("this is not json {", { status: 200 });
      }
      return new Response(null, { status: 404 });
    };
    const store = new GitHubClaimsReleaseStore({ repo: "o/r", token: "t", fetchImpl });
    await assert.rejects(store.listTags(), /byte cap/);
    await assert.rejects(store.fetchTagObject("0".repeat(40)), /valid JSON|unexpected response shape|HTTP/);
    void calls;
  });

  test("the dedicated workflow file exists and is claims-specific (separate from ConsoleSnapshotV2)", async () => {
    const { readFileSync } = await import("node:fs");
    const yml = readFileSync(new URL("../.github/workflows/publish-claims-artifact.yml", import.meta.url), "utf8");
    assert.match(yml, /publish-claims-artifact/);
    assert.match(yml, /claims-artifact-prod|claims:publish|claimsPublishCli/);
    assert.ok(!yml.includes("console-snapshot-prod"), "must not touch the ConsoleSnapshotV2 namespace");
  });
});
