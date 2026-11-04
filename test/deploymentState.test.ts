// SPDX-License-Identifier: Apache-2.0
//
// Deployment-state regression battery (NS-3 review) — mock-only, no real
// Devnet access, no transactions, no faucet. Covers the four deployment
// classifications plus the strict-opt-in faucet policy:
//
//   1. both programs absent            → deployment-pending (skip signal)
//   2. both deployed and initialized   → ready
//   3. only Scanner deployed           → partial-deployment (FAIL signal)
//   4. only Vault deployed             → partial-deployment (FAIL signal)
//   5. deployed but config missing     → inconsistent (FAIL signal)
//   6. incorrect configuration authority → flagged exactly
//   7. incorrect oracle signer config  → flagged exactly
//   8. read-only execution never requests faucet funding (strict opt-in)
//   9. program-level simulations never run on a pending deployment
//
// The program accounts are mocked at the RPC boundary (getAccountInfo /
// getBalance / requestAirdrop / getSlot / getBlock); the ProtocolConfig
// bytes are synthetic but byte-exact against the SDK borsh layout, so the
// decoders run for real.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  AccountDisc,
  decodeScannerProtocolConfig,
  decodeVaultProtocolConfig,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
} from "@graveyield/sdk";

import {
  DEVNET_SCANNER_PROGRAM_ID,
  DEVNET_VAULT_PROGRAM_ID,
  NS3_GOVERNANCE_AUTHORITY,
  NS3_ACTIVITY_ORACLE,
  NS3_LAUNCH_PRICE_ORACLE,
} from "../src/config.js";
import {
  resolveDeploymentState,
  collectScannerConfigProblems,
  collectVaultConfigProblems,
  BPF_UPGRADEABLE_LOADER_PROGRAM_ID,
  type DeploymentState,
} from "../src/deploymentState.js";
import { runEvidencePathVerification, resolveFundedPayer } from "../src/evidencePath.js";

const SCANNER = DEVNET_SCANNER_PROGRAM_ID;
const VAULT = DEVNET_VAULT_PROGRAM_ID;
const LOADER = new PublicKey(BPF_UPGRADEABLE_LOADER_PROGRAM_ID);
const GOVERNANCE = new PublicKey(NS3_GOVERNANCE_AUTHORITY);
const ACTIVITY_ORACLE = new PublicKey(NS3_ACTIVITY_ORACLE);
const LAUNCH_PRICE_ORACLE = new PublicKey(NS3_LAUNCH_PRICE_ORACLE);

// ---------------------------------------------------------------- mocks

interface MockAccount {
  owner: PublicKey;
  executable: boolean;
  data: Uint8Array;
}

interface MockState {
  accounts: Map<string, MockAccount>;
  balances: Map<string, number>;
  airdropCalls: string[];
}

function mockRpc(state: MockState): Connection {
  return {
    async getAccountInfo(addr: PublicKey) {
      return state.accounts.get(addr.toBase58()) ?? null;
    },
    async getBalance(addr: PublicKey) {
      return state.balances.get(addr.toBase58()) ?? 0;
    },
    async requestAirdrop(addr: PublicKey) {
      state.airdropCalls.push(addr.toBase58());
      throw new Error("airdrop refused: tests must not mutate external state");
    },
    async getSlot() {
      return 1_000_000;
    },
    async getBlock() {
      return { blockhash: "11111111111111111111111111111111" };
    },
  } as unknown as Connection;
}

function freshState(): MockState {
  return { accounts: new Map(), balances: new Map(), airdropCalls: [] };
}

// ------------------------------------------------- synthetic accounts

/** A minimal stand-in for a deployed BPF program account. */
function programAccount(): MockAccount {
  return { owner: LOADER, executable: true, data: new Uint8Array(64).fill(0x7f) };
}

/**
 * Byte-exact GraveScanner ProtocolConfig (188 bytes) per the SDK borsh
 * layout: disc(8) authority(32) pending(32) eta(i64) inactivity(u64)
 * collapse(u16) minTvl(u64) staleness(u64) dust(u64) certTtl(i64)
 * paused(1) activityOracle(32) launchPriceOracle(32) bump(1).
 */
function scannerConfigAccount(opts: {
  authority: PublicKey;
  activityOracle?: PublicKey;
  launchPriceOracle?: PublicKey;
  bump?: number;
}): MockAccount {
  const buf = Buffer.alloc(188);
  Buffer.from(AccountDisc.ProtocolConfig).copy(buf, 0);
  Buffer.from(opts.authority.toBytes()).copy(buf, 8);
  Buffer.from(opts.authority.toBytes()).copy(buf, 40); // pendingAuthority
  buf.writeBigInt64LE(0n, 72);
  buf.writeBigUInt64LE(7_776_000n, 80);
  buf.writeUInt16LE(9_900, 88);
  buf.writeBigUInt64LE(500_000_000n, 90);
  buf.writeBigUInt64LE(1_209_600n, 98);
  buf.writeBigUInt64LE(1_000n, 106);
  buf.writeBigInt64LE(3_600n, 114);
  buf.writeUInt8(0, 122); // paused = false
  Buffer.from((opts.activityOracle ?? opts.authority).toBytes()).copy(buf, 123);
  Buffer.from((opts.launchPriceOracle ?? opts.authority).toBytes()).copy(buf, 155);
  buf.writeUInt8(opts.bump ?? 255, 187);
  return { owner: SCANNER, executable: false, data: new Uint8Array(buf) };
}

/** Install a fully deployed + initialized two-program NS-3 world. */
function installReadyWorld(state: MockState): void {
  state.accounts.set(SCANNER.toBase58(), programAccount());
  state.accounts.set(VAULT.toBase58(), programAccount());
  // Config PDAs derived exactly like the code under test.
  state.accounts.set(
    scannerProtocolConfigPda(SCANNER).toBase58(),
    scannerConfigAccount({ authority: GOVERNANCE }),
  );
  state.accounts.set(
    vaultProtocolConfigPda(VAULT).toBase58(),
    vaultConfigAccount({ authority: GOVERNANCE }),
  );
}

/** Byte-exact GraveVault ProtocolConfig (185 bytes) per the SDK borsh layout. */
function vaultConfigAccount(opts: { authority: PublicKey }): MockAccount {
  // disc(8) authority(32) pending(32) eta(i64) lpHolder(u16) salvor(u16)
  // protocol(u16) maxPrioFee(u64) slippage(u16) dust(u64) timelock(i64)
  // paused(1) bump(1) = 8+32+32+8+2+2+2+8+2+8+8+1+1 = 114... the decoder
  // reads exactly the fields below; length is derived from the writes.
  const buf = Buffer.alloc(114);
  Buffer.from(AccountDisc.ProtocolConfig).copy(buf, 0);
  Buffer.from(opts.authority.toBytes()).copy(buf, 8);
  Buffer.from(opts.authority.toBytes()).copy(buf, 40);
  buf.writeBigInt64LE(0n, 72);
  buf.writeUInt16LE(4_000, 80);
  buf.writeUInt16LE(4_000, 82);
  buf.writeUInt16LE(2_000, 84);
  buf.writeBigUInt64LE(1_000_000_000n, 86);
  buf.writeUInt16LE(300, 94);
  buf.writeBigUInt64LE(666_666n, 96);
  buf.writeBigInt64LE(259_200n, 104);
  buf.writeUInt8(0, 112);
  buf.writeUInt8(255, 113);
  return { owner: VAULT, executable: false, data: new Uint8Array(buf) };
}

// ---------------------------------------------------------------- tests

describe("deployment-state classification (NS-3 review cases 1–4)", () => {
  test("Case 1: both programs absent → deployment-pending, no problems", async () => {
    const state = freshState();
    const rpc = mockRpc(state);
    const d = await resolveDeploymentState(rpc, SCANNER, VAULT);
    assert.equal(d.classification, "deployment-pending");
    assert.deepEqual(d.problems, []);
    assert.equal(d.scanner.programAccountExists, false);
    assert.equal(d.vault.programAccountExists, false);
  });

  test("Case 2: both programs deployed and initialized → ready", async () => {
    const state = freshState();
    installReadyWorld(state);
    const d = await resolveDeploymentState(mockRpc(state), SCANNER, VAULT);
    assert.equal(d.classification, "ready");
    assert.deepEqual(d.problems, []);
    assert.equal(d.scanner.configDecodable, true);
    assert.equal(d.vault.configDecodable, true);
    // The config account must be owned by the program itself, not the loader.
    assert.equal(d.scanner.configOwner, SCANNER.toBase58());
  });

  test("Case 3: only Scanner deployed → partial-deployment, exact problem", async () => {
    const state = freshState();
    state.accounts.set(SCANNER.toBase58(), programAccount());
    const d = await resolveDeploymentState(mockRpc(state), SCANNER, VAULT);
    assert.equal(d.classification, "partial-deployment");
    assert.equal(d.problems.length, 1);
    assert.match(d.problems[0]!, /GraveVault program account is absent/);
    assert.match(d.problems[0]!, /partial deployment/);
  });

  test("Case 3b: only Vault deployed → partial-deployment, exact problem", async () => {
    const state = freshState();
    state.accounts.set(VAULT.toBase58(), programAccount());
    const d = await resolveDeploymentState(mockRpc(state), SCANNER, VAULT);
    assert.equal(d.classification, "partial-deployment");
    assert.match(d.problems.join(" "), /GraveScanner program account is absent/);
  });

  test("Case 4: programs deployed but config missing → inconsistent (never 'pending')", async () => {
    const state = freshState();
    state.accounts.set(SCANNER.toBase58(), programAccount());
    state.accounts.set(VAULT.toBase58(), programAccount());
    const d = await resolveDeploymentState(mockRpc(state), SCANNER, VAULT);
    assert.equal(d.classification, "inconsistent");
    const joined = d.problems.join(" ");
    assert.match(joined, /GraveScanner is deployed but its \['protocol_config'\] PDA/);
    assert.match(joined, /NOT initialized/);
    assert.match(joined, /GraveVault is deployed but its \['protocol_config'\] PDA/);
  });

  test("Case 4b: config owned by the wrong program → inconsistent with exact owner", async () => {
    const state = freshState();
    state.accounts.set(SCANNER.toBase58(), programAccount());
    state.accounts.set(VAULT.toBase58(), programAccount());
    const pda = scannerProtocolConfigPda(SCANNER);
    // Scanner config present but owned by the VAULT program (wrong owner).
    const acct = scannerConfigAccount({ authority: GOVERNANCE });
    state.accounts.set(pda.toBase58(), { ...acct, owner: VAULT });
    const d = await resolveDeploymentState(mockRpc(state), SCANNER, VAULT);
    assert.equal(d.classification, "inconsistent");
    assert.match(d.problems.join(" "), new RegExp(`owner is ${VAULT.toBase58()}`));
  });

  test("Case 4c: undecodable config bytes → inconsistent with decode error", async () => {
    const state = freshState();
    state.accounts.set(SCANNER.toBase58(), programAccount());
    state.accounts.set(VAULT.toBase58(), programAccount());
    const pda = scannerProtocolConfigPda(SCANNER);
    state.accounts.set(pda.toBase58(), {
      owner: SCANNER,
      executable: false,
      data: new Uint8Array(32).fill(0xee), // wrong discriminator + too short
    });
    const d = await resolveDeploymentState(mockRpc(state), SCANNER, VAULT);
    assert.equal(d.classification, "inconsistent");
    assert.match(d.problems.join(" "), /does not decode/);
  });
});

describe("config identity expectations (NS-3 authority + oracles)", () => {
  test("correct NS-3 initial state (authority everywhere) raises NO problems", () => {
    const cfg = decodeScannerProtocolConfig(
      scannerConfigAccount({ authority: GOVERNANCE }).data,
    );
    const problems = collectScannerConfigProblems(cfg, { expectedAuthority: NS3_GOVERNANCE_AUTHORITY });
    assert.deepEqual(problems, []);
  });

  test("regression 6: incorrect configuration authority is flagged exactly", () => {
    // Initialized with the DEPLOYER as config authority instead of the
    // dedicated governance authority — the exact NS-3 arrangement defect.
    const deployer = new PublicKey("cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831");
    const cfg = decodeScannerProtocolConfig(scannerConfigAccount({ authority: deployer }).data);
    const problems = collectScannerConfigProblems(cfg, { expectedAuthority: NS3_GOVERNANCE_AUTHORITY });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, new RegExp(deployer.toBase58()));
    assert.match(problems[0]!, new RegExp(NS3_GOVERNANCE_AUTHORITY));
  });

  test("regression 7: incorrect oracle signer configuration is flagged exactly", () => {
    // Post-registration expectations: dedicated keys required, but the
    // config still carries the governance authority in the oracle fields.
    const cfg = decodeScannerProtocolConfig(scannerConfigAccount({ authority: GOVERNANCE }).data);
    const problems = collectScannerConfigProblems(cfg, {
      expectedAuthority: NS3_GOVERNANCE_AUTHORITY,
      expectedActivityOracle: NS3_ACTIVITY_ORACLE,
      expectedLaunchPriceOracle: NS3_LAUNCH_PRICE_ORACLE,
    });
    assert.equal(problems.length, 2);
    assert.match(problems.join(" "), new RegExp(NS3_ACTIVITY_ORACLE));
    assert.match(problems.join(" "), new RegExp(NS3_LAUNCH_PRICE_ORACLE));
  });

  test("registered dedicated oracles satisfy the expectations", () => {
    const cfg = decodeScannerProtocolConfig(
      scannerConfigAccount({
        authority: GOVERNANCE,
        activityOracle: ACTIVITY_ORACLE,
        launchPriceOracle: LAUNCH_PRICE_ORACLE,
      }).data,
    );
    const problems = collectScannerConfigProblems(cfg, {
      expectedAuthority: NS3_GOVERNANCE_AUTHORITY,
      expectedActivityOracle: NS3_ACTIVITY_ORACLE,
      expectedLaunchPriceOracle: NS3_LAUNCH_PRICE_ORACLE,
    });
    assert.deepEqual(problems, []);
  });

  test("vault authority expectation: wrong authority flagged, correct passes", () => {
    const good = decodeVaultProtocolConfig(vaultConfigAccount({ authority: GOVERNANCE }).data);
    assert.deepEqual(collectVaultConfigProblems(good, { expectedAuthority: NS3_GOVERNANCE_AUTHORITY }), []);
    const bad = decodeVaultProtocolConfig(
      vaultConfigAccount({ authority: new PublicKey("cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831") }).data,
    );
    const problems = collectVaultConfigProblems(bad, { expectedAuthority: NS3_GOVERNANCE_AUTHORITY });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /vault ProtocolConfig authority/);
  });
});

describe("faucet policy (strict opt-in, review regression 8)", () => {
  test("read-only default: unfunded payer + allowFaucet=false → NO airdrop attempted", async () => {
    const state = freshState();
    const rpc = mockRpc(state);
    const payer = await Keypair.generate();
    const r = await resolveFundedPayer(rpc, { payer, allowFaucet: false });
    assert.equal(r.funded, false);
    assert.equal(r.airdropAttempted, false);
    assert.equal(state.airdropCalls.length, 0, "no faucet request may leave the process");
  });

  test("read-only default also applies when allowFaucet is omitted", async () => {
    const state = freshState();
    const payer = await Keypair.generate();
    const r = await resolveFundedPayer(mockRpc(state), { payer });
    assert.equal(r.funded, false);
    assert.equal(r.airdropAttempted, false);
    assert.equal(state.airdropCalls.length, 0);
  });

  test("explicit opt-in: allowFaucet=true attempts the airdrop (and refuses here)", async () => {
    const state = freshState();
    const payer = await Keypair.generate();
    const r = await resolveFundedPayer(mockRpc(state), { payer, allowFaucet: true });
    assert.equal(r.airdropAttempted, true);
    assert.equal(state.airdropCalls.length, 1, "exactly one explicit faucet request");
    assert.equal(r.funded, false, "the mock refuses the airdrop; funding stays false");
  });

  test("pre-funded payer: never an airdrop, even when the faucet is allowed", async () => {
    const state = freshState();
    const payer = await Keypair.generate();
    state.balances.set(payer.publicKey.toBase58(), 42_000_000);
    const r = await resolveFundedPayer(mockRpc(state), { payer, allowFaucet: true });
    assert.equal(r.funded, true);
    assert.equal(r.airdropAttempted, false);
    assert.equal(state.airdropCalls.length, 0);
  });
});

describe("program-level gating (review regression 9)", () => {
  test("pending deployment: matrix reports the skip, runs NO program-level sims, requests NO faucet", async () => {
    const state = freshState();
    const rpc = mockRpc(state); // every account absent
    const report = await runEvidencePathVerification({
      connection: rpc,
      cluster: "devnet",
      scannerProgramId: SCANNER,
      vaultProgramId: VAULT,
      nowUnixSeconds: 1_760_000_000,
    });
    assert.equal(report.deployment.classification, "deployment-pending");
    const programCases = report.cases.filter((c) => c.layer === "program-live");
    assert.equal(programCases.length, 1, "exactly the explicit program-level-batch placeholder");
    assert.equal(programCases[0]!.caseId, "program-level-batch");
    assert.equal(programCases[0]!.skipped, true);
    assert.match(programCases[0]!.description, /NOT RUN/);
    assert.match(programCases[0]!.description, /deployment pending/);
    // Verifier-level cases still ran (read-only, program-independent).
    assert.ok(report.cases.some((c) => c.layer === "verifier-live" && !c.skipped));
    // No faucet was ever requested.
    assert.equal(state.airdropCalls.length, 0);
    assert.equal(report.payerAddress, "", "no payer resolved on a pending deployment");
  });

  test("partial deployment: matrix refuses to run program-level sims and carries the problem", async () => {
    const state = freshState();
    state.accounts.set(SCANNER.toBase58(), programAccount()); // vault missing
    const report = await runEvidencePathVerification({
      connection: mockRpc(state),
      cluster: "devnet",
      scannerProgramId: SCANNER,
      vaultProgramId: VAULT,
      nowUnixSeconds: 1_760_000_000,
    });
    assert.equal(report.deployment.classification, "partial-deployment");
    assert.match(report.deployment.problems.join(" "), /partial deployment/);
    const programCases = report.cases.filter((c) => c.layer === "program-live");
    assert.equal(programCases.length, 1);
    assert.equal(programCases[0]!.skipped, true);
    assert.equal(state.airdropCalls.length, 0);
  });

  test("deployment state surfaces in the smoke path for every non-ready case", async () => {
    const states: DeploymentState["classification"][] = [
      "deployment-pending",
      "partial-deployment",
      "inconsistent",
    ];
    for (const expected of states) {
      const state = freshState();
      if (expected === "partial-deployment") state.accounts.set(SCANNER.toBase58(), programAccount());
      if (expected === "inconsistent") {
        state.accounts.set(SCANNER.toBase58(), programAccount());
        state.accounts.set(VAULT.toBase58(), programAccount());
      }
      const d = await resolveDeploymentState(mockRpc(state), SCANNER, VAULT);
      assert.equal(d.classification, expected);
      void expected;
    }
  });
});
