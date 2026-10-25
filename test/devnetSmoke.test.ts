// SPDX-License-Identifier: Apache-2.0
//
// Live devnet smoke (read-only + simulation) — the Phase 2 scheduled
// smoke, gated on DEVNET_RPC_URL so `pnpm test` stays green offline.
//
//   1. Decode the deployed GraveScanner ProtocolConfig and assert the
//      DR-001 PDA coordinates and the bump-255 invariant.
//   2. Record the configured activity / launch-price oracles (public
//      keys — logged intentionally; these are authorization anchors).
//   3. Run the full evidence-path verification matrix against the
//      deployed program (live program-level cases where the payer could
//      be funded, verifier-level cases always) and require allPass.
//
// Mirrors sdk/test/devnetSmoke.test.ts conventions.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  DEVNET_SCANNER_PROGRAM_ID,
  DEVNET_VAULT_PROGRAM_ID,
  fetchScannerProtocolConfig,
  scannerProtocolConfigPda,
} from "@graveyield/sdk";
import { runEvidencePathVerification } from "../src/evidencePath.js";

const DEVNET_RPC = process.env.DEVNET_RPC_URL;
const SKIP = !DEVNET_RPC;

describe("devnet evidence-path smoke (read-only + simulation)", { skip: SKIP }, () => {
  const connection = new Connection(DEVNET_RPC ?? "http://localhost:8899", "confirmed");

  test("GraveScanner ProtocolConfig matches the DR-001 deployment with bump 255", async () => {
    const pda = scannerProtocolConfigPda(DEVNET_SCANNER_PROGRAM_ID);
    assert.equal(pda.toBase58(), "Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD");
    const cfg = await fetchScannerProtocolConfig(connection, pda);
    assert.ok(cfg, "ProtocolConfig must be initialized on devnet");
    assert.equal(cfg.bump, 255, "bump-255 invariant from the handoff");
    assert.equal(cfg.paused, false, "program must not be paused for the evidence path");
    // The configured oracles are PUBLIC keys — recorded for the report.
    console.log(`  configured activity_oracle:      ${cfg.activityOracle.toBase58()}`);
    console.log(`  configured launch_price_oracle:  ${cfg.launchPriceOracle.toBase58()}`);
  });

  test("evidence-path verification matrix passes against the deployed program", async () => {
    const report = await runEvidencePathVerification({
      connection,
      cluster: "devnet",
      scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
      vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
      allowFaucet: true,
    });
    for (const c of report.cases) {
      const status = c.skipped ? "SKIPPED" : c.pass ? "PASS" : "FAIL";
      console.log(`  [${status}] ${c.caseId}${c.observed.decoded ? ` → ${c.observed.decoded.name} (${c.observed.decoded.hex})` : ""}`);
    }
    console.log(`  configured activity_oracle:      ${report.configuredActivityOracle ?? "(unavailable)"}`);
    console.log(`  configured launch_price_oracle:  ${report.configuredLaunchPriceOracle ?? "(unavailable)"}`);
    console.log(`  payer: ${report.payerAddress} (funded: ${report.payerFunded})`);
    const failures = report.cases.filter((c) => !c.pass);
    assert.deepEqual(
      failures.map((c) => c.caseId),
      [],
      `evidence-path failures: ${JSON.stringify(failures, null, 2)}`,
    );
  });
});
