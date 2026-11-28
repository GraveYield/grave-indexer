// SPDX-License-Identifier: Apache-2.0
//
// I-05 rollback-concurrency regression tests — REAL ADAPTER SEMANTICS.
//
// The existing claimsPublication.test.ts battery runs against the
// in-memory store; an in-memory adapter cannot establish that the GitHub
// REST surface behaves the way the store assumes. THIS battery drives
// `GitHubClaimsReleaseStore` (the production adapter) over a mock HTTP
// GitHub API that reproduces the REST semantics the adapter depends on:
//
//   * GET /git/ref/tags/<ref> answers 200 {object:{sha,type:"tag"}} or
//     404 {"message":"Reference does not exist"};
//   * POST /git/refs answers 201, or 422 "Reference already exists"
//     when the ref came into existence concurrently (insert-if-absent);
//   * PATCH /git/refs/<ref> answers 200 (force overwrite) or 422 when
//     the ref is absent;
//   * DELETE /git/refs/<ref> answers 204 or 422 when the ref is absent;
//   * POST /git/tags mints an immutable annotated tag object;
//   * releases: POST /releases (201 draft / 422 duplicate), asset upload
//     on the uploads host, PATCH draft→published, DELETE of drafts;
//   * versioned-release assets are downloadable via the browser URL
//     `…/releases/download/<tag>/<name>` ONLY once published.
//
// Every request is logged, and RACE-INJECTION hooks mutate the ref state
// deterministically at exact request boundaries, so the I-05
// interleavings are reproduced DETERMINISTICALLY (the task requirement):
// foreign writes in the probe→write window, in the write→read-back
// window, and after the ownership gate.
//
// HONEST LIMITATION (stated, not hidden): the mock reproduces the
// DOCUMENTED GitHub REST semantics; it is still a mock — it cannot prove
// the real service behaves identically under load, and the probe→write
// race window is a REAL property of the GitHub refs API (no conditional
// write exists). The tests assert EXACTLY what the adapter can and
// cannot guarantee:
//   * a foreign write in the write→read-back window is DETECTED (post-
//     write read-back) and the outcome is TERMINAL UNVERIFIED;
//   * a foreign write in the probe→PATCH window is CLOBBERED — the
//     GitHub REST API offers no way to prevent this; the test asserts
//     the clobber happens, and docs/CLAIMS_PUBLICATION.md records it as
//     the residual boundary (mitigated operationally by tag protection
//     rules and the workflow concurrency group — never by pretending
//     atomicity).
//
// All runs are NON-PRODUCTION: fetch is fully substituted, no network
// access, no real releases, no real refs, no credentials.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";
import { SnapshotMerkleTree } from "@graveyield/sdk";

import { GitHubClaimsReleaseStore, GitHubStoreError } from "../src/claimsGitHubStore.js";
import {
  claimsSha256Hex,
  claimsVersionedTag,
  parseClaimsPointer,
  rollbackClaimsStableReference,
  runClaimsPublicationSequence,
  CLAIMS_ARTIFACT_ASSET_NAME,
  CLAIMS_STABLE_REF,
  ClaimsRollbackOutcomeError,
  type ClaimsPublicationInput,
  type RollbackAuditEvent,
} from "../src/claimsPublication.js";

// ── fixture factory (independent; same semantics as claimsPublication.test) ──

let counter = 0;
function key(prefix: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = prefix;
  bytes[1] = (counter = (counter + 1) % 251);
  bytes[2] = counter;
  return new PublicKey(bytes);
}

const POOL = key(0xaa);
const AMM = key(0xab);
const MINT = key(0x01);
const UNCX = "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo";

interface Fixture {
  bytes: Uint8Array;
  rootHex: string;
  pool: string;
  mint: string;
}

function buildFixture(): Fixture {
  const sinkOwner = key(0x50);
  const custodyOwner = key(0x60);
  const custodyAccount = key(0x61);
  const holders = [
    { owner: key(0x10), balance: 4_000n },
    { owner: key(0x20), balance: 2_500n },
    { owner: key(0x30), balance: 1_000n },
  ].sort((a, b) => {
    const ab = a.owner.toBytes();
    const bb = b.owner.toBytes();
    for (let i = 0; i < 32; i++) if ((ab[i] ?? 0) !== (bb[i] ?? 0)) return (ab[i] ?? 0) - (bb[i] ?? 0);
    return 0;
  });
  const sinkBalance = 500n;
  const ledgerBytes = Buffer.from(
    JSON.stringify(
      {
        schema_version: 1,
        ledger_id: "GY-SINK-TEST-ADAPTER-001",
        pool_address: POOL.toBase58(),
        amm_program_id: AMM.toBase58(),
        lp_mint: MINT.toBase58(),
        entries: [
          {
            owner: sinkOwner.toBase58(),
            token_account: key(0x51).toBase58(),
            lp_mint: MINT.toBase58(),
            raw_balance: sinkBalance,
            rationale: "incinerator address, funds provably unrecoverable",
            evidence_references: ["gy-evidence-001"],
            approval_identities: ["owner-identity-1"],
            independent_reviewer: "reviewer-identity-1",
            approved_at: "2026-11-27T00:00:00Z",
          },
        ],
      },
      (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v),
    ),
    "utf8",
  );
  const ledgerDigest = createHash("sha256").update(ledgerBytes).digest("hex");
  const tree = SnapshotMerkleTree.fromEntries(holders.map((h) => ({ owner: h.owner, lpBalance: h.balance })));
  const entries = holders.map((h, i) => ({
    owner: h.owner.toBase58(),
    lp_balance: h.balance,
    leaf: Buffer.from(tree.leaf(i) ?? new Uint8Array()).toString("hex"),
    proof: (tree.proof(i) ?? []).map((p) => Buffer.from(p).toString("hex")),
  }));
  const enumerated = holders.reduce((a, h) => a + h.balance, 0n) + sinkBalance;
  const doc = {
    format_version: 2,
    pool_address: POOL.toBase58(),
    amm_program_id: AMM.toBase58(),
    lp_mint: MINT.toBase58(),
    snapshot_slot: 123,
    lp_total_supply_at_snapshot: enumerated,
    merkle_root: Buffer.from(tree.root()).toString("hex"),
    leaf_count: entries.length,
    tree_depth: tree.treeDepth(),
    entries,
    reconciliation: {
      entries_total: holders.reduce((a, h) => a + h.balance, 0n),
      sink_exclusions_total: sinkBalance,
      enumerated_total: enumerated,
    },
    exclusions: [{ owner: sinkOwner.toBase58(), lp_balance: sinkBalance, reason: "explicit_sink" }],
    locked: {
      lock_records_seen: 1,
      total_locked: 1_000n,
      attributions: [{ owner: custodyOwner.toBase58(), lp_balance: 1_000n }],
      custody: {
        token_account: custodyAccount.toBase58(),
        owner: custodyOwner.toBase58(),
        balance: 1_000n,
        method: "exact_balance_match",
      },
    },
    provenance: {
      sink_ledger: {
        schema_version: 1,
        ledger_id: "GY-SINK-TEST-ADAPTER-001",
        input_sha256: ledgerDigest,
        entry_count: 1,
        sink_exclusions_total: sinkBalance,
      },
      lock_evidence: { source: "rpc", program_id: UNCX, commitment: "confirmed", anchor_slot: 123, records_seen: 1, total_locked: 1_000n },
    },
  };
  const jsonText = JSON.stringify(doc, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v), 2) + "\n";
  return {
    bytes: Buffer.from(jsonText, "utf8"),
    rootHex: Buffer.from(tree.root()).toString("hex"),
    pool: POOL.toBase58(),
    mint: MINT.toBase58(),
  };
}

const COMMIT_1 = "b".repeat(40);
const COMMIT_2 = "c".repeat(40);

function publicationInput(f: Fixture, publishedAtUnixMs: number, sourceCommit = COMMIT_1): ClaimsPublicationInput {
  return {
    artifactBytes: f.bytes,
    sourceCommit,
    producer: { identity: "grave-snapshotter-cli", version: "test" },
    publishedAtUnixMs,
  };
}

// ── the mock GitHub REST server ──────────────────────────────────────────────

const REPO = "GraveYield/grave-indexer";
const API = "https://api.github.test";
const REF_PATH = `/repos/${REPO}/git/ref/tags/${CLAIMS_STABLE_REF}`;
const REFS_PATH = `/repos/${REPO}/git/refs/tags/${CLAIMS_STABLE_REF}`;
const CREATE_REFS_PATH = `/repos/${REPO}/git/refs`;

type HandleFn = (url: URL, method: string, body: string) => Response;

interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
}

interface Hook {
  method: string;
  pathname: string;
  phase: "before" | "after";
  once: boolean;
  /** 1-based invocation counter of the matched route (before phase). */
  minInvocation?: number;
  fn: (srv: MockGitHubServer) => number | void;
}

/** Corrupt an artifact's last byte (integrity failure downstream). */
function corrupt(bytes: Uint8Array): Uint8Array {
  const flipped = Uint8Array.from(bytes);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
  return flipped;
}

/**
 * Install a request interceptor in front of the mock's handler. The
 * interceptor returns a Response to REPLACE the handled one, or
 * undefined to delegate (it may mutate server state first). This is the
 * deterministic race-injection mechanism for tests that need byte-level
 * control (corrupted downloads) or inter-request mutation.
 */
function interceptHandle(srv: MockGitHubServer, interceptor: (url: URL, method: string, srv2: MockGitHubServer) => Response | undefined): void {
  const slot = srv as unknown as { handle: HandleFn };
  const original: HandleFn = slot.handle.bind(srv);
  slot.handle = (url, method, body) => {
    const replaced = interceptor(url, method, srv);
    return replaced ?? original(url, method, body);
  };
}

/**
 * Mock GitHub REST API. Semantics mirror the documented GitHub behavior
 * the production adapter depends on (see file header). Race injection:
 * one-shot hooks fire at exact route/phase boundaries.
 */
class MockGitHubServer {
  /** ref name → tag-object sha (only tags/claims-artifact-prod is used). */
  refs = new Map<string, string>();
  /** sha → annotated tag object. */
  tagObjects = new Map<string, { message: string; commitSha: string }>();
  /** tag → release record (draft or published, with assets). */
  releases = new Map<string, { id: number; draft: boolean; assets: Map<string, Uint8Array> }>();
  readonly log: RequestLogEntry[] = [];
  private hooks: Hook[] = [];
  private routeInvocations = new Map<string, number>();
  private assetIds = new Map<string, number>();
  private ids = 1;
  private shas = 0x1000;

  /** Deterministic 40-hex object sha (foreign/extra objects). */
  mintSha(): string {
    this.shas += 1;
    return this.shas.toString(16).padStart(40, "0");
  }

  on(h: Omit<Hook, "phase"> & { phase?: "before" | "after" }): void {
    this.hooks.push({ ...h, phase: h.phase ?? "before" });
  }

  private routeCount(method: string, pathname: string): number {
    const k = `${method} ${pathname}`;
    const n = (this.routeInvocations.get(k) ?? 0) + 1;
    this.routeInvocations.set(k, n);
    return n;
  }

  private fireHooks(method: string, pathname: string, phase: "before" | "after"): number | null {
    const n = phase === "before" ? this.routeCount(method, pathname) : (this.routeInvocations.get(`${method} ${pathname}`) ?? 0);
    for (const h of [...this.hooks]) {
      if (h.phase !== phase) continue;
      if (h.method !== method || h.pathname !== pathname) continue;
      if (h.minInvocation !== undefined && n < h.minInvocation) continue;
      if (h.once) this.hooks = this.hooks.filter((x) => x !== h);
      const abort = h.fn(this);
      if (phase === "before" && typeof abort === "number") return abort;
    }
    return null;
  }

  handle(url: URL, method: string, bodyText: string): Response {
    const pathname = url.pathname;
    let body: Record<string, unknown> = {};
    if (bodyText.length > 0) {
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const json = (status: number, payload: unknown): Response =>
      new Response(Buffer.from(JSON.stringify(payload), "utf8"), { status });

    const abortBefore = this.fireHooks(method, pathname, "before");
    if (abortBefore !== null) {
      this.log.push({ method, path: pathname, status: abortBefore });
      return json(abortBefore, { message: `injected failure (HTTP ${abortBefore})` });
    }

    const respond = (status: number, payload: unknown): Response => {
      this.fireHooks(method, pathname, "after");
      this.log.push({ method, path: pathname, status });
      return payload === undefined ? new Response(null, { status }) : json(status, payload);
    };

    // ── git refs ──
    if (method === "GET" && pathname === REF_PATH) {
      const sha = this.refs.get(`tags/${CLAIMS_STABLE_REF}`);
      return sha === undefined
        ? respond(404, { message: "Reference does not exist" })
        : respond(200, { ref: `refs/tags/${CLAIMS_STABLE_REF}`, object: { sha, type: "tag" } });
    }
    if (method === "POST" && pathname === CREATE_REFS_PATH) {
      const refName = String(body["ref"] ?? "").replace(/^refs\//, "");
      const sha = String(body["sha"] ?? "");
      if (this.refs.has(refName)) return respond(422, { message: "Reference already exists" });
      this.refs.set(refName, sha);
      return respond(201, { ref: refName, object: { sha, type: "tag" } });
    }
    if (method === "PATCH" && pathname === REFS_PATH) {
      if (!this.refs.has(`tags/${CLAIMS_STABLE_REF}`)) return respond(422, { message: "Reference does not exist" });
      const sha = String(body["sha"] ?? "");
      this.refs.set(`tags/${CLAIMS_STABLE_REF}`, sha);
      return respond(200, { ref: `refs/tags/${CLAIMS_STABLE_REF}`, object: { sha, type: "tag" } });
    }
    if (method === "DELETE" && pathname === REFS_PATH) {
      if (!this.refs.has(`tags/${CLAIMS_STABLE_REF}`)) return respond(422, { message: "Reference does not exist" });
      this.refs.delete(`tags/${CLAIMS_STABLE_REF}`);
      return respond(204, undefined);
    }

    // ── git tags (annotated tag objects) ──
    if (method === "POST" && pathname === `/repos/${REPO}/git/tags`) {
      const sha = this.mintSha();
      this.tagObjects.set(sha, { message: String(body["message"] ?? ""), commitSha: String(body["object"] ?? "") });
      return respond(201, { sha, object: { sha: body["object"], type: "commit" } });
    }
    const tagGet = pathname.match(new RegExp(`^/repos/${REPO}/git/tags/([0-9a-f]{40})$`));
    if (method === "GET" && tagGet) {
      const obj = this.tagObjects.get(tagGet[1]!);
      return obj === undefined
        ? respond(404, { message: "Not Found" })
        : respond(200, { sha: tagGet[1], message: obj.message, object: { sha: obj.commitSha, type: "commit" } });
    }

    // ── releases ──
    if (method === "GET" && pathname === `/repos/${REPO}/tags`) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const names = [...this.releases.keys()];
      return respond(200, page === 1 ? names.map((name) => ({ name })) : []);
    }
    if (method === "POST" && pathname === `/repos/${REPO}/releases`) {
      const tag = String(body["tag_name"] ?? "");
      if (this.releases.has(tag)) return respond(422, { message: "Validation Failed (tag already exists)" });
      this.releases.set(tag, { id: this.ids++, draft: body["draft"] === true, assets: new Map() });
      return respond(201, this.releaseJson(tag));
    }
    const relByTag = pathname.match(new RegExp(`^/repos/${REPO}/releases/tags/(.+)$`));
    if (method === "GET" && relByTag) {
      const tag = decodeURIComponent(relByTag[1]!);
      return this.releases.has(tag) ? respond(200, this.releaseJson(tag)) : respond(404, { message: "Not Found" });
    }
    const relById = pathname.match(new RegExp(`^/repos/${REPO}/releases/(\\d+)$`));
    if (method === "PATCH" && relById) {
      const tag = [...this.releases.entries()].find(([, r]) => r.id === Number(relById[1]))?.[0];
      if (tag === undefined) return respond(404, { message: "Not Found" });
      if (body["draft"] === false) this.releases.get(tag)!.draft = false;
      return respond(200, this.releaseJson(tag));
    }
    if (method === "DELETE" && relById) {
      const tag = [...this.releases.entries()].find(([, r]) => r.id === Number(relById[1]))?.[0];
      if (tag === undefined) return respond(404, { message: "Not Found" });
      if (this.releases.get(tag)!.draft !== true) return respond(422, { message: "refusing to delete a published release (mock invariant)" });
      this.releases.delete(tag);
      return respond(204, undefined);
    }
    const assetApi = pathname.match(new RegExp(`^/repos/${REPO}/assets/(\\d+)$`));
    if (method === "GET" && assetApi) {
      for (const [tag, rel] of this.releases) {
        for (const [name, bytes] of rel.assets) {
          if (this.assetId(tag, name) === Number(assetApi[1])) {
            this.log.push({ method, path: pathname, status: 200 });
            return new Response(Buffer.from(bytes), { status: 200 });
          }
        }
      }
      return respond(404, { message: "Not Found" });
    }
    // NOTE: the adapter builds the browser URL as `${assetsBase}/${repo}/…`
    // (no `/repos/` prefix on the assets host).
    const dl = pathname.match(new RegExp(`^/${REPO}/releases/download/([^/]+)/([^/]+)$`));
    if (method === "GET" && dl) {
      const rel = this.releases.get(decodeURIComponent(dl[1]!));
      // The browser download URL serves PUBLISHED assets only (drafts 404).
      const bytes = rel && !rel.draft ? rel.assets.get(decodeURIComponent(dl[2]!)) : undefined;
      return bytes === undefined ? respond(404, { message: "Not Found" }) : new Response(Buffer.from(bytes), { status: 200 });
    }

    throw new Error(`mock GitHub server: unhandled ${method} ${pathname}`);
  }

  private assetId(tag: string, name: string): number {
    const k = `${tag} ${name}`;
    if (!this.assetIds.has(k)) this.assetIds.set(k, this.ids++);
    return this.assetIds.get(k)!;
  }

  private releaseJson(tag: string): Record<string, unknown> {
    const rel = this.releases.get(tag)!;
    return {
      id: rel.id,
      tag_name: tag,
      draft: rel.draft,
      assets: [...rel.assets.entries()].map(([name, bytes]) => ({
        id: this.assetId(tag, name),
        name,
        size: bytes.byteLength,
        url: `${API}/repos/${REPO}/assets/${this.assetId(tag, name)}`,
      })),
    };
  }

  /** The fetchImpl wired into GitHubClaimsReleaseStore. */
  readonly fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = init?.body;
    if (rawBody instanceof Uint8Array && url.pathname.endsWith("/assets")) {
      return this.handleUpload(url, method, rawBody);
    }
    const bodyText = typeof rawBody === "string" ? rawBody : rawBody instanceof Uint8Array ? Buffer.from(rawBody).toString("utf8") : "";
    return this.handle(url, method, bodyText);
  };

  private handleUpload(url: URL, method: string, bytes: Uint8Array): Response {
    const pathname = url.pathname;
    const abortBefore = this.fireHooks(method, pathname, "before");
    if (abortBefore !== null) return new Response(null, { status: abortBefore });
    const upload = pathname.match(new RegExp(`^/repos/${REPO}/releases/(\\d+)/assets$`));
    if (method === "POST" && upload) {
      const tag = [...this.releases.entries()].find(([, r]) => r.id === Number(upload[1]))?.[0];
      const rel = tag === undefined ? undefined : this.releases.get(tag)!;
      if (rel === undefined || !rel.draft) return new Response(null, { status: 422 });
      const name = url.searchParams.get("name") ?? "";
      if (rel.assets.has(name)) return new Response(null, { status: 422 });
      rel.assets.set(name, bytes);
      return new Response(Buffer.from(JSON.stringify({ id: this.assetId(tag!, name), name })), { status: 201 });
    }
    throw new Error(`mock GitHub upload server: unhandled ${method} ${pathname}`);
  }
}

function newStore(srv: MockGitHubServer): GitHubClaimsReleaseStore {
  return new GitHubClaimsReleaseStore({
    repo: REPO,
    token: "test-token-never-logged",
    apiBase: API,
    assetsBase: "https://github.test",
    fetchImpl: srv.fetchImpl,
  });
}

function destructiveRefRequests(srv: MockGitHubServer): RequestLogEntry[] {
  return srv.log.filter(
    (e) => (e.path === REF_PATH || e.path === REFS_PATH || e.path === CREATE_REFS_PATH) && (e.method === "PATCH" || e.method === "DELETE"),
  );
}

async function stableRefShaDirect(srv: MockGitHubServer): Promise<string | null> {
  return srv.refs.get(`tags/${CLAIMS_STABLE_REF}`) ?? null;
}

/**
 * Corrupt the artifact served from `tag`'s versioned release on the
 * Nth download (1 = the pre-activation verify-versioned-release check,
 * 2 = the post-activation verify-stable-reference check). Counting the
 * artifact download specifically makes the injection deterministic.
 */
function corruptArtifactOnNthDownload(srv: MockGitHubServer, tag: string, nth: number): void {
  // NOTE: the browser download URL has NO `/repos/` prefix (the assets host path is `/{owner}/{repo}/…`).
  const dlPath = `/${REPO}/releases/download/${tag}/${CLAIMS_ARTIFACT_ASSET_NAME}`;
  let seen = 0;
  interceptHandle(srv, (url, method, s) => {
    if (method === "GET" && url.pathname === dlPath) {
      seen += 1;
      if (seen === nth) {
        const bytes = s.releases.get(tag)!.assets.get(CLAIMS_ARTIFACT_ASSET_NAME)!;
        s.log.push({ method, path: url.pathname, status: 200 });
        return new Response(Buffer.from(corrupt(bytes)), { status: 200 });
      }
    }
    return undefined;
  });
}

// ── the battery ──────────────────────────────────────────────────────────────

describe("I-05: rollback concurrency against GitHub ADAPTER semantics (mock REST API)", () => {
  test("happy path through the REAL adapter: first + second publication succeed end-to-end", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const f1 = buildFixture();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f1, 1_800_000_000_000, COMMIT_1) });
    assert.ok(await stableRefShaDirect(srv));

    const f2 = buildFixture();
    const second = await runClaimsPublicationSequence({ store, input: publicationInput(f2, 1_800_000_060_000, COMMIT_2) });
    assert.notEqual(second.activatedTag, first.activatedTag);
    const object = await store.fetchTagObject((await store.stableRefSha())!);
    const pointer = parseClaimsPointer(object.message);
    assert.equal(pointer.versionedTag, second.activatedTag);
    assert.equal(pointer.previousVersionedTag, first.activatedTag);
    assert.equal(pointer.stableRef, CLAIMS_STABLE_REF);
    const artifact = await store.fetchAssetByTag(second.activatedTag!, CLAIMS_ARTIFACT_ASSET_NAME);
    assert.equal(claimsSha256Hex(artifact), pointer.artifact.sha256);
  });

  test("successful rollback when the publication still owns the reference (restores previous pointer)", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const f1 = buildFixture();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f1, 1_800_000_000_000, COMMIT_1) });

    // Second publication: the versioned artifact is corrupted ONLY on the
    // POST-activation download (2nd) — a failure AFTER activation while
    // the run still owns the ref.
    const secondTag = claimsVersionedTag(1_800_000_060_000, COMMIT_2);
    corruptArtifactOnNthDownload(srv, secondTag, 2);

    const f2 = buildFixture();
    await assert.rejects(
      runClaimsPublicationSequence({ store, input: publicationInput(f2, 1_800_000_060_000, COMMIT_2) }),
      (e: unknown) => {
        assert.ok(e instanceof ClaimsRollbackOutcomeError, `expected ClaimsRollbackOutcomeError, got ${String(e)}`);
        assert.equal(e.rollbackOutcome, "restored");
        assert.ok(e.rollbackAudit.length >= 2);
        assert.ok(e.message.includes("rollback RESTORED the previous known-good pointer"));
        return true;
      },
    );
    // The previous known-good pointer serves again.
    const refSha = (await store.stableRefSha())!;
    const restored = parseClaimsPointer((await store.fetchTagObject(refSha)).message);
    assert.equal(restored.versionedTag, first.activatedTag);
  });

  test("first-publication rollback: ownership-verified DELETE, absence verified by re-read", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const f = buildFixture();
    // The versioned artifact is corrupted ONLY on the POST-activation
    // download (2nd) of the FIRST publication → failure after activation,
    // previous = null → first-publication rollback.
    corruptArtifactOnNthDownload(srv, claimsVersionedTag(1_800_000_000_000, COMMIT_1), 2);

    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f, 1_800_000_000_000, COMMIT_1) }).then(
      () => null,
      (e: unknown) => {
        assert.ok(e instanceof ClaimsRollbackOutcomeError);
        assert.equal(e.rollbackOutcome, "first-publication-removed");
        return null;
      },
    );
    assert.equal(first, null, "the corrupted first publication failed and rolled back");
    // The ref is GONE — and exactly ONE ownership-verified DELETE happened.
    assert.equal(await stableRefShaDirect(srv), null);
    const deletes = destructiveRefRequests(srv).filter((r) => r.method === "DELETE");
    assert.equal(deletes.length, 1, "exactly one DELETE");
    // The versioned release (immutable identity) SURVIVES the ref rollback.
    assert.ok([...srv.releases.keys()].length === 1);
  });

  test("another writer CREATING the reference after the initial absence check → no destructive action, UNVERIFIED", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const foreignSha = srv.mintSha();
    // Deterministic interleaving: the rollback's ownership gate reads the
    // ref as absent (GET #1); a foreign writer CREATES the ref; the
    // absence re-check (GET #2) observes it → no destructive action.
    srv.on({
      method: "GET",
      pathname: REF_PATH,
      once: true,
      minInvocation: 2,
      fn: (s) => {
        s.refs.set(`tags/${CLAIMS_STABLE_REF}`, foreignSha);
      },
    });
    const destructiveBefore = destructiveRefRequests(srv).length;
    const audit: RollbackAuditEvent[] = [];
    const outcome = await rollbackClaimsStableReference({
      store,
      previous: null,
      activatedTag: claimsVersionedTag(1_800_000_000_000, COMMIT_1),
      activatedTagObjectSha: "<never-activated>",
      audit,
    });
    assert.equal(outcome, "unverified");
    assert.equal(destructiveRefRequests(srv).length, destructiveBefore, "NO destructive call was issued");
    assert.equal(await stableRefShaDirect(srv), foreignSha, "the foreign reference is untouched");
    assert.ok(audit.some((e) => e.detail.includes("no destructive action")));
  });

  test("another writer REPLACING the reference after the ownership check (probe→PATCH window): the clobber is REAL and CANNOT be prevented — documented residual race", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const f1 = buildFixture();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f1, 1_800_000_000_000, COMMIT_1) });
    const foreignSha = srv.mintSha();
    srv.tagObjects.set(foreignSha, { message: JSON.stringify({ foreign: true }), commitSha: COMMIT_1 });

    // Deterministic interleaving: the ownership probe returns the expected
    // sha; a foreign writer REPLACES the ref; the forced PATCH then lands.
    srv.on({
      method: "PATCH",
      pathname: REFS_PATH,
      once: true,
      fn: (s) => {
        s.refs.set(`tags/${CLAIMS_STABLE_REF}`, foreignSha);
      },
    });
    const ourSha = await store.createTagObject({ message: "attempt-2", commitSha: COMMIT_1 });
    const firstSha = (await store.stableRefSha())!;
    await store.updateStableRef(ourSha, { expectCurrentSha: firstSha });
    // HONEST ASSERTION (I-05 residual boundary): the foreign write was
    // OVERWRITTEN. The GitHub REST API has no conditional write, so this
    // clobber cannot be prevented by the adapter; it is mitigated
    // operationally (tag protection rules + workflow concurrency group)
    // and documented in docs/CLAIMS_PUBLICATION.md. This test exists to
    // PROVE the implementation does not claim atomicity it does not have.
    assert.equal(await stableRefShaDirect(srv), ourSha);
    assert.notEqual(await stableRefShaDirect(srv), foreignSha, "the foreign write was clobbered — the race is real, not eliminated");
  });

  test("another writer acting between the rollback write and the read-back → DETECTED, TERMINAL UNVERIFIED, no further destructive action", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const f1 = buildFixture();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f1, 1_800_000_000_000, COMMIT_1) });
    const previousTagObjectSha = (await store.stableRefSha())!;
    const previous = {
      versionedTag: first.activatedTag!,
      tagObjectSha: previousTagObjectSha,
      pointer: parseClaimsPointer((await store.fetchTagObject(previousTagObjectSha)).message),
    };

    // A second attempt activated a (bad) pointer; the rollback must
    // restore the first one.
    const badSha = await store.createTagObject({ message: JSON.stringify({ broken: true }), commitSha: COMMIT_2 });
    await store.updateStableRef(badSha, { expectCurrentSha: previousTagObjectSha });

    // Foreign write lands BETWEEN the rollback's restore PATCH and the
    // adapter's post-write read-back → detected; rollback aborts.
    const foreignSha = srv.mintSha();
    let armed = false;
    interceptHandle(srv, (url, method, s) => {
      if (method === "PATCH" && url.pathname === REFS_PATH) armed = true;
      if (method === "GET" && url.pathname === REF_PATH && armed) {
        armed = false;
        s.refs.set(`tags/${CLAIMS_STABLE_REF}`, foreignSha);
      }
      return undefined;
    });

    const audit: RollbackAuditEvent[] = [];
    await assert.rejects(
      rollbackClaimsStableReference({ store, previous, activatedTag: "t", activatedTagObjectSha: badSha, audit }),
      (e: unknown) => e instanceof GitHubStoreError && /read-back/.test(e.message),
    );
    assert.equal(await stableRefShaDirect(srv), foreignSha, "the foreign write SURVIVES — detection prevented any further destructive action");
  });

  test("a reference whose target does not match the activated tag-object SHA → foreign-reference-untouched, ZERO destructive calls", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const f1 = buildFixture();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f1, 1_800_000_000_000, COMMIT_1) });
    const prevSha = (await store.stableRefSha())!;
    const previous = {
      versionedTag: first.activatedTag!,
      tagObjectSha: prevSha,
      pointer: parseClaimsPointer((await store.fetchTagObject(prevSha)).message),
    };
    // The ref now names a FOREIGN object (not the attempt's activation,
    // not the previous pointer).
    const foreignSha = srv.mintSha();
    srv.refs.set(`tags/${CLAIMS_STABLE_REF}`, foreignSha);
    srv.tagObjects.set(foreignSha, { message: JSON.stringify({ someone: "else" }), commitSha: COMMIT_1 });

    const audit: RollbackAuditEvent[] = [];
    const destructiveBefore = destructiveRefRequests(srv).length;
    const outcome = await rollbackClaimsStableReference({
      store,
      previous,
      activatedTag: "claims-artifact-prod-t",
      activatedTagObjectSha: "0".repeat(40),
      audit,
    });
    assert.equal(outcome, "foreign-reference-untouched");
    assert.equal(destructiveRefRequests(srv).length, destructiveBefore, "ZERO destructive calls against a foreign reference");
    assert.equal(await stableRefShaDirect(srv), foreignSha, "the foreign pointer is preserved");
    assert.ok(audit.some((e) => e.at === "ownership-gate-refusal"));
  });

  test("GitHub API failure during rollback → the ref is left untouched (no partial state)", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const f = buildFixture();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f, 1_800_000_000_000, COMMIT_1) });
    const activatedSha = (await store.stableRefSha())!;
    srv.on({ method: "DELETE", pathname: REFS_PATH, once: true, fn: () => 500 });

    const audit: RollbackAuditEvent[] = [];
    await assert.rejects(
      rollbackClaimsStableReference({
        store,
        previous: null,
        activatedTag: first.activatedTag!,
        activatedTagObjectSha: activatedSha,
        audit,
      }),
      (e: unknown) => e instanceof GitHubStoreError && /got 500/.test(e.message),
    );
    assert.equal(await stableRefShaDirect(srv), activatedSha, "the failed DELETE left the ref untouched — no partial state");
  });

  test("uncertain ownership (ref absent while a previous pointer is known) → no destructive action, UNVERIFIED", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const f1 = buildFixture();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f1, 1_800_000_000_000, COMMIT_1) });
    const prevSha = (await store.stableRefSha())!;
    const previous = {
      versionedTag: first.activatedTag!,
      tagObjectSha: prevSha,
      pointer: parseClaimsPointer((await store.fetchTagObject(prevSha)).message),
    };
    // An external writer DELETED the ref.
    srv.refs.delete(`tags/${CLAIMS_STABLE_REF}`);
    const destructiveBefore = destructiveRefRequests(srv).length;
    const audit: RollbackAuditEvent[] = [];
    const outcome = await rollbackClaimsStableReference({
      store,
      previous,
      activatedTag: "t",
      activatedTagObjectSha: "0".repeat(40),
      audit,
    });
    assert.equal(outcome, "unverified");
    assert.equal(destructiveRefRequests(srv).length, destructiveBefore, "no writes against an ownership-uncertain state");
    assert.ok(audit.some((e) => e.detail.includes("ownership of the absence cannot be established")));
  });

  test("terminal UNVERIFIED state is RECORDED: structured outcome + full audit trail on the thrown error", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const f = buildFixture();
    // Post-activation failure (corrupted stable artifact read on the 2nd
    // download)...
    corruptArtifactOnNthDownload(srv, claimsVersionedTag(1_800_000_000_000, COMMIT_1), 2);
    // ...whose rollback's DELETE answers HTTP 503.
    srv.on({ method: "DELETE", pathname: REFS_PATH, once: true, fn: () => 503 });

    await assert.rejects(
      runClaimsPublicationSequence({ store, input: publicationInput(f, 1_800_000_000_000, COMMIT_1) }),
      (e: unknown) => {
        assert.ok(e instanceof ClaimsRollbackOutcomeError, `expected ClaimsRollbackOutcomeError, got ${String(e)}`);
        assert.equal(e.name, "ClaimsRollbackOutcomeError");
        assert.equal(e.rollbackOutcome, "unverified");
        assert.ok(e.rollbackAudit.length >= 2, "the audit trail is attached");
        assert.ok(e.rollbackAudit.some((ev) => ev.at === "post-activation-failure"));
        assert.ok(e.rollbackAudit.some((ev) => ev.at === "rollback-attempt-failed"));
        assert.ok(e.message.includes("TERMINAL UNVERIFIED STATE"));
        return true;
      },
    );
    const after = await stableRefShaDirect(srv);
    assert.ok(after !== null, "the ref still names the failed attempt (rollback never landed) — a manual inspection is required");
  });

  // ── adapter-level unit semantics (real REST status codes) ──

  test("adapter: ref move REFUSED when the live sha does not match expectCurrentSha (no PATCH issued)", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const sha = await store.createTagObject({ message: "p", commitSha: COMMIT_1 });
    srv.refs.set(`tags/${CLAIMS_STABLE_REF}`, "1".repeat(40)); // foreign
    await assert.rejects(
      store.updateStableRef(sha, { expectCurrentSha: "2".repeat(40) }),
      (e: unknown) => e instanceof GitHubStoreError && /moved concurrently|refusing non-atomic overwrite/.test(e.message),
    );
    assert.equal(destructiveRefRequests(srv).length, 0, "no PATCH was issued");
    assert.equal(await stableRefShaDirect(srv), "1".repeat(40));
  });

  test("adapter: first-publication create-race — a concurrent creator wins and POST /git/refs answers 422 (insert-if-absent)", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const foreignSha = srv.mintSha();
    // The foreign writer creates the ref AFTER the absence probe, BEFORE
    // the POST /git/refs lands → the real API answers 422.
    srv.on({
      method: "POST",
      pathname: CREATE_REFS_PATH,
      once: true,
      fn: (s) => {
        s.refs.set(`tags/${CLAIMS_STABLE_REF}`, foreignSha);
      },
    });
    const sha = await store.createTagObject({ message: "p", commitSha: COMMIT_1 });
    await assert.rejects(
      store.updateStableRef(sha, { expectCurrentSha: null }),
      (e: unknown) => e instanceof GitHubStoreError && /expected 201.*got 422/.test(e.message),
    );
    assert.equal(await stableRefShaDirect(srv), foreignSha, "the concurrent creator's ref is never overwritten");
  });

  test("adapter: delete REFUSED when the live sha does not match expectCurrentSha (no DELETE issued)", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    srv.refs.set(`tags/${CLAIMS_STABLE_REF}`, "3".repeat(40));
    await assert.rejects(
      store.deleteStableRef({ expectCurrentSha: "4".repeat(40) }),
      (e: unknown) => e instanceof GitHubStoreError && /deletion refused/.test(e.message),
    );
    assert.equal(destructiveRefRequests(srv).filter((r) => r.method === "DELETE").length, 0);
    assert.equal(await stableRefShaDirect(srv), "3".repeat(40));
  });

  test("adapter: delete of an ALREADY-ABSENT ref is a verified no-op (404 — no DELETE request)", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    await store.deleteStableRef({ expectCurrentSha: null });
    assert.equal(srv.log.filter((r) => r.method === "DELETE").length, 0, "no DELETE issued for an absent ref");
  });

  test("adapter: post-DELETE read-back catches a foreign writer recreating the ref (write→read-back window)", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const sha = srv.mintSha();
    srv.refs.set(`tags/${CLAIMS_STABLE_REF}`, sha);
    let armed = false;
    interceptHandle(srv, (url, method, s) => {
      if (method === "DELETE" && url.pathname === REFS_PATH) armed = true;
      if (method === "GET" && url.pathname === REF_PATH && armed) {
        armed = false;
        s.refs.set(`tags/${CLAIMS_STABLE_REF}`, s.mintSha());
      }
      return undefined;
    });
    await assert.rejects(
      store.deleteStableRef({ expectCurrentSha: sha }),
      (e: unknown) => e instanceof GitHubStoreError && /post-delete read-back/.test(e.message),
    );
    assert.notEqual(await stableRefShaDirect(srv), null, "the foreign re-creation survives");
  });

  test("adapter: successful move is verified by post-write read-back (clean window)", async () => {
    const srv = new MockGitHubServer();
    const store = newStore(srv);
    const sha = await store.createTagObject({ message: "p", commitSha: COMMIT_1 });
    await store.updateStableRef(sha, { expectCurrentSha: null });
    assert.equal(await stableRefShaDirect(srv), sha);
    const sha2 = await store.createTagObject({ message: "p2", commitSha: COMMIT_1 });
    await store.updateStableRef(sha2, { expectCurrentSha: sha });
    assert.equal(await stableRefShaDirect(srv), sha2);
  });
});

