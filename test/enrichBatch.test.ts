// SPDX-License-Identifier: Apache-2.0
//
// enrichBatch — cross-pool grouped enrichment reads (Option 2, Part 2
// item 4): request construction, per-pool extraction, per-pool failure
// isolation, envelope-failure fail-closed semantics, and the conservative
// group bound.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PublicKey } from "@solana/web3.js";

import {
  DEFAULT_POOLS_PER_BATCH,
  READS_PER_POOL,
  buildGroupedRequests,
  extractPoolFacts,
  fetchGroupedPoolReadOutcomes,
} from "../src/enrichBatch.js";
import { DEFAULT_BATCH_MAX_ITEMS, type BatchItemOutcome, type BatchRequest } from "../src/rpcBatching.js";
import { synth } from "./fixtures.js";

const ok = (result: unknown, id: number): BatchItemOutcome => ({ ok: true, result, id });
const unresolved = (reason: BatchItemOutcome extends never ? never : string, detail: string, id: number): BatchItemOutcome =>
  ({ ok: false, unresolved: true, reason, detail, id }) as BatchItemOutcome;

const pools = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    address: synth(0x30 + i).toBase58(),
    wsolVault: synth(0x40 + i),
    memecoinVault: synth(0x50 + i),
    memecoinMint: synth(0x60 + i),
    lpMint: synth(0x70 + i),
  }));

const valueResult = (amount: string): unknown => ({ value: { amount, decimals: 9, uiAmount: 1 } });
const supplyResult = (amount: string, decimals: number): unknown => ({ value: { amount, decimals, uiAmountString: "" } });

describe("enrichBatch — request construction", () => {
  test("each pool contributes a contiguous 4-read block with unique ids", () => {
    const requests = buildGroupedRequests(pools(3));
    assert.equal(requests.length, 12);
    assert.deepEqual(
      requests.map((r) => r.id),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
    // Pool 0's reads: wsol balance, memecoin balance, memecoin supply, LP supply.
    assert.deepEqual(
      requests.slice(0, 4).map((r) => r.method),
      ["getTokenAccountBalance", "getTokenAccountBalance", "getTokenSupply", "getTokenSupply"],
    );
    const req0 = requests[0] as Required<BatchRequest>;
    const req4 = requests[4] as Required<BatchRequest>;
    assert.equal((req0.params as string[])[0], synth(0x40).toBase58());
    assert.equal((req4.params as string[])[0], synth(0x41).toBase58());
  });

  test("the default group is derived from the conservative batch bound (5 pools × 4 reads = 20 items)", () => {
    assert.equal(DEFAULT_BATCH_MAX_ITEMS, 20);
    assert.equal(READS_PER_POOL, 4);
    assert.equal(DEFAULT_POOLS_PER_BATCH, 5);
  });

  test("oversized groups are rejected before any HTTP call", async () => {
    await assert.rejects(
      fetchGroupedPoolReadOutcomes({ rpcUrl: "https://mainnet.helius-rpc.com", pools: pools(6) }),
      /exceed poolsPerBatch/,
    );
    await assert.rejects(
      fetchGroupedPoolReadOutcomes({ rpcUrl: "https://mainnet.helius-rpc.com", pools: pools(1), poolsPerBatch: 0 }),
      /poolsPerBatch/,
    );
  });
});

describe("enrichBatch — per-pool extraction", () => {
  test("facts map 1:1 to each pool's contiguous block", () => {
    const outcomes = pools(2).flatMap((_p, i) => [
      ok(valueResult("600000000"), i * 4 + 0),
      ok(valueResult("1000000"), i * 4 + 1),
      ok(supplyResult("999000000", 6), i * 4 + 2),
      ok(valueResult("5000000"), i * 4 + 3),
    ]);
    const facts0 = extractPoolFacts(outcomes, 0);
    assert.deepEqual(facts0, { wsolAmount: "600000000", memecoinAmount: "1000000", memecoinDecimals: 6, lpAmount: "5000000" });
    const facts1 = extractPoolFacts(outcomes, 1);
    assert.deepEqual(facts1, { wsolAmount: "600000000", memecoinAmount: "1000000", memecoinDecimals: 6, lpAmount: "5000000" });
  });

  test("a malformed amount is UNRESOLVED — never a zero", () => {
    const outcomes = [ok({ value: { decimals: 9 } }, 0), ok(valueResult("1"), 1), ok(supplyResult("1", 6), 2), ok(valueResult("1"), 3)];
    assert.throws(() => extractPoolFacts(outcomes, 0), /malformed \(no exact amount string\) — unresolved, never zero/);
  });

  test("a per-item failure fails ONLY its own pool", () => {
    const outcomes = [
      unresolved("item_rpc_error", "boom", 0),
      ok(valueResult("1"), 1),
      ok(supplyResult("1", 6), 2),
      ok(valueResult("1"), 3),
      ok(valueResult("2"), 4),
      ok(valueResult("2"), 5),
      ok(supplyResult("2", 6), 6),
      ok(valueResult("2"), 7),
    ];
    assert.throws(() => extractPoolFacts(outcomes, 0), /wsol vault balance unresolved \(item_rpc_error\)/);
    const facts1 = extractPoolFacts(outcomes, 1);
    assert.equal(facts1.wsolAmount, "2", "the second pool's facts are untouched by the first pool's failure");
  });

  test("a missing outcome block is response_missing — never a negative result", () => {
    assert.throws(() => extractPoolFacts([], 0), /response_missing/);
  });
});

describe("enrichBatch — grouped fetch", () => {
  test("one executor call carries the whole group; outcomes return in request order", async () => {
    const seenBatches: BatchRequest[][] = [];
    const outcomes = await fetchGroupedPoolReadOutcomes({
      rpcUrl: "https://mainnet.helius-rpc.com",
      pools: pools(3),
      executeBatch: async (_url, requests) => {
        seenBatches.push([...requests]);
        return pools(3).flatMap((_p, i) => [
          ok(valueResult(String(100 + i)), i * 4 + 0),
          ok(valueResult(String(200 + i)), i * 4 + 1),
          ok(supplyResult("1", i), i * 4 + 2),
          ok(valueResult(String(300 + i)), i * 4 + 3),
        ]);
      },
    });
    assert.equal(seenBatches.length, 1, "exactly ONE HTTP batch for the whole group");
    assert.equal(seenBatches[0]!.length, 12);
    assert.equal(outcomes.length, 12);
  });
});
