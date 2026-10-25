// SPDX-License-Identifier: Apache-2.0
//
// Provenance — every record this pipeline produces carries the context it
// was derived from: which RPC surface, which cluster, at which slot, at
// which wall-clock time, over exactly which account bytes (sha256
// fingerprint).
//
// Two rules are load-bearing:
//
//   1. Endpoint REDACTION: the endpoint is recorded as a KIND
//      ("public-rpc" / "private-rpc"), never as a URL — RPC URLs routinely
//      embed API keys, and evidence files are meant to be shared.
//   2. Fingerprints are over RAW account bytes, so duplicate ingestion can
//      decide byte-equality (unchanged) vs byte-divergence (changed or
//      conflicting) without re-reading the chain.

import { createHash } from "node:crypto";
import type { PublicKey } from "@solana/web3.js";

export type Cluster = "devnet" | "mainnet-beta";

/** How the record reached us. URLs never appear in provenance. */
export type EndpointKind = "public-rpc" | "private-rpc";

/** Provenance attached to every discovery / derivation record. */
export interface Provenance {
  /** Pipeline stage that produced the record, e.g. "raydium-v4-gpa". */
  readonly source: string;
  readonly cluster: Cluster;
  readonly endpointKind: EndpointKind;
  /** RPC-reported slot nearest the fetch (bracketed by discovery). */
  readonly slot: number;
  /** Wall-clock time of the fetch (unix ms). */
  readonly fetchedAtUnixMs: number;
  /** sha256 hex of the raw account bytes this record was parsed from. */
  readonly accountSha256: string;
  /** Owning program of the account (base58), when applicable. */
  readonly owner?: string;
}

/** sha256 of raw bytes, hex-encoded — the canonical account fingerprint. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Fingerprint for an (address, data) pair — address mixes into the hash so
 *  two pools with byte-identical payloads never share a fingerprint. */
export function accountFingerprint(address: PublicKey, data: Uint8Array): string {
  const hasher = createHash("sha256");
  hasher.update(address.toBytes());
  hasher.update(data);
  return hasher.digest("hex");
}

/** Classify an RPC endpoint for provenance WITHOUT retaining the URL. */
export function endpointKindFor(rpcUrl: string): EndpointKind {
  if (rpcUrl.includes("api.mainnet-beta.solana.com") || rpcUrl.includes("api.devnet.solana.com")) {
    return "public-rpc";
  }
  return "private-rpc";
}

/** Age of a provenance record in slots (0 when the chain has rewound —
 *  treated as stale by policy since it indicates cluster confusion). */
export function provenanceAgeSlots(prov: Provenance, currentSlot: number): number {
  return currentSlot >= prov.slot ? currentSlot - prov.slot : Number.MAX_SAFE_INTEGER;
}

/** A record is fresh while it is younger than `maxAgeSlots` slots. */
export function isProvenanceFresh(prov: Provenance, currentSlot: number, maxAgeSlots: number): boolean {
  return provenanceAgeSlots(prov, currentSlot) <= maxAgeSlots;
}
