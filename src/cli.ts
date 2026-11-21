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
import type { DiscoveredPoolRecord } from "./discovery.js";
import { IngestLedger } from "./ingest.js";
import { HealthRegistry } from "./health.js";
import {
  ActivityIndexerLive,
  DEFAULT_ACTIVITY_TTL_MS,
  evaluateAttestationGate,
} from "./activityLive.js";
import { runEvidencePathVerification } from "./evidencePath.js";
import { issueEvidenceBundle } from "./issue.js";
import { verifyEvidenceBundle, summarizeVerifyResult } from "./verify.js";
import { ReplayJournal } from "./journal.js";
import { generateDisposableOracleSigner, resolveOracleSigner, publicKeyFingerprint } from "./sign.js";
import { parseConsoleSnapshot } from "./consoleSnapshotParse.js";
import {
  buildPublicationProvenance,
  verifySnapshotIntegrity,
  versionedTagName,
  snapshotSha256,
  STABLE_TAG,
  SNAPSHOT_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  CHECKSUM_ASSET_NAME,
  type PublicationProvenance,
} from "./snapshotPublication.js";
import {
  buildConsoleSnapshot,
  CONSOLE_SNAPSHOT_SCHEMA_VERSION,
  type ConsoleSnapshotFailure,
  type PoolEnrichment,
  type SnapshotThresholds,
} from "./consoleSnapshot.js";
import { evaluateM1Sourcing, assertM1Sourcing } from "./m1Sourcing.js";
import { buildM1WsolQuoteSideRpcFilter } from "./m1SourcingFilter.js";
import { endpointKindFor, type Cluster } from "./provenance.js";

const LEDGER_FILE = "ingest-ledger.jsonl";
const SUMMARY_FILE = "discovery-summary.json";
const REPORT_FILE = "verify-path-report.json";
const HEALTH_FILE = "health-snapshot.json";

/** Evidence freshness policy shared by BOTH evidence-consuming paths
 *  (IMPL-001 Correction 002 §2, and the C1 unification): a last-swap
 *  derivation older than this is rejected as stale — by the shared
 *  `evaluateAttestationGate` on the collect/attestation path AND by the
 *  same gate on the C1 console-snapshot path. The bound is the
 *  established activity-cache TTL (`DEFAULT_ACTIVITY_TTL_MS`); no
 *  separate TTL is defined for C1.
 *
 *  Deliberately DISTINCT from two neighbouring concepts:
 *    * CACHE RETENTION — how long a definitive result stays in the
 *      indexer's TTL cache. The same constant, but a different concept:
 *      retention governs when a re-derivation happens; freshness governs
 *      whether a record may be used at all.
 *    * ARTIFACT freshness — the console snapshot's `--max-age-hours`
 *      budget (default 24 h) after which the console must label the
 *      rendered artifact stale. That budget applies to the artifact as a
 *      whole and can never admit evidence the evidence-freshness policy
 *      rejects.
 *  Diagnostic evidence (last-known definitive records retained across an
 *  incomplete refresh) carries its ORIGINAL derivation timestamp, so it
 *  ages out under this policy exactly like any other record — it cannot
 *  bypass freshness validation on either path.
 *
 *  Exported so tests can pin the single shared threshold (no new TTL, and
 *  the exact same bound on the collect and C1 paths). */
export const EVIDENCE_FRESHNESS_MAX_AGE_MS = DEFAULT_ACTIVITY_TTL_MS;

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
export async function cmdVerifyPath(
  config: PipelineConfig,
  opts: { allowFaucet?: boolean } = {},
): Promise<number> {
  const connection = new Connection(config.verificationRpcUrl, "confirmed");
  mkdirSync(config.dataDir, { recursive: true });

  console.log(`verify-path: cluster=${"devnet"} scanner=${config.scannerProgramId.toBase58()}`);
  if (opts.allowFaucet) console.log("verify-path: faucet OPT-IN — an unfunded payer may request a devnet airdrop");
  else console.log("verify-path: read-only faucet policy — no airdrop will be requested");
  const report = await runEvidencePathVerification({
    connection,
    cluster: "devnet" as Cluster,
    scannerProgramId: config.scannerProgramId,
    vaultProgramId: config.vaultProgramId,
    allowFaucet: opts.allowFaucet === true,
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
  console.log(`deployment: ${report.deployment.classification}${report.deployment.problems.length > 0 ? ` — ${report.deployment.problems.join("; ")}` : ""}`);
  console.log(`report: ${reportPath}`);
  console.log(
    `all-pass: ${report.allPass}${
      report.deployment.classification !== "ready"
        ? " (program-level batch NOT RUN — deployment state: " + report.deployment.classification + ")"
        : report.payerFunded
          ? ""
          : " (program-level batch skipped — unfunded payer; rerun with --allow-faucet or PAYER_KEY_FILE)"
    }`,
  );
  return report.allPass ? 0 : 1;
}

/** `collect` — issue + verify a real evidence bundle for a live pool.
 *
 *  IMPL-001 Correction 002 §2: every pool's activity record must pass the
 *  explicit evidence gate (`evaluateAttestationGate`) before issuance.
 *  Only `evidenceStatus === "verified" && definitive === true` records
 *  that are well-formed and fresh pass; incomplete, non-definitive,
 *  missing, malformed and stale evidence skips the pool with no bundle
 *  issued and no fallback to any previous timestamp.
 */
export async function cmdCollect(
  config: PipelineConfig,
  opts: {
    pool?: string | undefined;
    useEphemeralOracle?: boolean | undefined;
    maxCandidates?: number | undefined;
    /** Test/diagnostic seam: inject connections instead of dialing the
     *  configured endpoints. Production callers never pass these. */
    discoveryConnection?: Connection | undefined;
    verificationConnection?: Connection | undefined;
  },
): Promise<number> {
  const health = new HealthRegistry();
  const discoveryConn =
    opts.discoveryConnection ?? new Connection(config.discoveryRpcUrl, "confirmed");
  const devnetConn =
    opts.verificationConnection ?? new Connection(config.verificationRpcUrl, "confirmed");
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

    // D-01 M1 sourcing gate (GY-M1-ODR-001 §3) — the collect path is an
    // ALTERNATE candidate-ingestion route (explicit --pool arguments and
    // ledger candidates bypass the console-snapshot enrichment filter),
    // so it MUST independently enforce the exact WSOL quote-side
    // predicate on the freshly fetched identity before any evidence work
    // starts. Fail closed: no bundle, no attestation, no fallback — the
    // pool is skipped and the refusal is recorded (machine-checkable via
    // the health registry's m1-sourcing failure counter).
    //
    // HEALTH ACCOUNTING (m1-sourcing): EVERY attempted sourcing
    // validation records exactly one outcome — recordSuccess on an
    // accepted identity, recordFailure on a rejection — so
    // successes + failures equals the number of pools that reached the
    // gate. A run with zero candidates records nothing and the component
    // stays "degraded" (never-reported components are not ok): completing
    // the command without any validation attempt must never mark sourcing
    // healthy — health reflects actual validation outcomes only.
    const tM1 = Date.now();
    try {
      assertM1Sourcing({ coinMint: identity.baseMint, pcMint: identity.quoteMint });
      health.recordSuccess("m1-sourcing", Date.now() - tM1);
    } catch (err) {
      health.recordFailure("m1-sourcing", err);
      console.log(`[skip] ${poolStr}: m1-sourcing rejected — ${String((err as Error).message ?? err).slice(0, 100)}`);
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
    // IMPL-001 Correction 002 §2 — explicit evidence gate (flow
    // control, not logging): only VERIFIED, DEFINITIVE, well-formed,
    // fresh evidence can support an inactivity attestation. Incomplete,
    // non-definitive, missing, malformed and stale records are rejected
    // here; the pool is skipped and NOTHING is issued — the failure path
    // never falls back to a previous timestamp. This is the SAME gate the
    // C1 console-snapshot path applies (single evidence-integrity
    // standard across collection, attestation and snapshots).
    const gate = evaluateAttestationGate(activity, {
      maxAgeMs: EVIDENCE_FRESHNESS_MAX_AGE_MS,
    });
    if (!gate.ok) {
      console.log(`[skip] ${poolStr}: attestation gate rejected the evidence (${gate.reason}) — ${gate.detail}`);
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
 *
 * Evidence integrity (C1 unification): a derivation seeds the C1
 * last-swap anchor ONLY when it passes the SAME shared
 * `evaluateAttestationGate` the collect/attestation path applies — one
 * evidence-integrity standard across collection, attestation and
 * snapshots. Incomplete, non-verified (e.g. a definitive no-swap scan),
 * mislabeled, malformed, missing and stale records never become a C1
 * anchor; the pool renders with no lastSwap (C1 "pending") and the
 * anomalous rejections are recorded in `failures` for observability.
 * Freshness uses the shared `EVIDENCE_FRESHNESS_MAX_AGE_MS` bound — NOT
 * the artifact's `--max-age-hours` budget, which only governs how long
 * the console may render the artifact before labelling it stale.
 */
export async function cmdConsoleSnapshot(
  config: PipelineConfig,
  opts: {
    maxPools: number;
    enrich: number;
    maxAgeHours: number;
    /** Test/diagnostic seams (mirrors `cmdCollect`): inject the discovery
     *  connection, the verification connection, the discovery
     *  getProgramAccounts transport, or the activity indexer instead of
     *  dialing the configured endpoints. Production callers never pass
     *  these. */
    discoveryConnection?: Connection | undefined;
    verificationConnection?: Connection | undefined;
    discoveryFetchImpl?: typeof fetch | undefined;
    activityIndexer?: ActivityIndexerLive | undefined;
  },
): Promise<number> {
  const conn = opts.discoveryConnection ?? new Connection(config.discoveryRpcUrl, "confirmed");
  const health = new HealthRegistry();
  const failures: ConsoleSnapshotFailure[] = [];

  // ---- Thresholds: read from the DEPLOYED ProtocolConfig — never hardcoded.
  // The deployed scanner lives on the VERIFICATION cluster (devnet); the
  // discovery corpus is mainnet. Two connections, one artifact.
  const devnetConn =
    opts.verificationConnection ?? new Connection(config.verificationRpcUrl, "confirmed");
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
  // M1 sourcing restriction (GY-M1-INT-001 §6): the enumeration itself is
  // narrowed at the RPC BOUNDARY with the verified pc_mint@432 memcmp
  // filter — only quote-side-WSOL AmmInfo accounts are returned, so the
  // local caps can no longer hide an unfiltered multi-hundred-MB corpus.
  // The filter is an M1-sourcing-only measure (never a settlement-
  // orientation change), and the local D-01 gate below remains
  // authoritative over the parsed records (defense in depth, fail-closed).
  const t0 = Date.now();
  const run = await discoverRaydiumV4Pools(conn, {
    cluster: config.discoveryCluster,
    rpcUrl: config.discoveryRpcUrl,
    maxPools: opts.maxPools,
    mode: "identity-slice",
    rpcFilters: buildM1WsolQuoteSideRpcFilter(),
    ...(opts.discoveryFetchImpl !== undefined ? { fetchImpl: opts.discoveryFetchImpl } : {}),
  });
  health.recordSuccess("rpc-discovery", Date.now() - t0);
  const wsolSupported = run.records
    .filter((r) => r.wsolSide !== null)
    .sort((a, b) => (a.poolAddress.toBase58() < b.poolAddress.toBase58() ? -1 : 1));
  // D-01 M1 sourcing gate (GY-M1-ODR-001 §3): only pools whose parsed
  // AmmInfo identity satisfies the exact WSOL quote-side predicate may
  // enter the enriched candidate list of this operator artifact. The
  // gate is applied HERE (discovery boundary) and re-asserted by the
  // builder (fail-closed), so rejected candidates can never be rendered
  // as M1-acceptable. Rejections are machine-checkable: each appears in
  // `failures` under stage "m1-sourcing" and in
  // `counts.m1SourcingRejected`. Non-M1 discovery behavior is preserved:
  // the discovery ledger keeps recording every 7019-supported pool.
  const supported: DiscoveredPoolRecord[] = [];
  for (const record of wsolSupported) {
    const verdict = evaluateM1Sourcing({ coinMint: record.pool.baseMint, pcMint: record.pool.quoteMint });
    if (verdict.accepted) {
      supported.push(record);
    } else {
      failures.push({
        stage: "m1-sourcing",
        pool: record.poolAddress.toBase58(),
        reason: `${verdict.reason} — ${verdict.detail}`,
      });
    }
  }
  const targets = supported.slice(0, opts.enrich);
  console.log(
    `discovery: ${run.stats.rawAccounts} raw RPC accounts (pc_mint-WSOL memcmp-filtered), ${run.stats.parsedPools} parsed, ${wsolSupported.length} WSOL-supported, ${supported.length} m1-eligible (pc_mint WSOL), enriching ${targets.length}`,
  );

  // ---- COMPLETENESS SAFEGUARDS (GY-M1-INT-001 §7): a truncated or
  // partially enriched run must never pass as a complete production
  // snapshot. Two distinct completeness dimensions are evaluated and
  // reported separately, recorded as schema-valid `failures` entries
  // (free-form stage; the strict v2 consumer contract accepts them), and
  // FORCE the command to exit non-zero so the publication pipeline can
  // never treat the artifact as publication-ready:
  //
  //   * DISCOVERY completeness — every account the (memcmp-filtered) RPC
  //     response returned was iterated; the local `--max-pools` cap did
  //     not cut the candidate universe short.
  //   * ENRICHMENT completeness — every m1-eligible pool was targeted
  //     (the `--enrich` cap did not shrink the candidate list) and every
  //     targeted pool was enriched without a stage failure.
  //
  // The existing sampling semantics are NOT silently changed: the caps
  // keep their defaults and meaning — an operator who wants a complete
  // artifact must raise them until no truncation is reported.
  const discoveryIncomplete = run.stats.truncated;
  if (discoveryIncomplete) {
    const reason =
      `discovery incomplete: the local --max-pools cap (${opts.maxPools}) stopped ` +
      `iteration after ${run.stats.iteratedAccounts} of ${run.stats.rawAccounts} raw RPC accounts ` +
      `— ${run.stats.rawAccounts - run.stats.iteratedAccounts} pc_mint-WSOL account(s) were never parsed; ` +
      `this artifact must NOT be treated as a complete production snapshot ` +
      `(raise --max-pools until the filtered corpus is fully covered)`;
    failures.push({ stage: "discovery-completeness", reason });
    console.error(`console-snapshot: COMPLETENESS — ${reason}`);
  }
  const enrichmentCapped = supported.length > targets.length;
  if (enrichmentCapped) {
    const reason =
      `enrichment incomplete: the local --enrich cap (${opts.enrich}) targeted only ` +
      `${targets.length} of ${supported.length} m1-eligible pool(s) — ` +
      `${supported.length - targets.length} candidate(s) were never enriched; ` +
      `this artifact must NOT be treated as a complete production snapshot ` +
      `(raise --enrich until every m1-eligible pool is enriched)`;
    failures.push({ stage: "enrichment-completeness", reason });
    console.error(`console-snapshot: COMPLETENESS — ${reason}`);
  }

  // ---- Per-pool enrichment: vault reserves, LP supply, memecoin decimals, last swap.
  const activityIndexer =
    opts.activityIndexer ??
    new ActivityIndexerLive({
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
      // Shared evidence gate (IMPL-001): the SAME `evaluateAttestationGate`
      // the collect/attestation path applies decides whether a derivation
      // may seed the C1 last-swap anchor. Only VERIFIED, DEFINITIVE,
      // well-formed, FRESH evidence passes; incomplete, non-verified
      // (e.g. a definitive no-swap scan), mislabeled, malformed, missing
      // and stale records are excluded — the pool stays without a
      // lastSwap anchor and C1 renders "pending" instead of evaluating on
      // weak evidence. In particular, stale verified evidence (older than
      // the shared freshness bound) can no longer enter C1 — the previous
      // manual condition checked status/definitive/timestamp but had NO
      // freshness check at all.
      const gate = evaluateAttestationGate(activity, {
        maxAgeMs: EVIDENCE_FRESHNESS_MAX_AGE_MS,
      });
      const lastSwap = gate.ok
        ? {
            unixTs: gate.activity.lastSwapUnixTs,
            slot: gate.activity.lastSwapSlot,
            signature: gate.activity.lastSwapSignature,
          }
        : null;
      if (activity !== null && !gate.ok && gate.reason !== "not_verified") {
        // Observability (Correction 002 §1.5): record WHY no anchor was
        // established. A definitive no_swap_in_scan is an honest, complete
        // determination that simply carries no swap anchor — not a
        // pipeline failure — so it is excluded without a failure record
        // (reason "not_verified"). Every other rejection is anomalous and
        // recorded: incomplete (C1 not evaluable from this derivation),
        // stale, malformed/mislabeled, non-definitive. Missing evidence
        // (activity === null) was already recorded by the catch above.
        failures.push({
          stage: "activity",
          pool: address,
          reason: `evidence gate rejected the derivation (${gate.reason}) — ${gate.detail}`,
        });
      }
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
      supportedWsolPairs: wsolSupported.length,
      m1SourcingRejected: wsolSupported.length - supported.length,
    },
    failures,
    slotLowerBound: run.stats.slotLowerBound,
    slotUpperBound: run.stats.slotUpperBound,
  });
  const out = join(config.dataDir, "console-snapshot.json");
  mkdirSync(config.dataDir, { recursive: true });
  writeJson(out, snapshot);
  const enrichedCount = snapshot.counts.enriched;
  const enrichFailures = failures.filter((f) => f.stage === "enrich").length;
  const enrichmentFailed = enrichFailures > 0 || enrichments.size < targets.length;
  if (enrichmentFailed && !enrichmentCapped) {
    const reason =
      `enrichment incomplete: ${enrichFailures} enrich-stage failure(s) — ` +
      `${enrichments.size} of ${targets.length} targeted pool(s) produced facts; ` +
      `this artifact must NOT be treated as a complete production snapshot`;
    failures.push({ stage: "enrichment-completeness", reason });
    console.error(`console-snapshot: COMPLETENESS — ${reason}`);
    // Re-persist so the on-disk artifact carries the completeness marker too.
    snapshot.failures = failures;
    writeJson(out, snapshot);
  }
  writeJson(join(config.dataDir, HEALTH_FILE), health.snapshot());
  console.log(
    `console-snapshot: v${CONSOLE_SNAPSHOT_SCHEMA_VERSION}, ${enrichedCount} pool(s) enriched, ${failures.length} failure(s), ` +
      `completeness: discovery=${discoveryIncomplete ? "INCOMPLETE" : "complete"} enrichment=${enrichmentCapped || enrichmentFailed ? "INCOMPLETE" : "complete"} → ${out}`,
  );
  // Fail-closed exit: a complete production snapshot requires the
  // enriched pool list to be non-empty AND both completeness dimensions
  // to be satisfied. An incomplete artifact is still WRITTEN (for
  // diagnostics) but the non-zero exit code refuses to endorse it, so
  // the publication pipeline can never mistake it for publication-ready.
  return enrichedCount > 0 && !discoveryIncomplete && !enrichmentCapped && !enrichmentFailed ? 0 : 1;
}

/** Failure stages that mark an artifact as INCOMPLETE (never publication-ready). */
const COMPLETENESS_STAGES = ["discovery-completeness", "enrichment-completeness"] as const;

/**
 * `publish-snapshot` — the manual publication entry point (GY-M1-INT-001
 * §4, §10): generate the schema-v2 artifact with the M1 quote-side RPC
 * filter, validate it with the strict parser, derive the provenance
 * sidecar + SHA-256 checksum from the EXACT artifact bytes, verify the
 * integrity, and stage all three files in the data dir for the
 * workflow's release job. Read-only chain-side; no release is created
 * here, no tag is touched — publication decisions stay in the workflow.
 *
 * Fail-closed: ANY incompleteness, schema violation or integrity
 * mismatch exits non-zero and stages nothing.
 */
export async function cmdPublishSnapshot(
  config: PipelineConfig,
  opts: {
    maxPools: number;
    enrich: number;
    maxAgeHours: number;
    /** Test/diagnostic seams (mirrors `cmdConsoleSnapshot`): inject the
     *  discovery/verification connections or the discovery gPA transport
     *  instead of dialing the configured endpoints. Production callers
     *  never pass these. */
    discoveryConnection?: Connection | undefined;
    verificationConnection?: Connection | undefined;
    discoveryFetchImpl?: typeof fetch | undefined;
    activityIndexer?: ActivityIndexerLive | undefined;
  },
): Promise<number> {
  const generateCode = await cmdConsoleSnapshot(config, {
    maxPools: opts.maxPools,
    enrich: opts.enrich,
    maxAgeHours: opts.maxAgeHours,
    discoveryConnection: opts.discoveryConnection,
    verificationConnection: opts.verificationConnection,
    discoveryFetchImpl: opts.discoveryFetchImpl,
    activityIndexer: opts.activityIndexer,
  });
  if (generateCode !== 0) {
    console.error("publish-snapshot: generation or completeness validation failed — nothing staged, nothing published");
    return 1;
  }
  const out = join(config.dataDir, SNAPSHOT_ASSET_NAME);
  const bytes = new Uint8Array(readFileSync(out));
  const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  const snapshot = parseConsoleSnapshot(raw); // strict schema-v2 gate

  const completenessFailures = snapshot.failures.filter((f) => (COMPLETENESS_STAGES as readonly string[]).includes(f.stage));
  if (completenessFailures.length > 0 || snapshot.pools.length === 0) {
    for (const f of completenessFailures) console.error(`publish-snapshot: ${f.stage} — ${f.reason}`);
    console.error("publish-snapshot: artifact is INCOMPLETE — refusing to stage it for publication");
    return 1;
  }

  const sourceCommitSha = indexerGitHead();
  const versionedTag = versionedTagName(snapshot.generatedAtUnixMs, sourceCommitSha);
  const provenance = buildPublicationProvenance(snapshot, bytes, {
    sourceCommitSha,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    versionedTag,
  });
  verifySnapshotIntegrity(bytes, provenance); // belt-and-braces: gate the staged bytes themselves

  const provPath = join(config.dataDir, PROVENANCE_ASSET_NAME);
  const checksumPath = join(config.dataDir, CHECKSUM_ASSET_NAME);
  writeJson(provPath, provenance);
  // sha256sum-compatible line over the EXACT artifact bytes staged above.
  writeFileSync(checksumPath, `${snapshotSha256(bytes)}  ${SNAPSHOT_ASSET_NAME}\n`, { encoding: "utf8" });

  console.log(`publish-snapshot: artifact verified — schema v${snapshot.schemaVersion}, ${snapshot.pools.length} pool(s), complete`);
  console.log(`publish-snapshot: sha256=${provenance.snapshotSha256} bytes=${provenance.snapshotByteLength}`);
  console.log(`publish-snapshot: versioned tag → ${versionedTag} (stable reference: ${STABLE_TAG}, advanced only after verification)`);
  console.log(`publish-snapshot: staged → ${out}, ${provPath}, ${checksumPath}`);
  return 0;
}

/**
 * `verify-snapshot <artifact> <provenance>` — the independent
 * re-verification gate the workflow runs AFTER downloading the staged
 * artifact (before release publication) and again against the asset
 * downloaded BACK from the versioned release. Strict schema-v2 parse +
 * SHA-256/byte-length integrity + completeness gate, in that order.
 */
export function cmdVerifySnapshot(artifactPath: string, provenancePath: string): number {
  let bytes: Uint8Array;
  let rawProvenance: unknown;
  try {
    bytes = new Uint8Array(readFileSync(artifactPath));
    rawProvenance = JSON.parse(readFileSync(provenancePath, "utf8")) as unknown;
  } catch (err) {
    console.error(`verify-snapshot: could not read inputs — ${String((err as Error).message ?? err)}`);
    return 1;
  }
  if (typeof rawProvenance !== "object" || rawProvenance === null) {
    console.error("verify-snapshot: provenance sidecar is not an object");
    return 1;
  }
  const provenance = rawProvenance as PublicationProvenance;

  // Gate 1: the strict schema-v2 parser (same contract the console runs).
  try {
    parseConsoleSnapshot(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
  } catch (err) {
    console.error(`verify-snapshot: artifact FAILED the strict schema-v2 parse — refusing (${String((err as Error).message ?? err)})`);
    return 1;
  }
  // Gate 2: integrity of the exact bytes against the sidecar.
  try {
    verifySnapshotIntegrity(bytes, provenance);
  } catch (err) {
    console.error(String((err as Error).message ?? err));
    return 1;
  }
  // Gate 3: the artifact must carry actual enriched content — an empty
  // publication can never be a production snapshot.
  const enrichedInProvenance = typeof provenance.counts?.enriched === "number" ? provenance.counts.enriched : 0;
  if (!(enrichedInProvenance > 0)) {
    console.error("verify-snapshot: provenance reports zero enriched pools — refusing to endorse an empty snapshot");
    return 1;
  }
  console.log(`verify-snapshot: OK — schema v2 parse passed, sha256 ${provenance.snapshotSha256} verified over ${provenance.snapshotByteLength} bytes`);
  return 0;
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
      // Faucet policy (review-enforced): the faucet is STRICT opt-in via
      // `--allow-faucet`. A default `verify-path` run never requests an
      // airdrop — an unfunded payer skips the program-level batch with an
      // actionable note instead of mutating external state.
      return cmdVerifyPath(config, {
        allowFaucet: process.argv.slice(3).includes("--allow-faucet"),
      });
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
    case "publish-snapshot": {
      const args = process.argv.slice(3);
      const num = (flag: string, fallback: number): number => {
        const i = args.indexOf(flag);
        if (i < 0) return fallback;
        const v = Number(args[i + 1]);
        if (!Number.isInteger(v) || v <= 0) throw new Error(`${flag} must be a positive integer`);
        return v;
      };
      return cmdPublishSnapshot(config, {
        maxPools: num("--max-pools", 120),
        enrich: num("--enrich", 24),
        maxAgeHours: num("--max-age-hours", 24),
      });
    }
    case "verify-snapshot": {
      const [artifact, prov] = process.argv.slice(3);
      if (!artifact || !prov) {
        console.error("usage: grave-indexer verify-snapshot <artifact.json> <provenance.json>");
        return 1;
      }
      return cmdVerifySnapshot(artifact, prov);
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
  grave-indexer publish-snapshot
                               Generate + validate + stage the console artifact with its
                               provenance sidecar and SHA-256 checksum (manual publication
                               pipeline; [--max-pools] [--enrich] [--max-age-hours])
  grave-indexer verify-snapshot <artifact.json> <provenance.json>
                               Re-verify an artifact: strict schema-v2 parse + SHA-256/
                               byte-length integrity against the provenance sidecar
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
