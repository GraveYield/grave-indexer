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
// Honest scope note: the PRODUCER-side upload (a graveyield-protocol
// workflow that runs grave-snapshotter-cli and uploads claims-artifact.json
// as a run artifact) is being added by protocol PR #125 — see
// docs/CLAIMS_PUBLICATION.md. These tests prove the consumer-side handoff
// machinery and its fail-closed behavior; they do NOT prove live GitHub
// publication works.

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
const WORKFLOW_ID = 100500;
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

/** The GitHub-authoritative run record the mock serves by default. */
function trustedRunRecord(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: WORKFLOW_NAME, // display name — NOT identity; informational only
    status: "completed",
    conclusion: "success",
    head_sha: COMMIT,
    head_branch: BRANCH,
    workflow_id: WORKFLOW_ID,
    path: WORKFLOW_PATH,
    head_repository: { full_name: REPO },
    repository: { full_name: REPO },
    ...overrides,
  };
}

/** The GitHub-authoritative workflow-registry record for the trusted path. */
function trustedWorkflowRecord(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: WORKFLOW_ID,
    name: WORKFLOW_NAME,
    path: WORKFLOW_PATH,
    state: "active",
    ...overrides,
  };
}

function trustedArtifactRecord(zipLen: number, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 9001,
    name: CLAIMS_PRODUCER_ARTIFACT_NAME,
    expired: false,
    size_in_bytes: zipLen,
    workflow_run: { id: RUN_ID, head_sha: COMMIT },
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
    // Workflow registry endpoint (resolved by the trusted workflow path).
    if (path === `/repos/${REPO}/actions/workflows/${WORKFLOW_PATH}`) {
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
      (e: ClaimsProducerHandoffError) => e.message.includes("not the trusted producer repository"),
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

describe("I-06: valid handoff (happy path)", () => {
  test("trusted main run with expected workflow identity and exact SHA — accepted, identity reported", async () => {
    const artifactText = validArtifactText();
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(artifactText, "utf8") }]);
    const { fetchImpl, requests } = mockGithub({ zip, redirect: true });
    const result = await fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl });
    assert.equal(result.artifactId, 9001);
    assert.equal(result.runHeadSha, COMMIT);
    assert.equal(result.artifactName, CLAIMS_PRODUCER_ARTIFACT_NAME);
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
      workflowId: WORKFLOW_ID,
    });
    // Every request was a GET (read-only handoff) and was authenticated.
    assert.ok(requests.length >= 4, "workflow registry + run + artifacts + zip were all requested");
    assert.ok(requests.every((r) => r.method === "GET"), "the handoff performs GET requests ONLY");
    assert.ok(
      requests.some((r) => r.path === `/repos/${REPO}/actions/workflows/${WORKFLOW_PATH}`),
      "the trusted workflow was resolved from the trusted repository's registry by PATH",
    );
    assert.ok(
      requests.some((r) => r.path === `/repos/${REPO}/actions/runs/${RUN_ID}`),
      "the run was resolved from the explicit producer run id",
    );
    assert.ok(
      !requests.some((r) => r.path.startsWith(`/repos/${REPO}/actions/workflows/`) && !r.path.includes(WORKFLOW_PATH)),
      "no workflow other than the trusted path was ever queried",
    );
  });
});

describe("P125-01: trust-boundary rejections — every case through the REAL handoff path", () => {
  test("successful run from a feature branch → reject (GitHub head_branch is authoritative)", async () => {
    const { fetchImpl } = mockGithub({ run: trustedRunRecord({ head_branch: "feature/untrusted-branch" }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("not the trusted producer branch"),
    );
  });

  test("caller claims main but the API reports another branch → reject", async () => {
    // The caller has no branch argument at all — the consumer pins "main".
    // This is the same authoritative comparison from the caller's view:
    // whatever the caller intends, GitHub's head_branch wins.
    const { fetchImpl } = mockGithub({ run: trustedRunRecord({ head_branch: "release-candidate" }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("not the trusted producer branch"),
    );
  });

  test("successful run from a fork → reject (head_repository is the fork)", async () => {
    const { fetchImpl } = mockGithub({
      run: trustedRunRecord({ head_repository: { full_name: "someone-else/graveyield-protocol-fork" } }),
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("FORK/UNTRUSTED CONTEXT"),
    );
  });

  test("successful run from another repository → reject (run repository mismatch)", async () => {
    const { fetchImpl } = mockGithub({ run: trustedRunRecord({ repository: { full_name: "attacker/other-repo" } }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("not the trusted producer repository"),
    );
  });

  test("different workflow path with the SAME display name → reject (run path mismatch)", async () => {
    // The attacker's workflow file lives at a different path but copies
    // the `name:` — identity comes from the path/id, not the name.
    const { fetchImpl } = mockGithub({
      run: trustedRunRecord({ path: ".github/workflows/claims-snapshot-lookalike.yml" }),
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WRONG WORKFLOW IDENTITY") && e.message.includes("workflow path"),
    );
  });

  test("registry path does not match the pinned path → reject", async () => {
    const { fetchImpl } = mockGithub({
      workflow: trustedWorkflowRecord({ path: ".github/workflows/not-the-producer.yml" }),
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("does not match the pinned workflow path"),
    );
  });

  test("different workflow ID (run executed by another workflow definition) → reject", async () => {
    const { fetchImpl } = mockGithub({ run: trustedRunRecord({ workflow_id: 999_999 }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("DIFFERENT WORKFLOW ID"),
    );
  });

  test("registry workflow not active (disabled/deleted) → reject", async () => {
    const { fetchImpl } = mockGithub({ workflow: trustedWorkflowRecord({ state: "disabled_manually" }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("is not active"),
    );
  });

  test("trusted workflow absent from the trusted repository's registry → reject", async () => {
    const { fetchImpl } = mockGithub({ workflow: null });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("trusted producer workflow") && e.message.includes("404"),
    );
  });

  test("caller supplies expected workflow name but GitHub reports another workflow name → reject", async () => {
    const { fetchImpl } = mockGithub({ workflow: trustedWorkflowRecord({ name: "renamed-producer" }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WRONG WORKFLOW IDENTITY"),
    );
  });

  test("run SHA differs from the requested source SHA → reject (provenance mismatch)", async () => {
    const { fetchImpl } = mockGithub({ run: trustedRunRecord({ head_sha: "b".repeat(40) }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("provenance mismatch"),
    );
  });

  test("missing branch/ref metadata (no head_branch) → reject fail-closed", async () => {
    const { fetchImpl } = mockGithub({ run: trustedRunRecord({ head_branch: undefined }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its head_branch"),
    );
  });

  test("missing head repository metadata → reject fail-closed", async () => {
    const { fetchImpl } = mockGithub({ run: trustedRunRecord({ head_repository: null }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its head repository identity"),
    );
  });

  test("missing workflow identity metadata (no workflow_id) → reject fail-closed", async () => {
    const { fetchImpl } = mockGithub({ run: trustedRunRecord({ workflow_id: undefined }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its workflow_id"),
    );
  });

  test("missing workflow identity metadata (no run path) → reject fail-closed", async () => {
    const { fetchImpl } = mockGithub({ run: trustedRunRecord({ path: undefined }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its workflow path"),
    );
  });

  test("registry record missing its numeric workflow id → reject fail-closed", async () => {
    const { fetchImpl } = mockGithub({ workflow: trustedWorkflowRecord({ id: undefined }) });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("no usable numeric workflow id"),
    );
  });

  test("artifact from a DIFFERENT run (workflow_run binding mismatch) → reject", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl } = mockGithub({
      zip,
      artifacts: [trustedArtifactRecord(zip.length, { workflow_run: { id: 4242, head_sha: COMMIT } })],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("ARTIFACT/FROM-ANOTHER-RUN") && e.message.includes("belongs to run 4242"),
    );
  });

  test("artifact record missing its run binding (workflow_run) → reject fail-closed", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl } = mockGithub({
      zip,
      artifacts: [trustedArtifactRecord(zip.length, { workflow_run: undefined })],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("missing its workflow_run run binding"),
    );
  });

  test("artifact run binding head commit differs from the run's head commit → reject", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl } = mockGithub({
      zip,
      artifacts: [trustedArtifactRecord(zip.length, { workflow_run: { id: RUN_ID, head_sha: "c".repeat(40) } })],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("ARTIFACT/FROM-ANOTHER-RUN") && e.message.includes("run binding head commit"),
    );
  });

  test("oversized artifact (size above the configured limit) → reject before any download", async () => {
    const oversized = 64 * 1024 * 1024 + 1; // MAX_HANDOFF_ZIP_BYTES + 1
    const { fetchImpl } = mockGithub({
      artifacts: [trustedArtifactRecord(oversized)],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("exceeds the configured") && e.message.includes("artifact size limit"),
    );
  });

  test("artifact listing without the claims artifact name → reject", async () => {
    const { fetchImpl } = mockGithub({ artifacts: [{ id: 1, name: "some-other-upload", expired: false, size_in_bytes: 10 }] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO artifact named"),
    );
  });

  test("multiple matching artifacts (ambiguous) → reject", async () => {
    const { fetchImpl } = mockGithub({
      artifacts: [
        trustedArtifactRecord(100, { id: 1 }),
        trustedArtifactRecord(100, { id: 2 }),
      ],
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

  test("run not completed / not successful → reject", async () => {
    for (const patch of [{ status: "in_progress", conclusion: null as unknown }, { status: "completed", conclusion: "failure" }]) {
      const { fetchImpl } = mockGithub({ run: trustedRunRecord(patch) });
      await assert.rejects(
        fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
        ClaimsProducerHandoffError,
      );
    }
  });

  test("wrong producer run ID (run does not exist) → reject", async () => {
    const { fetchImpl } = mockGithub({ run: null });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("producer run") && e.message.includes("404"),
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

  test("producer identity mismatch (unpinned identity) → reject", async () => {
    const { fetchImpl } = mockGithub();
    await assert.rejects(
      fetchVerifiedClaimsArtifact({
        token: "t".repeat(12),
        expectations: expectations({ producerIdentity: "someone-elses-producer" }),
        fetchImpl,
      }),
      (e: ClaimsProducerHandoffError) => e.message.includes("pinned producer identity"),
    );
  });

  test("producer identity mismatch fires before ANY network request", async () => {
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

  test("trust-boundary rejections also fire before any network call where they can", async () => {
    // Wrong trusted repo (caller-supplied) must fail before ANY request.
    let hits = 0;
    const counting = (async (): Promise<Response> => {
      hits += 1;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ token: "t", expectations: expectations({ producerRepo: "other/repo" }), fetchImpl: counting }),
      /not the trusted producer repository/,
    );
    assert.equal(hits, 0);
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
      { label: "unavailable download", mock: mockGithub({ zipStatus: 500 }) },
      { label: "wrong run id", mock: mockGithub({ run: null }) },
      { label: "feature branch", mock: mockGithub({ run: trustedRunRecord({ head_branch: "feature/x" }) }) },
      { label: "fork run", mock: mockGithub({ run: trustedRunRecord({ head_repository: { full_name: "evil/fork" } }) }) },
      { label: "other repo", mock: mockGithub({ run: trustedRunRecord({ repository: { full_name: "evil/other" } }) }) },
      { label: "same display name, different path", mock: mockGithub({ run: trustedRunRecord({ path: ".github/workflows/lookalike.yml" }) }) },
      { label: "different workflow id", mock: mockGithub({ run: trustedRunRecord({ workflow_id: 1_000_000 }) }) },
      { label: "artifact from another run", mock: mockGithub({ artifacts: [trustedArtifactRecord(zip.length, { workflow_run: { id: 777, head_sha: COMMIT } })] }) },
      { label: "untrusted workflow registry name", mock: mockGithub({ workflow: trustedWorkflowRecord({ name: "renamed-producer" }) }) },
      { label: "run failed", mock: mockGithub({ run: trustedRunRecord({ status: "completed", conclusion: "failure", head_sha: COMMIT }) }) },
      { label: "commit mismatch", mock: mockGithub({ run: trustedRunRecord({ head_sha: "b".repeat(40) }) }) },
      { label: "wrong zip entry", mock: mockGithub({ zip: buildZip([{ name: "snapshot.json", data: Buffer.from("{}", "utf8") }]) }) },
      { label: "byte-length mismatch", mock: mockGithub({ zip, artifacts: [trustedArtifactRecord(zip.length + 7)] }) },
      { label: "invalid schema", mock: mockGithub({ zip: buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from("{}", "utf8") }]) }) },
    ];
    for (const c of cases) {
      publishCalls = 0;
      await assert.rejects(
        publishVerifiedProducerArtifact({
          token: "t".repeat(12),
          expectations: expectations(),
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
