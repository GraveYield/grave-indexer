// SPDX-License-Identifier: Apache-2.0
//
// C1 console-snapshot evidence boundary (IMPL-001 unification) —
// regression tests for the ACTUAL console-snapshot output.
//
// The C1 inactivity criterion must be seeded ONLY by evidence that passes
// the SAME shared `evaluateAttestationGate` the collect/attestation path
// applies. These tests run the real `cmdConsoleSnapshot` command against
// faked RPC seams (the same test/diagnostic-seam convention `cmdCollect`
// uses) and assert on the WRITTEN `console-snapshot.json` artifact — not
// merely on the validator in isolation — proving that rejected evidence
// can never appear as a valid C1 last-swap record:
//
//   * verified + definitive + fresh evidence enters C1 with the exact
//     verified anchor;
//   * incomplete evidence is excluded (C1 stays "pending", failure
//     recorded);
//   * definitive no-swap evidence is never represented as a verified
//     last-swap anchor;
//   * stale verified evidence is excluded (freshness policy = the shared
//     activity-TTL bound, distinct from the artifact's --max-age-hours
//     budget);
//   * malformed evidence is excluded;
//   * mislabeled evidence (both Correction-003 directions) is excluded;
//   * verified claims without a real last-swap anchor are excluded;
//   * diagnostic (last-known definitive) evidence is never treated as
//     current verified evidence.
//
// Evidence sources follow the repository's testing conventions: the REAL
// ActivityIndexerLive over the REAL mainnet fixture corpus (the same
// `vendor/protocol/sdk/test/fixtures/lastSwap` provenance the SDK and
// activityLive tests use) wherever the real indexer can produce the
// state, and clearly labeled SYNTHETIC mutations of a real verified
// derivation for the corruption cases the canonical pipeline cannot
// produce by itself (stale/malformed/mislabeled records).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PublicKey, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";
import { AccountDisc, RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";

import {
  ActivityIndexerLive,
  DEFAULT_ACTIVITY_TTL_MS,
  type ActivityEvidence,
} from "../src/activityLive.js";
import { cmdConsoleSnapshot, EVIDENCE_FRESHNESS_MAX_AGE_MS } from "../src/cli.js";
import { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID, type PipelineConfig } from "../src/config.js";
import { buildAmmInfoSlice, synth, WSOL_MINT } from "./fixtures.js";

// ─── Real mainnet fixture corpus (same provenance as activityLive.test.ts) ──

const FIXTURE_DIR = fileURLToPath(
  new URL("../vendor/protocol/sdk/test/fixtures/lastSwap/", import.meta.url),
);

export const POOL = new PublicKey("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");

interface ReducedFixture {
  signature: string;
  slot: number;
  blockTime: number | null;
  txVersion: number | string;
  wireBase64: string;
  meta: {
    err: unknown;
    innerInstructions: Array<{ index: number; instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }> }>;
    loadedAddresses: { writable: string[]; readonly: string[] };
    preTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null;
    postTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null;
  };
}

function readFixture(name: string): ReducedFixture {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}.json`, "utf8")) as ReducedFixture;
}

function poolAccountBytes(): Uint8Array {
  const raw = JSON.parse(readFileSync(`${FIXTURE_DIR}/pool_account_sol_usdc.json`, "utf8")) as {
    dataBase64: string;
  };
  return new Uint8Array(Buffer.from(raw.dataBase64, "base64"));
}

const swapV2Outer = readFixture("tx_swap_base_in_v2_outer_legacy");
const failedSwap = readFixture("tx_failed_swap_inner_v1");

/** Build a web3.js-shaped getTransaction response from a real fixture
 *  (same construction as activityLive.test.ts). */
function responseFrom(fx: ReducedFixture): Record<string, unknown> {
  const txObj = VersionedTransaction.deserialize(Buffer.from(fx.wireBase64, "base64"));
  return {
    slot: BigInt(fx.slot),
    blockTime: fx.blockTime === null ? null : BigInt(fx.blockTime),
    transaction: txObj,
    meta: {
      err: fx.meta.err,
      innerInstructions: fx.meta.innerInstructions,
      loadedAddresses: {
        writable: fx.meta.loadedAddresses.writable.map((k) => new PublicKey(k)),
        readonly: fx.meta.loadedAddresses.readonly.map((k) => new PublicKey(k)),
      },
      preTokenBalances: fx.meta.preTokenBalances,
      postTokenBalances: fx.meta.postTokenBalances,
    },
  };
}

// ─── Faked RPC seams for cmdConsoleSnapshot ─────────────────────────────────

interface Candidate {
  signature: string;
  response: Record<string, unknown> | null;
  slot?: number;
  blockTime?: number | null;
  confirmationStatus?: string | null;
}

/** Verified derivation over the REAL swap fixture, with the anchor
 *  blockTime pinned so tests can reason about the exact C1 age. */
const swapCandidate = (blockTime = 1_700_000_100): Candidate => ({
  signature: swapV2Outer.signature,
  response: responseFrom(swapV2Outer),
  slot: swapV2Outer.slot,
  blockTime,
});

/** Definitive no-swap derivation over a REAL failed transaction
 *  (InstructionError — provably not an economic swap). */
const failedTxCandidate = (): Candidate => ({
  signature: failedSwap.signature,
  response: responseFrom(failedSwap),
  slot: failedSwap.slot,
});

/** Incomplete derivation: the only candidate is not finalized — the SDK
 *  fails closed with unresolved evidence (real fixture, labeled status
 *  mutation only). */
const nonFinalizedCandidate = (): Candidate => ({
  signature: swapV2Outer.signature,
  response: responseFrom(swapV2Outer),
  slot: swapV2Outer.slot,
  confirmationStatus: "processed",
});

/** Discovery-cluster fake: serves the signature/transaction/account
 *  surface the canonical SDK derivation reads, plus the vault/supply
 *  surface the enrichment reads. `rpcEndpoint` is never dialed — the
 *  getProgramAccounts transport is injected separately. */
class SnapshotRpc {
  calls: string[] = [];
  readonly rpcEndpoint = "https://api.mainnet-beta.solana.com";

  constructor(private readonly candidates: Candidate[]) {}

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  async getSlot(_commitment?: unknown): Promise<bigint> {
    this.calls.push("getSlot");
    return 5_000_000n;
  }

  async getSignaturesForAddress(
    _address: PublicKey,
    opts?: { limit?: number },
  ): Promise<Array<{ signature: string; slot: bigint; blockTime: bigint | null; err: unknown; confirmationStatus: string | null }>> {
    this.calls.push("getSignaturesForAddress");
    const limit = opts?.limit ?? this.candidates.length;
    return this.candidates.slice(0, limit).map((c) => ({
      signature: c.signature,
      slot: BigInt(c.slot ?? 900_000),
      blockTime:
        c.blockTime === undefined
          ? ((c.response as { blockTime?: bigint | null } | null)?.blockTime ?? null)
          : c.blockTime === null
            ? null
            : BigInt(c.blockTime),
      err: (c.response as { meta?: { err?: unknown } | null } | null)?.meta?.err ?? null,
      confirmationStatus: c.confirmationStatus ?? "finalized",
    }));
  }

  async getTransaction(signature: string): Promise<Record<string, unknown> | null> {
    this.calls.push(`getTransaction:${signature.slice(0, 12)}`);
    return this.candidates.find((c) => c.signature === signature)?.response ?? null;
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    this.calls.push(`getAccountInfo:${address.toBase58().slice(0, 8)}`);
    if (address.equals(POOL)) {
      return {
        lamports: 1_000_000,
        data: Buffer.from(poolAccountBytes()),
        owner: RAYDIUM_V4_PROGRAM_ID,
        executable: false,
        rentEpoch: 0n,
      } as unknown as AccountInfo<Uint8Array>;
    }
    return null;
  }

  async getTokenAccountBalance(_vault: PublicKey): Promise<{ value: { amount: string; decimals: number } }> {
    this.calls.push("getTokenAccountBalance");
    return { value: { amount: "600000000", decimals: 9 } };
  }

  async getTokenSupply(_mint: PublicKey): Promise<{ value: { amount: string; decimals: number } }> {
    this.calls.push("getTokenSupply");
    return { value: { amount: "1000000", decimals: 6 } };
  }
}

/** GraveScanner ProtocolConfig payload for the verification-cluster fake
 *  (full Anchor layout: discriminator + every field in order). */
function protocolConfigBytes(): Uint8Array {
  const out = new Uint8Array(8 + 32 + 32 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 32 + 32 + 1);
  const view = new DataView(out.buffer);
  out.set(AccountDisc.ProtocolConfig, 0);
  let at = 8;
  const put32 = (pk: PublicKey): void => {
    out.set(pk.toBytes(), at);
    at += 32;
  };
  const put64 = (v: bigint): void => {
    view.setBigUint64(at, v, true);
    at += 8;
  };
  put32(synth(0xa1)); // authority
  put32(synth(0xa2)); // pendingAuthority
  view.setBigInt64(at, 0n, true); at += 8; // pendingAuthorityEta
  put64(7_776_000n); // inactivitySeconds — 90 d (spec default)
  view.setUint16(at, 9_900, true); at += 2; // priceCollapseBps
  put64(500_000_000n); // minTvlLamports — 0.5 SOL (spec default)
  put64(1_209_600n); // anchorStalenessSeconds — 14 d
  put64(1_000n); // lpBurnDustThreshold
  view.setBigInt64(at, 3_600n, true); at += 8; // certTtlSeconds
  out[at] = 0; at += 1; // paused = false
  put32(synth(0xa3)); // activityOracle
  put32(synth(0xa4)); // launchPriceOracle
  out[at] = 0; at += 1; // bump
  return out;
}

const CONFIG_PDA = (
  await PublicKey.findProgramAddress([Buffer.from("protocol_config")], DEVNET_SCANNER_PROGRAM_ID)
)[0]!;

/** Verification-cluster fake: serves ONLY the deployed ProtocolConfig the
 *  snapshot thresholds are read from; every other call is recorded and
 *  fails the test via the returned call log. */
class VerificationRpc {
  calls: string[] = [];
  asConnection(): Connection {
    return this as unknown as Connection;
  }
  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    this.calls.push(`getAccountInfo:${address.toBase58().slice(0, 8)}`);
    if (address.equals(CONFIG_PDA)) {
      return {
        lamports: 1_000_000,
        data: Buffer.from(protocolConfigBytes()),
        owner: DEVNET_SCANNER_PROGRAM_ID,
        executable: false,
        rentEpoch: 0n,
      } as unknown as AccountInfo<Uint8Array>;
    }
    return null;
  }
}

/** getProgramAccounts transport fake (same shape as ingest.test.ts): the
 *  discovery enumeration sees one WSOL-supported pool per requested
 *  address, carrying the synthetic 160-byte identity slice. */
function gpaFetch(pools: PublicKey[]): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: pools.map((p) => ({
          pubkey: p.toBase58(),
          account: {
            data: [Buffer.from(buildAmmInfoSlice()).toString("base64"), "base64"],
            owner: RAYDIUM_V4_PROGRAM_ID.toBase58(),
          },
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

function snapshotConfig(dataDir: string): PipelineConfig {
  return {
    discoveryRpcUrl: "http://discovery.invalid",
    discoveryCluster: "mainnet-beta",
    verificationRpcUrl: "http://verification.invalid",
    scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
    vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
    maxPoolsPerScan: 10,
    signatureScanLimit: 50,
    discoveryStalenessSlots: 400,
    evidenceFreshnessSlots: 450,
    dataDir,
    oracleKeyFile: null,
    oracleKeyEnv: null,
    oracleIsRegistered: false,
  };
}

interface SnapshotArtifact {
  schemaVersion: number;
  generatedAtUnixMs: number;
  freshness: { maxAgeMs: number };
  counts: { enriched: number };
  failures: Array<{ stage: string; pool?: string; reason: string }>;
  thresholds: { inactivitySeconds: string; minTvlLamports: string };
  pools: Array<{
    address: string;
    lastSwap: { unixTs: number; slot: number; signature: string } | null;
    criteria: { c1Inactivity: "pass" | "fail" | "pending" };
    fetchedAtUnixMs: number;
  }>;
}

interface RunOpts {
  discovery?: SnapshotRpc;
  fetchPools?: PublicKey[];
  verification?: VerificationRpc;
  activityIndexer?: ActivityIndexerLive;
}

/** Run the REAL cmdConsoleSnapshot against faked seams and return the
 *  ACTUAL persisted console-snapshot.json artifact. */
async function runConsoleSnapshot(opts: RunOpts): Promise<SnapshotArtifact> {
  const dataDir = mkdtempSync(join(tmpdir(), "grave-indexer-c1-"));
  try {
    const code = await cmdConsoleSnapshot(snapshotConfig(dataDir), {
      maxPools: 10,
      enrich: 10,
      maxAgeHours: 24,
      discoveryConnection: (opts.discovery ?? new SnapshotRpc([])).asConnection(),
      verificationConnection: (opts.verification ?? new VerificationRpc()).asConnection(),
      discoveryFetchImpl: gpaFetch(opts.fetchPools ?? [POOL]),
      ...(opts.activityIndexer !== undefined ? { activityIndexer: opts.activityIndexer } : {}),
    });
    assert.equal(code, 0, "console-snapshot completed with enriched pools");
    const artifact = JSON.parse(
      readFileSync(join(dataDir, "console-snapshot.json"), "utf8"),
    ) as SnapshotArtifact;
    return artifact;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ─── Real indexer instances over the real fixture corpus ────────────────────

const realIndexer = () =>
  new ActivityIndexerLive({
    cluster: "mainnet-beta",
    rpcUrl: "https://api.mainnet-beta.solana.com",
  });

/** A REAL verified derivation (canonical SDK over the real swap fixture). */
async function deriveVerified(): Promise<ActivityEvidence> {
  return realIndexer().indexActivity(new SnapshotRpc([swapCandidate()]).asConnection(), POOL, {
    scanLimit: 50,
  });
}

/** A REAL incomplete derivation (non-finalized candidate → fail-closed). */
async function deriveIncomplete(): Promise<ActivityEvidence> {
  return realIndexer().indexActivity(new SnapshotRpc([nonFinalizedCandidate()]).asConnection(), POOL, {
    scanLimit: 50,
  });
}

/** Test/diagnostic seam: an indexer stub returning scripted evidence per
 *  pool (production callers never pass one). Used ONLY for the labeled
 *  synthetic corruption cases the canonical pipeline cannot produce. */
function stubIndexer(byPool: Map<string, ActivityEvidence>): ActivityIndexerLive {
  const stub = {
    indexActivity: async (_conn: unknown, pool: PublicKey): Promise<ActivityEvidence> => {
      const e = byPool.get(pool.toBase58());
      if (!e) throw new Error(`stub indexer: no evidence scripted for ${pool.toBase58()}`);
      return e;
    },
  };
  return stub as unknown as ActivityIndexerLive;
}

const poolFailure = (artifact: SnapshotArtifact): { stage: string; pool?: string; reason: string } | undefined =>
  artifact.failures.find((f) => f.stage === "activity" && f.pool === POOL.toBase58());

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("C1 console-snapshot evidence boundary (shared attestation gate)", () => {
  test("verified + definitive + fresh evidence enters C1 with the exact verified anchor", async () => {
    const artifact = await runConsoleSnapshot({
      discovery: new SnapshotRpc([swapCandidate()]),
      fetchPools: [POOL],
    });
    assert.equal(artifact.counts.enriched, 1);
    const pool = artifact.pools[0]!;
    assert.equal(pool.address, POOL.toBase58());
    // The anchor that entered C1 is EXACTLY the verified derivation's
    // anchor — no other timestamp could be substituted on the way in.
    assert.deepEqual(pool.lastSwap, {
      unixTs: 1_700_000_100,
      slot: swapV2Outer.slot,
      signature: swapV2Outer.signature,
    });
    // ~3-year-old swap vs the 90-day inactivity threshold → C1 evaluates.
    assert.equal(pool.criteria.c1Inactivity, "pass");
    assert.equal(poolFailure(artifact), undefined, "a passing record raises no failure");
  });

  test("incomplete evidence is excluded: no anchor, C1 pending, failure recorded", async () => {
    const artifact = await runConsoleSnapshot({
      discovery: new SnapshotRpc([nonFinalizedCandidate()]),
      fetchPools: [POOL],
    });
    const pool = artifact.pools[0]!;
    assert.equal(pool.address, POOL.toBase58());
    assert.equal(pool.lastSwap, null, "incomplete evidence never seeds a C1 anchor");
    assert.equal(pool.criteria.c1Inactivity, "pending", "C1 stays pending on unresolved evidence");
    const failure = poolFailure(artifact);
    assert.ok(failure, "the exclusion is recorded for observability");
    assert.ok(failure!.reason.includes("incomplete_evidence"), `failure names the gate reason: ${failure!.reason}`);
  });

  test("definitive no-swap evidence is never represented as a verified last-swap anchor", async () => {
    // The REAL derivation over a real FAILED transaction: definitive=true,
    // noSwapFound=true, derivationKind="no_swap" — a complete, honest
    // determination that carries NO swap anchor.
    const realIndexerInstance = realIndexer();
    const noSwap = await realIndexerInstance.indexActivity(
      new SnapshotRpc([failedTxCandidate()]).asConnection(),
      POOL,
      { scanLimit: 50 },
    );
    assert.equal(noSwap.evidenceStatus, "no_swap_in_scan");
    assert.equal(noSwap.definitive, true, "the determination is definitive");
    assert.equal(noSwap.noSwapFound, true);
    assert.equal(noSwap.derivationKind, "no_swap");

    const artifact = await runConsoleSnapshot({
      discovery: new SnapshotRpc([failedTxCandidate()]),
      fetchPools: [POOL],
    });
    const pool = artifact.pools[0]!;
    assert.equal(pool.lastSwap, null, "a definitive no-swap never becomes a last-swap anchor");
    assert.equal(pool.criteria.c1Inactivity, "pending", "C1 cannot pass on a no-swap determination");
    // A definitive no-swap is NOT a pipeline failure — the scan succeeded
    // and provably found no economic swap; only the anchor is absent.
    assert.equal(poolFailure(artifact), undefined, "an honest no-swap is not an anomalous rejection");
  });

  test("missing transaction data stays unresolved and is excluded from C1", async () => {
    const artifact = await runConsoleSnapshot({
      discovery: new SnapshotRpc([{ signature: swapV2Outer.signature, response: null, blockTime: 1_700_000_100 }]),
      fetchPools: [POOL],
    });
    const pool = artifact.pools[0]!;
    assert.equal(pool.lastSwap, null);
    assert.equal(pool.criteria.c1Inactivity, "pending");
    assert.ok(poolFailure(artifact), "the unresolved derivation is recorded");
    assert.ok(poolFailure(artifact)!.reason.includes("incomplete_evidence"));
  });

  test("stale verified evidence is excluded by the shared freshness policy", async () => {
    // SYNTHETIC (labeled): a REAL verified derivation whose derivation
    // timestamp is pushed past the shared freshness bound — the corruption
    // shape a stale cache would present. The canonical pipeline cannot
    // produce this on its own (every run derives fresh), so it is injected
    // via the test seam.
    const verified = await deriveVerified();
    const stale: ActivityEvidence = {
      ...verified,
      derivation: {
        ...verified.derivation,
        derivedAtUnixMs: Date.now() - DEFAULT_ACTIVITY_TTL_MS - 60_000,
      },
    };
    const artifact = await runConsoleSnapshot({
      fetchPools: [POOL],
      activityIndexer: stubIndexer(new Map([[POOL.toBase58(), stale]])),
    });
    const pool = artifact.pools[0]!;
    assert.equal(pool.lastSwap, null, "stale verified evidence cannot seed a C1 anchor");
    assert.equal(pool.criteria.c1Inactivity, "pending");
    const failure = poolFailure(artifact);
    assert.ok(failure, "the stale rejection is recorded");
    assert.ok(failure!.reason.includes("stale_evidence"), `failure names the gate reason: ${failure!.reason}`);
    // The ARTIFACT freshness budget (24 h) is a rendering budget for the
    // console — it is deliberately distinct from the evidence freshness
    // policy and did not admit the stale record.
    assert.equal(artifact.freshness.maxAgeMs, 24 * 3_600_000);
    assert.equal(artifact.generatedAtUnixMs > 0, true);
  });

  test("freshness boundary: the C1 threshold is the shared activity-TTL bound", async () => {
    // Pin the exported shared constant: no new TTL was invented, and the
    // collect/attestation path (whose gate tests use DEFAULT_ACTIVITY_TTL_MS)
    // and the C1 path enforce the SAME bound.
    assert.equal(EVIDENCE_FRESHNESS_MAX_AGE_MS, DEFAULT_ACTIVITY_TTL_MS);

    // Just inside the bound (half the TTL): the verified anchor enters C1.
    const fresh = await deriveVerified();
    const freshButAged: ActivityEvidence = {
      ...fresh,
      derivation: { ...fresh.derivation, derivedAtUnixMs: Date.now() - DEFAULT_ACTIVITY_TTL_MS / 2 },
    };
    const accepted = await runConsoleSnapshot({
      fetchPools: [POOL],
      activityIndexer: stubIndexer(new Map([[POOL.toBase58(), freshButAged]])),
    });
    assert.equal(accepted.pools[0]!.lastSwap!.unixTs, 1_700_000_100, "evidence inside the freshness bound enters C1");

    // Just outside the bound (TTL + one minute — robust to clock jitter):
    // the same anchor is rejected as stale.
    const staleByOneMinute: ActivityEvidence = {
      ...fresh,
      derivation: { ...fresh.derivation, derivedAtUnixMs: Date.now() - DEFAULT_ACTIVITY_TTL_MS - 60_000 },
    };
    const rejected = await runConsoleSnapshot({
      fetchPools: [POOL],
      activityIndexer: stubIndexer(new Map([[POOL.toBase58(), staleByOneMinute]])),
    });
    assert.equal(rejected.pools[0]!.lastSwap, null, "evidence past the freshness bound is excluded");
    assert.ok(rejected.pools[0]!.criteria.c1Inactivity === "pending");
    assert.ok(poolFailure(rejected)!.reason.includes("stale_evidence"));
  });

  test("the shared gate boundary is exact: age == TTL passes, age == TTL + 1 is stale", async () => {
    // The exact boundary semantics of the SHARED gate (the same function
    // object both the collect and C1 paths call), evaluated on a real
    // verified derivation with an injected evaluation clock.
    const verified = await deriveVerified();
    const atBound = { ...verified, derivation: { ...verified.derivation, derivedAtUnixMs: verified.derivation.derivedAtUnixMs } };
    const ok = (await import("../src/activityLive.js")).evaluateAttestationGate(atBound, {
      maxAgeMs: DEFAULT_ACTIVITY_TTL_MS,
      nowUnixMs: atBound.derivation.derivedAtUnixMs + DEFAULT_ACTIVITY_TTL_MS,
    });
    assert.equal(ok.ok, true, "age exactly at the bound is fresh");

    const past = (await import("../src/activityLive.js")).evaluateAttestationGate(atBound, {
      maxAgeMs: DEFAULT_ACTIVITY_TTL_MS,
      nowUnixMs: atBound.derivation.derivedAtUnixMs + DEFAULT_ACTIVITY_TTL_MS + 1,
    });
    assert.equal(past.ok, false);
    assert.ok(!past.ok);
    assert.equal(past.reason, "stale_evidence");
  });

  test("malformed evidence is excluded (wrong types, missing anchor)", async () => {
    const verified = await deriveVerified();
    const malformed: Array<[ActivityEvidence, string]> = [
      [{ ...verified, definitive: "true" as unknown as boolean }, "definitive not a boolean"],
      [{ ...verified, lastSwapUnixTs: 0 }, "verified claim without an anchor timestamp"],
      [{ ...verified, lastSwapSignature: "" }, "verified claim without an anchor signature"],
      [{ ...verified, noSwapFound: true }, "verified claim contradicting noSwapFound"],
    ];
    for (const [record, what] of malformed) {
      const artifact = await runConsoleSnapshot({
        fetchPools: [POOL],
        activityIndexer: stubIndexer(new Map([[POOL.toBase58(), record]])),
      });
      const pool = artifact.pools[0]!;
      assert.equal(pool.lastSwap, null, `malformed evidence excluded: ${what}`);
      assert.equal(pool.criteria.c1Inactivity, "pending", `C1 pending on malformed evidence: ${what}`);
      const failure = poolFailure(artifact);
      assert.ok(failure, `rejection recorded: ${what}`);
      assert.ok(
        failure!.reason.includes("malformed_evidence"),
        `failure names the gate reason for: ${what} — ${failure!.reason}`,
      );
    }
  });

  test("mislabeled evidence is excluded: \"unresolved\" label on verified status", async () => {
    // SYNTHETIC (labeled): a REAL verified derivation carrying an
    // "unresolved" derivationKind — the label does not mirror the state.
    const verified = await deriveVerified();
    const mislabeled: ActivityEvidence = { ...verified, derivationKind: "unresolved" };
    const artifact = await runConsoleSnapshot({
      fetchPools: [POOL],
      activityIndexer: stubIndexer(new Map([[POOL.toBase58(), mislabeled]])),
    });
    const pool = artifact.pools[0]!;
    assert.equal(pool.lastSwap, null, "a mislabeled verified record cannot seed a C1 anchor");
    assert.equal(pool.criteria.c1Inactivity, "pending");
    const failure = poolFailure(artifact);
    assert.ok(failure);
    assert.ok(failure!.reason.includes("malformed_evidence"), failure!.reason);
  });

  test("mislabeled evidence is excluded: \"swap\" label on incomplete status", async () => {
    // SYNTHETIC (labeled): a REAL incomplete derivation labeled "swap" —
    // the exact misrepresentation that would present unresolved evidence
    // as a verified economic swap.
    const incomplete = await deriveIncomplete();
    assert.equal(incomplete.evidenceStatus, "incomplete");
    const mislabeled: ActivityEvidence = { ...incomplete, derivationKind: "swap" };
    const artifact = await runConsoleSnapshot({
      fetchPools: [POOL],
      activityIndexer: stubIndexer(new Map([[POOL.toBase58(), mislabeled]])),
    });
    const pool = artifact.pools[0]!;
    assert.equal(pool.lastSwap, null, "an incomplete record labeled \"swap\" cannot seed a C1 anchor");
    assert.equal(pool.criteria.c1Inactivity, "pending");
    const failure = poolFailure(artifact);
    assert.ok(failure);
    assert.ok(failure!.reason.includes("malformed_evidence"), failure!.reason);
  });

  test("non-definitive verified-labeled evidence is excluded", async () => {
    // SYNTHETIC (labeled): a verified record flipped to non-definitive —
    // not a sound basis for any inactivity criterion.
    const verified = await deriveVerified();
    const nonDefinitive: ActivityEvidence = { ...verified, definitive: false };
    const artifact = await runConsoleSnapshot({
      fetchPools: [POOL],
      activityIndexer: stubIndexer(new Map([[POOL.toBase58(), nonDefinitive]])),
    });
    const pool = artifact.pools[0]!;
    assert.equal(pool.lastSwap, null);
    assert.equal(pool.criteria.c1Inactivity, "pending");
    const failure = poolFailure(artifact);
    assert.ok(failure);
    assert.ok(failure!.reason.includes("not_definitive"), failure!.reason);
  });

  test("diagnostic (last-known definitive) evidence is never treated as current verified evidence", async () => {
    // REAL indexer, REAL Correction-002 sequence: a verified derivation is
    // followed by an incomplete refresh — the verified record survives
    // ONLY in the diagnostics view; the current result is incomplete.
    const ix = realIndexer();
    const first = await ix.indexActivity(new SnapshotRpc([swapCandidate()]).asConnection(), POOL, { scanLimit: 50 });
    assert.equal(first.evidenceStatus, "verified");
    const current = await ix.indexActivity(
      new SnapshotRpc([nonFinalizedCandidate()]).asConnection(),
      POOL,
      { forceRefresh: true, scanLimit: 50 },
    );
    assert.equal(current.evidenceStatus, "incomplete");
    assert.notEqual(
      ix.lastKnownDefinitiveEvidence(POOL),
      null,
      "the verified record is retained for diagnostics",
    );

    // The console run consumes the indexer's CURRENT result only: the
    // snapshot must NOT resurrect the diagnostic anchor into C1.
    const artifact = await runConsoleSnapshot({
      discovery: new SnapshotRpc([nonFinalizedCandidate()]),
      fetchPools: [POOL],
      activityIndexer: ix,
    });
    const pool = artifact.pools[0]!;
    assert.equal(pool.lastSwap, null, "the diagnostic verified record never becomes the C1 anchor");
    assert.equal(pool.criteria.c1Inactivity, "pending");
    const failure = poolFailure(artifact);
    assert.ok(failure, "the incomplete CURRENT result is recorded");
    assert.ok(failure!.reason.includes("incomplete_evidence"), failure!.reason);
  });
});
