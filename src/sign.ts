// SPDX-License-Identifier: Apache-2.0
//
// Evidence signing — Ed25519 over the canonical 112-byte attestation
// message, byte-compatible with the on-chain precompile path (the SDK's
// `buildEd25519VerifyInstruction` consumes exactly these bytes).
//
// Signer authorization contract (ORACLE-002, as implemented in
// programs/grave-scanner/src/attestation.rs):
//
//   * The transaction carries an `ed25519_program` verify instruction
//     immediately before the scanner instruction; the runtime verifies
//     the signature BEFORE the handler runs.
//   * The handler then checks the covered public key equals
//     `ProtocolConfig.activity_oracle` (AttestationOracleMismatch 6026 on
//     divergence). A signature from any other key — however valid — is
//     unauthorized.
//
// Key handling red lines: key material is read into memory, used, and
// dropped. It is NEVER logged, echoed, serialized into bundles or
// journals, or written anywhere by this module. Logs carry only the
// public key fingerprint.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

import { parseOracleSeedFromEnv, parseOracleSeedFromFilePayload } from "./config.js";

/** A loaded oracle signer: keypair in memory + public identity. */
export interface OracleSigner {
  keypair: Keypair;
  publicKey: PublicKey;
  /** Short, safe identifier for logs: first 8 base58 chars of the pubkey. */
  fingerprint: string;
}

/** Safe public fingerprint for logs/health (public data only). */
export function publicKeyFingerprint(pk: PublicKey): string {
  const digest = createHash("sha256").update(pk.toBytes()).digest("hex").slice(0, 16);
  return `${pk.toBase58().slice(0, 8)}…/${digest}`;
}

/** Build an OracleSigner from a 32-byte Ed25519 seed. */
export async function oracleSignerFromSeed(seed: Uint8Array): Promise<OracleSigner> {
  if (seed.length !== 32) {
    throw new Error(`oracle seed must be exactly 32 bytes, got ${seed.length}`);
  }
  // web3.js 3.x made every Keypair constructor async (kit-backed).
  const keypair = await Keypair.fromSeed(seed);
  return {
    keypair,
    publicKey: keypair.publicKey,
    fingerprint: publicKeyFingerprint(keypair.publicKey),
  };
}
/**
 * Resolve the oracle signer from the environment, preferring the key FILE
 * (`ORACLE_KEY_FILE`, recommended custody: 0600, outside any repo) over
 * the env var (`ACTIVITY_ORACLE_KEY`). Throws when neither is present —
 * callers must then run in discovery-only / simulation-only mode.
 */
export async function resolveOracleSigner(opts?: {
  oracleKeyFile?: string | null;
  oracleKeyEnv?: string | null;
}): Promise<OracleSigner> {
  const keyFile = opts?.oracleKeyFile ?? process.env.ORACLE_KEY_FILE ?? null;
  const keyEnv = opts?.oracleKeyEnv ?? process.env.ACTIVITY_ORACLE_KEY ?? null;
  if (keyFile) {
    const payload = readFileSync(keyFile, "utf8");
    return oracleSignerFromSeed(parseOracleSeedFromFilePayload(payload));
  }
  if (keyEnv) {
    return oracleSignerFromSeed(parseOracleSeedFromEnv(keyEnv));
  }
  throw new Error(
    "no oracle key material: set ORACLE_KEY_FILE (preferred) or ACTIVITY_ORACLE_KEY — " +
      "see docs/ORACLE_PIPELINE.md custody rules",
  );
}

/**
 * Sign the canonical 112-byte attestation message with the oracle key.
 * Uses tweetnacl detached signing — the same primitive the monorepo
 * indexer/submit.ts and the SDK's test vectors use, so signature bytes
 * are exactly what the on-chain precompile path consumes.
 */
export function signAttestationMessage(signer: OracleSigner, message: Uint8Array): Uint8Array {
  if (message.length !== 112) {
    throw new Error(`attestation message must be exactly 112 bytes, got ${message.length}`);
  }
  return nacl.sign.detached(message, signer.keypair.secretKey);
}

/** Verify an Ed25519 signature over a message (public operation). */
export function verifyAttestationSignature(
  signature: Uint8Array,
  message: Uint8Array,
  oraclePublicKey: Uint8Array,
): boolean {
  return nacl.sign.detached.verify(message, signature, oraclePublicKey);
}

/**
 * Generate a fresh disposable devnet oracle keypair (Phase 2 verification
 * key). The secret exists ONLY in the returned signer's memory; callers
 * who want persistence must write it themselves under restrictive
 * permissions OUTSIDE any repository, or let it die with the session
 * (recommended for devnet-verification keys — see docs custody section).
 */
export async function generateDisposableOracleSigner(): Promise<OracleSigner> {
  const keypair = await Keypair.generate();
  return {
    keypair,
    publicKey: keypair.publicKey,
    fingerprint: publicKeyFingerprint(keypair.publicKey),
  };
}
