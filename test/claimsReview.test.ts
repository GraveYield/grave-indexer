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
  rollbackClaimsStableReference,
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

describe("Review round 2, finding 1: no workflow input reaches a run script", () => {
  test("every expression lives in env:/with: — run: scripts contain no ${{ }}", async () => {
    const { readFileSync } = await import("node:fs");
    const yml = readFileSync(new URL("../.github/workflows/publish-claims-artifact.yml", import.meta.url), "utf8");
    // Concurrency serialization is present (finding 2, primary guard).
    assert.match(yml, /concurrency:\n\s+group: claims-artifact-publication/);
    assert.match(yml, /cancel-in-progress: false/);
    // Every workflow expression must live on an `env:` line, never inside
    // a `run:` script (finding 1: static injection check).
    const lines = yml.split("\n");
    let inRun = false;
    let runIndent = 0;
    for (const line of lines) {
      const runMatch = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
      if (runMatch) {
        const runValue = runMatch[2] ?? "";
        inRun = !/^[>'\"]/.test(runValue) || runValue.includes("|") || runValue.includes(">");
        runIndent = runMatch[1]!.length;
        // inline (single-line) run values must not interpolate expressions
        if (inRun && runValue && !runValue.includes("|") && !runValue.includes(">")) {
          assert.ok(!runValue.includes("${{"), `expression inside inline run: ${line.trim()}`);
          inRun = false;
        }
        continue;
      }
      if (inRun) {
        const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (indent <= runIndent) inRun = false;
        else assert.ok(!line.includes("${{"), `expression inside a run block: ${line.trim()}`);
      }
    }
    // Inputs reach the shell ONLY via env indirection.
    for (const required of ["CLAIMS_ARTIFACT_PATH", "CLAIMS_SOURCE_COMMIT", "CLAIMS_PRODUCER_IDENTITY", "CLAIMS_PRODUCER_VERSION"]) {
      assert.match(yml, new RegExp(`^\\s+${required}:\\s+\\$\\{\\{ inputs\\.`, "m"), `env indirection missing: ${required}`);
    }
    assert.match(yml, /GY_CLAIMS_GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    // And the run scripts consume quoted env vars, not expressions.
    for (const quoted of ['"$CLAIMS_ARTIFACT_PATH"', '"$CLAIMS_SOURCE_COMMIT"', '"$CLAIMS_PRODUCER_IDENTITY"', '"$CLAIMS_PRODUCER_VERSION"']) {
      assert.ok(yml.includes(quoted), `run script must consume ${quoted}`);
    }
  });
});

describe("Review round 2, finding 2: ownership-conditional rollback (concurrent publisher)", () => {
  function foreignSha(): string {
    return "f".repeat(40);
  }

  test("a ref moved by a concurrent publisher is NEVER clobbered by rollback — TERMINAL UNVERIFIED", async () => {
    // First publication by publisher A.
    const a = input(validArtifactText());
    const good = await runClaimsPublicationSequence(a);
    const refBefore = await a.store.stableRefSha();

    // Publisher B publishes (moves the ref to ITS pointer).
    const b = input(validArtifactText(), {});
    const goodB = await runClaimsPublicationSequence({ store: a.store, input: { ...b.input, publishedAtUnixMs: 1_800_060_000_000 } });
    const refAfterB = await a.store.stableRefSha();
    assert.notEqual(refAfterB, refBefore, "B moved the ref");

    // Simulate A's LATE rollback (e.g. a delayed verification failure) —
    // it must refuse because the ref no longer names A's activation.
    const outcome = await rollbackClaimsStableReference({
      store: a.store,
      previous: { versionedTag: good.activatedTag!, tagObjectSha: refBefore!, pointer: parseClaimsPointer((await a.store.fetchTagObject(refBefore!)).message) },
      activatedTag: good.activatedTag!,
      activatedTagObjectSha: refBefore!,
    });
    assert.equal(outcome, "foreign-reference-untouched", "late rollback must not touch B's ref");
    assert.equal(await a.store.stableRefSha(), refAfterB, "B's pointer is untouched");
    void goodB;
  });

  test("the sequence reports TERMINAL UNVERIFIED when the ref changed hands mid-attempt", async () => {
    const run = input(validArtifactText());
    // The attempt activates fine, but by verify time the ref belongs to
    // someone else (concurrent move between activate and verify).
    class ConcurrentMove extends InMemoryClaimsReleaseStore {
      private moved = false;
      private foreignShaValue = foreignSha();
      override async stableRefSha(): Promise<string | null> {
        const sha = await super.stableRefSha();
        return this.moved ? this.foreignShaValue : sha;
      }
      // The FIRST post-activation asset fetch is where the concurrent
      // publisher wins the race: from that moment the stable ref names the
      // FOREIGN pointer — and the same fetch returns tampered bytes so the
      // attempt's own verification fails, driving the rollback path.
      override async fetchAssetByTag(tag: string, name: string): Promise<Uint8Array> {
        const bytes = await super.fetchAssetByTag(tag, name);
        if (name === "claims-artifact.json" && !this.moved) {
          this.moved = true;
          const flipped = Uint8Array.from(bytes);
          flipped[0] = (flipped[0] ?? 0) ^ 0x01;
          return flipped;
        }
        return bytes;
      }
    }
    const t = new ConcurrentMove();
    await assert.rejects(
      runClaimsPublicationSequence({ store: t, input: run.input }),
      (e: ClaimsPublicationError) => e.message.includes("TERMINAL UNVERIFIED") && e.message.includes("NO LONGER names this attempt"),
      "rollback must refuse to clobber the concurrent publisher",
    );
    assert.equal(await t.stableRefSha(), foreignSha(), "the foreign pointer is left untouched");
  });

  test("owned rollback still restores the previous pointer (unchanged good path)", async () => {
    const first = input(validArtifactText());
    const good = await runClaimsPublicationSequence(first);
    // Inject a verify failure on the second attempt only.
    class FailOnceVerify extends InMemoryClaimsReleaseStore {
      private attempts = 0;
      override async fetchAssetByTag(tag: string, name: string): Promise<Uint8Array> {
        const bytes = await super.fetchAssetByTag(tag, name);
        if (name === "claims-artifact.json") {
          this.attempts++;
          if (this.attempts === 2) {
            const flipped = Uint8Array.from(bytes);
            flipped[0] = (flipped[0] ?? 0) ^ 0x01;
            return flipped;
          }
        }
        return bytes;
      }
    }
    const t = new FailOnceVerify();
    await runClaimsPublicationSequence({ store: t, input: { ...input(validArtifactText()).input, publishedAtUnixMs: 1_800_000_000_000 } });
    await assert.rejects(
      runClaimsPublicationSequence({ store: t, input: { ...input(validArtifactText()).input, publishedAtUnixMs: 1_800_060_000_000 } }),
      /rollback RESTORED/,
    );
    const refSha = await t.stableRefSha();
    assert.equal(parseClaimsPointer((await t.fetchTagObject(refSha!)).message).versionedTag, good.activatedTag);
  });

  test("the adapter refuses a ref move when the live sha does not match the caller's expectation (CAS defense-in-depth)", async () => {
    const aSha = "1".repeat(40);
    const bSha = "2".repeat(40);
    let liveRef: string | null = null; // null = ref absent
    let patchCalls = 0;
    const refBody = () => JSON.stringify({ object: { sha: liveRef, type: "tag" } });
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.replace(/^https:\/\/[^/]+/, "");
      if (path === "/repos/o/r/git/ref/tags/claims-artifact-prod") {
        return liveRef === null ? new Response(null, { status: 404 }) : new Response(refBody(), { status: 200 });
      }
      if (path === "/repos/o/r/git/refs/tags/claims-artifact-prod" && method === "PATCH") {
        patchCalls++;
        liveRef = (JSON.parse(String(init?.body)) as { sha: string }).sha;
        return new Response(refBody(), { status: 200 });
      }
      if (path === "/repos/o/r/git/refs" && method === "POST") {
        patchCalls++;
        liveRef = (JSON.parse(String(init?.body)) as { sha: string }).sha;
        return new Response(JSON.stringify({ ref: "refs/tags/claims-artifact-prod" }), { status: 201 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const adapter = new GitHubClaimsReleaseStore({ repo: "o/r", token: "t", fetchImpl });
    // First move with expectation null (first publication) — allowed.
    await adapter.updateStableRef(aSha, { expectCurrentSha: null });
    assert.equal(liveRef, aSha);
    // An attempt that still expects the ref ABSENT must be refused.
    await assert.rejects(adapter.updateStableRef(bSha, { expectCurrentSha: null }), /refused non-atomic overwrite|moved concurrently/);
    assert.equal(liveRef, aSha, "ref unchanged after refusal");
    assert.equal(patchCalls, 1, "no PATCH was issued for a refused move");
    // A concurrent publisher moved the ref to B; an attempt that still
    // expects A must be refused, leaving B untouched.
    liveRef = bSha;
    patchCalls = 0;
    await assert.rejects(adapter.updateStableRef(aSha, { expectCurrentSha: aSha }), /moved concurrently/);
    assert.equal(patchCalls, 0, "no PATCH on ownership mismatch");
    assert.equal(liveRef, bSha, "B's pointer untouched");
    // Matching expectation passes.
    await adapter.updateStableRef(bSha, { expectCurrentSha: bSha });
    assert.equal(patchCalls, 1);
  });
});
