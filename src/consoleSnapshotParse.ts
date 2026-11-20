// SPDX-License-Identifier: Apache-2.0
//
// Console-snapshot READER — the fail-closed consumer contract for
// ConsoleSnapshotV2 (P3-A Task 3.1 artifact, D-01 extension).
//
// The builder (src/consoleSnapshot.ts) PRODUCES the artifact; this module
// is the reading counterpart: strict, exhaustive, schema-version-aware
// validation of an untyped payload before any consumer logic may touch
// it. It exists because the artifact has downstream consumers (the
// GraveYield console transport re-validates every payload with the same
// fail-closed gate), and a contract without an in-repo reader cannot pin
// what "valid" means.
//
// Contract rules (mirror the builder + the console's own contract):
//   - EXPLICIT SCHEMA VERSION: only schemaVersion 2 is accepted. A v1
//     artifact is REJECTED with an actionable error — it is never
//     silently reinterpreted as v2 (v1 lacks coinMint/pcMint/m1Sourcing
//     and counts.m1SourcingRejected, so reinterpretation would be
//     unsound). Unknown future versions are rejected for the same reason.
//   - EXHAUSTIVE FIELDS: unknown top-level and per-pool keys are
//     rejected, and every required field must be present — nothing is
//     silently ignored.
//   - EXACT INTEGRITY: u64 values are exact decimal strings; pubkey
//     fields are base58; provenance slots are bracketed.
//   - D-01 SOURCING CONSISTENCY (the v2 additions are validated as
//     exactly as they are produced):
//       * every pool's coinMint is a non-WSOL mint and pcMint is the
//         canonical WSOL mint (validated against the SDK's canonical
//         WSOL_MINT constant — no second WSOL definition);
//       * m1Sourcing is exactly the machine-checkable acceptance
//         { eligible: true, wsolSide: "pc_mint", reason: null } — any
//         deviation (eligible false, other wsolSide, a reason) throws;
//       * baseMint/quoteMint agree with coinMint/pcMint (the builder's
//         documented aliasing);
//       * wsolSide agrees with the validated orientation (memecoinMint
//         === coinMint, coinIsWsol false).
//   - COUNTS CONSISTENCY: enriched === pools.length;
//     m1SourcingRejected <= supportedWsolPairs;
//     pools.length <= supportedWsolPairs - m1SourcingRejected (enrichment
//     failures may shrink the emitted list, never grow it); and every
//     rejected pool appears exactly once in `failures` under stage
//     "m1-sourcing" with a pool address — so the count can never drift
//     into a misleading artifact total.
//
// DOWNSTREAM COMPATIBILITY STATUS (updated 2026-11-21): the GraveYield
// console consumer (GraveYield/graveyield-console,
// src/lib/gy/snapshotContract.ts) has been upgraded to this schema v2
// contract — strict v2-only, mirroring this reader rule-for-rule, with the
// real-serializer fixture + digest pin and the cross-repo compat battery
// (console side: __tests__/snapshotV2Compat.test.ts; sharing mechanism and
// regeneration procedure: console src/lib/gy/snapshot-fixture/PROVENANCE.md,
// docs/snapshot-contract.md). It rejects schemaVersion 1 the same way this
// reader does — never reinterpreting it — so a v1 artifact is corrupt for
// BOTH sides; regenerate with this indexer instead of downgrading the
// consumer. Rollout order matters: a v2-emitting indexer must never point
// at a console deployment that still pins v1 (it would classify every v2
// artifact corrupt) — deploy the console upgrade first.

import { WSOL_MINT } from "@graveyield/sdk";

import {
  CONSOLE_SNAPSHOT_KEYS,
  type ConsoleSnapshotFailure,
  type ConsoleSnapshotV2,
  type SnapshotCriteria,
  type SnapshotPool,
} from "./consoleSnapshot.js";
import type { EndpointKind } from "./provenance.js";

/** Error thrown when a payload fails the ConsoleSnapshotV2 contract. */
export class ConsoleSnapshotParseError extends Error {
  constructor(message: string) {
    super(`console-snapshot contract: ${message}`);
    this.name = "ConsoleSnapshotParseError";
  }
}

const WSOL = WSOL_MINT.toBase58();

/** The exhaustive per-pool key set (mirrors the builder's SnapshotPool). */
const SNAPSHOT_POOL_KEYS = [
  "address",
  "ammProgramId",
  "coinMint",
  "pcMint",
  "baseMint",
  "quoteMint",
  "lpMint",
  "wsolSide",
  "m1Sourcing",
  "wsolReserveLamports",
  "memecoinReserveRaw",
  "memecoinDecimals",
  "lpSupplyRaw",
  "lastSwap",
  "criteria",
  "fingerprint",
  "fetchedAtUnixMs",
] as const;

const U64_RE = /^[0-9]+$/;
const U64_MAX = "18446744073709551615";
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exactKeys(v: Record<string, unknown>, expected: readonly string[], what: string): void {
  const got = Object.keys(v).sort();
  const want = [...expected].sort();
  const missing = want.filter((k) => !got.includes(k));
  const unknown = got.filter((k) => !want.includes(k));
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
  if (unknown.length > 0) parts.push(`unknown ${unknown.join(", ")}`);
  if (parts.length > 0) throw new ConsoleSnapshotParseError(`${what} keys must be exactly the contract set (${parts.join("; ")})`);
}

/** Subset check for records with an optional key (e.g. failures[].pool). */
function noUnknownKeys(v: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(v).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw new ConsoleSnapshotParseError(`${what} has unknown keys: ${unknown.join(", ")}`);
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) throw new ConsoleSnapshotParseError(`${what} must be a non-empty string`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConsoleSnapshotParseError(`${what} must be a finite number`);
  return v;
}

function int(v: unknown, what: string): number {
  const n = num(v, what);
  if (!Number.isInteger(n) || n < 0) throw new ConsoleSnapshotParseError(`${what} must be a non-negative integer`);
  return n;
}

function u64str(v: unknown, what: string): string {
  const s = str(v, what);
  if (!U64_RE.test(s) || (s.length > 1 && s[0] === "0")) {
    throw new ConsoleSnapshotParseError(`${what} must be an exact u64 decimal string, got ${JSON.stringify(s)}`);
  }
  if (s.length > U64_MAX.length || (s.length === U64_MAX.length && s > U64_MAX)) {
    throw new ConsoleSnapshotParseError(`${what} exceeds u64 range`);
  }
  return s;
}

function pubkeyStr(v: unknown, what: string): string {
  const s = str(v, what);
  if (!PUBKEY_RE.test(s)) throw new ConsoleSnapshotParseError(`${what} is not a base58 pubkey: ${JSON.stringify(s)}`);
  return s;
}

function criterionState(v: unknown, what: string): "pass" | "fail" | "pending" {
  if (v !== "pass" && v !== "fail" && v !== "pending") {
    throw new ConsoleSnapshotParseError(`${what} must be pass|fail|pending`);
  }
  return v;
}

function pendingOnly(v: unknown, what: string): "pending" {
  if (v !== "pending") throw new ConsoleSnapshotParseError(`${what} must be "pending" (not derivable upstream)`);
  return "pending";
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new ConsoleSnapshotParseError(`${what} must be boolean`);
  return v;
}

/**
 * Parse and fully validate an untyped console-snapshot payload against
 * the ConsoleSnapshotV2 contract. Throws `ConsoleSnapshotParseError` on
 * any violation. Pure: no I/O, safe for tests and consumers alike.
 */
export function parseConsoleSnapshot(raw: unknown): ConsoleSnapshotV2 {
  if (!isObj(raw)) throw new ConsoleSnapshotParseError("root must be an object");
  exactKeys(raw, CONSOLE_SNAPSHOT_KEYS, "root");

  // ---- Explicit schema version: only v2, v1 deliberately unsupported.
  if (raw.schemaVersion === 1) {
    throw new ConsoleSnapshotParseError(
      "schemaVersion 1 is not supported by this reader and is never reinterpreted as v2 — v1 lacks the D-01 sourcing fields (coinMint/pcMint/m1Sourcing, counts.m1SourcingRejected). Regenerate the artifact with a schema-v2 grave-indexer (feat/m1-wsol-quote-side-sourcing, head 3abe645) or use a consumer pinned to the v1 contract.",
    );
  }
  if (raw.schemaVersion !== 2) {
    throw new ConsoleSnapshotParseError(
      `unsupported schemaVersion: got ${JSON.stringify(raw.schemaVersion)}, this reader accepts only schemaVersion 2`,
    );
  }

  const generatedAtUnixMs = num(raw.generatedAtUnixMs, "generatedAtUnixMs");
  if (generatedAtUnixMs <= 0) throw new ConsoleSnapshotParseError("generatedAtUnixMs must be positive");
  const cluster = str(raw.cluster, "cluster");
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    throw new ConsoleSnapshotParseError(`cluster must be "devnet" | "mainnet-beta", got ${JSON.stringify(cluster)}`);
  }
  const indexerGitHead = raw.indexerGitHead === null ? null : str(raw.indexerGitHead, "indexerGitHead");

  // ---- Provenance (bracketed slots, pinned source).
  if (!isObj(raw.provenance)) throw new ConsoleSnapshotParseError("provenance must be an object");
  exactKeys(raw.provenance, ["source", "endpointKind", "slotLowerBound", "slotUpperBound", "ordering", "fingerprintPolicy"], "provenance");
  const prov = raw.provenance;
  const provenance = {
    source: str(prov.source, "provenance.source") as "raydium-v4-gpa",
    endpointKind: str(prov.endpointKind, "provenance.endpointKind") as EndpointKind,
    slotLowerBound: num(prov.slotLowerBound, "provenance.slotLowerBound"),
    slotUpperBound: num(prov.slotUpperBound, "provenance.slotUpperBound"),
    ordering: str(prov.ordering, "provenance.ordering") as "ascending base58 pool address (reproducible)",
    fingerprintPolicy: str(prov.fingerprintPolicy, "provenance.fingerprintPolicy"),
  };
  if (provenance.source !== "raydium-v4-gpa") {
    throw new ConsoleSnapshotParseError(`provenance.source must be "raydium-v4-gpa", got ${JSON.stringify(provenance.source)}`);
  }
  if (provenance.endpointKind !== "public-rpc" && provenance.endpointKind !== "private-rpc") {
    throw new ConsoleSnapshotParseError(
      `provenance.endpointKind must be "public-rpc" | "private-rpc", got ${JSON.stringify(provenance.endpointKind)}`,
    );
  }
  if (provenance.ordering !== "ascending base58 pool address (reproducible)") {
    throw new ConsoleSnapshotParseError(
      `provenance.ordering must be "ascending base58 pool address (reproducible)", got ${JSON.stringify(provenance.ordering)}`,
    );
  }
  if (provenance.slotLowerBound > provenance.slotUpperBound) {
    throw new ConsoleSnapshotParseError("provenance slot bounds inverted");
  }

  // ---- Freshness.
  if (!isObj(raw.freshness)) throw new ConsoleSnapshotParseError("freshness must be an object");
  exactKeys(raw.freshness, ["maxAgeMs"], "freshness");
  const maxAgeMs = num(raw.freshness.maxAgeMs, "freshness.maxAgeMs");
  if (maxAgeMs <= 0) throw new ConsoleSnapshotParseError("freshness.maxAgeMs must be positive");

  // ---- Counts (incl. the v2 m1SourcingRejected total).
  if (!isObj(raw.counts)) throw new ConsoleSnapshotParseError("counts must be an object");
  exactKeys(raw.counts, ["rawAccounts", "parsedPools", "supportedWsolPairs", "m1SourcingRejected", "enriched"], "counts");
  const counts = {
    rawAccounts: int(raw.counts.rawAccounts, "counts.rawAccounts"),
    parsedPools: int(raw.counts.parsedPools, "counts.parsedPools"),
    supportedWsolPairs: int(raw.counts.supportedWsolPairs, "counts.supportedWsolPairs"),
    m1SourcingRejected: int(raw.counts.m1SourcingRejected, "counts.m1SourcingRejected"),
    enriched: int(raw.counts.enriched, "counts.enriched"),
  };
  // Rejections cannot exceed the WSOL-supported corpus they came from.
  if (counts.m1SourcingRejected > counts.supportedWsolPairs) {
    throw new ConsoleSnapshotParseError(
      `counts.m1SourcingRejected (${counts.m1SourcingRejected}) exceeds counts.supportedWsolPairs (${counts.supportedWsolPairs})`,
    );
  }

  // ---- Failures (every m1-sourcing rejection must appear exactly once).
  if (!Array.isArray(raw.failures)) throw new ConsoleSnapshotParseError("failures must be an array");
  const failures: ConsoleSnapshotFailure[] = raw.failures.map((f, i) => {
    if (!isObj(f)) throw new ConsoleSnapshotParseError(`failures[${i}] must be an object`);
    // `pool` is the one optional contract key; stage/reason are required.
    noUnknownKeys(f, ["stage", "pool", "reason"], `failures[${i}]`);
    const stage = str(f.stage, `failures[${i}].stage`);
    const pool = f.pool === undefined ? undefined : str(f.pool, `failures[${i}].pool`);
    const reason = str(f.reason, `failures[${i}].reason`);
    return pool === undefined ? { stage, reason } : { stage, pool, reason };
  });
  const sourcingFailures = failures.filter((f) => f.stage === "m1-sourcing");
  if (sourcingFailures.length !== counts.m1SourcingRejected) {
    throw new ConsoleSnapshotParseError(
      `counts.m1SourcingRejected (${counts.m1SourcingRejected}) != failures with stage "m1-sourcing" (${sourcingFailures.length}) — rejected pools must each appear exactly once in failures`,
    );
  }
  const sourcingFailurePools = new Set<string>();
  for (const f of sourcingFailures) {
    if (f.pool === undefined) throw new ConsoleSnapshotParseError(`a stage "m1-sourcing" failure is missing its pool address`);
    if (sourcingFailurePools.has(f.pool)) {
      throw new ConsoleSnapshotParseError(`pool ${f.pool} appears more than once under stage "m1-sourcing"`);
    }
    sourcingFailurePools.add(f.pool);
  }

  // ---- Thresholds (exact u64 decimal strings).
  if (!isObj(raw.thresholds)) throw new ConsoleSnapshotParseError("thresholds must be an object");
  exactKeys(raw.thresholds, ["inactivitySeconds", "minTvlLamports"], "thresholds");
  const thresholds = {
    inactivitySeconds: u64str(raw.thresholds.inactivitySeconds, "thresholds.inactivitySeconds"),
    minTvlLamports: u64str(raw.thresholds.minTvlLamports, "thresholds.minTvlLamports"),
  };

  // ---- Pools (exhaustive keys, exact D-01 sourcing metadata).
  if (!Array.isArray(raw.pools)) throw new ConsoleSnapshotParseError("pools must be an array");
  const pools: SnapshotPool[] = raw.pools.map((p, i): SnapshotPool => {
    if (!isObj(p)) throw new ConsoleSnapshotParseError(`pools[${i}] must be an object`);
    exactKeys(p, SNAPSHOT_POOL_KEYS, `pools[${i}]`);
    const at = (w: string) => `pools[${i}].${w}`;

    const address = pubkeyStr(p.address, at("address"));
    const ammProgramId = pubkeyStr(p.ammProgramId, at("ammProgramId"));

    // D-01 sourcing fields — validated EXACTLY, never reinterpreted:
    // coinMint non-WSOL, pcMint the canonical WSOL mint, aliases agree.
    const coinMint = pubkeyStr(p.coinMint, at("coinMint"));
    const pcMint = pubkeyStr(p.pcMint, at("pcMint"));
    const baseMint = pubkeyStr(p.baseMint, at("baseMint"));
    const quoteMint = pubkeyStr(p.quoteMint, at("quoteMint"));
    const lpMint = pubkeyStr(p.lpMint, at("lpMint"));
    if (coinMint === WSOL) {
      throw new ConsoleSnapshotParseError(
        `${at("coinMint")} must be non-WSOL — the D-01 M1 sourcing gate only emits WSOL-on-pc_mint pools (got WSOL on coin_mint for ${address})`,
      );
    }
    if (pcMint !== WSOL) {
      throw new ConsoleSnapshotParseError(
        `${at("pcMint")} must be the canonical WSOL mint (${WSOL}) — got ${JSON.stringify(pcMint)} for ${address}`,
      );
    }
    if (baseMint !== coinMint) throw new ConsoleSnapshotParseError(`${at("baseMint")} must equal coinMint (the builder's documented aliasing)`);
    if (quoteMint !== pcMint) throw new ConsoleSnapshotParseError(`${at("quoteMint")} must equal pcMint (the builder's documented aliasing)`);

    // The machine-checkable M1 acceptance, exactly as produced.
    if (!isObj(p.m1Sourcing)) throw new ConsoleSnapshotParseError(`${at("m1Sourcing")} must be an object`);
    exactKeys(p.m1Sourcing, ["eligible", "wsolSide", "reason"], at("m1Sourcing"));
    if (p.m1Sourcing.eligible !== true) {
      throw new ConsoleSnapshotParseError(`${at("m1Sourcing.eligible")} must be true for every emitted pool — a pool that did not pass the D-01 gate can never be in the pool list`);
    }
    if (p.m1Sourcing.wsolSide !== "pc_mint") {
      throw new ConsoleSnapshotParseError(`${at("m1Sourcing.wsolSide")} must be "pc_mint", got ${JSON.stringify(p.m1Sourcing.wsolSide)}`);
    }
    if (p.m1Sourcing.reason !== null) {
      throw new ConsoleSnapshotParseError(`${at("m1Sourcing.reason")} must be null for an emitted (accepted) pool`);
    }

    // wsolSide must agree with the validated orientation.
    if (!isObj(p.wsolSide)) throw new ConsoleSnapshotParseError(`${at("wsolSide")} must be an object`);
    exactKeys(p.wsolSide, ["memecoinMint", "coinIsWsol"], at("wsolSide"));
    const wsolSide = {
      memecoinMint: pubkeyStr(p.wsolSide.memecoinMint, at("wsolSide.memecoinMint")),
      coinIsWsol: bool(p.wsolSide.coinIsWsol, at("wsolSide.coinIsWsol")),
    };
    if (wsolSide.coinIsWsol !== false) {
      throw new ConsoleSnapshotParseError(`${at("wsolSide.coinIsWsol")} must be false — the emitted orientation is pc_mint-WSOL (coin_mint non-WSOL)`);
    }
    if (wsolSide.memecoinMint !== coinMint) {
      throw new ConsoleSnapshotParseError(`${at("wsolSide.memecoinMint")} must equal coinMint for a pc_mint-WSOL pool`);
    }

    // Exact u64 reserves/supply, decimals, last swap.
    const wsolReserveLamports = u64str(p.wsolReserveLamports, at("wsolReserveLamports"));
    const memecoinReserveRaw = u64str(p.memecoinReserveRaw, at("memecoinReserveRaw"));
    const memecoinDecimals = num(p.memecoinDecimals, at("memecoinDecimals"));
    if (!Number.isInteger(memecoinDecimals) || memecoinDecimals < 0 || memecoinDecimals > 255) {
      throw new ConsoleSnapshotParseError(`${at("memecoinDecimals")} must be an integer in [0, 255]`);
    }
    const lpSupplyRaw = u64str(p.lpSupplyRaw, at("lpSupplyRaw"));
    let lastSwap: SnapshotPool["lastSwap"] = null;
    if (p.lastSwap !== null) {
      if (!isObj(p.lastSwap)) throw new ConsoleSnapshotParseError(`${at("lastSwap")} must be null or an object`);
      exactKeys(p.lastSwap, ["unixTs", "slot", "signature"], at("lastSwap"));
      const unixTs = num(p.lastSwap.unixTs, at("lastSwap.unixTs"));
      const slot = num(p.lastSwap.slot, at("lastSwap.slot"));
      const signature = str(p.lastSwap.signature, at("lastSwap.signature"));
      if (unixTs <= 0 || slot <= 0) throw new ConsoleSnapshotParseError(`${at("lastSwap")} timestamps must be positive`);
      lastSwap = { unixTs, slot, signature };
    }
    if (!isObj(p.criteria)) throw new ConsoleSnapshotParseError(`${at("criteria")} must be an object`);
    exactKeys(p.criteria, ["c1Inactivity", "c3MinTvl", "c2PriceCollapse", "c4LpBurned", "c5LpLocked", "c6MultiEpoch"], at("criteria"));
    const criteria: SnapshotCriteria = {
      c1Inactivity: criterionState(p.criteria.c1Inactivity, at("criteria.c1Inactivity")),
      c3MinTvl: criterionState(p.criteria.c3MinTvl, at("criteria.c3MinTvl")),
      // C2/C4/C5/C6 are not derivable upstream — a future index cannot
      // quietly invent evaluations (the console contract pins the same).
      c2PriceCollapse: pendingOnly(p.criteria.c2PriceCollapse, at("criteria.c2PriceCollapse")),
      c4LpBurned: pendingOnly(p.criteria.c4LpBurned, at("criteria.c4LpBurned")),
      c5LpLocked: pendingOnly(p.criteria.c5LpLocked, at("criteria.c5LpLocked")),
      c6MultiEpoch: pendingOnly(p.criteria.c6MultiEpoch, at("criteria.c6MultiEpoch")),
    };
    const fingerprint = str(p.fingerprint, at("fingerprint"));
    const fetchedAtUnixMs = num(p.fetchedAtUnixMs, at("fetchedAtUnixMs"));
    if (fetchedAtUnixMs <= 0) throw new ConsoleSnapshotParseError(`${at("fetchedAtUnixMs")} must be positive`);

    return {
      address,
      ammProgramId,
      coinMint,
      pcMint,
      baseMint,
      quoteMint,
      lpMint,
      wsolSide,
      m1Sourcing: { eligible: true, wsolSide: "pc_mint", reason: null },
      wsolReserveLamports,
      memecoinReserveRaw,
      memecoinDecimals,
      lpSupplyRaw,
      lastSwap,
      criteria,
      fingerprint,
      fetchedAtUnixMs,
    };
  });

  // ---- Counts consistency with the emitted pool list.
  if (counts.enriched !== pools.length) {
    throw new ConsoleSnapshotParseError(`counts.enriched (${counts.enriched}) != pools.length (${pools.length})`);
  }
  if (pools.length > counts.supportedWsolPairs - counts.m1SourcingRejected) {
    throw new ConsoleSnapshotParseError(
      `pools.length (${pools.length}) exceeds supportedWsolPairs - m1SourcingRejected (${counts.supportedWsolPairs - counts.m1SourcingRejected}) — enrichment can shrink the list, never grow it`,
    );
  }

  return {
    schemaVersion: 2,
    generatedAtUnixMs,
    cluster,
    indexerGitHead,
    provenance,
    freshness: { maxAgeMs },
    counts,
    failures,
    thresholds,
    pools,
  };
}
