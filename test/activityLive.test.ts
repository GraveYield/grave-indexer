// SPDX-License-Identifier: Apache-2.0
//
// IMPL-001 Phase B + Correction 002 — ActivityIndexerLive integration tests.
//
// Exercises the ACTUAL integration and collect path: the indexer's
// `indexActivity` through the vendored SDK's canonical
// `deriveLastSwapEvidenceV4` (D4/D5), against the same real mainnet
// fixture corpus the SDK tests use (vendor/protocol/sdk/test/fixtures/
// lastSwap — provenance documented there). Synthetic edge cases are
// labeled mutations of those real fixtures, built in code.
//
// Correction 002 coverage:
//   * an incomplete refresh is never overridden by a cached verified /
//     no-swap record — the incomplete result IS the current result;
//   * last-known definitive evidence is retained for diagnostics only
//     and is never served as current;
//   * incomplete results are never cached for the normal TTL and never
//     suppress a fresh evidence attempt;
//   * the explicit attestation gate rejects missing, malformed,
//     incomplete, non-definitive and stale evidence — including at the
//     real `cmdCollect` issuance path (no bundle, no devnet contact).
//
// Correction 003 coverage (on top of the corrected canonical SDK pin):
//   * derivationKind mirrors the evidence state — verified → "swap",
//     no_swap_in_scan → "no_swap", incomplete → "unresolved"; a no-swap
//     or unresolved record is never represented as a verified economic
//     swap, and the attestation gate rejects mislabeled records in both
//     directions.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PublicKey, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";

import { RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";

import {
  ActivityIndexerLive,
  DEFAULT_ACTIVITY_TTL_MS,
  evaluateAttestationGate,
  type ActivityEvidence,
} from "../src/activityLive.js";
import { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID, type PipelineConfig } from "../src/config.js";
import { cmdCollect } from "../src/cli.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../vendor/protocol/sdk/test/fixtures/lastSwap/", import.meta.url),
);

export const POOL = new PublicKey("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");
export const COIN_VAULT = new PublicKey("DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz");
export const PC_VAULT = new PublicKey("HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz");

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

/** Build a web3.js-shaped getTransaction response from a real fixture. */
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

/** SYNTHETIC (labeled): replace the real swap's V4 instruction tag —
 *  validates the non-economic and ambiguous classification branches. */
function withTag(fx: ReducedFixture, tag: number): Record<string, unknown> {
  const resp = responseFrom(fx) as {
    transaction: { message: Record<string, unknown> };
    meta: Record<string, unknown>;
  };
  const baseMessage = resp.transaction.message as {
    getAccountKeys: (o?: unknown) => { keySegments(): ReadonlyArray<ReadonlyArray<PublicKey>> };
    compiledInstructions: Array<Record<string, unknown>>;
  };
  const message = {
    getAccountKeys: (opts?: unknown) => baseMessage.getAccountKeys.call(baseMessage, opts),
    compiledInstructions: baseMessage.compiledInstructions.map((ci) => ({ ...ci })),
  };
  const keys = baseMessage.getAccountKeys({}).keySegments().flat();
  const data = new Uint8Array(17);
  data[0] = tag;
  message.compiledInstructions = message.compiledInstructions.map((ci) =>
    keys[ci.programIdIndex as number]?.equals(RAYDIUM_V4_PROGRAM_ID) ? { ...ci, data } : ci,
  );
  resp.transaction.message = message;
  return resp;
}

/** SYNTHETIC (labeled): freeze both vault balances pre→post (claimed swap
 *  with no movement — conflicting evidence). */
function withVaultDeltasZeroed(fx: ReducedFixture): Record<string, unknown> {
  const resp = responseFrom(fx) as {
    transaction: { message: { getAccountKeys: (o?: unknown) => { keySegments(): ReadonlyArray<ReadonlyArray<PublicKey>> } } };
    meta: {
      preTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null;
      postTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null;
    };
  };
  const keys = resp.transaction.message.getAccountKeys({}).keySegments().flat();
  const vaultIdx = new Set<number>();
  keys.forEach((k, i) => {
    if (k.equals(COIN_VAULT) || k.equals(PC_VAULT)) vaultIdx.add(i);
  });
  const freeze = (entries: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null) =>
    entries?.map((e) =>
      vaultIdx.has(e.accountIndex) ? { ...e, uiTokenAmount: { ...e.uiTokenAmount, amount: "1000000" } } : e,
    ) ?? null;
  resp.meta.preTokenBalances = freeze(resp.meta.preTokenBalances);
  resp.meta.postTokenBalances = freeze(resp.meta.postTokenBalances);
  return resp;
}

interface Candidate {
  signature: string;
  response: Record<string, unknown> | null;
  blockTime?: number | null;
  slot?: number;
  confirmationStatus?: string | null;
}

class FakeRpc {
  private readonly poolBytes: Uint8Array | null;
  scanLimits: number[] = [];

  constructor(
    private readonly candidates: Candidate[],
    opts?: { poolAccountData?: Uint8Array | null },
  ) {
    this.poolBytes = opts !== undefined && "poolAccountData" in opts ? opts.poolAccountData : poolAccountBytes();
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  async getSignaturesForAddress(
    _address: PublicKey,
    opts?: { limit?: number },
  ): Promise<Array<{ signature: string; slot: bigint; blockTime: bigint | null; err: unknown; confirmationStatus: string | null }>> {
    this.scanLimits.push(opts?.limit ?? 1000);
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
    return this.candidates.find((c) => c.signature === signature)?.response ?? null;
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    if (this.poolBytes !== null && address.equals(POOL)) {
      return {
        lamports: 1_000_000,
        data: Buffer.from(this.poolBytes),
        owner: RAYDIUM_V4_PROGRAM_ID,
        executable: false,
        rentEpoch: 0n,
      } as unknown as AccountInfo<Uint8Array>;
    }
    return null;
  }

  async getSlot(): Promise<bigint> {
    return 1_000_000n;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const indexer = (opts: { ttlMs?: number } = {}) =>
  new ActivityIndexerLive({ cluster: "mainnet" as never, rpcUrl: "https://api.mainnet-beta.solana.com", ...opts });

/** A verified derivation over the REAL swap fixture (with a pinned
 *  blockTime so tests can reason about the exact anchor timestamp). */
const verifiedRpc = (blockTime = 1_700_000_100): FakeRpc =>
  new FakeRpc([{ signature: swapV2Outer.signature, response: responseFrom(swapV2Outer), slot: swapV2Outer.slot, blockTime }]);

/** An incomplete derivation: the candidate is not finalized, so the SDK
 *  fails closed with unresolved evidence (real fixture, labeled status
 *  mutation only). */
const incompleteRpc = (): FakeRpc =>
  new FakeRpc([
    { signature: swapV2Outer.signature, response: responseFrom(swapV2Outer), confirmationStatus: "processed" },
]);

describe("ActivityIndexerLive × canonical SDK evidence (IMPL-001)", () => {
  test("successful integration: verified swap propagates with provenance", async () => {
    const rpc = verifiedRpc();
    const ix = indexer();
    const evidence = await ix.indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "verified");
    assert.equal(evidence.definitive, true);
    assert.equal(evidence.noSwapFound, false);
    assert.equal(evidence.lastSwapUnixTs, 1_700_000_100);
    assert.equal(evidence.lastSwapSlot, swapV2Outer.slot);
    assert.equal(evidence.lastSwapSignature, swapV2Outer.signature);
    assert.equal(evidence.derivationKind, "swap");
    assert.equal(evidence.derivation.source, "deriveLastSwapEvidenceV4");
    assert.equal(evidence.derivation.signaturesScanned, 1, "records the ACTUAL scan size");
    assert.equal(evidence.derivation.scanReachedHistoryEnd, true);
  });

  test("derivationKind mirrors the evidence state (never a verified-swap label otherwise)", async () => {
    // Verified economic swap: labeled "swap" — the canonical economic-swap
    // derivation, never a bare amm-touch.
    const verified = await indexer().indexActivity(verifiedRpc().asConnection(), POOL, { scanLimit: 50 });
    assert.equal(verified.evidenceStatus, "verified");
    assert.equal(verified.derivationKind, "swap");

    // Definitive no-swap in a complete scan: NOT represented as a swap.
    const depositResponse = withTag(swapV2Outer, 3); // Deposit
    const noSwap = await indexer().indexActivity(
      new FakeRpc([{ signature: swapV2Outer.signature, response: depositResponse }]).asConnection(),
      POOL,
      { scanLimit: 50 },
    );
    assert.equal(noSwap.evidenceStatus, "no_swap_in_scan");
    assert.equal(noSwap.derivationKind, "no_swap", "a definitive no-swap is labeled no_swap");
    assert.notEqual(noSwap.derivationKind, "swap");

    // Incomplete evidence: unresolved — never represented as a swap.
    const incomplete = await indexer().indexActivity(incompleteRpc().asConnection(), POOL, { scanLimit: 50 });
    assert.equal(incomplete.evidenceStatus, "incomplete");
    assert.equal(incomplete.derivationKind, "unresolved", "incomplete evidence is labeled unresolved");
    assert.notEqual(incomplete.derivationKind, "swap");
  });

  test("liquidity operation does not reset inactivity (explicit no-swap, not a swap)", async () => {
    const depositResponse = withTag(swapV2Outer, 3); // Deposit
    const rpc = new FakeRpc([{ signature: swapV2Outer.signature, response: depositResponse }]);
    const evidence = await indexer().indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "no_swap_in_scan");
    assert.equal(evidence.definitive, true);
    assert.equal(evidence.noSwapFound, true);
    assert.equal(evidence.lastSwapUnixTs, 0);
    assert.equal(evidence.lastSwapSignature, "");
  });

  test("failed transaction does not reset inactivity (real failed fixture)", async () => {
    assert.notEqual(failedSwap.meta.err, null);
    const rpc = new FakeRpc([{ signature: failedSwap.signature, response: responseFrom(failedSwap) }]);
    const evidence = await indexer().indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "no_swap_in_scan");
    assert.equal(evidence.lastSwapUnixTs, 0);
  });

  test("non-finalized evidence is rejected and stays unresolved", async () => {
    const rpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: responseFrom(swapV2Outer), confirmationStatus: "confirmed" },
    ]);
    const evidence = await indexer().indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "incomplete");
    assert.equal(evidence.definitive, false);
    assert.equal(evidence.noSwapFound, false, "incomplete is not 'no swap'");
    assert.equal(evidence.lastSwapUnixTs, 0);
  });

  test("missing transaction data remains unresolved (fail-closed)", async () => {
    const rpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: null, blockTime: swapV2Outer.blockTime },
    ]);
    const evidence = await indexer().indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "incomplete");
    assert.equal(evidence.lastSwapUnixTs, 0);
  });

  test("conflicting evidence fails closed (claimed swap without vault movement)", async () => {
    const rpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: withVaultDeltasZeroed(swapV2Outer) },
    ]);
    const evidence = await indexer().indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "incomplete");
    assert.equal(evidence.definitive, false);
    assert.equal(evidence.lastSwapUnixTs, 0);
  });

  test("ambiguous evidence fails closed (unknown AMM tag)", async () => {
    const rpc = new FakeRpc([{ signature: swapV2Outer.signature, response: withTag(swapV2Outer, 200) }]);
    const evidence = await indexer().indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "incomplete");
    assert.equal(evidence.lastSwapUnixTs, 0);
  });

  test("incomplete (bounded) scan is never reported as complete", async () => {
    // Three non-swap candidates exist, but the scan stops at the limit of 2.
    const rpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: withTag(swapV2Outer, 3) },
      { signature: failedSwap.signature, response: responseFrom(failedSwap) },
      { signature: "5TUr6fM5gjkDkSg4pKLTBD99mPZtA9pSWhMD1A89gg4StvSq9ymntYyoXY1rno4yoJkuobqf2uVKe8yjaMiXXYED", response: responseFrom(readFixture("tx_swap_v0_alt_lookup")) },
    ]);
    const evidence = await indexer().indexActivity(rpc.asConnection(), POOL, { scanLimit: 2 });
    assert.equal(rpc.scanLimits[0], 2, "bounded-scan limit passed through unchanged");
    assert.equal(evidence.derivation.signaturesScanned, 2);
    assert.equal(evidence.derivation.scanReachedHistoryEnd, false);
    assert.equal(evidence.evidenceStatus, "incomplete");
    assert.equal(evidence.definitive, false);
    assert.equal(evidence.noSwapFound, false);
    assert.equal(evidence.lastSwapUnixTs, 0);
  });

  test("selects the newest verified economic swap across candidates", async () => {
    const rpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: withTag(swapV2Outer, 4) }, // newest: Withdraw
      { signature: failedSwap.signature, response: responseFrom(failedSwap) }, // older: failed swap
    ]);
    const evidence = await indexer().indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "no_swap_in_scan", "neither candidate is a verified swap");

    const rpc2 = new FakeRpc([
      { signature: failedSwap.signature, response: responseFrom(failedSwap) }, // newest: failed
      { signature: swapV2Outer.signature, response: responseFrom(swapV2Outer) }, // older: verified swap
    ]);
    const evidence2 = await indexer().indexActivity(rpc2.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence2.evidenceStatus, "verified");
    assert.equal(evidence2.lastSwapSignature, swapV2Outer.signature);
  });

  test("existing TTL cache and regression protection remain correct", async () => {
    const rpc = verifiedRpc();
    const ix = indexer();
    const first = await ix.indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(first.lastSwapUnixTs, 1_700_000_100);
    assert.equal(ix.size, 1);

    // Within the TTL, the cached definitive record is served WITHOUT a
    // re-derivation (existing freshness policy unchanged).
    const cached = await ix.indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(rpc.scanLimits.length, 1, "no re-derivation while the cache is fresh");
    assert.equal(cached.lastSwapUnixTs, 1_700_000_100);
    assert.equal(ix.isActivityStale(POOL, DEFAULT_ACTIVITY_TTL_MS, first.derivation.derivedAtUnixMs + 1_000), false);

    // Older verified refresh → the cache stays authoritative (regression rule).
    const olderRpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: responseFrom(swapV2Outer), blockTime: 1_699_000_000 },
    ]);
    const second = await ix.indexActivity(olderRpc.asConnection(), POOL, { forceRefresh: true, scanLimit: 50 });
    assert.equal(second.lastSwapUnixTs, 1_700_000_100, "cached record stays authoritative");
    assert.equal(second.evidenceStatus, "verified");
    assert.equal(ix.size, 1);

    // TTL expiry forces a fresh derivation of definitive results.
    const shortTtl = indexer({ ttlMs: 25 });
    const shortRpc = verifiedRpc();
    await shortTtl.indexActivity(shortRpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(shortRpc.scanLimits.length, 1);
    await sleep(40);
    const afterExpiry = await shortTtl.indexActivity(shortRpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(shortRpc.scanLimits.length, 2, "TTL expiry triggers a re-derivation");
    assert.equal(afterExpiry.evidenceStatus, "verified");
    assert.equal(shortTtl.size, 1);
  });
});

describe("Correction 002 §1 — incomplete refresh is the current result", () => {
  test("verified cache followed by an incomplete refresh returns an incomplete current result", async () => {
    // The indexer previously verified a swap (here: the real fixture swap);
    // a later refresh cannot resolve the evidence — the SDK correctly
    // returns "incomplete" (newer, unresolvable candidates may exist).
    const ix = indexer();
    const first = await ix.indexActivity(verifiedRpc().asConnection(), POOL, { scanLimit: 50 });
    assert.equal(first.evidenceStatus, "verified");

    const refresh = await ix.indexActivity(incompleteRpc().asConnection(), POOL, { forceRefresh: true, scanLimit: 50 });
    assert.equal(refresh.evidenceStatus, "incomplete", "the incomplete refresh IS the current result");
    assert.equal(refresh.definitive, false);
    assert.equal(refresh.lastSwapUnixTs, 0, "the old verified timestamp is not presented as current");
    assert.equal(refresh.lastSwapSignature, "");
    assert.equal(refresh.lastSwapSlot, 0);
    assert.equal(refresh.noSwapFound, false, "incomplete stays distinct from a definitive no-swap");
    assert.equal(ix.size, 0, "the stale verified record no longer sits in the current cache");
  });

  test("definitive no-swap cache followed by an incomplete refresh returns incomplete", async () => {
    const depositResponse = withTag(swapV2Outer, 3); // Deposit — provably not a swap
    const ix = indexer();
    const first = await ix.indexActivity(
      new FakeRpc([{ signature: swapV2Outer.signature, response: depositResponse }]).asConnection(),
      POOL,
      { scanLimit: 50 },
    );
    assert.equal(first.evidenceStatus, "no_swap_in_scan");
    assert.equal(first.noSwapFound, true);

    const refresh = await ix.indexActivity(incompleteRpc().asConnection(), POOL, { forceRefresh: true, scanLimit: 50 });
    assert.equal(refresh.evidenceStatus, "incomplete", "incomplete refresh is not upgraded to the cached no-swap");
    assert.equal(refresh.definitive, false);
    assert.equal(refresh.lastSwapUnixTs, 0);
    assert.equal(refresh.noSwapFound, false, "the refresh result is not the cached definitive no-swap");
  });

  test("previous verified evidence is retained for diagnostics only, never served as current", async () => {
    const verified = verifiedRpc();
    const failing = incompleteRpc();
    const ix = indexer();
    const first = await ix.indexActivity(verified.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(first.evidenceStatus, "verified");

    await ix.indexActivity(failing.asConnection(), POOL, { forceRefresh: true, scanLimit: 50 });

    // Diagnostics view: the last-known definitive record is retained with
    // its OWN honest provenance (original derivation timestamp + anchor).
    const diagnostics = ix.lastKnownDefinitiveEvidence(POOL);
    assert.notEqual(diagnostics, null, "last-known verified evidence is retained for diagnostics");
    assert.equal(diagnostics!.evidenceStatus, "verified");
    assert.equal(diagnostics!.lastSwapUnixTs, first.lastSwapUnixTs);
    assert.equal(diagnostics!.lastSwapSignature, first.lastSwapSignature);
    assert.equal(
      diagnostics!.derivation.derivedAtUnixMs,
      first.derivation.derivedAtUnixMs,
      "the retained record keeps its original derivation timestamp (no freshness misrepresentation)",
    );

    // …and it is NEVER served as current: the next request re-derives.
    const scanCount = failing.scanLimits.length;
    const third = await ix.indexActivity(failing.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(failing.scanLimits.length, scanCount + 1, "a fresh evidence attempt was made");
    assert.equal(third.evidenceStatus, "incomplete", "the retained diagnostic record is not served as current");
  });

  test("incomplete results are never cached for the normal TTL", async () => {
    const rpc = incompleteRpc();
    const ix = indexer({ ttlMs: DEFAULT_ACTIVITY_TTL_MS });
    const first = await ix.indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(first.evidenceStatus, "incomplete");
    assert.equal(ix.size, 0, "the incomplete result is not cached as current");

    // A request inside the normal TTL window is NOT suppressed by the
    // earlier incomplete result — it performs a fresh evidence attempt.
    const second = await ix.indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(rpc.scanLimits.length, 2, "no TTL-based retry suppression for incomplete results");
    assert.equal(second.evidenceStatus, "incomplete");
    assert.equal(ix.size, 0);
    assert.equal(
      ix.lastKnownDefinitiveEvidence(POOL),
      null,
      "no definitive record exists, so none is retained",
    );
  });

  test("a subsequent request after an incomplete refresh can retry and recover", async () => {
    const failing = incompleteRpc();
    const ix = indexer();
    const first = await ix.indexActivity(failing.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(first.evidenceStatus, "incomplete", "transient incomplete refresh (e.g. RPC hiccup)");

    // The transient failure does not suppress the next evidence attempt:
    // a fresh derivation over the recovered RPC verifies the swap.
    const second = await ix.indexActivity(verifiedRpc().asConnection(), POOL, { scanLimit: 50 });
    assert.equal(second.evidenceStatus, "verified");
    assert.equal(second.lastSwapUnixTs, 1_700_000_100);
    assert.equal(ix.size, 1, "the definitive result is cached again under the normal TTL");
  });

  test("a verified result remains usable under the existing freshness policy", async () => {
    const rpc = verifiedRpc();
    const ix = indexer();
    const first = await ix.indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });

    const cached = await ix.indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(rpc.scanLimits.length, 1, "definitive results are still cached under the normal TTL");
    assert.equal(cached.evidenceStatus, "verified");
    assert.equal(cached.lastSwapUnixTs, first.lastSwapUnixTs);
    assert.equal(ix.isActivityStale(POOL, DEFAULT_ACTIVITY_TTL_MS, first.derivation.derivedAtUnixMs + 1_000), false);

    const gate = evaluateAttestationGate(cached, {
      maxAgeMs: DEFAULT_ACTIVITY_TTL_MS,
      nowUnixMs: first.derivation.derivedAtUnixMs + 1_000,
    });
    assert.equal(gate.ok, true, "fresh verified evidence passes the attestation gate");
  });
});

describe("Correction 002 §2 — attestation gate", () => {
  test("passes a real verified, definitive, fresh record (integration-derived)", async () => {
    const evidence = await indexer().indexActivity(verifiedRpc().asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "verified");
    const gate = evaluateAttestationGate(evidence, {
      maxAgeMs: DEFAULT_ACTIVITY_TTL_MS,
      nowUnixMs: evidence.derivation.derivedAtUnixMs + 1_000,
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.ok && gate.activity, evidence);
  });

  test("rejects incomplete evidence (real derivation, task 7)", async () => {
    const evidence = await indexer().indexActivity(incompleteRpc().asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "incomplete");
    const gate = evaluateAttestationGate(evidence, { maxAgeMs: DEFAULT_ACTIVITY_TTL_MS });
    assert.equal(gate.ok, false);
    assert.ok(!gate.ok);
    assert.equal(gate.reason, "incomplete_evidence");
  });

  test("rejects non-definitive evidence (real no-swap + synthetic mutation, task 8)", async () => {
    const depositResponse = withTag(swapV2Outer, 3);
    const noSwap = await indexer().indexActivity(
      new FakeRpc([{ signature: swapV2Outer.signature, response: depositResponse }]).asConnection(),
      POOL,
      { scanLimit: 50 },
    );
    assert.equal(noSwap.evidenceStatus, "no_swap_in_scan");
    assert.equal(noSwap.definitive, true, "no-swap CAN be definitive — but it is not a verified last swap");
    const noSwapGate = evaluateAttestationGate(noSwap, { maxAgeMs: DEFAULT_ACTIVITY_TTL_MS });
    assert.equal(noSwapGate.ok, false);
    assert.ok(!noSwapGate.ok);
    assert.equal(noSwapGate.reason, "not_verified", "a definitive no-swap cannot support a last-swap attestation");

    // SYNTHETIC (labeled): a verified record flipped to non-definitive.
    const verified = await indexer().indexActivity(verifiedRpc().asConnection(), POOL, { scanLimit: 50 });
    const nonDefinitive: ActivityEvidence = { ...verified, definitive: false };
    const gate = evaluateAttestationGate(nonDefinitive, { maxAgeMs: DEFAULT_ACTIVITY_TTL_MS });
    assert.equal(gate.ok, false);
    assert.ok(!gate.ok);
    assert.equal(gate.reason, "not_definitive");
  });

  test("rejects missing evidence (task 8)", () => {
    for (const missing of [null, undefined] as const) {
      const gate = evaluateAttestationGate(missing, { maxAgeMs: DEFAULT_ACTIVITY_TTL_MS });
      assert.equal(gate.ok, false);
      assert.ok(!gate.ok);
      assert.equal(gate.reason, "missing_evidence");
    }
  });

  test("rejects malformed evidence (task 8)", async () => {
    const verified = await indexer().indexActivity(verifiedRpc().asConnection(), POOL, { scanLimit: 50 });
    const incomplete = await indexer().indexActivity(incompleteRpc().asConnection(), POOL, { scanLimit: 50 });

    const malformed: Array<[ActivityEvidence, string]> = [
      // Status literal outside the D4/D5 set.
      [{ ...verified, evidenceStatus: "verified " as unknown as ActivityEvidence["evidenceStatus"] }, "bad status literal"],
      // Wrong primitive types.
      [{ ...verified, definitive: "true" as unknown as boolean }, "definitive not boolean"],
      [{ ...verified, lastSwapUnixTs: "1700000100" as unknown as number }, "timestamp not a number"],
      // A verified claim without a real last-swap anchor.
      [{ ...verified, lastSwapUnixTs: 0 }, "verified without anchor ts"],
      [{ ...verified, lastSwapSignature: "" }, "verified without anchor signature"],
      // Missing derivation context.
      [{ ...verified, derivation: undefined as unknown as ActivityEvidence["derivation"] }, "missing derivation"],
      // A stale timestamp smuggled into a non-verified record — the exact
      // shape that would convert an incomplete refresh into seemingly
      // current inactivity evidence.
      [
        { ...incomplete, lastSwapUnixTs: verified.lastSwapUnixTs, lastSwapSignature: verified.lastSwapSignature },
        "smuggled timestamp on incomplete record",
      ],
    ];
    for (const [record, what] of malformed) {
      const gate = evaluateAttestationGate(record, { maxAgeMs: DEFAULT_ACTIVITY_TTL_MS });
      assert.equal(gate.ok, false, `gate must reject: ${what}`);
      assert.ok(!gate.ok);
      assert.equal(gate.reason, "malformed_evidence", what);
    }
  });

  test("rejects evidence whose derivationKind misrepresents the state (Correction 003)", async () => {
    const verified = await indexer().indexActivity(verifiedRpc().asConnection(), POOL, { scanLimit: 50 });
    const incomplete = await indexer().indexActivity(incompleteRpc().asConnection(), POOL, { scanLimit: 50 });
    const depositResponse = withTag(swapV2Outer, 3);
    const noSwap = await indexer().indexActivity(
      new FakeRpc([{ signature: swapV2Outer.signature, response: depositResponse }]).asConnection(),
      POOL,
      { scanLimit: 50 },
    );
    assert.equal(noSwap.evidenceStatus, "no_swap_in_scan");

    // Both mislabeling directions are malformed: a non-verified record
    // labeled "swap" would present no-swap or unresolved evidence as a
    // verified economic swap; a verified record carrying another label is
    // equally inconsistent with its own state.
    const mislabeled: Array<[ActivityEvidence, string]> = [
      [{ ...incomplete, derivationKind: "swap" }, "incomplete labeled as swap"],
      [{ ...noSwap, derivationKind: "swap" }, "definitive no-swap labeled as swap"],
      [{ ...verified, derivationKind: "unresolved" }, "verified labeled as unresolved"],
      [{ ...verified, derivationKind: "no_swap" }, "verified labeled as no_swap"],
      [{ ...verified, derivationKind: "unknown" as unknown as ActivityEvidence["derivationKind"] }, "unknown label"],
    ];
    for (const [record, what] of mislabeled) {
      const gate = evaluateAttestationGate(record, { maxAgeMs: DEFAULT_ACTIVITY_TTL_MS });
      assert.equal(gate.ok, false, `gate must reject: ${what}`);
      assert.ok(!gate.ok);
      assert.equal(gate.reason, "malformed_evidence", what);
    }
  });

  test("rejects stale evidence that has not been successfully refreshed (task 9)", async () => {
    const verified = await indexer().indexActivity(verifiedRpc().asConnection(), POOL, { scanLimit: 50 });
    const gate = evaluateAttestationGate(verified, {
      maxAgeMs: DEFAULT_ACTIVITY_TTL_MS,
      nowUnixMs: verified.derivation.derivedAtUnixMs + DEFAULT_ACTIVITY_TTL_MS + 1,
    });
    assert.equal(gate.ok, false);
    assert.ok(!gate.ok);
    assert.equal(gate.reason, "stale_evidence");
  });

  test("a stale cached timestamp cannot pass the attestation gate after a failed refresh (task 9)", async () => {
    // The indexer verified a swap; the refresh then failed closed. The
    // old timestamp survives ONLY in the diagnostics view — the CURRENT
    // result is incomplete, and that is what the collect path evaluates.
    const ix = indexer();
    const first = await ix.indexActivity(verifiedRpc().asConnection(), POOL, { scanLimit: 50 });
    const current = await ix.indexActivity(incompleteRpc().asConnection(), POOL, { forceRefresh: true, scanLimit: 50 });

    assert.equal(current.evidenceStatus, "incomplete");
    const currentGate = evaluateAttestationGate(current, { maxAgeMs: DEFAULT_ACTIVITY_TTL_MS });
    assert.equal(currentGate.ok, false);
    assert.ok(!currentGate.ok);
    assert.equal(currentGate.reason, "incomplete_evidence");

    // The retained record is diagnostics-only; even it is rejected once it
    // ages past the freshness policy.
    const diagnostics = ix.lastKnownDefinitiveEvidence(POOL);
    assert.notEqual(diagnostics, null);
    assert.equal(diagnostics!.lastSwapUnixTs, first.lastSwapUnixTs, "old timestamp retained for diagnostics only");
    const staleDiagnosticGate = evaluateAttestationGate(diagnostics!, {
      maxAgeMs: DEFAULT_ACTIVITY_TTL_MS,
      nowUnixMs: diagnostics!.derivation.derivedAtUnixMs + DEFAULT_ACTIVITY_TTL_MS + 1,
    });
    assert.equal(staleDiagnosticGate.ok, false);
    assert.ok(!staleDiagnosticGate.ok);
    assert.equal(staleDiagnosticGate.reason, "stale_evidence");
  });
});

// ─── Collect path end-to-end (IMPL-001 Correction 002 §2) ──────────────────

/** Minimal destination-cluster fake: enough for issuance (getSlot +
 *  getBlock for the slot hash); everything else absent. Records every
 *  call so tests can prove the gate runs BEFORE any devnet contact. */
class FakeDevnetRpc {
  calls: string[] = [];
  asConnection(): Connection {
    return this as unknown as Connection;
  }
  async getSlot(_commitment?: unknown): Promise<bigint> {
    this.calls.push("getSlot");
    return 1_000_000n;
  }
  async getBlock(slot: number, _opts?: Record<string, unknown>): Promise<{ blockhash: string } | null> {
    this.calls.push(`getBlock:${slot}`);
    return { blockhash: "11111111111111111111111111111111" };
  }
  async getAccountInfo(_address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    this.calls.push("getAccountInfo");
    return null;
  }
}

function collectConfig(dataDir: string): PipelineConfig {
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

function withTempDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "grave-indexer-collect-"));
  return fn(dataDir).finally(() => rmSync(dataDir, { recursive: true, force: true }));
}

describe("Correction 002 — collect path attestation gating (end-to-end)", () => {
  test("incomplete evidence issues NOTHING: no bundle, no devnet contact", async () => {
    await withTempDataDir(async (dataDir) => {
      const devnet = new FakeDevnetRpc();
      const code = await cmdCollect(collectConfig(dataDir), {
        pool: POOL.toBase58(),
        useEphemeralOracle: true,
        discoveryConnection: incompleteRpc().asConnection(),
        verificationConnection: devnet.asConnection(),
      });
      assert.equal(code, 1, "collect reports no issuance");
      const evidenceDir = join(dataDir, "evidence");
      assert.ok(existsSync(evidenceDir));
      assert.equal(readdirSync(evidenceDir).length, 0, "no evidence bundle was written");
      assert.equal(devnet.calls.length, 0, "the gate rejected the evidence BEFORE any issuance attempt");
    });
  });

  test("verified evidence still flows through the gate and issues a bundle", async () => {
    await withTempDataDir(async (dataDir) => {
      const devnet = new FakeDevnetRpc();
      const code = await cmdCollect(collectConfig(dataDir), {
        pool: POOL.toBase58(),
        useEphemeralOracle: true,
        discoveryConnection: verifiedRpc().asConnection(),
        verificationConnection: devnet.asConnection(),
      });
      assert.equal(code, 0, "verified evidence issues a bundle");
      assert.ok(devnet.calls.some((c) => c.startsWith("getSlot")), "issuance was attempted on the destination cluster");
      const files = readdirSync(join(dataDir, "evidence"));
      assert.deepEqual(files, [`evidence-${POOL.toBase58()}.json`]);
      assert.ok(files[0] !== undefined, "the bundle file exists");
      const bundle = JSON.parse(readFileSync(join(dataDir, "evidence", files[0]), "utf8")) as {
        activity: { lastSwapUnixTs: number; lastSwapSignature: string };
        attestation: { signatureHex: string };
      };
      assert.equal(bundle.activity.lastSwapUnixTs, 1_700_000_100, "the bundle carries the verified anchor");
      assert.equal(bundle.activity.lastSwapSignature, swapV2Outer.signature);
      assert.ok(bundle.attestation.signatureHex.length > 0);
    });
  });

  test("issuance itself refuses a missing last-swap anchor (defense in depth)", async () => {
    await withTempDataDir(async (dataDir) => {
      const devnet = new FakeDevnetRpc();
      // A pool whose scan covers only provably non-swap transactions: the
      // gate rejects it (not_verified) before issuance is ever attempted.
      const code = await cmdCollect(collectConfig(dataDir), {
        pool: POOL.toBase58(),
        useEphemeralOracle: true,
        discoveryConnection: new FakeRpc([
          { signature: swapV2Outer.signature, response: withTag(swapV2Outer, 3) }, // Deposit
        ]).asConnection(),
        verificationConnection: devnet.asConnection(),
      });
      assert.equal(code, 1);
      assert.equal(readdirSync(join(dataDir, "evidence")).length, 0, "no bundle without a verified anchor");
      assert.equal(devnet.calls.length, 0);
    });
  });
});
