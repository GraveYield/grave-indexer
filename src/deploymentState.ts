// SPDX-License-Identifier: Apache-2.0
//
// Deployment-state resolution — explicit, program-existence-first
// classification of the NS-3 devnet deployment, so no harness ever runs
// program-level simulations against programs that are not on chain.
//
// The classification (Case 1–4 from the NS-3 review) is decided by the
// ACTUAL PROGRAM ACCOUNTS, never by the absence of a configuration
// account alone:
//
//   1. deployment-pending   — both program accounts absent: a genuinely
//                             pending deployment. Program-requiring tests
//                             SKIP; no program-level simulation runs.
//   2. ready                — both programs deployed (executable under
//                             the BPF upgradeable loader) and both
//                             ProtocolConfig PDAs present, program-owned
//                             and decodable. Full smoke path runs.
//   3. partial-deployment   — exactly one program account present. FAIL
//                             loudly; a partial deployment is never
//                             classified as pending.
//   4. inconsistent         — both programs present but the expected
//                             configuration is missing, wrongly owned,
//                             or undecodable. FAIL with the exact
//                             inconsistencies.
//
// NS-3 identity note: the config PDAs are the canonical ['protocol_config']
// derivations of the ASSIGNED program IDs (bump 255), NOT evidence of
// deployment — a program account that does not exist on chain means the
// assigned IDs are simply not deployed yet.
//
// Content-level expectations (governance authority identity, oracle
// signers) are validated separately by `collectScannerConfigProblems` —
// structural consistency (this module) and identity correctness are
// reported independently so a reviewer can tell them apart.

import { PublicKey } from "@solana/web3.js";
import {
  decodeScannerProtocolConfig,
  decodeVaultProtocolConfig,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
  type ScannerProtocolConfig,
  type VaultProtocolConfig,
} from "@graveyield/sdk";

/** The BPF Upgradeable loader — the on-chain owner of every deployed program account. */
export const BPF_UPGRADEABLE_LOADER_PROGRAM_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

export type DeploymentClassification =
  | "ready"
  | "deployment-pending"
  | "partial-deployment"
  | "inconsistent";

/** Structural facts about one program and its ProtocolConfig, from live RPC. */
export interface ProgramDeploymentFacts {
  /** The program account itself exists on chain (getAccountInfo ≠ null). */
  programAccountExists: boolean;
  /** Owner of the program account (the loader) — null when absent. */
  programOwner: string | null;
  /** Program account executable flag — null when absent. */
  programExecutable: boolean | null;
  /** The ['protocol_config'] PDA account exists. */
  configAccountExists: boolean;
  /** Owner of the config PDA — must be the program itself. Null when absent. */
  configOwner: string | null;
  /** Config bytes decode as the program's ProtocolConfig. Null when absent. */
  configDecodable: boolean | null;
  /** Decode error detail when configDecodable === false. */
  configDecodeError: string | null;
}

export interface DeploymentState {
  scanner: ProgramDeploymentFacts;
  vault: ProgramDeploymentFacts;
  classification: DeploymentClassification;
  /** Exact inconsistencies for partial/inconsistent states (empty otherwise). */
  problems: string[];
}

/** Minimal RPC surface consumed here — mockable in unit tests. */
export type AccountInfoLike = {
  owner: PublicKey;
  executable: boolean;
  data: Uint8Array;
} | null;

export type DeploymentRpc = {
  getAccountInfo(address: PublicKey): Promise<AccountInfoLike>;
};

async function programFacts(
  rpc: DeploymentRpc,
  programId: PublicKey,
  configPda: PublicKey,
  decode: (data: Uint8Array) => unknown,
): Promise<ProgramDeploymentFacts> {
  const programInfo = await rpc.getAccountInfo(programId);
  const configInfo = programInfo ? await rpc.getAccountInfo(configPda) : null;
  let configDecodable: boolean | null = null;
  let configDecodeError: string | null = null;
  if (configInfo) {
    try {
      decode(configInfo.data);
      configDecodable = true;
    } catch (err) {
      configDecodable = false;
      configDecodeError = String((err as Error).message ?? err);
    }
  }
  return {
    programAccountExists: programInfo !== null,
    programOwner: programInfo ? programInfo.owner.toBase58() : null,
    programExecutable: programInfo ? programInfo.executable : null,
    configAccountExists: configInfo !== null,
    configOwner: configInfo ? configInfo.owner.toBase58() : null,
    configDecodable,
    configDecodeError,
  };
}

/**
 * Resolve the live NS-3 deployment state from actual program accounts.
 * `rpc` is satisfied by a web3.js Connection; tests may pass a mock.
 */
export async function resolveDeploymentState(
  rpc: DeploymentRpc,
  scannerProgramId: PublicKey,
  vaultProgramId: PublicKey,
): Promise<DeploymentState> {
  const scanner = await programFacts(
    rpc,
    scannerProgramId,
    scannerProtocolConfigPda(scannerProgramId),
    decodeScannerProtocolConfig,
  );
  const vault = await programFacts(
    rpc,
    vaultProgramId,
    vaultProtocolConfigPda(vaultProgramId),
    decodeVaultProtocolConfig,
  );

  const problems: string[] = [];
  const checkProgram = (name: string, facts: ProgramDeploymentFacts, programId: PublicKey) => {
    if (!facts.programAccountExists) {
      problems.push(`${name} program account absent on chain (${programId.toBase58()})`);
      return;
    }
    if (facts.programOwner !== BPF_UPGRADEABLE_LOADER_PROGRAM_ID) {
      problems.push(
        `${name} program account owner is ${facts.programOwner} — expected the ` +
          `BPF upgradeable loader ${BPF_UPGRADEABLE_LOADER_PROGRAM_ID}`,
      );
    }
    if (facts.programExecutable !== true) {
      problems.push(`${name} program account is not executable (executable=${facts.programExecutable})`);
    }
    if (!facts.configAccountExists) {
      problems.push(
        `${name} is deployed but its ['protocol_config'] PDA (${configPdaOf(name, scannerProgramId, vaultProgramId)}) ` +
          `is absent — program deployed but NOT initialized`,
      );
      return;
    }
    const expectedConfigOwner = programId.toBase58();
    if (facts.configOwner !== expectedConfigOwner) {
      problems.push(
        `${name} ProtocolConfig PDA owner is ${facts.configOwner} — expected the ` +
          `${name} program itself (${expectedConfigOwner})`,
      );
    }
    if (facts.configDecodable === false) {
      problems.push(`${name} ProtocolConfig does not decode: ${facts.configDecodeError}`);
    }
  };

  const scannerExists = scanner.programAccountExists;
  const vaultExists = vault.programAccountExists;

  let classification: DeploymentClassification;
  if (!scannerExists && !vaultExists) {
    // Case 1 — genuinely pending. Config accounts CANNOT exist without
    // their program; nothing else to report.
    classification = "deployment-pending";
  } else if (scannerExists !== vaultExists) {
    // Case 3 — partial deployment. Never quietly treated as pending.
    classification = "partial-deployment";
    const missing = scannerExists ? "GraveVault" : "GraveScanner";
    const present = scannerExists ? "GraveScanner" : "GraveVault";
    problems.push(
      `partial deployment: ${present} program account is present but ${missing} program account is absent — ` +
        `a one-program deployment is an inconsistent state, not a pending one`,
    );
  } else {
    // Both present — decide ready vs inconsistent (Case 2 vs 4).
    checkProgram("GraveScanner", scanner, scannerProgramId);
    checkProgram("GraveVault", vault, vaultProgramId);
    classification = problems.length === 0 ? "ready" : "inconsistent";
  }

  return { scanner, vault, classification, problems };
}

function configPdaOf(name: string, scannerProgramId: PublicKey, vaultProgramId: PublicKey): string {
  return name === "GraveScanner"
    ? scannerProtocolConfigPda(scannerProgramId).toBase58()
    : vaultProtocolConfigPda(vaultProgramId).toBase58();
}

// ---------------------------------------------------------------------------
// Content-level validation (identity correctness of a DECODED config)
// ---------------------------------------------------------------------------

export interface ConfigExpectations {
  /** Required ProtocolConfig authority (NS-3: the governance authority). */
  expectedAuthority: string;
  /** Required activity oracle (NS-3: the dedicated C1 key), when the caller opts in. */
  expectedActivityOracle?: string | undefined;
  /** Required launch-price oracle (NS-3: the dedicated C2 key), when the caller opts in. */
  expectedLaunchPriceOracle?: string | undefined;
}

/**
 * Validate a DECODED GraveScanner ProtocolConfig against the NS-3 identity
 * expectations. Returns problem strings (empty = consistent). Pure function
 * — unit-testable without RPC.
 *
 * Oracle fields are only compared when the caller supplies expectations:
 * immediately after initialization both oracle fields legitimately hold
 * the governance authority until the owner registers the dedicated keys
 * (protocol_admin.mjs register-oracle), so an unconditional equality
 * check against the dedicated keys would misreport a correct deployment.
 */
export function collectScannerConfigProblems(
  cfg: ScannerProtocolConfig,
  expectations: ConfigExpectations,
): string[] {
  const problems: string[] = [];
  if (cfg.authority.toBase58() !== expectations.expectedAuthority) {
    problems.push(
      `scanner ProtocolConfig authority is ${cfg.authority.toBase58()} — expected the NS-3 ` +
        `governance authority ${expectations.expectedAuthority}`,
    );
  }
  if (expectations.expectedActivityOracle && cfg.activityOracle.toBase58() !== expectations.expectedActivityOracle) {
    problems.push(
      `scanner activity_oracle is ${cfg.activityOracle.toBase58()} — expected ` +
        `${expectations.expectedActivityOracle}`,
    );
  }
  if (
    expectations.expectedLaunchPriceOracle &&
    cfg.launchPriceOracle.toBase58() !== expectations.expectedLaunchPriceOracle
  ) {
    problems.push(
      `scanner launch_price_oracle is ${cfg.launchPriceOracle.toBase58()} — expected ` +
        `${expectations.expectedLaunchPriceOracle}`,
    );
  }
  // NOTE: no unconditional distinctness check between the two oracle
  // fields — `initialize` legitimately starts BOTH oracle fields at the
  // governance authority until the owner registers the dedicated keys.
  // When both dedicated expectations are supplied and differ, the two
  // equality checks above already catch a collapsed configuration.
  return problems;
}

/** Convenience: same validation for the GraveVault ProtocolConfig authority. */
export function collectVaultConfigProblems(
  cfg: VaultProtocolConfig,
  expectations: ConfigExpectations,
): string[] {
  const problems: string[] = [];
  if (cfg.authority.toBase58() !== expectations.expectedAuthority) {
    problems.push(
      `vault ProtocolConfig authority is ${cfg.authority.toBase58()} — expected the NS-3 ` +
        `governance authority ${expectations.expectedAuthority}`,
    );
  }
  return problems;
}
