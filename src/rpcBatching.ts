// SPDX-License-Identifier: Apache-2.0
//
// Validated JSON-RPC batching (Option 2 — Part 1 item D).
//
// Batches supported, safe, read-only methods (getBalance-style value
// methods such as getTokenAccountBalance / getTokenSupply) into ONE
// HTTP JSON-RPC array request, then VALIDATES the response exhaustively:
//
//   * the HTTP body must parse as a JSON array;
//   * every response must carry a well-formed `id` that maps 1:1 to a
//     request id — duplicates, unknown ids, and missing ids are detected;
//   * per-item RPC error objects are captured as per-item failures;
//   * malformed results are captured as per-item failures;
//   * the batch envelope itself may fail (HTTP error, exhausted retries,
//     malformed array) — in that case EVERY item is returned UNRESOLVED
//     with the typed envelope reason.
//
// A MISSING response is NEVER interpreted as a negative result: an item
// without a validated response is `unresolved` — the caller must treat
// unresolved enrichment facts as stage failures (fail-closed), never as
// zeros and never as evidence of absence.
//
// Batch limits are NOT assumed from provider documentation: the batch
// size is a conservative local bound (env-overridable) and callers
// must probe provider behavior before raising it (measured, not assumed).

import { endpointKindFor, type EndpointKind } from "./provenance.js";
import { rpcJsonRequest, type RpcTransportOptions } from "./rpcTransport.js";

/** Conservative local batch-size bound. Providers differ; do not raise
 *  without a live probe (documented in docs/OPTION2_FINDINGS.md). */
export const DEFAULT_BATCH_MAX_ITEMS = 20;

/** A validated per-item outcome. */
export type BatchItemOutcome =
  | { ok: true; result: unknown; id: number }
  | { ok: false; unresolved: true; reason: BatchUnresolvedReason; detail: string; id: number };

export type BatchUnresolvedReason =
  | "item_rpc_error"
  | "item_result_missing"
  | "item_result_malformed"
  | "response_id_unmatched"
  | "response_id_duplicate"
  | "response_missing"
  | "envelope_malformed"
  | "envelope_request_failed"
  | "batch_size_invalid";

export interface BatchRequest {
  /** Unique JSON-RPC id (number) for THIS batch call. */
  id: number;
  method: string;
  params?: unknown;
}

export interface BatchCallOptions extends RpcTransportOptions {
  /** Max items per HTTP batch (1..DEFAULT_BATCH_MAX_ITEMS unless probed). */
  maxBatchItems?: number;
}

/** Build one JSON-RPC request object. */
function rpcRequestBody(req: BatchRequest): { jsonrpc: "2.0"; id: number; method: string; params?: unknown } {
  return req.params !== undefined
    ? { jsonrpc: "2.0" as const, id: req.id, method: req.method, params: req.params }
    : { jsonrpc: "2.0" as const, id: req.id, method: req.method };
}

/**
 * Validate a batch response envelope against the request ids.
 * Pure; exported for tests. Returns one outcome per request, in REQUEST
 * order (deterministic regardless of response order).
 */
export function validateBatchResponses(
  requests: readonly BatchRequest[],
  rawResponses: unknown,
): BatchItemOutcome[] {
  if (!Array.isArray(rawResponses)) {
    const detail = "batch response is not a JSON array";
    return requests.map((r) => ({ ok: false, unresolved: true, reason: "envelope_malformed", detail, id: r.id }));
  }

  const byId = new Map<number, unknown[]>();
  for (const raw of rawResponses) {
    if (raw === null || typeof raw !== "object") {
      // A malformed entry cannot be attributed to any id; it degrades
      // nothing by itself — missing items surface per-request below.
      continue;
    }
    const obj = raw as { id?: unknown; error?: unknown; result?: unknown };
    if (typeof obj.id !== "number" || !Number.isSafeInteger(obj.id)) {
      continue; // unattributable response — cannot map, cannot trust
    }
    const bucket = byId.get(obj.id);
    if (bucket) {
      bucket.push(raw);
    } else {
      byId.set(obj.id, [raw]);
    }
  }

  return requests.map((r) => {
    const bucket = byId.get(r.id);
    if (bucket === undefined) {
      return {
        ok: false,
        unresolved: true,
        reason: "response_missing",
        detail: `no response carried request id ${r.id} — the item is UNRESOLVED, never a negative result`,
        id: r.id,
      };
    }
    if (bucket.length > 1) {
      return {
        ok: false,
        unresolved: true,
        reason: "response_id_duplicate",
        detail: `${bucket.length} responses carried request id ${r.id} — ambiguous, unresolved`,
        id: r.id,
      };
    }
    const obj = bucket[0] as { error?: unknown; result?: unknown };
    if (obj.error !== undefined && obj.error !== null) {
      return {
        ok: false,
        unresolved: true,
        reason: "item_rpc_error",
        detail: `RPC error on id ${r.id}: ${JSON.stringify(obj.error).slice(0, 200)}`,
        id: r.id,
      };
    }
    if (!("result" in obj)) {
      return {
        ok: false,
        unresolved: true,
        reason: "item_result_missing",
        detail: `response for id ${r.id} carries no result field — unresolved`,
        id: r.id,
      };
    }
    if (obj.result === undefined) {
      return {
        ok: false,
        unresolved: true,
        reason: "item_result_malformed",
        detail: `response for id ${r.id} carries an undefined result — unresolved`,
        id: r.id,
      };
    }
    return { ok: true, result: obj.result, id: r.id };
  });
}

/**
 * Execute a batch of JSON-RPC requests with exhaustive response
 * validation. Order of the returned outcomes matches the order of the
 * requests. Never throws for per-item problems — every failure mode is
 * an explicit unresolved outcome. Only request-shape errors throw.
 */
export async function batchJsonRpc(
  rpcUrl: string,
  requests: readonly BatchRequest[],
  opts?: BatchCallOptions,
): Promise<BatchItemOutcome[]> {
  if (requests.length === 0) return [];
  const maxItems = opts?.maxBatchItems ?? DEFAULT_BATCH_MAX_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error(`maxBatchItems must be a positive integer, got ${maxItems}`);
  }
  if (requests.length > maxItems) {
    throw new Error(
      `batch of ${requests.length} requests exceeds maxBatchItems ${maxItems} — split the batch (provider limits must be probed, not assumed)`,
    );
  }
  const ids = new Set<number>();
  for (const r of requests) {
    if (!Number.isSafeInteger(r.id) || r.id < 0) {
      throw new Error(`batch request id must be a non-negative safe integer, got ${JSON.stringify(r.id)}`);
    }
    if (ids.has(r.id)) {
      throw new Error(`duplicate batch request id ${r.id} — ids must be unique within one batch`);
    }
    ids.add(r.id);
    if (typeof r.method !== "string" || r.method.length === 0) {
      throw new Error(`batch request ${r.id} carries an invalid method`);
    }
  }

  let raw: unknown;
  try {
    raw = await rpcJsonRequest(
      rpcUrl,
      requests.map(rpcRequestBody),
      opts,
    );
  } catch (err) {
    const detail = String((err as Error).message ?? err).slice(0, 200);
    // Envelope-level failure: EVERY item is unresolved — never negative,
    // never partial-success. The typed transport error name is preserved.
    const reason: BatchUnresolvedReason =
      (err as Error).name === "RpcRetryExhaustedError" || (err as Error).name === "RpcDeadlineExceededError"
        ? "envelope_request_failed"
        : "envelope_request_failed";
    return requests.map((r) => ({
      ok: false,
      unresolved: true,
      reason,
      detail: `batch transport failure (${(err as Error).name ?? "Error"}): ${detail}`,
      id: r.id,
    }));
  }
  return validateBatchResponses(requests, raw);
}

/**
 * Convenience: execute a value-method batch and split outcomes by
 * requested key. Keys are caller-defined (e.g. pool address); the same
 * key MAY appear multiple times with distinct ids.
 */
export async function batchValueMethods(
  rpcUrl: string,
  items: ReadonlyArray<{ key: string; method: string; params?: unknown }>,
  opts?: BatchCallOptions,
): Promise<Map<string, BatchItemOutcome>> {
  const requests: BatchRequest[] = items.map((it, i) => ({ id: i, method: it.method, ...(it.params !== undefined ? { params: it.params } : {}) }));
  const outcomes = await batchJsonRpc(rpcUrl, requests, opts);
  const byKey = new Map<string, BatchItemOutcome>();
  items.forEach((it, i) => byKey.set(it.key, outcomes[i]!));
  return byKey;
}

/** Endpoint kind of a batch target (for governor accounting). */
export function batchEndpointKind(rpcUrl: string): EndpointKind {
  return endpointKindFor(rpcUrl);
}
