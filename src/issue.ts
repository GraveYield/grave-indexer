// SPDX-License-Identifier: Apache-2.0
//
// Evidence issuance — builds the canonical 112-byte C1 attestation for a
// pool on the DESTINATION cluster (issued_slot + slot hash must resolve
// in THAT cluster's SlotHashes), signs it with the activity oracle key,
// and returns the serializable bundle. No secret material enters the
// bundle: only the oracle public key and the 64-byte signature (both
// public data) appear.

import { PublicKey } from "@solana/web3.js";
import {
  buildAttestationMessage,
  fetchSlotHash,
  scannerProtocolConfigPda,
} from "@graveyield/sdk";
import { buildEvidenceBundle, type EvidenceBundle } from "./evidence.js";
import { signAttestationMessage, type OracleSigner } from "./sign.js";
import type { EvidenceIssuanceInput } from "./index.js";

export async function issueEvidenceBundle(
  connection: import("@solana/web3.js").Connection,
  oracle: OracleSigner,
  input: EvidenceIssuanceInput,
): Promise<EvidenceBundle> {
  const issuedSlot =
    input.issuedSlot ?? Math.max(1, Number(await connection.getSlot("finalized")) - 4);
  const slotHash = await fetchSlotHash(connection, issuedSlot);
  if (!slotHash) {
    throw new Error(
      `could not resolve the slot hash for issued_slot ${issuedSlot} on the destination cluster — ` +
        `evidence cannot be issued (on-chain analogue: AttestationStale 6029)`,
    );
  }
  const ammProgramId = new PublicKey(input.ammProgramId);
  const poolAddress = new PublicKey(input.poolAddress);
  const msg = buildAttestationMessage({
    ammProgramId,
    poolAddress,
    lastSwapUnixTs: input.lastSwapUnixTs,
    issuedSlot,
    slotHash,
  });
  const signature = signAttestationMessage(oracle, msg);
  return buildEvidenceBundle({
    destination: {
      cluster: input.destinationCluster,
      scannerProgramId: input.scannerProgramId,
      protocolConfigPda: scannerProtocolConfigPda(input.scannerProgramId),
    },
    poolIdentity: input.poolIdentity,
    activity: {
      lastSwapUnixTs: input.lastSwapUnixTs,
      lastSwapSlot: input.lastSwapSlot,
      lastSwapSignature: input.lastSwapSignature,
      derivationCluster: input.derivationCluster,
    },
    issuance: { issuedSlot, slotHash, issuedAtUnixMs: Date.now() },
    signature,
    oraclePublicKey: oracle.publicKey,
    discoveryFingerprint: input.discoveryFingerprint ?? null,
  });
}
