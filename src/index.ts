// SPDX-License-Identifier: Apache-2.0
//
// @graveyield/grave-indexer — Phase 2 evidence pipeline public surface.
//
// The pipeline consumes `@graveyield/sdk` as the single source of truth
// for every wire format (attestation messages, precompile instruction
// layout, AmmInfo parsing, ProtocolConfig decoding, program error
// codes); nothing here re-implements or re-orders a wire format.

export * from "./provenance.js";
export * from "./config.js";
export * from "./discovery.js";
export * from "./ingest.js";
export * from "./health.js";
export * from "./activityLive.js";
export * from "./evidence.js";
export * from "./sign.js";
export * from "./journal.js";
export * from "./verify.js";
export * from "./evidencePath.js";

import { GraveYieldClient, type Phase1Input } from "@graveyield/sdk";
import { PublicKey } from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";
import type { EvidenceBundle } from "./evidence.js";
import type { OracleSigner } from "./sign.js";
import { issueEvidenceBundle as issueBundle } from "./issue.js";

export { GraveYieldClient } from "@graveyield/sdk";

/** Pool identity material needed to issue evidence for one pool. */
export interface EvidenceIssuanceInput {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  poolIdentity: EvidenceBundle["poolIdentity"];
  /** Historical last-swap fact (usually derived on the discovery cluster). */
  lastSwapUnixTs: number;
  lastSwapSlot: number;
  lastSwapSignature: string;
  derivationCluster: "devnet" | "mainnet-beta";
  scannerProgramId: PublicKey;
  vaultProgramId: PublicKey;
  destinationCluster: "devnet" | "mainnet-beta";
  discoveryFingerprint?: string | null;
  /** Issue at this exact slot (else a recent finalized slot is used). */
  issuedSlot?: number;
}

/**
 * Issue an evidence bundle: build the canonical 112-byte attestation for
 * the destination cluster, sign it with the activity oracle key, and
 * return the serializable bundle (public data only — no secrets).
 *
 * The issuance slot + slot hash come from the DESTINATION cluster so the
 * on-chain SlotHashes freshness check can resolve them.
 */
export async function issueEvidenceBundle(
  connection: import("@solana/web3.js").Connection,
  oracle: OracleSigner,
  input: EvidenceIssuanceInput,
): Promise<EvidenceBundle> {
  return issueBundle(connection, oracle, input);
}

/**
 * Build the (precompile, phase1) instruction pair for a bundle, ready
 * for submission by a funded writer. The bundle is self-contained and
 * secret-free: the oracle signature + public key it carries are public
 * data.
 */
export function buildPhase1TransactionParts(
  client: GraveYieldClient,
  bundle: EvidenceBundle,
  writer: PublicKey,
): { precompileIx: TransactionInstruction; phase1Ix: TransactionInstruction } {
  const input: Phase1Input = {
    ammProgramId: new PublicKey(bundle.poolIdentity.ammProgramId),
    poolAddress: new PublicKey(bundle.poolIdentity.poolAddress),
    derivation: {
      lastSwapUnixTs: bundle.activity.lastSwapUnixTs,
      slot: bundle.issuance.issuedSlot,
      signature: bundle.activity.lastSwapSignature,
    },
    slotHash: Uint8Array.from(Buffer.from(bundle.issuance.slotHashHex, "hex")),
    signature: Uint8Array.from(Buffer.from(bundle.attestation.signatureHex, "hex")),
    oraclePublicKey: new PublicKey(bundle.attestation.oraclePublicKey),
    writer,
  };
  return client.buildPhase1Ix(input);
}
