// SPDX-License-Identifier: Apache-2.0
//
// rpcBatching — validated JSON-RPC batch execution. Every failure mode
// (per-item errors, missing items, duplicate/unmatched ids, malformed
// envelopes) is an explicit UNRESOLVED outcome — never a negative result,
// never a fabricated success.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  batchJsonRpc,
  DEFAULT_BATCH_MAX_ITEMS,
  validateBatchResponses,
  type BatchRequest,
} from "../src/rpcBatching.js";
import { RpcRetryExhaustedError } from "../src/rpcTransport.js";

const T = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, deadlineMs: 1_000, rng: () => 0, sleep: () => Promise.resolve() };

const reqs = (n: number, method = "getTokenSupply"): BatchRequest[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, method, params: ["mint"] }));

/** Batch response for a subset of ids. */
const batchRes = (ids: Array<{ id: number; result?: unknown; error?: unknown }>): Response =>
  new Response(
    JSON.stringify(
      ids.map((e) => ({ jsonrpc: "2.0", id: e.id, ...(e.error !== undefined ? { error: e.error } : { result: e.result }) })),
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("rpcBatching — validation matrix", () => {
  test("happy path: ordered outcomes map 1:1 to request ids", async () => {
    const outcomes = await batchJsonRpc(
      "https://api.mainnet-beta.solana.com",
      reqs(3),
      { ...T, fetchImpl: (async () => batchRes([
        { id: 2, result: { value: { amount: "3" } } },
        { id: 0, result: { value: { amount: "1" } } },
        { id: 1, result: { value: { amount: "2" } } },
      ])) as typeof fetch },
    );
    assert.equal(outcomes.length, 3);
    assert.deepEqual(outcomes.map((o) => (o.ok ? o.result : null)), [
      { value: { amount: "1" } },
      { value: { amount: "2" } },
      { value: { amount: "3" } },
    ]);
  });

  test("a MISSING response is unresolved — never a negative result", async () => {
    const outcomes = await batchJsonRpc(
      "https://api.mainnet-beta.solana.com",
      reqs(3),
      { ...T, fetchImpl: (async () => batchRes([{ id: 0, result: {} }])) as typeof fetch },
    );
    assert.equal(outcomes[0]!.ok, true);
    assert.equal(outcomes[1]!.ok, false);
    assert.equal(outcomes[2]!.ok, false);
    assert.equal(outcomes[1]!.ok === false ? outcomes[1]!.reason : "", "response_missing");
    assert.ok(outcomes[1]!.ok === false && outcomes[1]!.detail.includes("UNRESOLVED, never a negative result"));
  });

  test("per-item RPC errors are captured as item_rpc_error", async () => {
    const outcomes = await batchJsonRpc(
      "https://api.mainnet-beta.solana.com",
      reqs(2),
      { ...T, fetchImpl: (async () => batchRes([
        { id: 0, result: {} },
        { id: 1, error: { code: -32005, message: "Too many requests" } },
      ])) as typeof fetch },
    );
    assert.equal(outcomes[1]!.ok, false);
    assert.equal(outcomes[1]!.ok === false ? outcomes[1]!.reason : "", "item_rpc_error");
  });

  test("duplicate responses for one id are ambiguous → unresolved", async () => {
    const outcomes = await batchJsonRpc(
      "https://api.mainnet-beta.solana.com",
      reqs(2),
      { ...T, fetchImpl: (async () => new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 0, result: {} },
          { jsonrpc: "2.0", id: 0, result: {} },
          { jsonrpc: "2.0", id: 1, result: {} },
        ]),
        { status: 200 },
      )) as typeof fetch },
    );
    assert.equal(outcomes[0]!.ok, false);
    assert.equal(outcomes[0]!.ok === false ? outcomes[0]!.reason : "", "response_id_duplicate");
    assert.equal(outcomes[1]!.ok, true);
  });

  test("a non-array envelope marks every item envelope_malformed", async () => {
    const outcomes = await batchJsonRpc(
      "https://api.mainnet-beta.solana.com",
      reqs(2),
      { ...T, fetchImpl: (async () => new Response(JSON.stringify({ error: { code: -32600 } }), { status: 200 })) as typeof fetch },
    );
    assert.equal(outcomes.length, 2);
    for (const o of outcomes) {
      assert.equal(o.ok, false);
      assert.equal(o.ok === false ? o.reason : "", "envelope_malformed");
    }
  });

  test("a batch transport failure marks EVERY item unresolved (typed reason, no negative results)", async () => {
    const outcomes = await batchJsonRpc(
      "https://api.mainnet-beta.solana.com",
      reqs(2),
      { ...T, fetchImpl: (async () => {
        throw new RpcRetryExhaustedError("public-rpc", 2, 429, false);
      }) as typeof fetch },
    );
    for (const o of outcomes) {
      assert.equal(o.ok, false);
      assert.equal(o.ok === false ? o.reason : "", "envelope_request_failed");
      assert.ok(o.ok === false && o.detail.includes("RpcRetryExhaustedError"));
    }
  });

  test("unmatched extra ids in the response are ignored; unmatched REQUESTS stay unresolved", async () => {
    const outcomes = await batchJsonRpc(
      "https://api.mainnet-beta.solana.com",
      reqs(1),
      { ...T, fetchImpl: (async () => batchRes([
        { id: 0, result: {} },
        { id: 99, result: { injected: true } },
      ])) as typeof fetch },
    );
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.ok, true);
  });

  test("oversized batches are rejected before any HTTP call", async () => {
    await assert.rejects(
      batchJsonRpc("https://api.mainnet-beta.solana.com", reqs(DEFAULT_BATCH_MAX_ITEMS + 1), {
        ...T,
        fetchImpl: (async () => {
          throw new Error("must not be called");
        }) as typeof fetch,
      }),
      /exceeds maxBatchItems/,
    );
  });

  test("duplicate request ids are rejected before any HTTP call", async () => {
    await assert.rejects(
      batchJsonRpc("https://api.mainnet-beta.solana.com", [
        { id: 7, method: "getTokenSupply", params: [] },
        { id: 7, method: "getTokenSupply", params: [] },
      ], { ...T, fetchImpl: (async () => new Response("[]", { status: 200 })) as typeof fetch }),
      /duplicate batch request id/,
    );
  });

  test("an empty batch returns an empty outcome list", async () => {
    assert.deepEqual(await batchJsonRpc("https://api.mainnet-beta.solana.com", [], T), []);
  });
});

describe("rpcBatching — validateBatchResponses (pure)", () => {
  test("result field missing vs undefined are distinct unresolved reasons", () => {
    const out = validateBatchResponses([{ id: 0, method: "m" }, { id: 1, method: "m" }], [
      { jsonrpc: "2.0", id: 0 },
      { jsonrpc: "2.0", id: 1, result: undefined },
    ]);
    assert.equal(out[0]!.ok === false ? out[0]!.reason : "", "item_result_missing");
    assert.equal(out[1]!.ok === false ? out[1]!.reason : "", "item_result_malformed");
  });
});
