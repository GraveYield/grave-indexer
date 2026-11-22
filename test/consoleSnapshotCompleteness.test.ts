// SPDX-License-Identifier: Apache-2.0
//
// Console-snapshot completeness + publication pipeline (GY-M1-INT-001
// §4, §7, §11) — offline integration battery over the REAL commands
// (`cmdConsoleSnapshot`, `cmdPublishSnapshot`, `cmdVerifySnapshot`)
// through the repo's test/diagnostic connection + transport seams.
//
// Pinned behaviors:
//   * the snapshot command applies the M1 WSOL quote-side memcmp filter
//     at the RPC boundary (the emitted getProgramAccounts request carries
//     the verified offset/bytes);
//   * a --max-pools truncation is reported as an explicit
//     "discovery-completeness" failure, the artifact is still written for
//     diagnostics, but the command exits non-zero (never publishable);
//   * an --enrich cap is reported as an explicit
//     "enrichment-completeness" failure and also forces non-zero;
//   * a fully covering run exits zero with both dimensions complete;
//   * publish-snapshot stages the artifact + provenance + checksum ONLY
//     for complete, schema-valid artifacts — and refuses incomplete ones;
//   * verify-snapshot re-verifies parse + SHA-256 + byte length, and
//     refuses a tampered artifact.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { AccountDisc, RAYDIUM_V4_PROGRAM_ID, decodeScannerProtocolConfig } from "@graveyield/sdk";

import {
  cmdConsoleSnapshot,
  cmdPublishSnapshot,
  cmdVerifySnapshot,
} from "../src/cli.js";
import { buildM1WsolQuoteSideRpcFilter, WSOL_MEMCMP_BYTES } from "../src/m1SourcingFilter.js";
import { parseConsoleSnapshot } from "../src/consoleSnapshotParse.js";
import {
  buildPublicationProvenance,
  verifyRawArtifactCompleteness,
  type PublicationProvenance,
} from "../src/snapshotPublication.js";
import { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID, type PipelineConfig } from "../src/config.js";
import { buildAmmInfoSlice, synth } from "./fixtures.js";

// ─── Seams ───────────────────────────────────────────────────────────────────

function protocolConfigBytes(): Uint8Array {
  // Exact layout from test/consoleSnapshotC1.test.ts (real Anchor shape):
  // discriminator + authority + pendingAuthority + pendingAuthorityEta
  // + inactivitySeconds + priceCollapseBps(u16) + minTvlLamports
  // + anchorStalenessSeconds + lpBurnDustThreshold + certTtlSeconds
  // + paused + activityOracle + launchPriceOracle + bump.
  const out = new Uint8Array(8 + 32 + 32 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 32 + 32 + 1);
  const view = new DataView(out.buffer);
  out.set(AccountDisc.ProtocolConfig, 0);
  let at = 8;
  const put32 = (pk: PublicKey): void => {
    out.set(pk.toBytes(), at);
    at += 32;
  };
  const put64 = (v: bigint): void => {
    view.setBigUint64(at, v, true);
    at += 8;
  };
  put32(synth(0xa1)); // authority
  put32(synth(0xa2)); // pendingAuthority
  view.setBigInt64(at, 0n, true); at += 8; // pendingAuthorityEta
  put64(7_776_000n); // inactivitySeconds — 90 d (spec default)
  view.setUint16(at, 9_900, true); at += 2; // priceCollapseBps
  put64(500_000_000n); // minTvlLamports — 0.5 SOL (spec default)
  put64(1_209_600n); // anchorStalenessSeconds — 14 d
  put64(1_000n); // lpBurnDustThreshold
  view.setBigInt64(at, 3_600n, true); at += 8; // certTtlSeconds
  out[at] = 0; at += 1; // paused = false
  put32(synth(0xa3)); // activityOracle
  put32(synth(0xa4)); // launchPriceOracle
  out[at] = 0; at += 1; // bump
  return out;
}

const CONFIG_PDA = (await PublicKey.findProgramAddress([Buffer.from("protocol_config")], DEVNET_SCANNER_PROGRAM_ID))[0]!;

/** Sanity: the synthetic config must decode with the REAL SDK decoder. */
assert.ok(decodeScannerProtocolConfig(Buffer.from(protocolConfigBytes())).inactivitySeconds > 0n);

class VerificationRpc {
  asConnection(): Connection {
    return this as unknown as Connection;
  }
  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    if (address.equals(CONFIG_PDA)) {
      return {
        lamports: 1_000_000,
        data: Buffer.from(protocolConfigBytes()),
        owner: DEVNET_SCANNER_PROGRAM_ID,
        executable: false,
        rentEpoch: 0n,
      } as unknown as AccountInfo<Uint8Array>;
    }
    return null;
  }
}

class DiscoveryRpc {
  async getSlot(_c?: unknown): Promise<bigint> {
    return 5_000_000n;
  }
  async getTokenAccountBalance(_vault: PublicKey): Promise<{ value: { amount: string; decimals: number } }> {
    return { value: { amount: "600000000", decimals: 9 } };
  }
  async getTokenSupply(_mint: PublicKey): Promise<{ value: { amount: string; decimals: number } }> {
    return { value: { amount: "1000000", decimals: 6 } };
  }
  async getSignaturesForAddress(_a: PublicKey, _o?: { limit?: number }): Promise<never[]> {
    return []; // deterministic no-swap-in-scan scan (C1 stays pending)
  }
  async getTransaction(_s: string): Promise<null> {
    return null;
  }
  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

interface CapturedBody {
  filters: Array<Record<string, unknown>>;
}

interface RpcRequestBody {
  method: string;
  params: [string, { filters: Array<Record<string, unknown>> }];
}

/** gPA transport seam: captures the request body and returns the identity
 *  slices for `n` synthetic pc_mint-WSOL pools. */
function gpaFetch(n: number): { fetch: typeof fetch; bodies: CapturedBody[] } {
  const bodies: CapturedBody[] = [];
  const fetchImpl = (async (_url: string | URL, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as RpcRequestBody;
    bodies.push({ filters: body.params[1].filters });
    const pools = Array.from({ length: n }, (_, i) => synth(0x60 + i));
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: pools.map((p) => ({
          pubkey: p.toBase58(),
          account: { data: [Buffer.from(buildAmmInfoSlice()).toString("base64"), "base64"], owner: RAYDIUM_V4_PROGRAM_ID.toBase58() },
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, bodies };
}

function snapshotConfig(dataDir: string): PipelineConfig {
  return {
    discoveryRpcUrl: "http://discovery.invalid",
    discoveryCluster: "mainnet-beta",
    verificationRpcUrl: "http://verification.invalid",
    scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
    vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
    maxPoolsPerScan: 10,
    signatureScanLimit: 50,
    discoveryStalenessSlots: 400,
    evidenceFreshnessSlots: 450,
    dataDir,
    oracleKeyFile: null,
    oracleKeyEnv: null,
    oracleIsRegistered: false,
  };
}

function withTempDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "grave-indexer-completeness-"));
  return fn(dataDir).finally(() => rmSync(dataDir, { recursive: true, force: true }));
}

function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ─── Command-level RPC filter + completeness ─────────────────────────────────

describe("cmdConsoleSnapshot — RPC-level M1 filter + completeness safeguards", () => {
  test("the command sends the verified pc_mint@432 WSOL memcmp filter in the RPC request", async () => {
    await withTempDataDir(async (dataDir) => {
      const { fetch: fetchImpl, bodies } = gpaFetch(2);
      const code = await cmdConsoleSnapshot(snapshotConfig(dataDir), {
        maxPools: 10,
        enrich: 10,
        maxAgeHours: 24,
        discoveryConnection: new DiscoveryRpc().asConnection(),
        verificationConnection: new VerificationRpc().asConnection(),
        discoveryFetchImpl: fetchImpl,
      });
      assert.equal(code, 0);
      assert.equal(bodies.length, 1);
      assert.deepEqual(bodies[0]!.filters, [
        { dataSize: 752 },
        { memcmp: { offset: 432, bytes: WSOL_MEMCMP_BYTES } },
      ]);
    });
  });

  test("a --max-pools truncation is exposed explicitly and forces a non-zero exit (artifact written for diagnostics)", async () => {
    await withTempDataDir(async (dataDir) => {
      const { fetch: fetchImpl } = gpaFetch(5); // 5 filtered accounts, cap 2
      const code = await cmdConsoleSnapshot(snapshotConfig(dataDir), {
        maxPools: 2,
        enrich: 10,
        maxAgeHours: 24,
        discoveryConnection: new DiscoveryRpc().asConnection(),
        verificationConnection: new VerificationRpc().asConnection(),
        discoveryFetchImpl: fetchImpl,
      });
      assert.equal(code, 1, "an incomplete run must never exit zero");

      const artifact = JSON.parse(readFileSync(join(dataDir, "console-snapshot.json"), "utf8")) as {
        counts: { rawAccounts: number; parsedPools: number; enriched: number };
        failures: Array<{ stage: string; reason: string }>;
      };
      const completeness = artifact.failures.filter((f) => f.stage === "discovery-completeness");
      assert.equal(completeness.length, 1, "exactly one discovery-completeness failure is recorded");
      assert.ok(completeness[0]!.reason.includes("--max-pools cap (2)"));
      assert.ok(completeness[0]!.reason.includes("of 5 raw RPC accounts"), "the raw account count is reported");
      assert.ok(completeness[0]!.reason.includes("must NOT be treated as a complete production snapshot"));
      assert.equal(artifact.counts.rawAccounts, 5);
      assert.equal(artifact.counts.parsedPools, 2);

      // The artifact itself is still schema-valid (the completeness entry
      // is a free-form failures stage) — but the completeness failure
      // makes it unmistakably non-production.
      assert.doesNotThrow(() => parseConsoleSnapshot(JSON.parse(readFileSync(join(dataDir, "console-snapshot.json"), "utf8"))));
    });
  });

  test("an --enrich cap is exposed explicitly as a separate enrichment-completeness dimension", async () => {
    await withTempDataDir(async (dataDir) => {
      const { fetch: fetchImpl } = gpaFetch(5); // 5 m1-eligible pools, enrich cap 2
      const code = await cmdConsoleSnapshot(snapshotConfig(dataDir), {
        maxPools: 10,
        enrich: 2,
        maxAgeHours: 24,
        discoveryConnection: new DiscoveryRpc().asConnection(),
        verificationConnection: new VerificationRpc().asConnection(),
        discoveryFetchImpl: fetchImpl,
      });
      assert.equal(code, 1);
      const artifact = JSON.parse(readFileSync(join(dataDir, "console-snapshot.json"), "utf8")) as {
        counts: { supportedWsolPairs: number; enriched: number };
        failures: Array<{ stage: string; reason: string }>;
      };
      const completeness = artifact.failures.filter((f) => f.stage === "enrichment-completeness");
      assert.equal(completeness.length, 1);
      assert.ok(completeness[0]!.reason.includes("--enrich cap (2)"));
      assert.ok(completeness[0]!.reason.includes("of 5 m1-eligible pool(s)"));
      assert.equal(artifact.counts.enriched, 2);
      // Discovery was NOT truncated in this run — the two dimensions are distinct.
      assert.equal(artifact.failures.some((f) => f.stage === "discovery-completeness"), false);
    });
  });

  test("a fully covering run is complete on both dimensions and exits zero", async () => {
    await withTempDataDir(async (dataDir) => {
      const { fetch: fetchImpl } = gpaFetch(3);
      const code = await cmdConsoleSnapshot(snapshotConfig(dataDir), {
        maxPools: 10,
        enrich: 10,
        maxAgeHours: 24,
        discoveryConnection: new DiscoveryRpc().asConnection(),
        verificationConnection: new VerificationRpc().asConnection(),
        discoveryFetchImpl: fetchImpl,
      });
      assert.equal(code, 0);
      const artifact = JSON.parse(readFileSync(join(dataDir, "console-snapshot.json"), "utf8")) as {
        counts: { rawAccounts: number; parsedPools: number; supportedWsolPairs: number; m1SourcingRejected: number; enriched: number };
        failures: Array<{ stage: string }>;
      };
      assert.equal(artifact.counts.rawAccounts, 3);
      assert.equal(artifact.counts.parsedPools, 3);
      assert.equal(artifact.counts.enriched, 3);
      assert.equal(artifact.failures.some((f) => f.stage === "discovery-completeness" || f.stage === "enrichment-completeness"), false);
    });
  });
});

// ─── Publication staging + independent re-verification ───────────────────────

describe("cmdPublishSnapshot / cmdVerifySnapshot — staged publication gate", () => {
  test("a complete run stages artifact + provenance + checksum with accurate integrity", async () => {
    await withTempDataDir(async (dataDir) => {
      const { fetch: fetchImpl } = gpaFetch(2);
      const code = await withEnv(
        {
          GITHUB_RUN_ID: "12345",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_REPOSITORY: "GraveYield/grave-indexer",
        },
        () =>
          cmdPublishSnapshot(snapshotConfig(dataDir), {
            maxPools: 10,
            enrich: 10,
            maxAgeHours: 24,
            discoveryConnection: new DiscoveryRpc().asConnection(),
            verificationConnection: new VerificationRpc().asConnection(),
            discoveryFetchImpl: fetchImpl,
          }),
      );
      assert.equal(code, 0);

      const artifactPath = join(dataDir, "console-snapshot.json");
      const provPath = join(dataDir, "console-snapshot-provenance.json");
      const checksumPath = join(dataDir, "console-snapshot.sha256");
      assert.ok(existsSync(artifactPath));
      assert.ok(existsSync(provPath));
      assert.ok(existsSync(checksumPath));

      const bytes = readFileSync(artifactPath);
      const prov = JSON.parse(readFileSync(provPath, "utf8")) as {
        schemaVersion: number;
        snapshotSha256: string;
        snapshotByteLength: number;
        counts: { rawAccounts: number; m1SourcingRejected: number; enriched: number };
        workflowRunId: string | null;
        workflowAttempt: string | null;
        repository: string | null;
        indexerSourceCommitSha: string | null;
        versionedTag: string;
      };
      assert.equal(prov.schemaVersion, 2);
      assert.equal(prov.snapshotByteLength, bytes.byteLength);
      assert.equal(prov.workflowRunId, "12345");
      assert.equal(prov.workflowAttempt, "2");
      assert.equal(prov.repository, "GraveYield/grave-indexer");
      assert.ok(prov.versionedTag.startsWith("console-snapshot-prod-"));
      assert.match(prov.versionedTag, /console-snapshot-prod-\d{8}T\d{6}Z-/);

      const checksumLine = readFileSync(checksumPath, "utf8").trim();
      assert.match(checksumLine, /^[0-9a-f]{64}  console-snapshot\.json$/, "sha256sum-compatible checksum line");
      const actualSha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
      assert.equal(checksumLine.split("  ")[0], actualSha);
      assert.equal(prov.snapshotSha256, actualSha);
      assert.equal(prov.counts.enriched, 2);

      // Off-CI execution records null workflow context, never fabricated values.
      const bare = JSON.parse(readFileSync(provPath, "utf8")) as Record<string, unknown>;
      assert.ok("workflowRunId" in bare);
    });
  });

  test("verify-snapshot accepts the staged artifact and refuses a tampered one", async () => {
    await withTempDataDir(async (dataDir) => {
      const { fetch: fetchImpl } = gpaFetch(2);
      await withEnv(
        { GITHUB_RUN_ID: "", GITHUB_RUN_ATTEMPT: "", GITHUB_REPOSITORY: "" },
        () =>
          cmdPublishSnapshot(snapshotConfig(dataDir), {
            maxPools: 10,
            enrich: 10,
            maxAgeHours: 24,
            discoveryConnection: new DiscoveryRpc().asConnection(),
            verificationConnection: new VerificationRpc().asConnection(),
            discoveryFetchImpl: fetchImpl,
          }),
      );
      const artifactPath = join(dataDir, "console-snapshot.json");
      const provPath = join(dataDir, "console-snapshot-provenance.json");

      // The staged artifact passes the independent re-verification gate.
      assert.equal(cmdVerifySnapshot(artifactPath, provPath), 0);

      // Any byte tampering is refused.
      const original = readFileSync(artifactPath);
      const tampered = Buffer.from(original);
      tampered[0] = (tampered[0] ?? 0) ^ 0x01;
      const tamperedPath = join(dataDir, "tampered.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(tamperedPath, tampered);
      assert.equal(cmdVerifySnapshot(tamperedPath, provPath), 1);
    });
  });

  test("publish-snapshot refuses to stage an INCOMPLETE artifact (non-zero, no staged files)", async () => {
    await withTempDataDir(async (dataDir) => {
      const { fetch: fetchImpl } = gpaFetch(5);
      const code = await cmdPublishSnapshot(snapshotConfig(dataDir), {
        maxPools: 2, // forces discovery truncation
        enrich: 10,
        maxAgeHours: 24,
        discoveryConnection: new DiscoveryRpc().asConnection(),
        verificationConnection: new VerificationRpc().asConnection(),
        discoveryFetchImpl: fetchImpl,
      });
      assert.equal(code, 1, "an incomplete artifact is never staged");
      assert.equal(existsSync(join(dataDir, "console-snapshot-provenance.json")), false, "no provenance staged");
      assert.equal(existsSync(join(dataDir, "console-snapshot.sha256")), false, "no checksum staged");
      // The diagnostic artifact itself may exist, but nothing publishable was produced.
    });
  });
});

// ─── The INDEPENDENT completeness contract (Finding 3, eighth round) ─────────

// The independent `verify-snapshot` gate must enforce the SAME completeness
// conditions as the producer's staging gate: a completeness failure marker
// in the artifact is refused, the provenance count must exist and be
// well-formed, and it must exactly agree with the artifact's own enriched
// count. Fixtures are built from a REAL complete staged bundle, then
// re-provenanced over the exact modified bytes so the INTEGRITY gate passes
// and the COMPLETENESS gate is the one that fires.

describe("cmdVerifySnapshot — the independent completeness contract (Finding 3)", () => {
  /** Stage a REAL complete bundle, then hand the raw artifact+sidecar JSON to the caller. */
  async function stageRealBundle(): Promise<{
    dataDir: string;
    artifactPath: string;
    provPath: string;
    snapshotRaw: Record<string, unknown>;
    provRaw: Record<string, unknown>;
  }> {
    const dataDir = mkdtempSync(join(tmpdir(), "grave-indexer-verifycompleteness-"));
    const { fetch: fetchImpl } = gpaFetch(2);
    const code = await withEnv(
      { GITHUB_RUN_ID: "", GITHUB_RUN_ATTEMPT: "", GITHUB_REPOSITORY: "" },
      () =>
        cmdPublishSnapshot(snapshotConfig(dataDir), {
          maxPools: 10,
          enrich: 10,
          maxAgeHours: 24,
          discoveryConnection: new DiscoveryRpc().asConnection(),
          verificationConnection: new VerificationRpc().asConnection(),
          discoveryFetchImpl: fetchImpl,
        }),
    );
    assert.equal(code, 0, "the fixture bundle must stage cleanly");
    const artifactPath = join(dataDir, "console-snapshot.json");
    const provPath = join(dataDir, "console-snapshot-provenance.json");
    const snapshotRaw = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const provRaw = JSON.parse(readFileSync(provPath, "utf8")) as Record<string, unknown>;
    return { dataDir, artifactPath, provPath, snapshotRaw, provRaw };
  }

  /**
   * Rebuild the provenance sidecar over the EXACT (possibly modified)
   * artifact bytes so the SHA-256/length integrity gate passes and the
   * COMPLETENESS gate is the one that decides the outcome.
   */
  function rebuildProvenanceOver(snapshotRaw: Record<string, unknown>, original: Record<string, unknown>): PublicationProvenance {
    const bytes = new TextEncoder().encode(JSON.stringify(snapshotRaw));
    return buildPublicationProvenance(
      parseConsoleSnapshot(JSON.parse(new TextDecoder().decode(bytes))),
      bytes,
      {
        sourceCommitSha: (original["indexerSourceCommitSha"] as string | null) ?? null,
        workflowRunId: null,
        workflowAttempt: null,
        repository: null,
        versionedTag: (original["versionedTag"] as string | null) ?? null,
      },
    );
  }

  function writeVariant(
    dataDir: string,
    snapshotRaw: Record<string, unknown>,
    prov: unknown,
  ): { artifactPath: string; provPath: string } {
    const artifactPath = join(dataDir, "variant-console-snapshot.json");
    const provPath = join(dataDir, "variant-console-snapshot-provenance.json");
    writeFileSync(artifactPath, JSON.stringify(snapshotRaw));
    writeFileSync(provPath, JSON.stringify(prov));
    return { artifactPath, provPath };
  }

  test("a complete, consistent artifact still passes (existing valid schema-v2 fixtures are unaffected)", async () => {
    const { dataDir, artifactPath, provPath, snapshotRaw, provRaw } = await stageRealBundle();
    try {
      assert.equal(cmdVerifySnapshot(artifactPath, provPath), 0);
      // The raw gate agrees on the exact same bytes.
      const prov = rebuildProvenanceOver(snapshotRaw, provRaw);
      assert.doesNotThrow(() => verifyRawArtifactCompleteness(snapshotRaw, prov));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a NONEMPTY snapshot carrying a discovery-completeness failure marker is refused", async () => {
    const { dataDir, snapshotRaw, provRaw } = await stageRealBundle();
    try {
      assert.equal((snapshotRaw["counts"] as { enriched: number }).enriched > 0, true, "fixture is nonempty");
      (snapshotRaw["failures"] as unknown[]).push({
        stage: "discovery-completeness",
        reason: "injected regression marker: the corpus was truncated",
      });
      const prov = rebuildProvenanceOver(JSON.parse(JSON.stringify(snapshotRaw)), provRaw);
      const { artifactPath, provPath } = writeVariant(dataDir, snapshotRaw, prov);
      assert.equal(cmdVerifySnapshot(artifactPath, provPath), 1, "the marker must fail the independent verifier");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a NONEMPTY snapshot carrying an enrichment-completeness failure marker is refused", async () => {
    const { dataDir, snapshotRaw, provRaw } = await stageRealBundle();
    try {
      (snapshotRaw["failures"] as unknown[]).push({
        stage: "enrichment-completeness",
        reason: "injected regression marker: enrichment targets were capped",
      });
      const prov = rebuildProvenanceOver(JSON.parse(JSON.stringify(snapshotRaw)), provRaw);
      const { artifactPath, provPath } = writeVariant(dataDir, snapshotRaw, prov);
      assert.equal(cmdVerifySnapshot(artifactPath, provPath), 1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("an artifact whose enriched count differs from the provenance count is refused", async () => {
    const { dataDir, snapshotRaw, provRaw } = await stageRealBundle();
    try {
      const prov = rebuildProvenanceOver(JSON.parse(JSON.stringify(snapshotRaw)), provRaw);
      // Integrity still holds (digest covers the snapshot bytes, not counts)…
      (prov.counts as { enriched: number }).enriched += 1;
      const { artifactPath, provPath } = writeVariant(dataDir, snapshotRaw, prov);
      assert.equal(cmdVerifySnapshot(artifactPath, provPath), 1, "the count mismatch must fail the verifier");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("missing completeness evidence (no counts object in the sidecar) is refused", async () => {
    const { dataDir, snapshotRaw, provRaw } = await stageRealBundle();
    try {
      const prov = rebuildProvenanceOver(JSON.parse(JSON.stringify(snapshotRaw)), provRaw);
      const bare = JSON.parse(JSON.stringify(prov)) as Record<string, unknown>;
      delete bare["counts"];
      const { artifactPath, provPath } = writeVariant(dataDir, snapshotRaw, bare);
      assert.equal(cmdVerifySnapshot(artifactPath, provPath), 1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("malformed completeness evidence (a non-integer enriched count) is refused", async () => {
    const { dataDir, snapshotRaw, provRaw } = await stageRealBundle();
    try {
      const prov = rebuildProvenanceOver(JSON.parse(JSON.stringify(snapshotRaw)), provRaw);
      const malformed = JSON.parse(JSON.stringify(prov)) as { counts: { enriched: unknown } };
      malformed.counts.enriched = "2"; // a string is not a count
      const { artifactPath, provPath } = writeVariant(dataDir, snapshotRaw, malformed);
      assert.equal(cmdVerifySnapshot(artifactPath, provPath), 1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("an empty snapshot (zero enriched pools, agreeing sidecar) is refused — fail closed", async () => {
    const { dataDir, snapshotRaw, provRaw } = await stageRealBundle();
    try {
      const empty = JSON.parse(JSON.stringify(snapshotRaw)) as Record<string, unknown>;
      (empty["counts"] as { enriched: number }).enriched = 0;
      (empty["pools"] as unknown[]).length = 0;
      const prov = rebuildProvenanceOver(JSON.parse(JSON.stringify(empty)), provRaw);
      const { artifactPath, provPath } = writeVariant(dataDir, empty, prov);
      assert.equal(cmdVerifySnapshot(artifactPath, provPath), 1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("the raw gate fails closed on a snapshot with NO failures array (missing evidence)", () => {
    const prov = { counts: { enriched: 2 } } as unknown as PublicationProvenance;
    assert.throws(
      () => verifyRawArtifactCompleteness({ counts: { enriched: 2 }, pools: [{}] }, prov),
      /completeness evidence: the snapshot carries no failures array/,
    );
  });

  test("the raw gate fails closed on a malformed failures entry (malformed evidence)", () => {
    const prov = { counts: { enriched: 2 } } as unknown as PublicationProvenance;
    assert.throws(
      () => verifyRawArtifactCompleteness({ failures: [{ stage: 42 }], counts: { enriched: 2 } }, prov),
      /completeness evidence: failures\[0\]\.stage is not a non-empty string/,
    );
  });
});
