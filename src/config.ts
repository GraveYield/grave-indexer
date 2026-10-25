// SPDX-License-Identifier: Apache-2.0
//
// Configuration — env-driven with safe defaults (org convention inherited
// from @graveyield/indexer). Two-cluster support is the point of Phase 2:
//
//   * DISCOVERY cluster (default mainnet-beta) — where Raydium V4 pools
//     actually live; all discovery/derivation RPC is read-only there.
//   * VERIFICATION cluster (default devnet) — where the deployed
//     GraveScanner consumes attestations; evidence issuance (issued_slot +
//     slot_hash) MUST happen against this cluster, because the on-chain
//     freshness check resolves issued_slot in THIS cluster's SlotHashes.
//
// Secret handling:
//
//   * The activity oracle key is loaded from a FILE (`ORACLE_KEY_FILE`,
//     recommended: solana-keygen JSON, mode 0600) or the `ACTIVITY_ORACLE_KEY`
//     env var (base58 32-byte seed). Key material is parsed into memory and
//     NEVER logged, echoed, serialized, or committed. See docs/ORACLE_PIPELINE.md
//     for the custody/rotation runbook.

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/** Devnet GraveScanner program ID (DR-001 fresh deployment, 2026-10-25). */
export const DEVNET_SCANNER_PROGRAM_ID = new PublicKey(
  "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54",
);

/** Devnet GraveVault program ID (DR-001 fresh deployment, 2026-10-25). */
export const DEVNET_VAULT_PROGRAM_ID = new PublicKey(
  "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg",
);

/**
 * SlotHashes holds ~512 entries; the on-chain freshness check fails once
 * issued_slot ages out. Evidence issuance must complete within this
 * window. Pipeline policy keeps a safety margin under the window.
 */
export const SLOTHASHES_WINDOW_SLOTS = 512;

/** Discovery snapshots older than this (slots) are stale and must be
 *  re-fetched before any evidence is issued from them. Default 400 ≈
 *  ~17 min at 2.5 s/slot — comfortably inside the SlotHashes window. */
export const DEFAULT_DISCOVERY_STALENESS_SLOTS = 400;

/** Verifier refuses to rate a bundle whose issued_slot is further back
 *  than this (it could never be accepted on chain). Default 450 < 512. */
export const DEFAULT_EVIDENCE_FRESHNESS_SLOTS = 450;

/** Pipeline configuration, loaded from env with safe defaults. */
export interface PipelineConfig {
  /** Discovery RPC endpoint (read-only usage enforced by convention). */
  discoveryRpcUrl: string;
  discoveryCluster: "devnet" | "mainnet-beta";
  /** Verification / evidence-issuance RPC endpoint (default devnet). */
  verificationRpcUrl: string;
  /** GraveScanner program id on the verification cluster. */
  scannerProgramId: PublicKey;
  /** GraveVault program id on the verification cluster. */
  vaultProgramId: PublicKey;
  /** Max pools enumerated per discovery scan (RPC politeness). */
  maxPoolsPerScan: number;
  /** Signature-scan limit for last-swap derivations. */
  signatureScanLimit: number;
  /** Discovery staleness policy (slots). */
  discoveryStalenessSlots: number;
  /** Evidence freshness policy (slots). */
  evidenceFreshnessSlots: number;
  /** Directory for ledgers, journals and evidence bundles. */
  dataDir: string;
  /** Path to the oracle key file (never serialized anywhere). */
  oracleKeyFile: string | null;
  /** Base58 32-byte oracle seed from env (discouraged; file preferred). */
  oracleKeyEnv: string | null;
  /** When true, verify-path expects the canonical case to fail with
   *  AttestationOracleMismatch (signer ≠ configured oracle). Set
   *  ORACLE_IS_REGISTERED=true once a dedicated oracle key has been
   *  registered on chain via update_protocol_config. */
  oracleIsRegistered: boolean;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Load the pipeline configuration from the environment. */
export function loadPipelineConfig(): PipelineConfig {
  const discoveryRpcUrl = process.env.DISCOVERY_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const discoveryCluster =
    (process.env.DISCOVERY_CLUSTER ?? "mainnet-beta") === "devnet" ? "devnet" : "mainnet-beta";
  const verificationRpcUrl = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  const scannerProgramId = process.env.SCANNER_PROGRAM_ID
    ? new PublicKey(process.env.SCANNER_PROGRAM_ID)
    : DEVNET_SCANNER_PROGRAM_ID;
  const vaultProgramId = process.env.VAULT_PROGRAM_ID
    ? new PublicKey(process.env.VAULT_PROGRAM_ID)
    : DEVNET_VAULT_PROGRAM_ID;

  const oracleKeyFile = process.env.ORACLE_KEY_FILE ?? null;
  const oracleKeyEnv = process.env.ACTIVITY_ORACLE_KEY ?? null;

  return {
    discoveryRpcUrl,
    discoveryCluster,
    verificationRpcUrl,
    scannerProgramId,
    vaultProgramId,
    maxPoolsPerScan: intEnv("MAX_POOLS_PER_SCAN", 500),
    signatureScanLimit: intEnv("SIGNATURE_SCAN_LIMIT", 1000),
    discoveryStalenessSlots: intEnv("DISCOVERY_STALENESS_SLOTS", DEFAULT_DISCOVERY_STALENESS_SLOTS),
    evidenceFreshnessSlots: intEnv("EVIDENCE_FRESHNESS_SLOTS", DEFAULT_EVIDENCE_FRESHNESS_SLOTS),
    dataDir: process.env.DATA_DIR ?? "./data",
    oracleKeyFile,
    oracleKeyEnv,
    oracleIsRegistered: (process.env.ORACLE_IS_REGISTERED ?? "false") === "true",
  };
}

/**
 * Parse an Ed25519 seed (32 bytes) from a key-file payload. Accepts:
 *   - solana-keygen JSON arrays of 64 bytes (`[se crate…, pubkey]`)
 *   - solana-keygen JSON arrays of 32 bytes (seed-only files)
 *   - JSON objects `{ "seed_base58": "…" }`
 * Returns ONLY the 32-byte seed. Never log the input.
 */
export function parseOracleSeedFromFilePayload(payload: string): Uint8Array {
  const trimmed = payload.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(arr) || (arr.length !== 32 && arr.length !== 64)) {
      throw new Error(
        `oracle key file must be a JSON array of 32 (seed) or 64 (secret) bytes, got ${Array.isArray(arr) ? arr.length : "non-array"}`,
      );
    }
    const bytes = Uint8Array.from(arr as number[]);
    return bytes.length === 64 ? bytes.slice(0, 32) : bytes;
  }
  const obj = JSON.parse(trimmed) as { seed_base58?: string };
  if (typeof obj?.seed_base58 === "string") {
    const decoded = bs58.decode(obj.seed_base58);
    if (decoded.length !== 32) {
      throw new Error(`seed_base58 must decode to 32 bytes, got ${decoded.length}`);
    }
    return new Uint8Array(decoded);
  }
  throw new Error("oracle key file payload not recognized (expected JSON array or {seed_base58})");
}

/** Parse a base58 32-byte seed from the env-var form. Never log the input. */
export function parseOracleSeedFromEnv(value: string): Uint8Array {
  const decoded = bs58.decode(value.trim());
  if (decoded.length !== 32) {
    throw new Error(`ACTIVITY_ORACLE_KEY must decode to 32 bytes (Ed25519 seed), got ${decoded.length}`);
  }
  return new Uint8Array(decoded);
}
