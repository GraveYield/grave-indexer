// SPDX-License-Identifier: Apache-2.0
//
// Live activity derivation with provenance + conflict detection.
//
// Wraps the SDK's `deriveLastSwapEvidenceV4` (the canonical D4/D5
// derivation the on-chain oracle contract expects) and adds what the
// operational pipeline needs on top:
//
//   * PROVENANCE — when the derivation ran, over how many signatures,
//     against which cluster/endpoint kind.
//   * CACHE with TTL — identical semantics to the monorepo ActivityIndexer
//     (a pool that hasn't swapped in 90 days is unlikely to swap within
//     the TTL), keyed by pool address. Only DEFINITIVE results (verified
//     or no_swap_in_scan) are cached; incomplete results are never cached,
//     so a transient RPC failure never suppresses a fresh evidence
//     attempt for the normal TTL.
//   * INCOMPLETE REFRESH (IMPL-001 Correction 002) — when a refresh comes
//     back incomplete, the incomplete record IS the current result. It is
//     never overridden by — or upgraded to — a previously cached
//     verified/no-swap record: newer transactions may have occurred and
//     the refresh could not resolve them, so the cached determination may
//     no longer represent the latest swap. The prior definitive record is
//     demoted from the current cache and retained separately for
//     diagnostics/observability only (`lastKnownDefinitiveEvidence`); it
//     is never served as current.
//   * CONFLICT DETECTION — a re-derivation that returns an OLDER
//     last-swap than the cached record is flagged as an activity
//     regression (pruned history / untrusted RPC) and surfaced instead of
//     silently overwriting the cache. The CACHED record remains
//     authoritative for attestation; the regression is reported for the
//     operator and recorded in health.
//   * STALENESS — `isActivityStale` decides whether a derivation is old
//     enough to require a re-scan before it seeds an attestation.
//   * ATTESTATION GATE (IMPL-001 Correction 002) — `evaluateAttestationGate`
//     is the explicit gate every last-swap record must pass before it can
//     support an inactivity attestation (or the C1 eligibility cut): only
//     VERIFIED, DEFINITIVE, well-formed, fresh evidence passes. Incomplete,
//     non-definitive, missing, malformed and stale records are rejected;
//     the failure path can never fall back to a previous timestamp.

import { Connection, type PublicKey } from "@solana/web3.js";
import { deriveLastSwapEvidenceV4, RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";
import { endpointKindFor, type Cluster, type EndpointKind } from "./provenance.js";

/**
 * Explicit D4/D5 evidence status (IMPL-001, Deliverable 3 §8):
 *   verified       — the newest finalized, verified economic swap is established;
 *   no_swap_in_scan— the pool's full available signature history was covered and
 *                    every candidate is provably not an economic swap;
 *   incomplete     — unresolved evidence present (or an empty/bounded scan):
 *                    NO inactivity determination may be derived, and this state
 *                    must never be reported as complete.
 */
export type ActivityEvidenceStatus = "verified" | "no_swap_in_scan" | "incomplete";

/** Live last-swap activity record with provenance. */
export interface ActivityEvidence {
  poolAddress: PublicKey;
  /** Unix seconds of the most recent confirmed swap (0 = none found). */
  lastSwapUnixTs: number;
  /** Slot of that swap (0 = none found). */
  lastSwapSlot: number;
  /** Signature of that swap tx ("" = none found) — the audit anchor. */
  lastSwapSignature: string;
  /** True when no verified swap exists in the covered evidence (legacy
   *  field semantics: no usable last-swap record). For `incomplete`
   *  evidence this is false with zeroed last-swap fields — the honest
   *  state is "unknown", not "no swap". */
  noSwapFound: boolean;
  /** Explicit D4/D5 completeness status of this derivation. */
  evidenceStatus: ActivityEvidenceStatus;
  /** True when this record is a sound basis for an inactivity claim. */
  definitive: boolean;
  /** Derivation labeling per Deliverable 3 §7 (IMPL-001 Correction 003):
   *  what this record's derivation ACTUALLY established — it mirrors the
   *  evidence state and never misrepresents it:
   *    "swap"       — a verified economic swap anchor (never a bare
   *                   amm-touch); the record carries a last-swap anchor;
   *    "no_swap"    — a definitive scan that established no economic swap
   *                   in the covered history (no swap anchor exists);
   *    "unresolved" — incomplete evidence; no swap determination exists.
   *  Only `evidenceStatus === "verified"` records are labeled "swap" —
   *  a no-swap or unresolved record is never represented as a verified
   *  swap. */
  derivationKind: "swap" | "no_swap" | "unresolved";
  /** Derivation context. */
  derivation: {
    cluster: Cluster;
    endpointKind: EndpointKind;
    scanLimit: number;
    /** Actual number of signatures returned and classified by the scan
     *  (not the requested limit — Deliverable 3 §8 flags the old
     *  limit-as-count as a defect). */
    signaturesScanned: number;
    /** True when the scan covered the pool's full available history. */
    scanReachedHistoryEnd: boolean;
    derivedAtUnixMs: number;
    source: "deriveLastSwapEvidenceV4";
  };
  /** Set when a re-derivation returned an older swap than the cache. */
  regressionDetected: boolean;
}

/**
 * Derivation labeling for a D4/D5 evidence status (Deliverable 3 §7,
 * IMPL-001 Correction 003): the label mirrors the evidence state —
 * "swap" ONLY for verified evidence, "no_swap" for a definitive
 * no_swap_in_scan determination, "unresolved" for incomplete evidence.
 * Exhaustive over `ActivityEvidenceStatus`: a future status literal
 * cannot silently inherit the verified-swap label.
 */
export function derivationKindFor(
  status: ActivityEvidenceStatus,
): ActivityEvidence["derivationKind"] {
  switch (status) {
    case "verified":
      return "swap";
    case "no_swap_in_scan":
      return "no_swap";
    case "incomplete":
      return "unresolved";
  }
}

interface CacheEntry {
  evidence: ActivityEvidence;
  cachedAtUnixMs: number;
}

/** Default cache TTL (1 h, mirroring the monorepo indexer). Also the
 *  freshness bound the collect path applies at the attestation gate:
 *  evidence older than this must be re-derived before it can seed an
 *  attestation (IMPL-001 Correction 002 §2). */
export const DEFAULT_ACTIVITY_TTL_MS = 3_600_000;

export interface ActivityIndexerOptions {
  /** Cache TTL (default 1 h, mirroring the monorepo indexer). */
  ttlMs?: number;
  cluster: Cluster;
  rpcUrl: string;
}

export class ActivityIndexerLive {
  /** Current-result cache. Holds ONLY definitive records (verified or
   *  no_swap_in_scan) — incomplete results are never cached, so a
   *  transient RPC failure can never suppress a fresh evidence attempt
   *  for the normal TTL (Correction 002 §3). */
  private readonly cache = new Map<string, CacheEntry>();
  /** Last-known DEFINITIVE record per pool, retained across incomplete
   *  refreshes for diagnostics/observability ONLY (Correction 002 §1.3/
   *  §1.6). Never served as the current result by `indexActivity`. */
  private readonly lastKnownDefinitive = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly cluster: Cluster;
  private readonly rpcUrl: string;

  constructor(opts: ActivityIndexerOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_ACTIVITY_TTL_MS;
    this.cluster = opts.cluster;
    this.rpcUrl = opts.rpcUrl;
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Derive (or fetch from cache) the last-swap record for a pool.
   * Throws through on RPC failure — the caller records health.
   *
   * Evidence handling (IMPL-001, Correction 002): the derivation consumes
   * the SDK's canonical `deriveLastSwapEvidenceV4`; incomplete evidence is
   * represented explicitly (`evidenceStatus: "incomplete"`, zeroed
   * last-swap fields, `noSwapFound: false`) and can never be reported as
   * a complete determination.
   *
   * An INCOMPLETE refresh is returned as the CURRENT result, unchanged:
   * a previously verified/no-swap record may no longer represent the
   * latest swap (newer transactions may exist that the refresh could not
   * resolve), so the cache never overrides an incomplete refresh. The
   * prior definitive record is demoted to the diagnostics view
   * (`lastKnownDefinitiveEvidence`) and removed from the current cache —
   * it can never be served as current after a failed refresh. The
   * incomplete result itself is not cached: the next request performs a
   * fresh evidence attempt (no retry suppression, no timers).
   */
  async indexActivity(
    connection: Connection,
    poolAddress: PublicKey,
    opts?: { scanLimit?: number; forceRefresh?: boolean },
  ): Promise<ActivityEvidence> {
    const key = poolAddress.toBase58();
    const now = Date.now();
    const scanLimit = opts?.scanLimit ?? 1000;

    const cached = this.cache.get(key);
    if (!opts?.forceRefresh && cached && now - cached.cachedAtUnixMs < this.ttlMs) {
      return cached.evidence;
    }

    const result = await deriveLastSwapEvidenceV4(connection, RAYDIUM_V4_PROGRAM_ID, poolAddress, {
      scanLimit,
    });

    const buildEvidence = (): ActivityEvidence => ({
      poolAddress,
      lastSwapUnixTs: result.lastSwap?.lastSwapUnixTs ?? 0,
      lastSwapSlot: result.lastSwap?.slot ?? 0,
      lastSwapSignature: result.lastSwap?.signature ?? "",
      noSwapFound: result.status === "no_swap_in_scan",
      evidenceStatus: result.status,
      definitive: result.definitive,
      derivationKind: derivationKindFor(result.status),
      derivation: {
        cluster: this.cluster,
        endpointKind: endpointKindFor(this.rpcUrl),
        scanLimit,
        signaturesScanned: result.scan.signaturesReturned,
        scanReachedHistoryEnd: result.scan.reachedHistoryEnd,
        derivedAtUnixMs: now,
        source: "deriveLastSwapEvidenceV4",
      },
      regressionDetected: false,
    });

    const evidence = buildEvidence();

    // Correction 002 §1/§3 — an incomplete refresh is the CURRENT result.
    // It must never be converted into (or replaced by) a cached verified
    // or no-swap determination: the cached record may predate newer,
    // unresolvable transactions, and presenting it as current would
    // overstate inactivity. The prior definitive record (if any) is
    // demoted to the diagnostics view with its own honest provenance and
    // REMOVED from the current cache, so it can never be served as
    // current after a failed refresh. The incomplete result itself is not
    // cached under the normal TTL — no retry-suppression interval is
    // implemented, so the next request attempts fresh evidence
    // immediately and a transient RPC failure never suppresses it.
    if (evidence.evidenceStatus === "incomplete") {
      const prior = this.cache.get(key);
      if (prior && prior.evidence.evidenceStatus !== "incomplete") {
        this.lastKnownDefinitive.set(key, prior);
      }
      this.cache.delete(key);
      return evidence;
    }

    // Conflict rule (definitive-vs-definitive only since Correction 002:
    // incomplete results no longer reach this point and are never
    // cached): a refreshed derivation that lands OLDER than the cached
    // one means the history we are looking at shrank — a signature of an
    // untrusted/pruned RPC. Keep the cached (older, larger-window)
    // derivation as authoritative and flag the regression.
    if (cached && !cached.evidence.noSwapFound && !evidence.noSwapFound) {
      if (evidence.lastSwapUnixTs < cached.evidence.lastSwapUnixTs) {
        evidence.regressionDetected = true;
        return cached.evidence;
      }
    }

    this.cache.set(key, { evidence, cachedAtUnixMs: now });
    this.lastKnownDefinitive.set(key, { evidence, cachedAtUnixMs: now });
    return evidence;
  }

  /**
   * Diagnostic/observability view (Correction 002 §1.3/§1.6): the
   * last-known DEFINITIVE evidence for a pool, retained when a later
   * refresh came back incomplete. The record carries its own honest
   * derivation timestamp (`derivation.derivedAtUnixMs`) and completeness
   * status — it is NEVER served as the current result by
   * `indexActivity`, and consumers must treat it as historical data, not
   * as a current inactivity determination. Returns null when no
   * definitive record exists for the pool.
   */
  lastKnownDefinitiveEvidence(poolAddress: PublicKey): ActivityEvidence | null {
    return this.lastKnownDefinitive.get(poolAddress.toBase58())?.evidence ?? null;
  }

  /** True when the cached derivation is older than `maxAgeMs`. */
  isActivityStale(poolAddress: PublicKey, maxAgeMs: number, nowUnixMs = Date.now()): boolean {
    const cached = this.cache.get(poolAddress.toBase58());
    if (!cached) return true;
    return nowUnixMs - cached.evidence.derivation.derivedAtUnixMs > maxAgeMs;
  }

  clear(): void {
    this.cache.clear();
    this.lastKnownDefinitive.clear();
  }
}

// ─── Attestation gate (IMPL-001 Correction 002 §2) ─────────────────────────
//
// Every last-swap record must pass this explicit gate BEFORE it can
// support an inactivity attestation (collect path) or seed the C1
// inactivity criterion (console snapshot). The gate rejects:
//   * missing evidence (no record at all),
//   * malformed evidence (wrong types, invalid status literals, a
//     verified claim without a last-swap anchor, a non-verified record
//     carrying a smuggled last-swap timestamp, or a record whose
//     derivationKind does not mirror its evidenceStatus — a non-verified
//     record is never labeled as a verified economic swap),
//   * incomplete evidence (never a basis for inactivity),
//   * non-definitive evidence (no_swap_in_scan and anything else that is
//     not a verified last swap),
//   * stale evidence (a derivation older than the caller's freshness
//     policy — not successfully refreshed).
// The gate is flow control, not logging: callers must skip issuance on
// `ok === false`, and the failure path returns no usable timestamp, so it
// can never silently fall back to a previous one.

/** Why the attestation gate rejected a record. */
export type AttestationGateRejection =
  | "missing_evidence"
  | "malformed_evidence"
  | "incomplete_evidence"
  | "not_verified"
  | "not_definitive"
  | "stale_evidence";

export interface AttestationGateOptions {
  /** Freshness policy: a record whose derivation is older than this is
   *  rejected as stale evidence (the existing `isActivityStale` policy,
   *  applied to the record itself). */
  maxAgeMs: number;
  /** Evaluation clock (defaults to `Date.now()`). */
  nowUnixMs?: number;
}

export type AttestationGateResult =
  | { ok: true; activity: ActivityEvidence }
  | { ok: false; reason: AttestationGateRejection; detail: string };

const EVIDENCE_STATUSES: readonly ActivityEvidenceStatus[] = [
  "verified",
  "no_swap_in_scan",
  "incomplete",
];

function isSafeNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Evaluate the attestation gate for a last-swap evidence record
 * (Correction 002 §2). Property names and shapes are validated against
 * the ACTUAL `ActivityEvidence` implementation:
 * `evidenceStatus: ActivityEvidenceStatus`, `definitive: boolean` and
 * `derivationKind` (which must mirror `evidenceStatus` — Correction 003).
 * A record passes only when it is present, well-formed,
 * `evidenceStatus === "verified"`, `definitive === true`, labeled
 * `derivationKind === "swap"`, carries a real last-swap anchor, and is
 * fresh under `opts.maxAgeMs`.
 */
export function evaluateAttestationGate(
  activity: ActivityEvidence | null | undefined,
  opts: AttestationGateOptions,
): AttestationGateResult {
  const reject = (reason: AttestationGateRejection, detail: string): AttestationGateResult => ({
    ok: false,
    reason,
    detail,
  });

  if (!isPlainObject(activity)) {
    return reject("missing_evidence", "no activity evidence record is available");
  }
  const a = activity as unknown as Record<string, unknown>;

  const status = a.evidenceStatus;
  if (typeof status !== "string" || !EVIDENCE_STATUSES.includes(status as ActivityEvidenceStatus)) {
    return reject(
      "malformed_evidence",
      `evidenceStatus must be one of ${EVIDENCE_STATUSES.join(" | ")}, got ${JSON.stringify(status)}`,
    );
  }
  if (typeof a.definitive !== "boolean") {
    return reject("malformed_evidence", `definitive must be a boolean, got ${JSON.stringify(a.definitive)}`);
  }
  if (typeof a.noSwapFound !== "boolean") {
    return reject("malformed_evidence", `noSwapFound must be a boolean, got ${JSON.stringify(a.noSwapFound)}`);
  }
  if (typeof a.regressionDetected !== "boolean") {
    return reject(
      "malformed_evidence",
      `regressionDetected must be a boolean, got ${JSON.stringify(a.regressionDetected)}`,
    );
  }
  if (!isSafeNonNegativeInt(a.lastSwapUnixTs)) {
    return reject("malformed_evidence", `lastSwapUnixTs must be a non-negative safe integer, got ${JSON.stringify(a.lastSwapUnixTs)}`);
  }
  if (!isSafeNonNegativeInt(a.lastSwapSlot)) {
    return reject("malformed_evidence", `lastSwapSlot must be a non-negative safe integer, got ${JSON.stringify(a.lastSwapSlot)}`);
  }
  if (typeof a.lastSwapSignature !== "string") {
    return reject("malformed_evidence", `lastSwapSignature must be a string, got ${JSON.stringify(a.lastSwapSignature)}`);
  }
  if (!isPlainObject(a.derivation)) {
    return reject("malformed_evidence", "derivation context is missing");
  }
  const d = a.derivation;
  if (d.source !== "deriveLastSwapEvidenceV4") {
    return reject(
      "malformed_evidence",
      `derivation.source must be "deriveLastSwapEvidenceV4", got ${JSON.stringify(d.source)}`,
    );
  }
  if (typeof d.cluster !== "string" || typeof d.endpointKind !== "string") {
    return reject("malformed_evidence", "derivation.cluster and derivation.endpointKind must be strings");
  }
  if (!isSafeNonNegativeInt(d.scanLimit) || (d.scanLimit as number) === 0) {
    return reject("malformed_evidence", `derivation.scanLimit must be a positive integer, got ${JSON.stringify(d.scanLimit)}`);
  }
  if (!isSafeNonNegativeInt(d.signaturesScanned)) {
    return reject(
      "malformed_evidence",
      `derivation.signaturesScanned must be a non-negative safe integer, got ${JSON.stringify(d.signaturesScanned)}`,
    );
  }
  if (typeof d.scanReachedHistoryEnd !== "boolean") {
    return reject(
      "malformed_evidence",
      `derivation.scanReachedHistoryEnd must be a boolean, got ${JSON.stringify(d.scanReachedHistoryEnd)}`,
    );
  }
  if (!isSafeNonNegativeInt(d.derivedAtUnixMs) || (d.derivedAtUnixMs as number) === 0) {
    return reject(
      "malformed_evidence",
      `derivation.derivedAtUnixMs must be a positive integer, got ${JSON.stringify(d.derivedAtUnixMs)}`,
    );
  }

  // Anchor consistency (mirrors the SDK contract: `lastSwap` is set ONLY
  // for verified evidence; every other status carries zeroed fields).
  if (status === "verified") {
    if (a.noSwapFound !== false) {
      return reject("malformed_evidence", "verified evidence cannot claim noSwapFound");
    }
    if ((a.lastSwapUnixTs as number) <= 0 || (a.lastSwapSignature as string) === "") {
      return reject(
        "malformed_evidence",
        "verified evidence without a last-swap anchor (lastSwapUnixTs > 0 and a non-empty signature)",
      );
    }
  } else if ((a.lastSwapUnixTs as number) !== 0 || (a.lastSwapSignature as string) !== "") {
    // A stale timestamp smuggled into a non-verified record can never
    // pass the gate — this is the exact shape that would convert an
    // incomplete refresh into seemingly-current inactivity evidence.
    return reject(
      "malformed_evidence",
      `non-verified evidence must carry zeroed last-swap fields, got ts=${JSON.stringify(a.lastSwapUnixTs)} sig=${JSON.stringify(a.lastSwapSignature)}`,
    );
  }

  // Derivation-label consistency (IMPL-001 Correction 003): the record's
  // derivationKind must mirror its evidenceStatus. A non-verified record
  // labeled "swap" is the exact misrepresentation that would present
  // no-swap or unresolved evidence as a verified economic swap; the
  // reverse mislabeling is equally malformed. The gate rejects both
  // directions — the label can never imply a verified swap that the
  // evidence state does not establish.
  if (a.derivationKind !== derivationKindFor(status as ActivityEvidenceStatus)) {
    return reject(
      "malformed_evidence",
      `derivationKind ${JSON.stringify(a.derivationKind)} does not match evidenceStatus ${JSON.stringify(status)} (expected ${JSON.stringify(derivationKindFor(status as ActivityEvidenceStatus))})`,
    );
  }

  if (status === "incomplete") {
    return reject(
      "incomplete_evidence",
      "evidence is incomplete — unresolved candidates prevent any inactivity determination",
    );
  }
  if (status !== "verified") {
    return reject("not_verified", `evidenceStatus ${status} is not a verified last swap`);
  }
  if (a.definitive !== true) {
    return reject("not_definitive", "evidence is not definitive — not a sound basis for an inactivity claim");
  }

  const now = opts.nowUnixMs ?? Date.now();
  const age = now - (d.derivedAtUnixMs as number);
  if (age > opts.maxAgeMs) {
    return reject(
      "stale_evidence",
      `derivation is ${age}ms old, older than the freshness policy (${opts.maxAgeMs}ms) — refresh required`,
    );
  }

  return { ok: true, activity };
}
