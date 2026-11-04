// SPDX-License-Identifier: Apache-2.0
//
// Live devnet smoke (read-only + simulation) — the Phase 2 scheduled
// smoke, gated on DEVNET_RPC_URL so `pnpm test` stays green offline.
//
// EXPLICIT DEPLOYMENT-STATE HANDLING (NS-3 review, cases 1–4): the suite
// resolves the ACTUAL deployment state from the program accounts FIRST
// (src/deploymentState.ts) and branches on it:
//
//   Case 1 — both programs absent        → genuinely pending deployment:
//         program-requiring tests SKIP with a clear report; NO
//         program-level evidence-path simulation runs.
//   Case 2 — both programs deployed AND initialized → full validation:
//         program identity (owner loader + executable), NS-3 config
//         coordinates, governance authority, oracle anchors, then the
//         evidence-path matrix.
//   Case 3 — only one program deployed   → the smoke test FAILS. A
//         partial deployment is never classified as pending.
//   Case 4 — programs present but config missing / wrongly owned /
//         undecodable / wrong authority → the smoke test FAILS with the
//         exact inconsistency; nothing is silently skipped.
//
// A missing configuration account alone is NEVER treated as proof that a
// program is undeployed — program existence comes from the program
// account itself.
//
// READ-ONLY FAUCET POLICY (NS-3 review): this suite never requests a
// devnet airdrop. The evidence-path matrix runs with the faucet STRICTLY
// off; its funding-dependent program-level cases self-skip with an
// actionable note unless the operator supplies PAYER_KEY_FILE (owner
// opt-in). No default path mutates external chain state.
//
//   1. Deployment-state classification (cases 1/3/4 decided here).
//   2. Decode the deployed GraveScanner ProtocolConfig and assert the
//      NS-3 PDA coordinates (pre-deployment derivation), the bump-255
//      invariant, the governance authority, and the configured
//      activity / launch-price oracles (public keys — logged
//      intentionally; these are authorization anchors).
//   3. Run the evidence-path verification matrix (verifier-level cases
//      always; program-level cases only when the deployment is ready AND
//      a funded payer is available — never via an implicit faucet).
//
// Deployment: NS-3 (DR-002) — the program IDs are ASSIGNED but NOT yet
// deployed or initialized. Until the owner executes the NS-3 deployment
// (graveyield-protocol docs/DEVNET.md), Case 1 applies and the suite
// reports the pending condition explicitly. The NS-2 deployment is a
// preserved legacy record — do NOT re-point at it.
//
// Mirrors sdk/test/devnetSmoke.test.ts conventions.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchScannerProtocolConfig,
  fetchVaultProtocolConfig,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
} from "@graveyield/sdk";
// The SDK exports its default program ids as base58 STRINGS (client.ts);
// the indexer's config module owns the PublicKey forms. Do not pass the
// SDK string constants where PublicKey is required.
import {
  DEVNET_SCANNER_PROGRAM_ID,
  DEVNET_VAULT_PROGRAM_ID,
  NS3_GOVERNANCE_AUTHORITY,
  NS3_ACTIVITY_ORACLE,
  NS3_LAUNCH_PRICE_ORACLE,
} from "../src/config.js";
import { runEvidencePathVerification } from "../src/evidencePath.js";
import {
  resolveDeploymentState,
  collectScannerConfigProblems,
  collectVaultConfigProblems,
  BPF_UPGRADEABLE_LOADER_PROGRAM_ID,
  type DeploymentState,
} from "../src/deploymentState.js";

const DEVNET_RPC = process.env.DEVNET_RPC_URL;
const SKIP = !DEVNET_RPC;

/**
 * Optional operator opt-in: when these are set, the configured oracle
 * fields are additionally REQUIRED to equal the dedicated NS-3 oracle
 * identities (i.e. the owner has already run register-oracle). Before
 * registration the fields legitimately hold the governance authority, so
 * these expectations default OFF.
 */
const EXPECTED_ACTIVITY_ORACLE = process.env.EXPECTED_ACTIVITY_ORACLE ?? undefined;
const EXPECTED_LAUNCH_PRICE_ORACLE = process.env.EXPECTED_LAUNCH_PRICE_ORACLE ?? undefined;

describe("devnet evidence-path smoke (read-only + simulation)", { skip: SKIP }, () => {
  const connection = new Connection(DEVNET_RPC ?? "http://localhost:8899", "confirmed");

  let state: DeploymentState;
  before(async () => {
    state = await resolveDeploymentState(connection, DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID);
    console.log(`  deployment classification: ${state.classification}`);
    for (const p of state.problems) console.log(`    problem: ${p}`);
  });

  const pending = () => state.classification === "deployment-pending";
  const broken = () =>
    state.classification === "partial-deployment" || state.classification === "inconsistent";

  test("deployment state is coherent — pending skips, partial/inconsistent FAIL", async (t) => {
    if (pending()) {
      t.skip(
        "NS-3 deployment pending: neither NS-3 program account exists on devnet yet " +
          "(owner executes deployment per graveyield-protocol docs/DEVNET.md — program-requiring tests validate it afterward)",
      );
      return;
    }
    if (broken()) {
      assert.fail(
        `deployment state is ${state.classification} — NOT pending, NOT ready:\n  - ${state.problems.join("\n  - ")}`,
      );
    }
    // Case 2 — the deployment is structurally ready; pin the program
    // identity facts explicitly (owner loader + executable).
    assert.equal(state.classification, "ready");
    assert.equal(
      state.scanner.programOwner,
      BPF_UPGRADEABLE_LOADER_PROGRAM_ID,
      "GraveScanner program account must be owned by the BPF upgradeable loader",
    );
    assert.equal(state.scanner.programExecutable, true, "GraveScanner must be executable");
    assert.equal(
      state.vault.programOwner,
      BPF_UPGRADEABLE_LOADER_PROGRAM_ID,
      "GraveVault program account must be owned by the BPF upgradeable loader",
    );
    assert.equal(state.vault.programExecutable, true, "GraveVault must be executable");
  });

  test("GraveScanner ProtocolConfig matches the NS-3 derivation with bump 255", async (t) => {
    if (pending()) {
      t.skip(
        "NS-3 deployment pending: scanner ProtocolConfig not initialized on devnet yet " +
          "(owner executes deployment per graveyield-protocol docs/DEVNET.md)",
      );
      return;
    }
    assert.equal(broken(), false, `deployment broken — see the classification test: ${state.problems.join("; ")}`);
    const pda = scannerProtocolConfigPda(DEVNET_SCANNER_PROGRAM_ID);
    assert.equal(pda.toBase58(), "5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe");
    const cfg = await fetchScannerProtocolConfig(connection, pda);
    if (!cfg) {
      // The program EXISTS but its config is absent — Case 4, never a skip.
      assert.fail(
        `GraveScanner program is deployed but its ['protocol_config'] PDA (${pda.toBase58()}) is absent — deployed but NOT initialized`,
      );
    }
    assert.equal(cfg!.bump, 255, "bump-255 invariant (['protocol_config'], canonical bump)");
    assert.equal(cfg!.paused, false, "program must not be paused for the evidence path");
    // NS-3 content expectations: governance authority identity, oracle anchors.
    const problems = collectScannerConfigProblems(cfg!, {
      expectedAuthority: NS3_GOVERNANCE_AUTHORITY,
      ...(EXPECTED_ACTIVITY_ORACLE ? { expectedActivityOracle: EXPECTED_ACTIVITY_ORACLE } : {}),
      ...(EXPECTED_LAUNCH_PRICE_ORACLE ? { expectedLaunchPriceOracle: EXPECTED_LAUNCH_PRICE_ORACLE } : {}),
    });
    assert.deepEqual(problems, [], "NS-3 config identity expectations");
    // The configured oracles are PUBLIC keys — recorded for the report.
    // Under NS-3 these start at the governance authority and become the
    // dedicated keys after register-oracle:
    //   governance      BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5
    //   activity        2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o
    //   launch price    97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee
    console.log(`  configured authority:            ${cfg!.authority.toBase58()}`);
    console.log(`  configured activity_oracle:      ${cfg!.activityOracle.toBase58()}`);
    console.log(`  configured launch_price_oracle:  ${cfg!.launchPriceOracle.toBase58()}`);
    const vaultCfg = await fetchVaultProtocolConfig(
      connection,
      vaultProtocolConfigPda(DEVNET_VAULT_PROGRAM_ID),
    );
    if (!vaultCfg) {
      assert.fail(
        `GraveVault program is deployed but its ['protocol_config'] PDA is absent — deployed but NOT initialized`,
      );
    }
    assert.deepEqual(
      collectVaultConfigProblems(vaultCfg, { expectedAuthority: NS3_GOVERNANCE_AUTHORITY }),
      [],
      "vault NS-3 authority expectation",
    );
  });

  test("evidence-path verification matrix passes against the deployed program", async (t) => {
    if (pending()) {
      t.skip(
        "NS-3 deployment pending: program-level evidence-path simulations require the deployed " +
          "programs — nothing is executed against absent programs (owner executes deployment per " +
          "graveyield-protocol docs/DEVNET.md)",
      );
      return;
    }
    if (broken()) {
      assert.fail(
        `deployment state is ${state.classification} — refusing to run the matrix:\n  - ${state.problems.join("\n  - ")}`,
      );
    }
    // READ-ONLY faucet policy: no airdrop is ever requested here. The
    // funding-dependent program-level cases self-skip (with an actionable
    // note) unless the operator provides PAYER_KEY_FILE; verifier-level
    // cases always run.
    const report = await runEvidencePathVerification({
      connection,
      cluster: "devnet",
      scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
      vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
      allowFaucet: false,
    });
    assert.equal(
      report.deployment.classification,
      "ready",
      `matrix must run only against a ready deployment: ${report.deployment.problems.join("; ")}`,
    );
    for (const c of report.cases) {
      const status = c.skipped ? "SKIPPED" : c.pass ? "PASS" : "FAIL";
      console.log(`  [${status}] ${c.caseId}${c.observed.decoded ? ` → ${c.observed.decoded.name} (${c.observed.decoded.hex})` : ""}`);
    }
    console.log(`  configured activity_oracle:      ${report.configuredActivityOracle ?? "(unavailable)"}`);
    console.log(`  configured launch_price_oracle:  ${report.configuredLaunchPriceOracle ?? "(unavailable)"}`);
    console.log(`  payer: ${report.payerAddress || "(not resolved — program stage skipped)"} (funded: ${report.payerFunded})`);
    const failures = report.cases.filter((c) => !c.pass);
    assert.deepEqual(
      failures.map((c) => c.caseId),
      [],
      `evidence-path failures: ${JSON.stringify(failures, null, 2)}`,
    );
    void t;
  });
});
