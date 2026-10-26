// console-snapshot — typed, secret-free console data contract (P3-A Task 3.1).
//
// Bridges the Phase 2 discovery/evidence pipeline to the GraveYield console:
// a `ConsoleSnapshotV1` artifact carries REAL mainnet Raydium V4 pool facts
// (identity, vault reserves, LP supply, derived last-swap) with end-to-end
// provenance, for the console to render with truthful freshness labelling.
//
// Contract rules:
//   - SECRET-FREE by construction: no URLs, no key material, no signatures
//     beyond swap-transaction anchors. The field set below is exhaustive;
//     tests pin it so nothing can leak in later without a schema bump.
//   - EXACT integers: every u64 crosses the JSON boundary as a decimal
//     string (JS numbers lose precision above 2^53).
//   - FAIL-CLOSED: the builder throws on any record that cannot be fully
//     established (missing WSOL side, malformed amounts). It never guesses.
//   - HONEST criteria: only C1 (inactivity) and C3 (min TVL) are derivable
//     from on-chain facts this pipeline reads. C2 needs an attested launch
//     price, C4 needs an original-supply baseline, C5 needs locker adapters
//     (LOCKER-002), C6 needs anchor epochs — they stay "pending" and the
//     console must present them as not-yet-evaluated, never as passing.

import { SCANNER_PROTOCOL_CONFIG_DEFAULTS } from "@graveyield/sdk";
import type { Cluster } from "./provenance.js";
import type { EndpointKind } from "./provenance.js";
import type { DiscoveredPoolRecord } from "./discovery.js";

export const CONSOLE_SNAPSHOT_SCHEMA_VERSION = 1;

/** Criteria states the snapshot can express. Everything not derivable is "pending". */
export type SnapshotCriterionState = "pass" | "fail" | "pending";

export interface SnapshotCriteria {
  c1Inactivity: SnapshotCriterionState;
  c3MinTvl: SnapshotCriterionState;
  c2PriceCollapse: "pending";
  c4LpBurned: "pending";
  c5LpLocked: "pending";
  c6MultiEpoch: "pending";
}

/** One enriched, salvage-funnel-supported pool. All amounts are exact decimal strings. */
export interface SnapshotPool {
  address: string;
  ammProgramId: string;
  baseMint: string;
  /** Always WSOL — supported pairs have exactly one WSOL side (7019 guard). */
  quoteMint: string;
  lpMint: string;
  wsolSide: { memecoinMint: string; coinIsWsol: boolean };
  /** WSOL-side vault token-account amount (u64 exact). */
  wsolReserveLamports: string;
  /** Memecoin-side vault token-account amount (u64 exact). */
  memecoinReserveRaw: string;
  memecoinDecimals: number;
  /** LP mint supply (u64 exact). */
  lpSupplyRaw: string;
  /** Derived last swap, or null when not derivable in this run (fail-open
   *  per-pool with a recorded failure; the console shows "unavailable"). */
  lastSwap: { unixTs: number; slot: number; signature: string } | null;
  criteria: SnapshotCriteria;
  /** sha256(pool address bytes ‖ raw account payload) from discovery. */
  fingerprint: string;
  fetchedAtUnixMs: number;
}

export interface ConsoleSnapshotFailure {
  stage: string;
  pool?: string;
  reason: string;
}

export interface ConsoleSnapshotV1 {
  schemaVersion: 1;
  generatedAtUnixMs: number;
  /** Discovery cluster (mainnet-beta for the real corpus). */
  cluster: Cluster;
  /** git head of the indexer that produced the artifact (null off-repo). */
  indexerGitHead: string | null;
  provenance: {
    source: "raydium-v4-gpa";
    endpointKind: EndpointKind;
    slotLowerBound: number;
    slotUpperBound: number;
    ordering: "ascending base58 pool address (reproducible)";
    fingerprintPolicy: string;
  };
  /** Wall-clock budget after which the console must label the artifact stale. */
  freshness: { maxAgeMs: number };
  counts: {
    rawAccounts: number;
    parsedPools: number;
    supportedWsolPairs: number;
    enriched: number;
  };
  failures: ConsoleSnapshotFailure[];
  /** Criteria cut-offs — read from the DEPLOYED ProtocolConfig, not hardcoded. */
  thresholds: {
    inactivitySeconds: string;
    minTvlLamports: string;
  };
  pools: SnapshotPool[];
}

/** Deployed-ProtocolConfig thresholds the snapshot's criteria math uses. */
export interface SnapshotThresholds {
  inactivitySeconds: bigint;
  minTvlLamports: bigint;
}

/** Per-pool enrichment facts gathered by the CLI glue (RPC layer). */
export interface PoolEnrichment {
  wsolReserveLamports: string;
  memecoinReserveRaw: string;
  memecoinDecimals: number;
  lpSupplyRaw: string;
  lastSwap: { unixTs: number; slot: number; signature: string } | null;
  fetchedAtUnixMs: number;
}

function fail(msg: string): never {
  throw new Error(`console-snapshot: ${msg}`);
}

/** Validate an exact u64 decimal string (no sign, no exponent, no padding). */
export function assertExactU64(value: string, what: string): string {
  if (!/^[0-9]+$/.test(value)) fail(`${what} must be an exact decimal string, got ${JSON.stringify(value)}`);
  if (value.length > 1 && value[0] === "0") fail(`${what} must not carry leading zeros`);
  if (value.length > 20 || (value.length === 20 && value > "18446744073709551615")) {
    fail(`${what} exceeds u64 range`);
  }
  return value;
}

export function assertBase58Pubkey(value: string, what: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) fail(`${what} is not a base58 pubkey: ${JSON.stringify(value)}`);
  return value;
}

const MIN_INACTIVITY_MARGIN = 0; // margins are ratios in [0, 1]; reserved for the console

/**
 * Criteria for one enriched pool. Pure; visible for tests.
 * C1 pass = pool silent for >= inactivitySeconds. C3 pass = WSOL reserve >= minTvlLamports.
 */
export function deriveCriteria(
  lastSwap: { unixTs: number } | null,
  wsolReserveLamports: string,
  thresholds: SnapshotThresholds,
  nowUnixMs: number,
): SnapshotCriteria {
  let c1: SnapshotCriterionState = "pending";
  if (lastSwap && lastSwap.unixTs > 0) {
    const ageSeconds = Math.floor(nowUnixMs / 1000) - lastSwap.unixTs;
    c1 = ageSeconds >= Number(thresholds.inactivitySeconds) ? "pass" : "fail";
  }
  let c3: SnapshotCriterionState = "pending";
  try {
    const reserve = BigInt(assertExactU64(wsolReserveLamports, "wsolReserveLamports"));
    c3 = reserve >= thresholds.minTvlLamports ? "pass" : "fail";
  } catch {
    c3 = "pending";
  }
  return {
    c1Inactivity: c1,
    c3MinTvl: c3,
    c2PriceCollapse: "pending",
    c4LpBurned: "pending",
    c5LpLocked: "pending",
    c6MultiEpoch: "pending",
  };
}

/** Convert a discovery record + enrichment into a validated SnapshotPool. */
export function buildSnapshotPool(
  record: DiscoveredPoolRecord,
  enrichment: PoolEnrichment,
  thresholds: SnapshotThresholds,
  nowUnixMs: number,
): SnapshotPool {
  if (!record.wsolSide) fail(`pool ${record.poolAddress.toBase58()} has no WSOL side — not salvage-funnel supported`);
  if (enrichment.fetchedAtUnixMs <= 0) fail(`pool ${record.poolAddress.toBase58()} enrichment has no timestamp`);
  const address = record.poolAddress.toBase58();
  return {
    address,
    ammProgramId: record.ammProgramId.toBase58(),
    baseMint: assertBase58Pubkey(record.pool.baseMint.toBase58(), "baseMint"),
    quoteMint: assertBase58Pubkey(record.pool.quoteMint.toBase58(), "quoteMint"),
    lpMint: assertBase58Pubkey(record.pool.lpMint.toBase58(), "lpMint"),
    wsolSide: {
      memecoinMint: assertBase58Pubkey(record.wsolSide.memecoinMint.toBase58(), "memecoinMint"),
      coinIsWsol: record.wsolSide.coinIsWsol,
    },
    wsolReserveLamports: assertExactU64(enrichment.wsolReserveLamports, "wsolReserveLamports"),
    memecoinReserveRaw: assertExactU64(enrichment.memecoinReserveRaw, "memecoinReserveRaw"),
    memecoinDecimals: enrichment.memecoinDecimals,
    lpSupplyRaw: assertExactU64(enrichment.lpSupplyRaw, "lpSupplyRaw"),
    lastSwap: enrichment.lastSwap,
    criteria: deriveCriteria(enrichment.lastSwap, enrichment.wsolReserveLamports, thresholds, nowUnixMs),
    fingerprint: record.raw.fingerprint,
    fetchedAtUnixMs: enrichment.fetchedAtUnixMs,
  };
}

export interface ConsoleSnapshotMeta {
  generatedAtUnixMs: number;
  cluster: Cluster;
  endpointKind: EndpointKind;
  indexerGitHead: string | null;
  maxAgeMs: number;
  thresholds: SnapshotThresholds;
  counts: { rawAccounts: number; parsedPools: number; supportedWsolPairs: number };
  failures: ConsoleSnapshotFailure[];
  slotLowerBound: number;
  slotUpperBound: number;
}

/**
 * Assemble the full artifact. `records` must already be the SUPPORTED
 * (WSOL-sided), enriched subset, in ascending base58 address order —
 * the builder enforces the ordering instead of trusting the caller.
 */
export function buildConsoleSnapshot(
  records: DiscoveredPoolRecord[],
  enrichments: Map<string, PoolEnrichment>,
  meta: ConsoleSnapshotMeta,
): ConsoleSnapshotV1 {
  if (meta.generatedAtUnixMs <= 0) fail("generatedAtUnixMs must be positive");
  if (meta.maxAgeMs <= 0) fail("freshness.maxAgeMs must be positive");
  const ordered = [...records].sort((a, b) =>
    a.poolAddress.toBase58() < b.poolAddress.toBase58() ? -1 : 1,
  );
  const pools: SnapshotPool[] = [];
  for (const record of ordered) {
    const address = record.poolAddress.toBase58();
    const enrichment = enrichments.get(address);
    if (!enrichment) fail(`missing enrichment for ordered pool ${address}`);
    pools.push(buildSnapshotPool(record, enrichment!, meta.thresholds, meta.generatedAtUnixMs));
  }
  void MIN_INACTIVITY_MARGIN;
  return {
    schemaVersion: CONSOLE_SNAPSHOT_SCHEMA_VERSION,
    generatedAtUnixMs: meta.generatedAtUnixMs,
    cluster: meta.cluster,
    indexerGitHead: meta.indexerGitHead,
    provenance: {
      source: "raydium-v4-gpa",
      endpointKind: meta.endpointKind,
      slotLowerBound: meta.slotLowerBound,
      slotUpperBound: meta.slotUpperBound,
      ordering: "ascending base58 pool address (reproducible)",
      fingerprintPolicy: "sha256(pool address bytes ‖ raw 752-byte account payload)",
    },
    freshness: { maxAgeMs: meta.maxAgeMs },
    counts: {
      rawAccounts: meta.counts.rawAccounts,
      parsedPools: meta.counts.parsedPools,
      supportedWsolPairs: meta.counts.supportedWsolPairs,
      enriched: pools.length,
    },
    failures: meta.failures,
    thresholds: {
      inactivitySeconds: meta.thresholds.inactivitySeconds.toString(),
      minTvlLamports: meta.thresholds.minTvlLamports.toString(),
    },
    pools,
  };
}

/** The exhaustive top-level key set — tests pin this to keep the artifact secret-free. */
export const CONSOLE_SNAPSHOT_KEYS = [
  "schemaVersion",
  "generatedAtUnixMs",
  "cluster",
  "indexerGitHead",
  "provenance",
  "freshness",
  "counts",
  "failures",
  "thresholds",
  "pools",
] as const;

/** Default thresholds when the deployed ProtocolConfig cannot be read (offline tests). */
export const SNAPSHOT_THRESHOLD_FALLBACK: SnapshotThresholds = {
  inactivitySeconds: SCANNER_PROTOCOL_CONFIG_DEFAULTS.inactivitySeconds,
  minTvlLamports: SCANNER_PROTOCOL_CONFIG_DEFAULTS.minTvlLamports,
};
