// SPDX-License-Identifier: Apache-2.0
//
// Live devnet smoke (read-only + simulation) — the Phase 2 scheduled
// smoke, gated on DEVNET_RPC_URL so `pnpm test` stays green offline.
//
//   1. Decode the deployed GraveScanner ProtocolConfig and assert the
//      NS-3 PDA coordinates (pre-deployment derivation) and the
//      bump-255 invariant.
//   2. Record the configured activity / launch-price oracles (public
//      keys — logged intentionally; these are authorization anchors).
//   3. Run the full evidence-path verification matrix against the
//      deployed program (live program-level cases where the payer could
//      be funded, verifier-level cases always) and require allPass.
//
// Deployment: NS-3 (DR-002) — the program IDs are ASSIGNED but NOT yet
// deployed or initialized. Until the owner executes the NS-3 deployment
// (graveyield-protocol docs/DEVNET.md), the config-decode test below
// reports "deployment pending" (explicit skip) instead of failing; the
// matrix test exercises the same pending path honestly. The NS-2
// deployment is a preserved legacy record — do NOT re-point at it.
//
// Mirrors sdk/test/devnetSmoke.test.ts conventions.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchScannerProtocolConfig,
  scannerProtocolConfigPda,
} from "@graveyield/sdk";
// The SDK exports its default program ids as base58 STRINGS (client.ts);
// the indexer's config module owns the PublicKey forms. Do not pass the
// SDK string constants where PublicKey is required.
import { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID } from "../src/config.js";
import { runEvidencePathVerification } from "../src/evidencePath.js";

const DEVNET_RPC = process.env.DEVNET_RPC_URL;
const SKIP = !DEVNET_RPC;

describe("devnet evidence-path smoke (read-only + simulation)", { skip: SKIP }, () => {
  const connection = new Connection(DEVNET_RPC ?? "http://localhost:8899", "confirmed");

  test("GraveScanner ProtocolConfig matches the NS-3 derivation with bump 255", async (t) => {
    const pda = scannerProtocolConfigPda(DEVNET_SCANNER_PROGRAM_ID);
    assert.equal(pda.toBase58(), "5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe");
    const cfg = await fetchScannerProtocolConfig(connection, pda);
    if (!cfg) {
      t.skip(
        "NS-3 deployment pending: scanner ProtocolConfig not initialized on devnet yet " +
          "(owner executes deployment per graveyield-protocol docs/DEVNET.md)",
      );
      return;
    }
    assert.equal(cfg.bump, 255, "bump-255 invariant (['protocol_config'], canonical bump)");
    assert.equal(cfg.paused, false, "program must not be paused for the evidence path");
    // The configured oracles are PUBLIC keys — recorded for the report.
    // Under NS-3 these must be the dedicated oracle keys after registration:
    //   activity       2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o
    //   launch price   97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee
    console.log(`  configured activity_oracle:      ${cfg.activityOracle.toBase58()}`);
    console.log(`  configured launch_price_oracle:  ${cfg.launchPriceOracle.toBase58()}`);
  });

  test("evidence-path verification matrix passes against the deployed program", async (t) => {
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
    void t;
  });
});
