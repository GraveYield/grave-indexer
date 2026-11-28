// SPDX-License-Identifier: Apache-2.0
//
// I-06 + P125-01 regression battery: real D3→D4 producer-run handoff
// (src/claimsProducerHandoff.ts + claimsPublishCli.ts), exercised at the
// HTTP level against a controlled mock of the GitHub Actions API. NO
// network, NO production dispatch, NO publication side effect.
//
// P125-01 scenarios (trusted producer identity) run through the REAL
// handoff entry point `fetchVerifiedClaimsArtifact` — the same function
// the publication workflow's pre-flight invokes — so the trust boundary
// is tested where production enforces it, not against an isolated helper.
//
// API-FIDELITY NOTE: the run fixture below uses the REAL GitHub
// workflow-run response shape, including the authoritative
// `path: "<file>@<ref>"` representation (e.g.
// `.github/workflows/claims-snapshot.yml@refs/heads/main`) and the
// artifact record's `workflow_run` run binding — not simplified
// no-suffix fixtures. Registry records are served from the NUMERIC
// workflow-id endpoint (`/actions/workflows/{id}`), exactly what the
// handoff calls.
//
// Honest scope note: the producer-side upload (the graveyield-protocol
// claims-snapshot.yml workflow that runs grave-snapshotter-cli and uploads
// claims-artifact.json as a run artifact) exists since protocol PR #125,
// but has NEVER been dispatched — no genuine producer artifact exists yet.
// These tests prove the consumer-side handoff machinery and its fail-closed
// behavior; they do NOT prove live GitHub publication works.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";
import { SnapshotMerkleTree } from "@graveyield/sdk";
import { UNCX_RAYDIUM_AMM_V4_LOCKER_PROGRAM_ID } from "../src/claimsArtifact.js";
import {
  CLAIMS_PRODUCER_ARTIFACT_NAME,
  ClaimsProducerHandoffError,
  TRUSTED_CLAIMS_PRODUCER_REPO,
  TRUSTED_CLAIMS_PRODUCER_BRANCH,
  TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH,
  TRUSTED_CLAIMS_PRODUCER_WORKFLOW_NAME,
  fetchVerifiedClaimsArtifact,
  parseProducerRunId,
  parseWorkflowRunPath,
  publishVerifiedProducerArtifact,
  readZipEntry,
  type ClaimsProducerExpectations,
} from "../src/claimsProducerHandoff.js";

// ── fixture helpers (self-contained, mirrors claimsReview.test.ts) ──

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

function validArtifactText(mutate?: (a: Record<string, unknown>) => void): string {
  const holders = [
    { owner: key(0x10), balance: 4_000n },
    { owner: key(0x20), balance: 2_000n },
  ].sort((a, b) => {
    const ab = a.owner.toBytes(), bb = b.owner.toBytes();
    for (let i = 0; i < 32; i++) if (ab[i] !== bb[i]) return (ab[i] ?? 0) - (bb[i] ?? 0);
    return 0;
  });
  const tree = SnapshotMerkleTree.fromEntries(holders.map((h) => ({ owner: h.owner, lpBalance: h.balance })));
  const slot = 123;
  const ledger = Buffer.from(JSON.stringify({
    schema_version: 1, ledger_id: "L1", pool_address: POOL.toBase58(), amm_program_id: AMM.toBase58(), lp_mint: MINT.toBase58(), entries: [],
  }) + "\n");
  const artifact: Record<string, unknown> = {
    format_version: 2,
    pool_address: POOL.toBase58(),
    amm_program_id: AMM.toBase58(),
    lp_mint: MINT.toBase58(),
    snapshot_slot: slot,
    lp_total_supply_at_snapshot: 6000,
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
      lock_evidence: { source: "rpc", program_id: UNCX_RAYDIUM_AMM_V4_LOCKER_PROGRAM_ID, commitment: "confirmed", anchor_slot: slot, records_seen: 0, total_locked: 0 },
    },
  };
  mutate?.(artifact);
  return JSON.stringify(artifact);
}

const COMMIT = "a".repeat(40);
const RUN_ID = 42;
const WORKFLOW_NAME = TRUSTED_CLAIMS_PRODUCER_WORKFLOW_NAME; // "grave-snapshotter-cli"
const WORKFLOW_ID = 433_697_378; // the REAL registry id of claims-snapshot.yml (verified live 2026-11-28)
const REPO = TRUSTED_CLAIMS_PRODUCER_REPO; // "GraveYield/graveyield-protocol"
const BRANCH = TRUSTED_CLAIMS_PRODUCER_BRANCH; // "main"
const WORKFLOW_PATH = TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH; // ".github/workflows/claims-snapshot.yml"

function expectations(overrides?: Partial<ClaimsProducerExpectations>): ClaimsProducerExpectations {
  return {
    producerRepo: REPO,
    producerRunId: RUN_ID,
    producerWorkflowName: WORKFLOW_NAME,
    artifactName: CLAIMS_PRODUCER_ARTIFACT_NAME,
    sourceCommit: COMMIT,
    producerIdentity: "grave-snapshotter-cli",
    expectedPool: POOL.toBase58(),
    ...overrides,
  };
}

// ── minimal ZIP writer (stored entries) for the mock ──

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]!;
    for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    c >>>= 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries: Array<{ name: string; data: Uint8Array }>, opts?: { zeroCrc?: boolean }): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = encoder.encode(e.name);
    const crc = opts?.zeroCrc ? 0 : crc32(e.data);
    const local = new Uint8Array(30 + name.length + e.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(e.data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true); // stored
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdStart = offset;
  const cdLen = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, cdStart, true);
  const total = cdStart + cdLen + 22;
  const zip = new Uint8Array(total);
  let off = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    zip.set(part, off);
    off += part.length;
  }
  return zip;
}

// ── controlled mock of the Actions API (registry + runs + artifacts) ──

/** The GitHub-authoritative run record the mock serves by default (real API shape). */
function trustedRunRecord(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    // Real workflow-run response fields (subset, API-faithful):
    id: RUN_ID,
    node_id: "WFR_kw_mock",
    name: WORKFLOW_NAME, // display name — NOT identity; informational only
    head_branch: BRANCH,
    head_sha: COMMIT,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    workflow_id: WORKFLOW_ID,
    // The REAL API path representation: <file>@<ref>.
    path: `${WORKFLOW_PATH}@refs/heads/${BRANCH}`,
    run_number: 1,
    run_attempt: 1,
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    ...overrides,
  };
}

/** The GitHub-authoritative workflow-registry record for the trusted workflow. */
function trustedWorkflowRecord(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: WORKFLOW_ID,
    node_id: "WF_kw_mock",
    name: WORKFLOW_NAME,
    path: WORKFLOW_PATH, // registry records carry the PLAIN path (no @ref)
    state: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    url: `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_ID}`,
    ...overrides,
  };
}

/** The GitHub-authoritative artifact record with its run binding. */
function trustedArtifactRecord(zipLen: number, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 9001,
    node_id: "ART_kw_mock",
    name: CLAIMS_PRODUCER_ARTIFACT_NAME,
    expired: false,
    size_in_bytes: zipLen,
    archive_download_url: `https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/artifacts/9001/zip`,
    // Real artifact records carry this GitHub-authoritative run binding:
    workflow_run: { id: RUN_ID, head_sha: COMMIT, head_branch: BRANCH, workflow_id: WORKFLOW_ID },
    ...overrides,
  };
}

function mockGithub(opts?: {
  workflow?: Record<string, unknown> | null;
  workflowStatus?: number;
  run?: Record<string, unknown> | null;
  runStatus?: number;
  artifacts?: Array<Record<string, unknown>> | null;
  artifactsStatus?: number;
  zip?: Uint8Array;
  zipStatus?: number;
  redirect?: boolean;
}): { fetchImpl: typeof fetch; requests: Array<{ method: string; path: string }> } {
  const requests: Array<{ method: string; path: string }> = [];
  const zip = opts?.zip ?? buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
  const workflowRecord = opts?.workflow === null
    ? null
    : (opts?.workflow ?? trustedWorkflowRecord());
  const runRecord = opts?.run === null
    ? null
    : (opts?.run ?? trustedRunRecord());
  const artifacts = opts?.artifacts === null
    ? []
    : (opts?.artifacts ?? [trustedArtifactRecord(zip.length)]);
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace(/^https:\/\/[^/]+/, "");
    requests.push({ method, path });
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    if (!path.startsWith("/claims-artifact-zip") && (auth === undefined || !auth.startsWith("Bearer "))) {
      return new Response(JSON.stringify({ message: "unauthenticated" }), { status: 401 });
    }
    // Workflow registry endpoint — resolved by NUMERIC workflow id, exactly
    // as the handoff calls it (never by the full workflow path).
    const wfMatch = new RegExp(`^/repos/${REPO}/actions/workflows/(\\d+)$`).exec(path);
    if (wfMatch !== null) {
      if (opts?.workflowStatus) return new Response(null, { status: opts.workflowStatus });
      if (workflowRecord === null) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(workflowRecord), { status: 200 });
    }
    if (path === `/repos/${REPO}/actions/runs/${RUN_ID}`) {
      if (opts?.runStatus) return new Response(null, { status: opts.runStatus });
      if (runRecord === null) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(runRecord), { status: 200 });
    }
    if (path === `/repos/${REPO}/actions/runs/${RUN_ID}/artifacts?per_page=100`) {
      if (opts?.artifactsStatus) return new Response(null, { status: opts.artifactsStatus });
      return new Response(JSON.stringify({ total_count: artifacts.length, artifacts }), { status: 200 });
    }
    if (path === `/repos/${REPO}/actions/runs/${RUN_ID}/artifacts/9001/zip`) {
      if (opts?.zipStatus) return new Response(null, { status: opts.zipStatus });
      if (opts?.redirect) {
        return new Response(null, { status: 302, headers: { location: "https://blob.example/claims-artifact-zip" } });
      }
      return new Response(Buffer.from(zip), { status: 200 });
    }
    if (path === "/claims-artifact-zip" || path.startsWith("https://blob.example")) {
      return new Response(Buffer.from(zip), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function handoffArgs(): { token: string; expectations: ClaimsProducerExpectations } {
  return { token: "t".repeat(12), expectations: expectations() };
}

/** Assert no artifact zip was ever downloaded (identity failures precede download). */
function assertNoZipDownload(requests: Array<{ method: string; path: string }>, what: string): void {
  assert.ok(
    !requests.some((r) => r.path.endsWith("/zip") || r.path.startsWith("/claims-artifact-zip")),
    `${what}: the artifact zip must NOT be downloaded for an identity failure`,
  );
}

// ── tests ──

describe("I-06: producer-run handoff — input validation", () => {
  test("run id parse: decimal only, safe-integer subset, u64 overflow refused", () => {
    assert.equal(parseProducerRunId("42"), 42);
    assert.equal(parseProducerRunId("0000042"), 42);
    assert.throws(() => parseProducerRunId("-1"), /decimal run number/);
    assert.throws(() => parseProducerRunId("1e3"), /decimal run number/);
    assert.throws(() => parseProducerRunId("9007199254740993"), /safe-integer subset/); // 2^53+1
    assert.throws(() => parseProducerRunId(""), /decimal run number/);
  });
  test("negative or zero run id refused before any network call", async () => {
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ token: "t", expectations: expectations({ producerRunId: 0 }) }),
      /positive safe integer/,
    );
  });
  test("workflow-run path parse: STRICT <file>@<ref> only, no permissive matching", () => {
    // Real API representations parse cleanly.
    assert.deepEqual(parseWorkflowRunPath(".github/workflows/claims-snapshot.yml@refs/heads/main"), {
      file: ".github/workflows/claims-snapshot.yml",
      ref: "refs/heads/main",
    });
    assert.deepEqual(parseWorkflowRunPath(".github/workflows/claims-snapshot.yml@main"), {
      file: ".github/workflows/claims-snapshot.yml",
      ref: "main",
    });
    // Fixture-shaped / malformed values are rejected (fail closed).
    assert.equal(parseWorkflowRunPath(".github/workflows/claims-snapshot.yml"), null); // no @ref suffix
    assert.equal(parseWorkflowRunPath("@refs/heads/main"), null); // empty file part
    assert.equal(parseWorkflowRunPath(".github/workflows/claims-snapshot.yml@"), null); // empty ref part
    assert.equal(parseWorkflowRunPath("foo@bar@baz"), null); // two @ separators
    assert.equal(parseWorkflowRunPath(""), null);
    assert.equal(parseWorkflowRunPath(undefined), null);
    assert.equal(parseWorkflowRunPath(12345), null);
  });
});

describe("P125-01: caller-controlled trust inputs are enforced by the consumer", () => {
  test("a caller-supplied producer repo that is not the trusted repository is refused BEFORE any network call", async () => {
    let networkHits = 0;
    const fetchImpl = (async (): Promise<Response> => {
      networkHits += 1;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchVerifiedClaimsArtifact({
        token: "t",
        expectations: expectations({ producerRepo: "attacker/other-repo" }),
        fetchImpl,
      }),
      (e: ClaimsProducerHandoffError) => e.message.includes("not the trusted producer repository") && e.message.includes("P125-01"),
    );
    assert.equal(networkHits, 0, "the trusted repository is enforced locally, before any network call");
  });

  test("a caller-declared workflow name that differs from the pinned producer workflow is refused locally", async () => {
    let networkHits = 0;
    const fetchImpl = (async (): Promise<Response> => {
      networkHits += 1;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchVerifiedClaimsArtifact({
        token: "t",
        expectations: expectations({ producerWorkflowName: "attacker-workflow" }),
        fetchImpl,
      }),
      (e: ClaimsProducerHandoffError) => e.message.includes("does not match the consumer's pinned producer workflow"),
    );
    assert.equal(networkHits, 0, "the declaration check precedes every network call");
  });
});

describe("I-06: valid handoff (happy path, API-faithful fixtures)", () => {
  test("trusted main run (path @refs/heads/main) with exact SHA — accepted, identity evidence reported", async () => {
    const artifactText = validArtifactText();
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(artifactText, "utf8") }]);
    const { fetchImpl, requests } = mockGithub({ zip, redirect: true });
    const result = await fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl });
    assert.equal(result.artifactId, 9001);
    assert.equal(result.runHeadSha, COMMIT);
    assert.equal(result.artifactName, CLAIMS_PRODUCER_ARTIFACT_NAME);
    assert.equal(result.artifactZipByteLength, zip.length);
    assert.equal(
      result.artifactSha256Hex,
      createHash("sha256").update(Buffer.from(artifactText, "utf8")).digest("hex"),
    );
    assert.deepEqual(
      Buffer.from(result.bytes).toString("utf8"),
      artifactText,
      "the verified bytes are EXACTLY the producer artifact",
    );
    // P125-01: the result carries the GitHub-authoritative identity the
    // run was bound to (audit evidence).
    assert.deepEqual(result.trustedProducer, {
      repo: REPO,
      branch: BRANCH,
      workflowPath: WORKFLOW_PATH,
      workflowRef: "refs/heads/main",
      workflowId: WORKFLOW_ID,
      runId: RUN_ID,
      sourceSha: COMMIT,
    });
    // Every request was a GET (read-only handoff) and was authenticated.
    assert.ok(requests.length >= 4, "run + workflow registry + artifacts + zip were all requested");
    assert.ok(requests.every((r) => r.method === "GET"), "the handoff performs GET requests ONLY");
    assert.ok(
      requests.some((r) => r.path === `/repos/${REPO}/actions/runs/${RUN_ID}`),
      "the run was resolved from the explicit producer run id",
    );
    assert.ok(
      requests.some((r) => r.path === `/repos/${REPO}/actions/workflows/${WORKFLOW_ID}`),
      "the workflow registry record was resolved by the run's NUMERIC workflow id (P125-01)",
    );
    assert.ok(
      !requests.some((r) => /^\/repos\/[^/]+\/actions\/workflows\/\.github/.test(r.path)),
      "the workflow path is NEVER used as the REST endpoint parameter (P125-01)",
    );
  });

  test("the `@main` shorthand ref representation is also accepted (exact forms only)", async () => {
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ path: `${WORKFLOW_PATH}@main` }) });
    const result = await fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl });
    assert.equal(result.trustedProducer.workflowRef, "main");
    assert.ok(requests.some((r) => r.path.endsWith("/zip")), "the full handoff completed");
  });
});

describe("P125-01: trust-boundary rejections — every case through the REAL handoff path", () => {
  test("successful run from a feature branch → reject (GitHub head_branch is authoritative)", async () => {
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ head_branch: "feature/untrusted-branch" }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("UNTRUSTED BRANCH") && e.message.includes("feature/untrusted-branch"),
    );
    assertNoZipDownload(requests, "feature branch");
  });

  test("successful run from a fork → reject (head_repository is the fork)", async () => {
    const { fetchImpl, requests } = mockGithub({
      run: trustedRunRecord({ head_repository: { full_name: "someone-else/graveyield-protocol-fork" } }),
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("FORK/UNTRUSTED CONTEXT") && e.message.includes("someone-else/graveyield-protocol-fork"),
    );
    assertNoZipDownload(requests, "fork origin");
  });

  test("successful run from another repository → reject (run repository mismatch)", async () => {
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ repository: { full_name: "attacker/other-repo" } }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("not the trusted producer repository") && e.message.includes("attacker/other-repo"),
    );
    assertNoZipDownload(requests, "wrong run repository");
  });

  test("missing run repository identity → reject fail-closed", async () => {
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ repository: null }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its repository identity") && e.message.includes("fail closed"),
    );
    assertNoZipDownload(requests, "missing run repository");
  });

  test("missing head repository metadata → reject fail-closed", async () => {
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ head_repository: null }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its head repository identity") && e.message.includes("fail closed"),
    );
    assertNoZipDownload(requests, "missing head repository");
  });

  test("missing branch/ref metadata (no head_branch) → reject fail-closed", async () => {
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ head_branch: undefined }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its head_branch") && e.message.includes("fail closed"),
    );
    assertNoZipDownload(requests, "missing head_branch");
  });

  test("run executed by a DIFFERENT workflow file path (same display name) → reject", async () => {
    // The attacker's workflow file lives at a different path but copies
    // the `name:` — identity comes from the path/id, not the name.
    const { fetchImpl, requests } = mockGithub({
      run: trustedRunRecord({ path: `.github/workflows/claims-snapshot-lookalike.yml@refs/heads/main` }),
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WRONG WORKFLOW IDENTITY") && e.message.includes("claims-snapshot-lookalike.yml"),
    );
    assertNoZipDownload(requests, "wrong workflow file path");
  });

  test("run path with an UNTRUSTED ref (feature branch in the path) → reject", async () => {
    const { fetchImpl, requests } = mockGithub({
      run: trustedRunRecord({ path: `${WORKFLOW_PATH}@refs/heads/feature/untrusted`, head_branch: "feature/untrusted" }),
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("UNTRUSTED WORKFLOW REF") && e.message.includes("refs/heads/feature/untrusted"),
    );
    assertNoZipDownload(requests, "untrusted path ref");
  });

  test("run path WITHOUT the @ref suffix (simplified fixture shape) → reject fail-closed", async () => {
    // A no-suffix path is NOT accepted: the ref is part of the trust
    // decision, so a fixture-shaped value must not pass.
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ path: WORKFLOW_PATH }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO usable workflow path") && e.message.includes("fail closed"),
    );
    assertNoZipDownload(requests, "no-suffix path");
  });

  test("missing workflow path metadata (no path) → reject fail-closed", async () => {
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ path: undefined }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO usable workflow path") && e.message.includes("fail closed"),
    );
    assertNoZipDownload(requests, "missing path");
  });

  test("missing immutable workflow_id metadata (no workflow_id) → reject fail-closed", async () => {
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ workflow_id: undefined }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its workflow_id") && e.message.includes("fail closed"),
    );
    assertNoZipDownload(requests, "missing workflow_id");
  });

  test("run executed by a different WORKFLOW ID whose registry record matches that id (lookalike workflow) → reject", async () => {
    const { fetchImpl, requests } = mockGithub({
      run: trustedRunRecord({ workflow_id: 888, path: `.github/workflows/attacker-clone.yml@refs/heads/main` }),
      workflow: { id: 888, name: WORKFLOW_NAME, path: ".github/workflows/attacker-clone.yml", state: "active" },
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WRONG WORKFLOW IDENTITY") && e.message.includes("attacker-clone.yml"),
    );
    assertNoZipDownload(requests, "lookalike workflow id");
  });

  test("a LYING registry record (id != the requested workflow_id) → reject fail-closed", async () => {
    const { fetchImpl, requests } = mockGithub({ workflow: trustedWorkflowRecord({ id: 999_999_999 }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WORKFLOW IDENTITY MISMATCH") && e.message.includes("immutable workflow_id"),
    );
    assertNoZipDownload(requests, "lying registry id");
  });

  test("registry record with a WRONG path (registry metadata mismatch) → reject", async () => {
    const { fetchImpl, requests } = mockGithub({ workflow: trustedWorkflowRecord({ path: ".github/workflows/not-the-producer.yml" }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("does not match the pinned workflow path"),
    );
    assertNoZipDownload(requests, "registry path mismatch");
  });

  test("registry record with a WRONG name (caller expects one name, GitHub reports another) → reject", async () => {
    const { fetchImpl, requests } = mockGithub({ workflow: trustedWorkflowRecord({ name: "renamed-producer" }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WRONG WORKFLOW IDENTITY") && e.message.includes("renamed-producer"),
    );
    assertNoZipDownload(requests, "registry name mismatch");
  });

  test("registry record missing its numeric id → reject fail-closed", async () => {
    const { fetchImpl, requests } = mockGithub({ workflow: trustedWorkflowRecord({ id: undefined }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WORKFLOW IDENTITY MISMATCH") && e.message.includes("immutable workflow_id"),
    );
    assertNoZipDownload(requests, "registry missing id");
  });

  test("registry workflow not active (disabled) → reject", async () => {
    const { fetchImpl, requests } = mockGithub({ workflow: trustedWorkflowRecord({ state: "disabled_manually" }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("not active") && e.message.includes("fail closed"),
    );
    assertNoZipDownload(requests, "inactive workflow");
  });

  test("trusted workflow absent from the registry (404) → reject", async () => {
    const { fetchImpl, requests } = mockGithub({ workflow: null });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("producer workflow registry record") && e.message.includes("404"),
    );
    assertNoZipDownload(requests, "registry 404");
  });

  test("run SHA differs from the requested source SHA → reject (provenance mismatch)", async () => {
    const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord({ head_sha: "b".repeat(40) }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("provenance mismatch"),
    );
    assertNoZipDownload(requests, "commit mismatch");
  });

  test("run not completed / not successful → reject", async () => {
    for (const patch of [{ status: "in_progress", conclusion: null as unknown }, { status: "completed", conclusion: "failure" }]) {
      const { fetchImpl, requests } = mockGithub({ run: trustedRunRecord(patch) });
      await assert.rejects(
        fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
        ClaimsProducerHandoffError,
      );
      assertNoZipDownload(requests, `run ${patch.status}/${String(patch.conclusion)}`);
    }
  });

  test("wrong producer run ID (run does not exist) → reject", async () => {
    const { fetchImpl, requests } = mockGithub({ run: null });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("producer run") && e.message.includes("404"),
    );
    assertNoZipDownload(requests, "run 404");
  });
});

describe("P125-01: artifact-to-run binding and artifact safety", () => {
  test("artifact from a DIFFERENT run (workflow_run binding mismatch) → reject", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl, requests } = mockGithub({
      zip,
      artifacts: [trustedArtifactRecord(zip.length, { workflow_run: { id: 4242, head_sha: COMMIT, head_branch: BRANCH, workflow_id: WORKFLOW_ID } })],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("ARTIFACT/FROM-ANOTHER-RUN") && e.message.includes("belongs to run 4242"),
    );
    assertNoZipDownload(requests, "artifact run id mismatch");
  });

  test("artifact record missing its run binding (workflow_run) → reject fail-closed", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl, requests } = mockGithub({
      zip,
      artifacts: [trustedArtifactRecord(zip.length, { workflow_run: undefined })],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its workflow_run run binding") && e.message.includes("fail closed"),
    );
    assertNoZipDownload(requests, "missing artifact run binding");
  });

  test("artifact run binding head commit differs from the run's head commit → reject", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl, requests } = mockGithub({
      zip,
      artifacts: [trustedArtifactRecord(zip.length, { workflow_run: { id: RUN_ID, head_sha: "c".repeat(40), head_branch: BRANCH, workflow_id: WORKFLOW_ID } })],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("ARTIFACT/FROM-ANOTHER-RUN") && e.message.includes("run binding head commit"),
    );
    assertNoZipDownload(requests, "artifact head_sha mismatch");
  });

  test("artifact run binding head branch differs from the trusted branch → reject (where exposed)", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl, requests } = mockGithub({
      zip,
      artifacts: [trustedArtifactRecord(zip.length, { workflow_run: { id: RUN_ID, head_sha: COMMIT, head_branch: "feature/elsewhere", workflow_id: WORKFLOW_ID } })],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("ARTIFACT/FROM-ANOTHER-RUN") && e.message.includes("run binding branch"),
    );
    assertNoZipDownload(requests, "artifact binding branch mismatch");
  });

  test("artifact run binding workflow id differs from the validated workflow id → reject (where exposed)", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl, requests } = mockGithub({
      zip,
      artifacts: [trustedArtifactRecord(zip.length, { workflow_run: { id: RUN_ID, head_sha: COMMIT, head_branch: BRANCH, workflow_id: 888 } })],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("ARTIFACT/FROM-ANOTHER-RUN") && e.message.includes("run binding workflow id"),
    );
    assertNoZipDownload(requests, "artifact binding workflow id mismatch");
  });

  test("oversized artifact (size above the configured limit) → reject BEFORE any download", async () => {
    const oversized = 64 * 1024 * 1024 + 1; // MAX_HANDOFF_ZIP_BYTES + 1
    const { fetchImpl, requests } = mockGithub({
      artifacts: [trustedArtifactRecord(oversized)],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("exceeds the configured") && e.message.includes("BEFORE download"),
    );
    assertNoZipDownload(requests, "oversized artifact");
  });

  test("artifact listing without the claims artifact name → reject", async () => {
    const { fetchImpl } = mockGithub({ artifacts: [{ id: 1, name: "some-other-upload", expired: false, size_in_bytes: 10 }] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO artifact named") && e.message.includes("missing artifact"),
    );
  });

  test("multiple matching artifacts (ambiguous) → reject", async () => {
    const { fetchImpl } = mockGithub({
      artifacts: [trustedArtifactRecord(100, { id: 1 }), trustedArtifactRecord(100, { id: 2 })],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("AMBIGUOUS"),
    );
  });

  test("expired artifact → reject", async () => {
    const { fetchImpl } = mockGithub({ artifacts: [trustedArtifactRecord(100, { expired: true })] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("EXPIRED"),
    );
  });

  test("artifact download unavailable → reject", async () => {
    const { fetchImpl } = mockGithub({ zipStatus: 404 });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("download failed") || e.message.includes("unavailable"),
    );
  });

  test("wrong artifact identity INSIDE the zip (entry name mismatch) → reject", async () => {
    const zip = buildZip([{ name: "snapshot.json", data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl } = mockGithub({ zip });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("does not contain the expected"),
    );
  });

  test("digest/byte-length mismatch (zip bytes != producer-run record) → reject", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl } = mockGithub({
      zip,
      artifacts: [trustedArtifactRecord(zip.length + 1)],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("DIGEST/BYTE-LENGTH MISMATCH"),
    );
  });

  test("CRC32 mismatch (corrupted or tampered download) → reject", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }], { zeroCrc: true });
    const { fetchImpl } = mockGithub({ zip });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("CRC32"),
    );
    // And the low-level reader agrees.
    assert.throws(() => readZipEntry(zip, CLAIMS_PRODUCER_ARTIFACT_NAME, 1024 * 1024), /CRC32/);
  });

  test("invalid schema (artifact JSON does not match the strict claims schema) → reject", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from("{\"format_version\":2}", "utf8") }]);
    const { fetchImpl } = mockGithub({ zip, artifacts: [trustedArtifactRecord(zip.length)] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: unknown) => e instanceof Error && /schema|claims/i.test(e.message),
    );
  });

  test("invalid provenance/reconciliation (cross-field inconsistency) → reject", async () => {
    // Honest note: the claims-grade gate validates provenance structure and
    // cross-field consistency (sink ledger checks engage when explicit sink
    // exclusions exist — see claimsArtifact.ts). The ledger digest VALUE is
    // producer-attested; an internally inconsistent artifact fails closed.
    const text = validArtifactText((a) => {
      (a.reconciliation as Record<string, unknown>).enumerated_total = 5999;
    });
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(text, "utf8") }]);
    const { fetchImpl } = mockGithub({ zip, artifacts: [trustedArtifactRecord(zip.length)] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: unknown) => e instanceof Error && /reconciliation|enumerated|consisten/i.test(e.message),
    );
  });

  test("pool identity mismatch → reject", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl } = mockGithub({ zip, artifacts: [trustedArtifactRecord(zip.length)] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ token: "t".repeat(12), expectations: expectations({ expectedPool: key(0x99).toBase58() }), fetchImpl }),
      (e: unknown) => e instanceof Error && /pool/i.test(e.message),
    );
  });

  test("producer identity mismatch (unpinned identity) is rejected BEFORE any network call", async () => {
    let networkHits = 0;
    const fetchImpl = (async (): Promise<Response> => {
      networkHits += 1;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchVerifiedClaimsArtifact({
        token: "t",
        expectations: expectations({ producerIdentity: "not-the-pinned-producer" }),
        fetchImpl,
      }),
      /pinned producer identity/,
    );
    assert.equal(networkHits, 0, "local validation precedes every network call");
  });
});

describe("I-06: publish composition — invalid cases cause ZERO publication side effects", () => {
  test("publishVerifiedProducerArtifact runs the publisher ONLY after a fully verified handoff", async () => {
    let publishCalls = 0;
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);

    // Happy path: the publisher receives exactly the verified bytes.
    const good = mockGithub({ zip });
    const out = await publishVerifiedProducerArtifact({
      ...handoffArgs(),
      fetchImpl: good.fetchImpl,
      publish: async (bytes) => {
        publishCalls += 1;
        return Buffer.from(bytes).toString("utf8").length;
      },
    });
    assert.equal(publishCalls, 1);
    assert.ok(out > 0);

    // EVERY rejection case: the publisher spy is NEVER invoked, and no
    // non-GET request is ever issued (the handoff is read-only end to end).
    const cases: Array<{ label: string; mock: ReturnType<typeof mockGithub>; expectations?: ClaimsProducerExpectations }> = [
      { label: "missing artifact", mock: mockGithub({ artifacts: [{ id: 1, name: "other", expired: false, size_in_bytes: 10 }] }) },
      { label: "expired artifact", mock: mockGithub({ artifacts: [trustedArtifactRecord(10, { expired: true })] }) },
      { label: "artifact from another run", mock: mockGithub({ artifacts: [trustedArtifactRecord(zip.length, { workflow_run: { id: 777, head_sha: COMMIT, head_branch: BRANCH, workflow_id: WORKFLOW_ID } })] }) },
      { label: "oversized artifact", mock: mockGithub({ artifacts: [trustedArtifactRecord(64 * 1024 * 1024 + 1)] }) },
      { label: "unavailable download", mock: mockGithub({ zipStatus: 500 }) },
      { label: "wrong run id", mock: mockGithub({ run: null }) },
      { label: "feature branch", mock: mockGithub({ run: trustedRunRecord({ head_branch: "feature/x" }) }) },
      { label: "fork run", mock: mockGithub({ run: trustedRunRecord({ head_repository: { full_name: "evil/fork" } }) }) },
      { label: "other repo", mock: mockGithub({ run: trustedRunRecord({ repository: { full_name: "evil/other" } }) }) },
      { label: "same display name, different path", mock: mockGithub({ run: trustedRunRecord({ path: `.github/workflows/lookalike.yml@refs/heads/main` }) }) },
      { label: "untrusted path ref", mock: mockGithub({ run: trustedRunRecord({ path: `${WORKFLOW_PATH}@refs/heads/dev`, head_branch: "dev" }) }) },
      { label: "no-ref path (fixture shape)", mock: mockGithub({ run: trustedRunRecord({ path: WORKFLOW_PATH }) }) },
      { label: "different workflow id", mock: mockGithub({ run: trustedRunRecord({ workflow_id: 1_000_000 }) }) },
      { label: "untrusted workflow registry name", mock: mockGithub({ workflow: trustedWorkflowRecord({ name: "renamed-producer" }) }) },
      { label: "inactive workflow", mock: mockGithub({ workflow: trustedWorkflowRecord({ state: "disabled_inactivity" }) }) },
      { label: "registry 404", mock: mockGithub({ workflow: null }) },
      { label: "run failed", mock: mockGithub({ run: trustedRunRecord({ status: "completed", conclusion: "failure", head_sha: COMMIT }) }) },
      { label: "commit mismatch", mock: mockGithub({ run: trustedRunRecord({ head_sha: "b".repeat(40) }) }) },
      { label: "wrong zip entry", mock: mockGithub({ zip: buildZip([{ name: "snapshot.json", data: Buffer.from("{}", "utf8") }]) }) },
      { label: "byte-length mismatch", mock: mockGithub({ zip, artifacts: [trustedArtifactRecord(zip.length + 7)] }) },
      { label: "invalid schema", mock: mockGithub({ zip: buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from("{}", "utf8") }]) }) },
      { label: "foreign caller repo (local refusal)", mock: mockGithub(), expectations: expectations({ producerRepo: "attacker/evil" }) },
    ];
    for (const c of cases) {
      publishCalls = 0;
      await assert.rejects(
        publishVerifiedProducerArtifact({
          token: "t".repeat(12),
          expectations: c.expectations ?? expectations(),
          fetchImpl: c.mock.fetchImpl,
          publish: async () => {
            publishCalls += 1;
            return true;
          },
        }),
        Error,
        `case must fail closed: ${c.label}`,
      );
      assert.equal(publishCalls, 0, `ZERO publication side effects for: ${c.label}`);
      assert.ok(
        c.mock.requests.every((r) => r.method === "GET"),
        `handoff for ${c.label} performed GET requests only (no release/tag/ref writes)`,
      );
    }
  });
});
