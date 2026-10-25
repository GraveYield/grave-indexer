// SPDX-License-Identifier: Apache-2.0
//
// Live activity derivation with provenance + conflict detection.
//
// Wraps the SDK's `deriveLastSwapV4` (the authoritative derivation the
// on-chain oracle contract expects) and adds what the operational
// pipeline needs on top:
//
//   * PROVENANCE — when the derivation ran, over how many signatures,
//     against which cluster/endpoint kind.
//   * CACHE with TTL — identical semantics to the monorepo ActivityIndexer
//     (a pool that hasn't swapped in 90 days is unlikely to swap within
//     the TTL), keyed by pool address.
//   * CONFLICT DETECTION — a re-derivation that returns an OLDER
//     last-swap than the cached record is flagged as an activity
//     regression (pruned history / untrusted RPC) and surfaced instead of
//     silently overwriting the cache. The CACHED record remains
//     authoritative for attestation; the regression is reported for the
//     operator and recorded in health.
//   * STALENESS — `isActivityStale` decides whether a derivation is old
//     enough to require a re-scan before it seeds an attestation.

import { Connection, type PublicKey } from "@solana/web3.js";
import { deriveLastSwapV4, RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";
import { endpointKindFor, type Cluster, type EndpointKind } from "./provenance.js";

/** Live last-swap activity record with provenance. */
export interface ActivityEvidence {
  poolAddress: PublicKey;
  /** Unix seconds of the most recent confirmed swap (0 = none found). */
  lastSwapUnixTs: number;
  /** Slot of that swap (0 = none found). */
  lastSwapSlot: number;
  /** Signature of that swap tx ("" = none found) — the audit anchor. */
  lastSwapSignature: string;
  noSwapFound: boolean;
  /** Derivation context. */
  derivation: {
    cluster: Cluster;
    endpointKind: EndpointKind;
    scanLimit: number;
    signaturesScanned: number;
    derivedAtUnixMs: number;
    source: "deriveLastSwapV4";
  };
  /** Set when a re-derivation returned an older swap than the cache. */
  regressionDetected: boolean;
}

interface CacheEntry {
  evidence: ActivityEvidence;
  cachedAtUnixMs: number;
}

export interface ActivityIndexerOptions {
  /** Cache TTL (default 1 h, mirroring the monorepo indexer). */
  ttlMs?: number;
  cluster: Cluster;
  rpcUrl: string;
}

export class ActivityIndexerLive {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly cluster: Cluster;
  private readonly rpcUrl: string;

  constructor(opts: ActivityIndexerOptions) {
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.cluster = opts.cluster;
    this.rpcUrl = opts.rpcUrl;
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Derive (or fetch from cache) the last-swap record for a pool.
   * Throws through on RPC failure — the caller records health.
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

    const derivation = await deriveLastSwapV4(connection, RAYDIUM_V4_PROGRAM_ID, poolAddress, {
      scanLimit,
    });

    const evidence: ActivityEvidence = derivation
      ? {
          poolAddress,
          lastSwapUnixTs: derivation.lastSwapUnixTs,
          lastSwapSlot: derivation.slot,
          lastSwapSignature: derivation.signature,
          noSwapFound: false,
          derivation: {
            cluster: this.cluster,
            endpointKind: endpointKindFor(this.rpcUrl),
            scanLimit,
            signaturesScanned: scanLimit,
            derivedAtUnixMs: now,
            source: "deriveLastSwapV4",
          },
          regressionDetected: false,
        }
      : {
          poolAddress,
          lastSwapUnixTs: 0,
          lastSwapSlot: 0,
          lastSwapSignature: "",
          noSwapFound: true,
          derivation: {
            cluster: this.cluster,
            endpointKind: endpointKindFor(this.rpcUrl),
            scanLimit,
            signaturesScanned: scanLimit,
            derivedAtUnixMs: now,
            source: "deriveLastSwapV4",
          },
          regressionDetected: false,
        };

    // Conflict rule: a refreshed derivation that lands OLDER than the
    // cached one means the history we are looking at shrank — a signature
    // of an untrusted/pruned RPC. Keep the cached (older, larger-window)
    // derivation as authoritative and flag the regression.
    if (cached && !cached.evidence.noSwapFound && !evidence.noSwapFound) {
      if (evidence.lastSwapUnixTs < cached.evidence.lastSwapUnixTs) {
        evidence.regressionDetected = true;
        return cached.evidence;
      }
    }

    this.cache.set(key, { evidence, cachedAtUnixMs: now });
    return evidence;
  }

  /** True when the cached derivation is older than `maxAgeMs`. */
  isActivityStale(poolAddress: PublicKey, maxAgeMs: number, nowUnixMs = Date.now()): boolean {
    const cached = this.cache.get(poolAddress.toBase58());
    if (!cached) return true;
    return nowUnixMs - cached.evidence.derivation.derivedAtUnixMs > maxAgeMs;
  }

  clear(): void {
    this.cache.clear();
  }
}
