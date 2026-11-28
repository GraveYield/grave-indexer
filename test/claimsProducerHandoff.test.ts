// SPDX-License-Identifier: Apache-2.0
//
// I-06 regression battery: real D3→D4 producer-run handoff
// (src/claimsProducerHandoff.ts + claimsPublishCli.ts), exercised at the
// HTTP level against a controlled mock of the GitHub Actions artifacts
// API. NO network, NO production dispatch, NO publication side effect.
//
// Honest scope note: the PRODUCER-side upload (a graveyield-protocol
// workflow that runs grave-snapshotter-cli and uploads claims-artifact.json
// as a run artifact) does not exist yet — see docs/CLAIMS_PUBLICATION.md.
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
  PINNED_CLAIMS_PRODUCER_REPO,
  PINNED_CLAIMS_PRODUCER_WORKFLOW_PATH,
  PINNED_TRUSTED_PRODUCER_BRANCH,
  PINNED_CLAIMS_PRODUCER_IDENTITY,
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
// P125-01: the pinned producer identity is ALSO the workflow display
// name (claims-snapshot.yml's `name:`); the handoff pins both.
const WORKFLOW_NAME = PINNED_CLAIMS_PRODUCER_IDENTITY;
const WORKFLOW_ID = 777;

function expectations(overrides?: Partial<ClaimsProducerExpectations>): ClaimsProducerExpectations {
  return {
    producerRepo: PINNED_CLAIMS_PRODUCER_REPO,
    producerRunId: RUN_ID,
    producerWorkflowName: WORKFLOW_NAME,
    producerWorkflowPath: PINNED_CLAIMS_PRODUCER_WORKFLOW_PATH,
    producerBranch: PINNED_TRUSTED_PRODUCER_BRANCH,
    artifactName: CLAIMS_PRODUCER_ARTIFACT_NAME,
    sourceCommit: COMMIT,
    producerIdentity: PINNED_CLAIMS_PRODUCER_IDENTITY,
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

// ── controlled mock of the Actions artifacts API ──

function mockGithub(opts?: {
  run?: Record<string, unknown> | null;
  runStatus?: number;
  artifacts?: Array<Record<string, unknown>>;
  artifactsStatus?: number;
  zip?: Uint8Array;
  zipStatus?: number;
  redirect?: boolean;
  /** The producer repo the mock serves routes for (default: pinned). */
  repo?: string;
  /** The workflow record behind the run's workflow_id (null = 404). */
  workflow?: Record<string, unknown> | null;
}): { fetchImpl: typeof fetch; requests: Array<{ method: string; path: string }> } {
  const requests: Array<{ method: string; path: string }> = [];
  const repo = opts?.repo ?? PINNED_CLAIMS_PRODUCER_REPO;
  const zip = opts?.zip ?? buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
  const defaultRun = {
    name: WORKFLOW_NAME,
    status: "completed",
    conclusion: "success",
    head_sha: COMMIT,
    head_branch: PINNED_TRUSTED_PRODUCER_BRANCH,
    path: PINNED_CLAIMS_PRODUCER_WORKFLOW_PATH,
    workflow_id: WORKFLOW_ID,
    head_repository: { full_name: repo },
    repository: { full_name: repo },
  };
  // Partial patches OVERRIDE only the given fields (an explicit
  // `undefined` in the patch erases the field, which the handoff must
  // treat as missing evidence → fail closed).
  const runRecord = opts?.run === null ? null : { ...defaultRun, ...(opts?.run ?? {}) };
  const workflowRecord = opts?.workflow === null
    ? null
    : (opts?.workflow ?? {
        id: WORKFLOW_ID,
        name: WORKFLOW_NAME,
        path: PINNED_CLAIMS_PRODUCER_WORKFLOW_PATH,
        state: "active_can_be_scheduled",
      });
  const artifacts = opts?.artifacts ?? [
    { id: 9001, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: false, size_in_bytes: zip.length },
  ];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace(/^https:\/\/[^/]+/, "");
    requests.push({ method, path });
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    if (!path.startsWith("/claims-artifact-zip") && (auth === undefined || !auth.startsWith("Bearer "))) {
      return new Response(JSON.stringify({ message: "unauthenticated" }), { status: 401 });
    }
    if (path === `/repos/${repo}/actions/runs/${RUN_ID}`) {
      if (opts?.runStatus) return new Response(null, { status: opts.runStatus });
      if (runRecord === null) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(runRecord), { status: 200 });
    }
    if (new RegExp(`^/repos/${repo}/actions/workflows/\\d+$`).test(path)) {
      if (workflowRecord === null) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(workflowRecord), { status: 200 });
    }
    if (path === `/repos/${repo}/actions/runs/${RUN_ID}/artifacts?per_page=100`) {
      if (opts?.artifactsStatus) return new Response(null, { status: opts.artifactsStatus });
      return new Response(JSON.stringify({ total_count: artifacts.length, artifacts }), { status: 200 });
    }
    if (path === `/repos/${repo}/actions/runs/${RUN_ID}/artifacts/9001/zip`) {
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

describe("I-06: valid handoff (happy path)", () => {
  test("valid artifact retrieved from the SPECIFIED producer run — GETs only, identity reported", async () => {
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
    // Every request was a GET (read-only handoff) and was authenticated.
    assert.ok(requests.length >= 3, "run + artifacts + zip were all requested");
    assert.ok(requests.every((r) => r.method === "GET"), "the handoff performs GET requests ONLY");
    assert.ok(
      requests.some((r) => r.path === `/repos/${PINNED_CLAIMS_PRODUCER_REPO}/actions/runs/${RUN_ID}`),
      "the run was resolved from the explicit producer run id",
    );
    assert.ok(
      requests.some((r) => r.path === `/repos/${PINNED_CLAIMS_PRODUCER_REPO}/actions/workflows/${WORKFLOW_ID}`),
      "the run's immutable workflow identity was resolved via the workflows API (P125-01)",
    );
  });
});

describe("P125-01: producer identity trust boundary — repository, branch, workflow", () => {
  test("a trusted main-branch run of the pinned producer workflow is accepted (full handoff path)", async () => {
    // The default mock IS the trusted context: pinned repo, main branch,
    // pinned workflow path + immutable ID, success, exact head SHA.
    const { fetchImpl, requests } = mockGithub();
    const result = await fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl });
    assert.equal(result.runHeadSha, COMMIT);
    assert.ok(requests.every((r) => r.method === "GET"), "GETs only");
  });

  test("a feature-branch run is rejected (UNTRUSTED BRANCH)", async () => {
    const { fetchImpl } = mockGithub({ run: { head_branch: "feat/lower-commit-fee" } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("UNTRUSTED BRANCH") && e.message.includes("feat/lower-commit-fee"),
    );
  });

  test("a fork run (different head repository) is rejected (FORK / UNTRUSTED ORIGIN)", async () => {
    const { fetchImpl } = mockGithub({ run: { head_repository: { full_name: "attacker/graveyield-protocol-fork" } } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("FORK / UNTRUSTED ORIGIN") && e.message.includes("attacker/graveyield-protocol-fork"),
    );
  });

  test("a run with MISSING head repository identity fails closed (no silent trust)", async () => {
    const { fetchImpl } = mockGithub({ run: { head_repository: null } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO usable head repository identity") && e.message.includes("failing closed"),
    );
  });

  test("a run living in a different repository is rejected", async () => {
    const { fetchImpl } = mockGithub({ run: { repository: { full_name: "attacker/evil-repo" } } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("not the pinned producer repository"),
    );
  });

  test("a run of a DIFFERENT workflow path is rejected (same display name does not help)", async () => {
    // Same workflow display name, same branch, same SHA — but the run
    // belongs to another workflow FILE. Display-name trust is gone.
    const { fetchImpl } = mockGithub({ run: { path: ".github/workflows/attacker-clone.yml" } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WRONG WORKFLOW PATH"),
    );
  });

  test("a run whose IMMUTABLE workflow ID resolves to a different path is rejected", async () => {
    const { fetchImpl } = mockGithub({
      run: { workflow_id: 888 },
      workflow: { id: 888, name: WORKFLOW_NAME, path: ".github/workflows/attacker-clone.yml", state: "active" },
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WORKFLOW IDENTITY MISMATCH"),
    );
  });

  test("a run with missing workflow path metadata fails closed", async () => {
    const { fetchImpl } = mockGithub({ run: { path: undefined } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO usable workflow path metadata") && e.message.includes("failing closed"),
    );
  });

  test("a run with missing immutable workflow_id metadata fails closed", async () => {
    const { fetchImpl } = mockGithub({ run: { workflow_id: undefined } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO usable immutable workflow_id metadata") && e.message.includes("failing closed"),
    );
  });

  test("a run whose workflow record cannot be resolved (404) fails closed", async () => {
    const { fetchImpl } = mockGithub({ workflow: null });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("producer workflow record") && e.message.includes("404"),
    );
  });

  test("a disabled producer workflow fails closed", async () => {
    const { fetchImpl } = mockGithub({
      workflow: { id: WORKFLOW_ID, name: WORKFLOW_NAME, path: PINNED_CLAIMS_PRODUCER_WORKFLOW_PATH, state: "disabled_manually" },
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("not active") && e.message.includes("failing closed"),
    );
  });

  test("a run with missing branch metadata fails closed", async () => {
    const { fetchImpl } = mockGithub({ run: { head_branch: undefined } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO usable head_branch metadata") && e.message.includes("failing closed"),
    );
  });

  test("a caller-supplied foreign producer repo is refused BEFORE any network call", async () => {
    let networkHits = 0;
    const fetchImpl = (async (): Promise<Response> => {
      networkHits += 1;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchVerifiedClaimsArtifact({
        token: "t",
        expectations: expectations({ producerRepo: "attacker/evil" }),
        fetchImpl,
      }),
      (e: ClaimsProducerHandoffError) => e.message.includes("not the pinned producer repository") && e.message.includes("P125-01"),
    );
    assert.equal(networkHits, 0, "the pin check precedes every network call");
  });

  test("caller-supplied foreign branch / path / name expectations are refused BEFORE any network call", async () => {
    for (const patch of [
      { producerBranch: "dev" },
      { producerWorkflowPath: ".github/workflows/attacker-clone.yml" },
      { producerWorkflowName: "attacker-producer" },
    ]) {
      let networkHits = 0;
      const fetchImpl = (async (): Promise<Response> => {
        networkHits += 1;
        return new Response(null, { status: 500 });
      }) as unknown as typeof fetch;
      await assert.rejects(
        fetchVerifiedClaimsArtifact({ token: "t", expectations: expectations(patch), fetchImpl }),
        /P125-01/,
        `expectation patch ${JSON.stringify(patch)} must be refused against the pin`,
      );
      assert.equal(networkHits, 0, "pin enforcement precedes every network call");
    }
  });

  test("a run with a mismatched branch despite trusted repo+workflow is rejected (defense in depth)", async () => {
    // A run on main's SHA but from a differently-named branch (e.g. a
    // renamed ref) is still refused: the branch check is independent.
    const { fetchImpl } = mockGithub({ run: { head_branch: "release-candidate" } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("UNTRUSTED BRANCH"),
    );
  });
});

describe("I-06: rejection cases — fail closed BEFORE any publication side effect", () => {
  test("missing artifact (producer run has no claims artifact)", async () => {
    const { fetchImpl } = mockGithub({ artifacts: [{ id: 1, name: "some-other-upload", expired: false, size_in_bytes: 10 }] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO artifact named") && e.message.includes("missing artifact"),
    );
  });

  test("expired artifact is rejected", async () => {
    const { fetchImpl } = mockGithub({
      artifacts: [{ id: 9001, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: true, size_in_bytes: 100 }],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("EXPIRED"),
    );
  });

  test("unavailable artifact (download endpoint fails) is rejected", async () => {
    const { fetchImpl } = mockGithub({ zipStatus: 404 });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("download failed") || e.message.includes("unavailable"),
    );
  });

  test("wrong producer run ID (run does not exist)", async () => {
    const { fetchImpl } = mockGithub({ run: null });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("producer run") && e.message.includes("404"),
    );
  });

  test("wrong workflow identity (run belongs to a different workflow)", async () => {
    const { fetchImpl } = mockGithub({ run: { name: "attacker-ci", status: "completed", conclusion: "success", head_sha: COMMIT } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("WRONG WORKFLOW IDENTITY"),
    );
  });

  test("run not completed / not successful is rejected", async () => {
    for (const patch of [{ status: "in_progress", conclusion: null as unknown }, { status: "completed", conclusion: "failure" }]) {
      const { fetchImpl } = mockGithub({ run: { name: WORKFLOW_NAME, head_sha: COMMIT, ...patch } });
      await assert.rejects(
        fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
        ClaimsProducerHandoffError,
      );
    }
  });

  test("wrong producer commit (run head_sha != publication source commit)", async () => {
    const { fetchImpl } = mockGithub({ run: { name: WORKFLOW_NAME, status: "completed", conclusion: "success", head_sha: "b".repeat(40) } });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("provenance mismatch"),
    );
  });

  test("wrong artifact name in the run record", async () => {
    const { fetchImpl } = mockGithub({
      artifacts: [{ id: 9001, name: "claims-snapshot-bundle", expired: false, size_in_bytes: 100 }],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("NO artifact named"),
    );
  });

  test("wrong artifact identity INSIDE the zip (entry name mismatch)", async () => {
    const zip = buildZip([{ name: "snapshot.json", data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl } = mockGithub({ zip });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("does not contain the expected"),
    );
  });

  test("ambiguous artifact (two uploads with the same name) is rejected", async () => {
    const { fetchImpl } = mockGithub({
      artifacts: [
        { id: 1, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: false, size_in_bytes: 100 },
        { id: 2, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: false, size_in_bytes: 100 },
      ],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("AMBIGUOUS"),
    );
  });

  test("digest/byte-length mismatch (zip bytes != producer-run record)", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl } = mockGithub({
      zip,
      artifacts: [{ id: 9001, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: false, size_in_bytes: zip.length + 1 }],
    });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("DIGEST/BYTE-LENGTH MISMATCH"),
    );
  });

  test("CRC32 mismatch (corrupted or tampered download) is rejected", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }], { zeroCrc: true });
    const { fetchImpl } = mockGithub({ zip });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: ClaimsProducerHandoffError) => e.message.includes("CRC32"),
    );
    // And the low-level reader agrees.
    assert.throws(() => readZipEntry(zip, CLAIMS_PRODUCER_ARTIFACT_NAME, 1024 * 1024), /CRC32/);
  });

  test("invalid schema (artifact JSON does not match the strict claims schema)", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from("{\"format_version\":2}", "utf8") }]);
    const { fetchImpl } = mockGithub({ zip, artifacts: [{ id: 9001, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: false, size_in_bytes: zip.length }] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: unknown) => e instanceof Error && /schema|claims/i.test(e.message),
    );
  });

  test("invalid provenance/reconciliation (cross-field inconsistency) is rejected", async () => {
    // Honest note: the claims-grade gate validates provenance structure and
    // cross-field consistency (sink ledger checks engage when explicit sink
    // exclusions exist — see claimsArtifact.ts). The ledger digest VALUE is
    // producer-attested; an internally inconsistent artifact fails closed.
    const text = validArtifactText((a) => {
      (a.reconciliation as Record<string, unknown>).enumerated_total = 5999;
    });
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(text, "utf8") }]);
    const { fetchImpl } = mockGithub({ zip, artifacts: [{ id: 9001, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: false, size_in_bytes: zip.length }] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ ...handoffArgs(), fetchImpl }),
      (e: unknown) => e instanceof Error && /reconciliation|enumerated|consisten/i.test(e.message),
    );
  });

  test("pool identity mismatch is rejected", async () => {
    const zip = buildZip([{ name: CLAIMS_PRODUCER_ARTIFACT_NAME, data: Buffer.from(validArtifactText(), "utf8") }]);
    const { fetchImpl } = mockGithub({ zip, artifacts: [{ id: 9001, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: false, size_in_bytes: zip.length }] });
    await assert.rejects(
      fetchVerifiedClaimsArtifact({ token: "t".repeat(12), expectations: expectations({ expectedPool: key(0x99).toBase58() }), fetchImpl }),
      (e: unknown) => e instanceof Error && /pool/i.test(e.message),
    );
  });

  test("producer identity mismatch (unpinned identity) is rejected", async () => {
    const { fetchImpl } = mockGithub();
    await assert.rejects(
      fetchVerifiedClaimsArtifact({
        token: "t".repeat(12),
        expectations: expectations({ producerIdentity: "someone-elses-producer" }),
        fetchImpl,
      }),
      (e: ClaimsProducerHandoffError) => e.message.includes("pinned producer identity"),
    );
    // The check runs BEFORE any network call.
    const { fetchImpl: noCalls } = mockGithub();
    const requests0: unknown[] = [];
    void noCalls;
    void requests0;
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
      { label: "expired artifact", mock: mockGithub({ artifacts: [{ id: 9001, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: true, size_in_bytes: 10 }] }) },
      { label: "unavailable download", mock: mockGithub({ zipStatus: 500 }) },
      { label: "wrong run id", mock: mockGithub({ run: null }) },
      { label: "wrong workflow identity", mock: mockGithub({ run: { name: "attacker-ci", status: "completed", conclusion: "success", head_sha: COMMIT } }) },
      { label: "feature branch", mock: mockGithub({ run: { head_branch: "feat/x" } }) },
      { label: "fork origin", mock: mockGithub({ run: { head_repository: { full_name: "attacker/fork" } } }) },
      { label: "wrong workflow path", mock: mockGithub({ run: { path: ".github/workflows/attacker-clone.yml" } }) },
      { label: "run failed", mock: mockGithub({ run: { name: WORKFLOW_NAME, status: "completed", conclusion: "failure", head_sha: COMMIT } }) },
      { label: "commit mismatch", mock: mockGithub({ run: { name: WORKFLOW_NAME, status: "completed", conclusion: "success", head_sha: "b".repeat(40) } }) },
      { label: "wrong zip entry", mock: mockGithub({ zip: buildZip([{ name: "snapshot.json", data: Buffer.from("{}", "utf8") }]) }) },
      { label: "byte-length mismatch", mock: mockGithub({ zip, artifacts: [{ id: 9001, name: CLAIMS_PRODUCER_ARTIFACT_NAME, expired: false, size_in_bytes: zip.length + 7 }] }) },
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
