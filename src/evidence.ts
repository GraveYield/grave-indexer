// SPDX-License-Identifier: Apache-2.0
//
// Evidence bundles — the serializable unit of oracle evidence.
//
// A bundle carries EVERYTHING the on-chain ORACLE-002 contract consumes,
// plus the provenance needed to audit where each field came from, and
// NOTHING secret: only the oracle PUBLIC key and the 64-byte signature
// (both public data) appear — key material never enters a bundle, a log,
// or a commit. This satisfies "evidence examples with secrets removed"
// by construction rather than by redaction.
//
// Serialization is strict JSON with hex-encoded byte fields so evidence
// files are diff-able, deterministic, and safe to check into an audit
// trail. `parseEvidenceBundle` rejects malformed input fail-closed and
// mirrors the on-chain field checks (lengths, sanity windows, binding).

import { PublicKey } from "@solana/web3.js";
import {
  buildAttestationMessage,
  ATTESTATION_MSG_LEN,
  type LastSwapAttestation,
} from "@graveyield/sdk";
import type { Cluster } from "./provenance.js";

export const EVIDENCE_SCHEMA_VERSION = 1;

/** Pool identity as the on-chain adapters see it. */
export interface EvidencePoolIdentity {
  ammProgramId: string;
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  coinVault: string;
  pcVault: string;
}

/** Serialized evidence bundle (hex byte fields, no secrets). */
export interface EvidenceBundle {
  schemaVersion: number;
  /** The GraveScanner instance the evidence is destined for. */
  destination: {
    cluster: Cluster;
    scannerProgramId: string;
    protocolConfigPda: string;
  };
  poolIdentity: EvidencePoolIdentity;
  activity: {
    /** Historical last-swap fact (may originate on the discovery cluster). */
    lastSwapUnixTs: number;
    lastSwapSlot: number;
    lastSwapSignature: string;
    derivationCluster: Cluster;
  };
  /** Attestation issuance — MUST happen on the destination cluster so
   *  issued_slot resolves in ITS SlotHashes. */
  issuance: {
    issuedSlot: number;
    slotHashHex: string;
    issuedAtUnixMs: number;
  };
  attestation: {
    /** The exact 112-byte signed message (hex) — mirrors msg[80..112] etc. */
    msgHex: string;
    /** 64-byte Ed25519 signature over msgHex (hex) — public data. */
    signatureHex: string;
    /** Oracle PUBLIC key (base58) — public data. */
    oraclePublicKey: string;
  };
  /** sha256 of the discovery fingerprint this evidence was derived from. */
  discoveryFingerprint: string | null;
  createdAtUnixMs: number;
}

export interface BuildEvidenceBundleInput {
  destination: { cluster: Cluster; scannerProgramId: PublicKey; protocolConfigPda: PublicKey };
  poolIdentity: EvidencePoolIdentity;
  activity: { lastSwapUnixTs: number; lastSwapSlot: number; lastSwapSignature: string; derivationCluster: Cluster };
  issuance: { issuedSlot: number; slotHash: Uint8Array; issuedAtUnixMs: number };
  signature: Uint8Array;
  oraclePublicKey: PublicKey;
  discoveryFingerprint?: string | null;
  createdAtUnixMs?: number;
}

/** Build the canonical 112-byte attestation message for this bundle. */
export function buildEvidenceMessage(input: {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  lastSwapUnixTs: number;
  issuedSlot: number;
  slotHash: Uint8Array;
}): Uint8Array {
  const att: LastSwapAttestation = {
    ammProgramId: input.ammProgramId,
    poolAddress: input.poolAddress,
    lastSwapUnixTs: input.lastSwapUnixTs,
    issuedSlot: input.issuedSlot,
    slotHash: input.slotHash,
  };
  return buildAttestationMessage(att);
}

/** Assemble + serialize an evidence bundle. */
export function buildEvidenceBundle(input: BuildEvidenceBundleInput): EvidenceBundle {
  if (input.issuance.slotHash.length !== 32) throw new Error("slotHash must be exactly 32 bytes");
  if (input.signature.length !== 64) throw new Error("signature must be exactly 64 bytes");
  const msg = buildEvidenceMessage({
    ammProgramId: new PublicKey(input.poolIdentity.ammProgramId),
    poolAddress: new PublicKey(input.poolIdentity.poolAddress),
    lastSwapUnixTs: input.activity.lastSwapUnixTs,
    issuedSlot: input.issuance.issuedSlot,
    slotHash: input.issuance.slotHash,
  });
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    destination: {
      cluster: input.destination.cluster,
      scannerProgramId: input.destination.scannerProgramId.toBase58(),
      protocolConfigPda: input.destination.protocolConfigPda.toBase58(),
    },
    poolIdentity: { ...input.poolIdentity },
    activity: { ...input.activity },
    issuance: {
      issuedSlot: input.issuance.issuedSlot,
      slotHashHex: Buffer.from(input.issuance.slotHash).toString("hex"),
      issuedAtUnixMs: input.issuance.issuedAtUnixMs,
    },
    attestation: {
      msgHex: Buffer.from(msg).toString("hex"),
      signatureHex: Buffer.from(input.signature).toString("hex"),
      oraclePublicKey: input.oraclePublicKey.toBase58(),
    },
    discoveryFingerprint: input.discoveryFingerprint ?? null,
    createdAtUnixMs: input.createdAtUnixMs ?? Date.now(),
  };
}

export class MalformedEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedEvidenceError";
  }
}

function mustBeHex(name: string, value: unknown, byteLen: number): Uint8Array {
  if (typeof value !== "string") {
    throw new MalformedEvidenceError(`${name} must be a hex string`);
  }
  if (!/^[0-9a-f]+$/.test(value)) {
    throw new MalformedEvidenceError(`${name} must be lowercase hex`);
  }
  const bytes = Uint8Array.from(Buffer.from(value, "hex"));
  if (bytes.length !== byteLen) {
    throw new MalformedEvidenceError(`${name} must decode to exactly ${byteLen} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function mustBeBase58Pubkey(name: string, value: unknown): PublicKey {
  if (typeof value !== "string") {
    throw new MalformedEvidenceError(`${name} must be a base58 pubkey string`);
  }
  try {
    return new PublicKey(value);
  } catch {
    throw new MalformedEvidenceError(`${name} is not a valid base58 pubkey: ${value}`);
  }
}

/** The canonical 112-byte message implied by a bundle's OWN fields. */
export function recomputeBundleMessage(bundle: EvidenceBundle): Uint8Array {
  return buildEvidenceMessage({
    ammProgramId: new PublicKey(bundle.poolIdentity.ammProgramId),
    poolAddress: new PublicKey(bundle.poolIdentity.poolAddress),
    lastSwapUnixTs: bundle.activity.lastSwapUnixTs,
    issuedSlot: bundle.issuance.issuedSlot,
    slotHash: mustBeHex("issuance.slotHashHex", bundle.issuance.slotHashHex, 32),
  });
}

/**
 * Parse + validate a serialized bundle. Malformed input is rejected with
 * `MalformedEvidenceError` (fail-closed) — mirrors the on-chain field
 * checks: exact lengths, timestamp sanity (0 < ts), slot sanity
 * (0 < issued_slot), 32-byte hash, 64-byte signature, valid pubkeys, and
 * msg/field agreement (the embedded msgHex must equal the message
 * recomputed from the bundle's own fields — the same "params must echo
 * the attestation" rule the program enforces).
 */
export function parseEvidenceBundle(raw: unknown): EvidenceBundle {
  if (raw === null || typeof raw !== "object") {
    throw new MalformedEvidenceError("bundle must be a JSON object");
  }
  const b = raw as EvidenceBundle;

  if (b.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new MalformedEvidenceError(`unsupported schemaVersion: ${String(b.schemaVersion)}`);
  }
  if (b.destination?.cluster !== "devnet" && b.destination?.cluster !== "mainnet-beta") {
    throw new MalformedEvidenceError("destination.cluster must be devnet or mainnet-beta");
  }
  mustBeBase58Pubkey("destination.scannerProgramId", b.destination.scannerProgramId);
  mustBeBase58Pubkey("destination.protocolConfigPda", b.destination.protocolConfigPda);

  const identity = b.poolIdentity;
  if (!identity) throw new MalformedEvidenceError("poolIdentity missing");
  for (const key of [
    "ammProgramId",
    "poolAddress",
    "baseMint",
    "quoteMint",
    "lpMint",
    "coinVault",
    "pcVault",
  ] as const) {
    mustBeBase58Pubkey(`poolIdentity.${key}`, identity[key]);
  }

  const activity = b.activity;
  if (!activity) throw new MalformedEvidenceError("activity missing");
  if (!Number.isInteger(activity.lastSwapUnixTs) || activity.lastSwapUnixTs <= 0) {
    throw new MalformedEvidenceError("activity.lastSwapUnixTs must be a positive integer (on-chain: 6028)");
  }
  if (!Number.isInteger(activity.lastSwapSlot) || activity.lastSwapSlot < 0) {
    throw new MalformedEvidenceError("activity.lastSwapSlot must be a non-negative integer");
  }
  if (typeof activity.lastSwapSignature !== "string") {
    throw new MalformedEvidenceError("activity.lastSwapSignature must be a string");
  }
  if (activity.derivationCluster !== "devnet" && activity.derivationCluster !== "mainnet-beta") {
    throw new MalformedEvidenceError("activity.derivationCluster must be devnet or mainnet-beta");
  }

  const issuance = b.issuance;
  if (!issuance) throw new MalformedEvidenceError("issuance missing");
  if (!Number.isInteger(issuance.issuedSlot) || issuance.issuedSlot <= 0) {
    throw new MalformedEvidenceError("issuance.issuedSlot must be a positive integer (on-chain: 6031)");
  }
  mustBeHex("issuance.slotHashHex", issuance.slotHashHex, 32);
  if (!Number.isInteger(issuance.issuedAtUnixMs)) {
    throw new MalformedEvidenceError("issuance.issuedAtUnixMs must be an integer");
  }

  const att = b.attestation;
  if (!att) throw new MalformedEvidenceError("attestation missing");
  mustBeHex("attestation.msgHex", att.msgHex, ATTESTATION_MSG_LEN);
  mustBeHex("attestation.signatureHex", att.signatureHex, 64);
  mustBeBase58Pubkey("attestation.oraclePublicKey", att.oraclePublicKey);

  // Binding echo rule (on-chain 6027 analogue): the embedded message must
  // be exactly what the bundle's own fields would serialize to.
  const recomputed = recomputeBundleMessage(b);
  const embedded = Uint8Array.from(Buffer.from(att.msgHex, "hex"));
  for (let i = 0; i < ATTESTATION_MSG_LEN; i++) {
    if (recomputed[i] !== embedded[i]) {
      throw new MalformedEvidenceError(
        `attestation.msgHex disagrees with bundle fields at byte ${i} (on-chain analogue: AttestationBindingMismatch 6027)`,
      );
    }
  }

  if (b.discoveryFingerprint !== null && typeof b.discoveryFingerprint !== "string") {
    throw new MalformedEvidenceError("discoveryFingerprint must be a string or null");
  }
  if (!Number.isInteger(b.createdAtUnixMs)) {
    throw new MalformedEvidenceError("createdAtUnixMs must be an integer");
  }

  return b;
}

/** Read a bundle from a JSON string (file contents). */
export function parseEvidenceBundleJson(json: string): EvidenceBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new MalformedEvidenceError("bundle file is not valid JSON");
  }
  return parseEvidenceBundle(raw);
}
