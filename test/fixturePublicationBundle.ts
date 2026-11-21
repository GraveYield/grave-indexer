// SPDX-License-Identifier: Apache-2.0
//
// Fixture publication-bundle builder for the NON-PRODUCTION rehearsal
// workflow (.github/workflows/rehearsal-publication.yml) — PR #5
// remediation, review Task 6.
//
// Builds a REAL schema-v2 ConsoleSnapshot bundle (snapshot bytes +
// provenance sidecar + sha256 checksum file) from the same production
// builders the CLI uses — no network, no RPC, no keys — so the rehearsal
// exercises the REAL publication operations against a clearly separate
// non-production repository without ever touching production state.
//
//   --out <dir>        write console-snapshot{,-provenance}.json/.sha256
//   --incomplete       build an INCOMPLETE bundle instead (zero enriched
//                      pools): verify-snapshot must refuse it — the
//                      rehearsal uses this to prove an incomplete artifact
//                      is never promoted.
//
// This file lives under test/ so `pnpm run typecheck` covers it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PublicKey } from "@solana/web3.js";
import { RAYDIUM_V4_PROGRAM_ID, WSOL_MINT } from "@graveyield/sdk";

import { buildConsoleSnapshot, SNAPSHOT_THRESHOLD_FALLBACK, type PoolEnrichment } from "../src/consoleSnapshot.js";
import type { DiscoveredPoolRecord } from "../src/discovery.js";
import {
  buildPublicationProvenance,
  CHECKSUM_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  snapshotSha256,
  versionedTagName,
} from "../src/snapshotPublication.js";
import { parseConsoleSnapshot } from "../src/consoleSnapshotParse.js";

const NOW_MS = Date.now();
const SOURCE_COMMIT = process.env.GITHUB_SHA ?? "0".repeat(40);

function synthPool(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, seed);
  return new PublicKey(bytes);
}

function discoveredRecord(seed: number): DiscoveredPoolRecord {
  return {
    poolAddress: synthPool(seed),
    ammProgramId: RAYDIUM_V4_PROGRAM_ID,
    pool: {
      coinVault: synthPool(0x21 + seed),
      pcVault: synthPool(0x22 + seed),
      baseMint: synthPool(0x23 + seed),
      quoteMint: WSOL_MINT,
      lpMint: synthPool(0x24 + seed),
    },
    wsolSide: { memecoinMint: synthPool(0x23 + seed), coinIsWsol: false },
    raw: {
      mode: "identity-slice",
      dataLen: 160,
      fingerprint: `fp-${seed}`,
      owner: RAYDIUM_V4_PROGRAM_ID.toBase58(),
    },
    provenance: {
      source: "raydium-v4-gpa",
      cluster: "mainnet-beta",
      endpointKind: "public-rpc",
      slotLowerBound: 5_000_000,
      slotUpperBound: 5_000_002,
      fetchedAtUnixMs: NOW_MS,
    },
  };
}

function enrichment(seed: number): PoolEnrichment {
  return {
    wsolReserveLamports: "600000000",
    memecoinReserveRaw: "1000000",
    memecoinDecimals: 6,
    lpSupplyRaw: "1000000",
    lastSwap: { unixTs: 1_700_000_100, slot: 900_000, signature: `sig-${seed}`.padEnd(88, "x").slice(0, 87) },
    fetchedAtUnixMs: NOW_MS,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? (args[args.indexOf("--out") + 1] ?? "data") : "data";
  const incomplete = args.includes("--incomplete");

  const records = incomplete ? [discoveredRecord(0x71)] : [discoveredRecord(0x61), discoveredRecord(0x62)];
  const enrichments = incomplete
    ? new Map<string, PoolEnrichment>() // NO enrichment: completeness gate must fail
    : new Map(records.map((r) => [r.poolAddress.toBase58(), enrichment(0)]));

  const snapshot = buildConsoleSnapshot(records, enrichments, {
    generatedAtUnixMs: NOW_MS,
    cluster: "mainnet-beta",
    endpointKind: "public-rpc",
    indexerGitHead: SOURCE_COMMIT,
    maxAgeMs: 24 * 3_600_000,
    thresholds: SNAPSHOT_THRESHOLD_FALLBACK,
    counts: {
      rawAccounts: 4200,
      parsedPools: 4200,
      supportedWsolPairs: records.length,
      m1SourcingRejected: 0,
    },
    failures: [],
    slotLowerBound: 5_000_000,
    slotUpperBound: 5_000_002,
  });

  // Gate parity with the real pipeline: an incomplete bundle must fail
  // the strict parser's completeness expectations (no enriched pools).
  if (incomplete) {
    const parsed = parseConsoleSnapshot(JSON.parse(JSON.stringify(snapshot)) as unknown);
    if (parsed.pools.length !== 0) {
      throw new Error("internal: incomplete fixture unexpectedly parsed with pools");
    }
    console.log(`fixture: INCOMPLETE bundle built (zero enriched pools — verify-snapshot MUST refuse it)`);
  } else {
    parseConsoleSnapshot(JSON.parse(JSON.stringify(snapshot)) as unknown);
  }

  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const versionedTag = versionedTagName(NOW_MS, SOURCE_COMMIT);
  const provenance = buildPublicationProvenance(snapshot, bytes, {
    sourceCommitSha: SOURCE_COMMIT,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    versionedTag,
  });

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, SNAPSHOT_ASSET_NAME), bytes);
  writeFileSync(join(out, PROVENANCE_ASSET_NAME), new TextEncoder().encode(JSON.stringify(provenance, null, 2)));
  writeFileSync(join(out, CHECKSUM_ASSET_NAME), new TextEncoder().encode(`${snapshotSha256(bytes)}  ${SNAPSHOT_ASSET_NAME}\n`));
  console.log(`fixture: bundle written to ${out} — versioned tag: ${versionedTag}${incomplete ? " (INCOMPLETE)" : " (complete)"}`);
}

main();
