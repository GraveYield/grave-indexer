// SPDX-License-Identifier: Apache-2.0
//
// Cross-pool batched enrichment reads (Option 2 — Part 2 item 4).
//
// The per-pool enrichment stage reads four token facts per pool (WSOL
// vault balance, memecoin vault balance, memecoin supply, LP supply).
// The previous Option 2 phase already batched those four reads into ONE
// JSON-RPC array per pool. This module goes one step further and groups
// MULTIPLE pools' four-method request sets into a single validated
// JSON-RPC array, cutting the HTTP round trips of the balance/supply
// stage by the group factor while keeping the read methods — and there-
// fore the produced evidence values — byte-identical.
//
// What is deliberately NOT done here (provider support unestablished):
//   * `getMultipleAccounts` consolidation of vault/mint reads — the
//     method is universally specified, but switching evidence-producing
//     read methods (and jsonParsed decoding) requires a live parity probe
//     against the configured provider before any value it returns can
//     feed eligibility. Documented in docs/OPTION2_FINDINGS.md (D-5).
//   * `getTransaction` batching — provider behavior for transaction
//     payloads inside JSON-RPC arrays is not documented by the provider;
//     transaction fetches remain per-signature (SDK-owned path).
//
// Failure semantics (unchanged, fail-closed):
//   * an envelope-level failure (transport, retries exhausted, malformed
//     array) resolves EVERY pool in the group as a stage failure — never
//     a zero balance, never negative evidence;
//   * per-item failures resolve only their own pool;
//   * response ids map 1:1 back to request ids (duplicates, missing and
//     unmatched responses are explicit unresolved outcomes from
//     rpcBatching's exhaustive validation);
//   * the group size is derived from the SAME conservative
//     `DEFAULT_BATCH_MAX_ITEMS` bound (provider batch limits must be
//     probed before raising — measured, never assumed).

import {
  DEFAULT_BATCH_MAX_ITEMS,
  batchJsonRpc,
  type BatchItemOutcome,
  type BatchRequest,
} from "./rpcBatching.js";
import type { PublicKey } from "@solana/web3.js";

/** RPC reads per pool (2 × getTokenAccountBalance + 2 × getTokenSupply). */
export const READS_PER_POOL = 4;

/** Conservative default group: 20 items / 4 reads = 5 pools per request. */
export const DEFAULT_POOLS_PER_BATCH = Math.max(1, Math.floor(DEFAULT_BATCH_MAX_ITEMS / READS_PER_POOL));

export interface GroupedPoolReads {
  wsolAmount: string;
  memecoinAmount: string;
  memecoinDecimals: number;
  lpAmount: string;
}

export interface GroupedReadsRequest {
  rpcUrl: string;
  pools: ReadonlyArray<{
    address: string;
    wsolVault: PublicKey;
    memecoinVault: PublicKey;
    memecoinMint: PublicKey;
    lpMint: PublicKey;
  }>;
  /** Pools per HTTP batch (≤ DEFAULT_POOLS_PER_BATCH unless probed). */
  poolsPerBatch?: number;
  /** Injectable transport options (tests) — passes through to the batch. */
  transport?: Record<string, unknown>;
  /** Injectable batch executor (tests). Defaults to batchJsonRpc. */
  executeBatch?: (
    rpcUrl: string,
    requests: readonly BatchRequest[],
    opts?: Record<string, unknown>,
  ) => Promise<BatchItemOutcome[]>;
}

/**
 * Build the combined JSON-RPC request set for a group of pools. Pure;
 * exported for tests: ids are unique across the WHOLE group (0..4n-1) and
 * each pool's four reads occupy a contiguous block.
 */
export function buildGroupedRequests(
  pools: GroupedReadsRequest["pools"],
): BatchRequest[] {
  const requests: BatchRequest[] = [];
  pools.forEach((p, i) => {
    const base = i * READS_PER_POOL;
    requests.push(
      { id: base + 0, method: "getTokenAccountBalance", params: [p.wsolVault.toBase58(), { commitment: "confirmed" }] },
      { id: base + 1, method: "getTokenAccountBalance", params: [p.memecoinVault.toBase58(), { commitment: "confirmed" }] },
      { id: base + 2, method: "getTokenSupply", params: [p.memecoinMint.toBase58(), { commitment: "confirmed" }] },
      { id: base + 3, method: "getTokenSupply", params: [p.lpMint.toBase58(), { commitment: "confirmed" }] },
    );
  });
  return requests;
}

/** Extract one pool's four facts from its contiguous outcome block. */
export function extractPoolFacts(outcomes: readonly BatchItemOutcome[], poolIndex: number): GroupedPoolReads {
  const base = poolIndex * READS_PER_POOL;
  const amountFrom = (outcome: BatchItemOutcome | undefined, what: string): string => {
    if (outcome === undefined || !outcome.ok) {
      const reason = outcome === undefined ? "response_missing" : outcome.reason;
      const detail = outcome === undefined ? "no outcome for this id" : outcome.detail;
      throw new Error(`${what} unresolved (${reason}) — ${detail}`);
    }
    const result = outcome.result as { value?: { amount?: unknown } } | null;
    const amount = result?.value?.amount;
    if (typeof amount !== "string") {
      throw new Error(`${what} malformed (no exact amount string) — unresolved, never zero`);
    }
    return amount;
  };
  const wsolAmount = amountFrom(outcomes[base + 0], "wsol vault balance");
  const memecoinAmount = amountFrom(outcomes[base + 1], "memecoin vault balance");
  const supplyOutcome = outcomes[base + 2];
  if (supplyOutcome === undefined || !supplyOutcome.ok) {
    const reason = supplyOutcome === undefined ? "response_missing" : supplyOutcome.reason;
    const detail = supplyOutcome === undefined ? "no outcome for this id" : supplyOutcome.detail;
    throw new Error(`memecoin supply unresolved (${reason}) — ${detail}`);
  }
  const decimals = (supplyOutcome.result as { value?: { decimals?: unknown } } | null)?.value?.decimals;
  if (typeof decimals !== "number") {
    throw new Error("memecoin supply malformed (no decimals) — unresolved, never zero");
  }
  const lpAmount = amountFrom(outcomes[base + 3], "LP mint supply");
  return { wsolAmount, memecoinAmount, memecoinDecimals: decimals, lpAmount };
}

/**
 * Resolve the validated outcome block for a group of pools via ONE JSON-RPC
 * array request. Returns the per-item outcomes IN REQUEST ORDER (pool i's
 * four reads occupy ids 4i..4i+3); the CALLER extracts each pool's facts
 * with `extractPoolFacts` inside its own per-pool try/catch, so one pool's
 * malformed fact can never zero another pool's evidence. Envelope-level
 * failures mark EVERY item unresolved (rpcBatching), so every pool in the
 * group fails closed with the typed detail — never a zero, never negative
 * evidence.
 */
export async function fetchGroupedPoolReadOutcomes(req: GroupedReadsRequest): Promise<BatchItemOutcome[]> {
  if (req.pools.length === 0) return [];
  const poolsPerBatch = req.poolsPerBatch ?? DEFAULT_POOLS_PER_BATCH;
  if (!Number.isInteger(poolsPerBatch) || poolsPerBatch < 1 || poolsPerBatch > DEFAULT_POOLS_PER_BATCH) {
    throw new Error(
      `poolsPerBatch must be in 1..${DEFAULT_POOLS_PER_BATCH} (provider batch limits must be probed before raising), got ${poolsPerBatch}`,
    );
  }
  if (req.pools.length > poolsPerBatch) {
    throw new Error(
      `grouped reads for ${req.pools.length} pool(s) exceed poolsPerBatch ${poolsPerBatch} — split the group`,
    );
  }
  const requests = buildGroupedRequests(req.pools);
  const outcomes = req.executeBatch
    ? await req.executeBatch(req.rpcUrl, requests, req.transport)
    : await batchJsonRpc(req.rpcUrl, requests, req.transport as never);
  return outcomes;
}
