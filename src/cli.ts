// SPDX-License-Identifier: Apache-2.0
//
// grave-indexer CLI — the operational entry points:
//
//   discover      — enumerate Raydium V4 pools on the discovery cluster,
//                   ingest into the durable ledger, write a summary +
//                   health snapshot (reproducible: deterministic order,
//                   provenance + fingerprints on every record)
//   verify-path   — run the full evidence-path verification matrix
//                   against the deployed devnet GraveScanner
//   health        — print the latest health snapshot from the data dir

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchV4Pool, decodeScannerProtocolConfig } from "@graveyield/sdk";

import { loadPipelineConfig, type PipelineConfig } from "./config.js";
import { discoverRaydiumV4Pools } from "./discovery.js";
import { IngestLedger } from "./ingest.js";
import { HealthRegistry } from "./health.js";
import { ActivityIndexerLive } from "./activityLive.js";
import { runEvidencePathVerification } from "./evidencePath.js";
import { issueEvidenceBundle } from "./issue.js";
import { verifyEvidenceBundle, summarizeVerifyResult } from "./verify.js";
import { ReplayJournal } from "./journal.js";
import { generateDisposableOracleSigner, resolveOracleSigner, publicKeyFingerprint } from "./sign.js";
import {
  buildConsoleSnapshot,
  CONSOLE_SNAPSHOT_SCHEMA_VERSION,
  type ConsoleSnapshotFailure,
  type PoolEnrichment,
  type SnapshotThresholds,
} from "./consoleSnapshot.js";
import { endpointKindFor, type Cluster } from "./provenance.js";

const LEDGER_FILE = "ingest-ledger.jsonl";
const SUMMARY_FILE = "discovery-summary.json";
const REPORT_FILE = "verify-path-report.json";
const HEALTH_FILE = "health-snapshot.json";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
}

/** `discover` — run one discovery cycle and persist ledger + summary. */
export async function cmdDiscover(config: PipelineConfig): Promise<number> {
  const health = new HealthRegistry();
  const connection = new Connection(config.discoveryRpcUrl, "confirmed");
  mkdirSync(config.dataDir, { recursive: true });

  const t0 = Date.now();
  try {
    const run = await discoverRaydiumV4Pools(connection, {
      cluster: config.discoveryCluster,
      rpcUrl: config.discoveryRpcUrl,
      maxPools: config.maxPoolsPerScan,
    });
    health.recordSuccess("rpc-discovery", Date.now() - t0);
    health.recordSuccess("discovery", run.stats.durationMs);

    const ingestT0 = Date.now();
    const ledger = new IngestLedger();
    const ledgerPath = join(config.dataDir, LEDGER_FILE);
    // Reload any prior ledger for cross-cycle dedupe.
    const prior = new IngestLedger();
    if (existsSync(ledgerPath)) {
      const loaded = IngestLedger.fromJSONL(readFileSync(ledgerPath, "utf8"));
      for (const entry of loaded.list()) prior.adopt(entry);
    }
    const result = prior.ingestBatch(run.records, Date.now());
    health.recordSuccess("ingest", Date.now() - ingestT0);

    const currentSlot = run.stats.slotUpperBound;
    const stale = prior.staleEntries(currentSlot, config.discoveryStalenessSlots);
    const blocked = prior.blockedEntries(currentSlot, config.discoveryStalenessSlots);

    writeFileSync(ledgerPath, prior.toJSONL(), { encoding: "utf8" });

    const summary = {
      generatedAtUnixMs: Date.now(),
      discovery: {
        ...run.stats,
        distinctPools: run.records.length,
        unsupportedPairs: run.stats.unsupportedPairs,
      },
      ingest: {
        counts: result.counts,
        ledgerSize: prior.size,
        conflicts: result.conflicts.length,
      },
      staleness: {
        currentSlot,
        policyMaxAgeSlots: config.discoveryStalenessSlots,
        staleEntries: stale.length,
        blockedEntries: blocked.length,
      },
      provenancePolicy: {
        endpointKind: "public-rpc|private-rpc (URLs never recorded)",
        fingerprint: "sha256(pool address bytes ‖ raw 752-byte account payload)",
        ordering: "ascending base58 pool address (reproducible)",
      },
    };
    writeJson(join(config.dataDir, SUMMARY_FILE), summary);
    writeJson(join(config.dataDir, HEALTH_FILE), health.snapshot());

    console.log(`discovery: ${run.stats.parsedPools} pools parsed (${run.stats.malformedSkipped} malformed skipped, ${run.stats.unsupportedPairs} unsupported pairs)`);
    console.log(`ingest: new=${result.counts.new} unchanged=${result.counts["duplicate-unchanged"]} changed=${result.counts.changed} conflicts=${result.counts.conflict}`);
    console.log(`health: ${health.snapshot().status}`);
    console.log(`artifacts: ${ledgerPath}, ${join(config.dataDir, SUMMARY_FILE)}`);
    return 0;
  } catch (err) {
    health.recordFailure("discovery", err);
    writeJson(join(config.dataDir, HEALTH_FILE), health.snapshot());
    console.error(`discovery failed: ${String((err as Error).message ?? err)}`);
    return 1;
  }
}

/** `verify-path` — run the devnet evidence-path matrix and persist the report. */
export async function cmdVerifyPath(config: PipelineConfig): Promise<number> {
  const connection = new Connection(config.verificationRpcUrl, "confirmed");
  mkdirSync(config.dataDir, { recursive: true });

  console.log(`verify-path: cluster=${"devnet"} scanner=${config.scannerProgramId.toBase58()}`);
  const report = await runEvidencePathVerification({
    connection,
    cluster: "devnet" as Cluster,
    scannerProgramId: config.scannerProgramId,
    vaultProgramId: config.vaultProgramId,
    allowFaucet: true,
  });

  const reportPath = join(config.dataDir, REPORT_FILE);
  writeJson(reportPath, report);

  for (const c of report.cases) {
    const status = c.skipped ? "SKIPPED" : c.pass ? "PASS" : "FAIL";
    const expected = c.expectation.errorCode
      ? `expect=${c.expectation.errorCode}(${c.expectation.errorName})`
      : c.expectation.failedCheck
        ? `expect=${c.expectation.failedCheck}`
        : `expect=${c.expectation.result}${c.expectation.errorFamily ? `/${c.expectation.errorFamily}` : ""}`;
    console.log(`[${status}] ${c.caseId} — ${expected}${c.observed.decoded ? ` observed=${c.observed.decoded.name}` : ""}`);
  }
  console.log(`configured activity_oracle:  ${report.configuredActivityOracle ?? "(unavailable)"}`);
  console.log(`configured launch_price_oracle: ${report.configuredLaunchPriceOracle ?? "(unavailable)"}`);
  console.log(`report: ${reportPath}`);
  console.log(`all-pass: ${report.allPass}${report.payerFunded ? "" : " (program-level batch skipped — unfunded payer)"}`);
  return report.allPass ? 0 : 1;
}

/** `collect` — issue + verify a real evidence bundle for a live pool. */
export async function cmdCollect(
  config: PipelineConfig,
  opts: { pool?: string | undefined; useEphemeralOracle?: boolean | undefined; maxCandidates?: number | undefined },
): Promise<number> {
  const health = new HealthRegistry();
  const discoveryConn = new Connection(config.discoveryRpcUrl, "confirmed");
  const devnetConn = new Connection(config.verificationRpcUrl, "confirmed");
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(join(config.dataDir, "evidence"), { recursive: true });

  // ---- Oracle signer: explicit key material, or a fresh disposable key.
  let oracle;
  if (opts.useEphemeralOracle) {
    oracle = await generateDisposableOracleSigner();
    console.log(`oracle: EPHEMERAL disposable devnet key ${publicKeyFingerprint(oracle.publicKey)} (memory-only, dies with this process)`);
  } else {
    oracle = await resolveOracleSigner(config);
    console.log(`oracle: loaded from key material ${publicKeyFingerprint(oracle.publicKey)}`);
  }

  const journal = new ReplayJournal(join(config.dataDir, "replay-journal.jsonl"));

  // ---- Candidate pools: explicit --pool, else scan the discovery ledger.
  const ledgerPath = join(config.dataDir, LEDGER_FILE);
  let candidates: string[] = [];
  if (opts.pool) {
    candidates = [opts.pool];
  } else if (existsSync(ledgerPath)) {
    const ledger = IngestLedger.fromJSONL(readFileSync(ledgerPath, "utf8"));
    candidates = ledger
      .list()
      .filter((e) => !e.conflicted && !e.unsupported)
      .map((e) => e.poolAddress);
  }
  const maxCandidates = opts.maxCandidates ?? 3;
  console.log(`collect: ${candidates.length} candidate pool(s) from ledger, will try up to ${maxCandidates}`);

  const activityIndexer = new ActivityIndexerLive({
    cluster: config.discoveryCluster,
    rpcUrl: config.discoveryRpcUrl,
  });

  let issued = 0;
  for (const poolStr of candidates) {
    if (issued >= maxCandidates) break;
    let poolAddress: PublicKey;
    try {
      poolAddress = new PublicKey(poolStr);
    } catch {
      continue;
    }

    // Full pool identity from the DISCOVERY cluster (mainnet).
    let identity;
    try {
      identity = await fetchV4Pool(discoveryConn, poolAddress);
    } catch (err) {
      console.log(`[skip] ${poolStr}: identity fetch failed — ${String((err as Error).message ?? err).slice(0, 80)}`);
      continue;
    }

    // Last-swap derivation from DISCOVERY-cluster history.
    const t0 = Date.now();
    let activity;
    try {
      activity = await activityIndexer.indexActivity(discoveryConn, poolAddress, {
        scanLimit: config.signatureScanLimit,
      });
      health.recordSuccess("activity", Date.now() - t0);
    } catch (err) {
      health.recordFailure("activity", err);
      console.log(`[skip] ${poolStr}: activity derivation failed — ${String((err as Error).message ?? err).slice(0, 80)}`);
      continue;
    }
    if (activity.noSwapFound || activity.lastSwapUnixTs <= 0) {
      console.log(`[skip] ${poolStr}: no swap found in the last ${config.signatureScanLimit} signatures — cannot attest a last-swap time`);
      continue;
    }

    // Issue the bundle on the DESTINATION cluster (devnet): issued_slot +
    // slot hash resolve in DEVNET SlotHashes so the on-chain check binds.
    try {
      const tIssue = Date.now();
      const ammProgramId = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
      const bundle = await issueEvidenceBundle(devnetConn, oracle, {
        ammProgramId,
        poolAddress,
        poolIdentity: {
          ammProgramId: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8").toBase58(),
          poolAddress: poolAddress.toBase58(),
          baseMint: identity.baseMint.toBase58(),
          quoteMint: identity.quoteMint.toBase58(),
          lpMint: identity.lpMint.toBase58(),
          coinVault: identity.coinVault.toBase58(),
          pcVault: identity.pcVault.toBase58(),
        },
        lastSwapUnixTs: activity.lastSwapUnixTs,
        lastSwapSlot: activity.lastSwapSlot,
        lastSwapSignature: activity.lastSwapSignature,
        derivationCluster: config.discoveryCluster,
        scannerProgramId: config.scannerProgramId,
        vaultProgramId: config.vaultProgramId,
        destinationCluster: "devnet",
      });
      health.recordSuccess("evidence", Date.now() - tIssue);

      // Journal the issuance (operator-side replay guard).
      const { createHash } = await import("node:crypto");
      const msgHash = createHash("sha256")
        .update(Uint8Array.from(Buffer.from(bundle.attestation.msgHex, "hex")))
        .digest("hex");
      journal.append({
        msgSha256: msgHash,
        poolAddress: poolAddress.toBase58(),
        issuedSlot: bundle.issuance.issuedSlot,
        oraclePublicKey: bundle.attestation.oraclePublicKey,
        action: "sign",
      });

      const file = join(config.dataDir, "evidence", `evidence-${poolStr}.json`);
      writeJson(file, bundle);

      // Verify immediately against live devnet state.
      const result = await verifyEvidenceBundle(devnetConn, "devnet", bundle, {
        journal: new ReplayJournal(null), // fresh journal: issuance record must not trip the replay guard here
      });
      health.recordSuccess("verifier", 0);
      health.recordSuccess("journal", 0);

      console.log(`[issued] ${poolStr}`);
      console.log(`  last_swap: ${new Date(activity.lastSwapUnixTs * 1000).toISOString()} (slot ${activity.lastSwapSlot}, sig ${activity.lastSwapSignature.slice(0, 12)}…)`);
      console.log(`  issued_slot: ${bundle.issuance.issuedSlot} (devnet)`);
      console.log(`  verify: ${summarizeVerifyResult(result)}`);
      console.log(`  bundle: ${file}`);
      issued++;
    } catch (err) {
      health.recordFailure("evidence", err);
      console.log(`[fail] ${poolStr}: ${String((err as Error).message ?? err).slice(0, 120)}`);
      continue;
    }
  }

  writeJson(join(config.dataDir, HEALTH_FILE), health.snapshot());
  console.log(`collect: ${issued} bundle(s) issued → ${join(config.dataDir, "evidence")}`);
  return issued > 0 ? 0 : 1;
}

/** `health` — print the latest persisted health snapshot. */
export function cmdHealth(config: PipelineConfig): number {
  const path = join(config.dataDir, HEALTH_FILE);
  if (!existsSync(path)) {
    console.error(`no health snapshot at ${path} — run discover or verify-path first`);
    return 1;
  }
  console.log(readFileSync(path, "utf8"));
  return 0;
}

function indexerGitHead(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * `console-snapshot` — produce the typed, secret-free console artifact
 * (P3-A Task 3.1). Real mainnet Raydium V4 facts + deployed-ProtocolConfig
 * thresholds, fail-closed. Read-only; no keys involved.
 */
export async function cmdConsoleSnapshot(
  config: PipelineConfig,
  opts: { maxPools: number; enrich: number; maxAgeHours: number },
): Promise<number> {
  const conn = new Connection(config.discoveryRpcUrl, "confirmed");
  const health = new HealthRegistry();
  const failures: ConsoleSnapshotFailure[] = [];

  // ---- Thresholds: read from the DEPLOYED ProtocolConfig — never hardcoded.
  // The deployed scanner lives on the VERIFICATION cluster (devnet); the
  // discovery corpus is mainnet. Two connections, one artifact.
  const devnetConn = new Connection(config.verificationRpcUrl, "confirmed");
  const [configPda] = await PublicKey.findProgramAddress(
    [Buffer.from("protocol_config")],
    config.scannerProgramId,
  );
  const cfgInfo = await devnetConn.getAccountInfo(configPda);
  if (!cfgInfo) {
    console.error(`console-snapshot: ProtocolConfig ${configPda.toBase58()} not found on the verification cluster — refusing to fall back to defaults`);
    return 1;
  }
  const deployedCfg = decodeScannerProtocolConfig(cfgInfo.data);
  const thresholds: SnapshotThresholds = {
    inactivitySeconds: deployedCfg.inactivitySeconds,
    minTvlLamports: deployedCfg.minTvlLamports,
  };
  console.log(
    `thresholds (deployed ProtocolConfig): inactivity=${thresholds.inactivitySeconds}s minTvl=${thresholds.minTvlLamports} lamports`,
  );

  // ---- Discovery cycle (identity-slice, mainnet-safe).
  const t0 = Date.now();
  const run = await discoverRaydiumV4Pools(conn, {
    cluster: config.discoveryCluster,
    rpcUrl: config.discoveryRpcUrl,
    maxPools: opts.maxPools,
    mode: "identity-slice",
  });
  health.recordSuccess("rpc-discovery", Date.now() - t0);
  const supported = run.records
    .filter((r) => r.wsolSide !== null)
    .sort((a, b) => (a.poolAddress.toBase58() < b.poolAddress.toBase58() ? -1 : 1));
  const targets = supported.slice(0, opts.enrich);
  console.log(
    `discovery: ${run.stats.parsedPools} parsed, ${supported.length} WSOL-supported, enriching ${targets.length}`,
  );

  // ---- Per-pool enrichment: vault reserves, LP supply, memecoin decimals, last swap.
  const activityIndexer = new ActivityIndexerLive({
    cluster: config.discoveryCluster,
    rpcUrl: config.discoveryRpcUrl,
  });
  const enrichments = new Map<string, PoolEnrichment>();
  for (const record of targets) {
    const address = record.poolAddress.toBase58();
    const fetchedAt = Date.now();
    try {
      const wsolVault = record.wsolSide!.coinIsWsol ? record.pool.coinVault : record.pool.pcVault;
      const memecoinVault = record.wsolSide!.coinIsWsol ? record.pool.pcVault : record.pool.coinVault;
      const memecoinMint = record.wsolSide!.memecoinMint;
      const [wsolBal, memecoinBal, memecoinSupply, lpSupply, activity] = await Promise.all([
        conn.getTokenAccountBalance(wsolVault),
        conn.getTokenAccountBalance(memecoinVault),
        conn.getTokenSupply(memecoinMint),
        conn.getTokenSupply(record.pool.lpMint),
        activityIndexer
          .indexActivity(conn, record.poolAddress, { scanLimit: config.signatureScanLimit })
          .catch((err) => {
            failures.push({ stage: "activity", pool: address, reason: String((err as Error).message ?? err).slice(0, 120) });
            return null;
          }),
      ]);
      const lastSwap =
        activity && !activity.noSwapFound && activity.lastSwapUnixTs > 0
          ? { unixTs: activity.lastSwapUnixTs, slot: activity.lastSwapSlot, signature: activity.lastSwapSignature }
          : null;
      enrichments.set(address, {
        wsolReserveLamports: wsolBal.value.amount,
        memecoinReserveRaw: memecoinBal.value.amount,
        memecoinDecimals: memecoinSupply.value.decimals,
        lpSupplyRaw: lpSupply.value.amount,
        lastSwap,
        fetchedAtUnixMs: fetchedAt,
      });
      health.recordSuccess("enrich", 0);
    } catch (err) {
      failures.push({ stage: "enrich", pool: address, reason: String((err as Error).message ?? err).slice(0, 120) });
      health.recordFailure("enrich", err);
    }
  }

  const snapshot = buildConsoleSnapshot(supported.filter((r) => enrichments.has(r.poolAddress.toBase58())), enrichments, {
    generatedAtUnixMs: Date.now(),
    cluster: config.discoveryCluster as Cluster,
    endpointKind: endpointKindFor(config.discoveryRpcUrl),
    indexerGitHead: indexerGitHead(),
    maxAgeMs: opts.maxAgeHours * 3_600_000,
    thresholds,
    counts: {
      rawAccounts: run.stats.rawAccounts,
      parsedPools: run.stats.parsedPools,
      supportedWsolPairs: supported.length,
    },
    failures,
    slotLowerBound: run.stats.slotLowerBound,
    slotUpperBound: run.stats.slotUpperBound,
  });
  const out = join(config.dataDir, "console-snapshot.json");
  mkdirSync(config.dataDir, { recursive: true });
  writeJson(out, snapshot);
  writeJson(join(config.dataDir, HEALTH_FILE), health.snapshot());
  console.log(
    `console-snapshot: v${CONSOLE_SNAPSHOT_SCHEMA_VERSION}, ${snapshot.counts.enriched} pool(s) enriched, ${failures.length} failure(s) → ${out}`,
  );
  return snapshot.counts.enriched > 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const config = loadPipelineConfig();
  const command = process.argv[2] ?? "help";
  switch (command) {
    case "discover":
      return cmdDiscover(config);
    case "collect": {
      const args = process.argv.slice(3);
      const poolIdx = args.indexOf("--pool");
      return cmdCollect(config, {
        pool: poolIdx >= 0 ? args[poolIdx + 1] : undefined,
        useEphemeralOracle: args.includes("--use-ephemeral-oracle"),
        maxCandidates: 3,
      });
    }
    case "verify-path":
      return cmdVerifyPath(config);
    case "console-snapshot": {
      const args = process.argv.slice(3);
      const num = (flag: string, fallback: number): number => {
        const i = args.indexOf(flag);
        if (i < 0) return fallback;
        const v = Number(args[i + 1]);
        if (!Number.isInteger(v) || v <= 0) throw new Error(`${flag} must be a positive integer`);
        return v;
      };
      return cmdConsoleSnapshot(config, {
        maxPools: num("--max-pools", 120),
        enrich: num("--enrich", 24),
        maxAgeHours: num("--max-age-hours", 24),
      });
    }
    case "health":
      return cmdHealth(config);
    default:
      console.log(`grave-indexer — Phase 2 evidence pipeline

Usage:
  grave-indexer discover       Run one Raydium V4 discovery cycle (DISCOVERY_RPC_URL, default mainnet-beta)
  grave-indexer collect        Issue + verify evidence bundles for live pools (from the discovery ledger)
  grave-indexer verify-path    Run the devnet evidence-path verification matrix
  grave-indexer console-snapshot
                               Produce the typed secret-free console artifact
                               [--max-pools 120] [--enrich 24] [--max-age-hours 24]
  grave-indexer health         Print the latest health snapshot

Key env (see docs/ORACLE_PIPELINE.md):
  ORACLE_KEY_FILE              Oracle key file (0600, outside any repo) — never logged
  ACTIVITY_ORACLE_KEY          Base58 32-byte oracle seed (discouraged; file preferred)
  PAYER_KEY_FILE               Fee-payer key file (0600, outside any repo) — fund ≥0.01 SOL devnet for program-level cases
  DISCOVERY_RPC_URL            Discovery endpoint (default https://api.mainnet-beta.solana.com)
  DEVNET_RPC_URL               Verification endpoint (default https://api.devnet.solana.com)
  ORACLE_IS_REGISTERED         true once a dedicated oracle key is registered on chain (9.5)`);
      return command === "help" ? 0 : 1;
  }
}

const invoked = process.argv[1]?.includes("cli");
if (invoked) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
