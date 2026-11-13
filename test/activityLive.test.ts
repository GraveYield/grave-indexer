// SPDX-License-Identifier: Apache-2.0
//
// IMPL-001 Phase B — ActivityIndexerLive integration tests.
//
// Exercises the ACTUAL integration path: the indexer's `indexActivity`
// through the vendored SDK's canonical `deriveLastSwapEvidenceV4` (D4/D5),
// against the same real mainnet fixture corpus the SDK tests use
// (vendor/protocol/sdk/test/fixtures/lastSwap — provenance documented
// there). Synthetic edge cases are labeled mutations of those real
// fixtures, built in code.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PublicKey, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";

import { RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";

import { ActivityIndexerLive, type ActivityEvidence } from "../src/activityLive.js";

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

const indexer = (cluster = "mainnet", rpcUrl = "https://api.mainnet-beta.solana.com") =>
  new ActivityIndexerLive({ cluster: cluster as never, rpcUrl });

describe("ActivityIndexerLive × canonical SDK evidence (IMPL-001)", () => {
  test("successful integration: verified swap propagates with provenance", async () => {
    const rpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: responseFrom(swapV2Outer), slot: swapV2Outer.slot },
    ]);
    const ix = indexer();
    const evidence = await ix.indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(evidence.evidenceStatus, "verified");
    assert.equal(evidence.definitive, true);
    assert.equal(evidence.noSwapFound, false);
    assert.equal(evidence.lastSwapUnixTs, swapV2Outer.blockTime);
    assert.equal(evidence.lastSwapSlot, swapV2Outer.slot);
    assert.equal(evidence.lastSwapSignature, swapV2Outer.signature);
    assert.equal(evidence.derivationKind, "swap");
    assert.equal(evidence.derivation.source, "deriveLastSwapEvidenceV4");
    assert.equal(evidence.derivation.signaturesScanned, 1, "records the ACTUAL scan size");
    assert.equal(evidence.derivation.scanReachedHistoryEnd, true);
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

  test("existing bounded-scan behavior intact: cache + TTL + regression rule", async () => {
    const rpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: responseFrom(swapV2Outer), blockTime: 1_700_000_100 },
    ]);
    const ix = indexer();
    const first = await ix.indexActivity(rpc.asConnection(), POOL, { scanLimit: 50 });
    assert.equal(first.lastSwapUnixTs, 1_700_000_100);
    assert.equal(ix.size, 1);

    // Older refresh → the cache stays authoritative (regression rule).
    const olderRpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: responseFrom(swapV2Outer), blockTime: 1_699_000_000 },
    ]);
    const second = await ix.indexActivity(olderRpc.asConnection(), POOL, { forceRefresh: true, scanLimit: 50 });
    assert.equal(second.lastSwapUnixTs, 1_700_000_100, "cached record stays authoritative");
    assert.equal(second.evidenceStatus, "verified");

    // Incomplete refresh with a verified cache → cache stays authoritative.
    const incompleteRpc = new FakeRpc([
      { signature: swapV2Outer.signature, response: responseFrom(swapV2Outer), confirmationStatus: "processed" },
    ]);
    const third = await ix.indexActivity(incompleteRpc.asConnection(), POOL, { forceRefresh: true, scanLimit: 50 });
    assert.equal(third.evidenceStatus, "verified", "cached verified record wins over incomplete refresh");
    assert.equal(third.lastSwapUnixTs, 1_700_000_100);
  });

  test("attestation gate semantics: collect-path skip condition never fires on incomplete-as-complete", async () => {
    // Mirrors cli.ts: `activity.noSwapFound || activity.lastSwapUnixTs <= 0`
    // must hold for BOTH no-swap and incomplete evidence.
    const incomplete = {
      noSwapFound: false,
      lastSwapUnixTs: 0,
      evidenceStatus: "incomplete",
    } as ActivityEvidence;
    assert.equal(incomplete.noSwapFound || incomplete.lastSwapUnixTs <= 0, true);
    const noSwap = {
      noSwapFound: true,
      lastSwapUnixTs: 0,
      evidenceStatus: "no_swap_in_scan",
    } as ActivityEvidence;
    assert.equal(noSwap.noSwapFound || noSwap.lastSwapUnixTs <= 0, true);
    const verified = {
      noSwapFound: false,
      lastSwapUnixTs: 1_700_000_000,
      evidenceStatus: "verified",
    } as ActivityEvidence;
    assert.equal(verified.noSwapFound || verified.lastSwapUnixTs <= 0, false);
  });
});
