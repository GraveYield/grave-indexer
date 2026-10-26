// consoleSnapshot — contract tests for the console artifact builder (P3-A Task 3.1).
//
// Pins the schema key set (secret-free by construction), the exact-u64
// string encoding, the fail-closed construction rules, and the honest
// criteria math (only C1/C3 derivable; C2/C4/C5/C6 stay pending).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PublicKey } from "@solana/web3.js";

import {
  assertExactU64,
  buildConsoleSnapshot,
  buildSnapshotPool,
  CONSOLE_SNAPSHOT_KEYS,
  CONSOLE_SNAPSHOT_SCHEMA_VERSION,
  deriveCriteria,
  type PoolEnrichment,
} from "../src/consoleSnapshot.js";
import type { DiscoveredPoolRecord } from "../src/discovery.js";
import { accountFingerprint, sha256Hex } from "../src/provenance.js";
import { buildAmmInfo, synth, WSOL_MINT } from "./fixtures.js";

const NOW_MS = 1_800_000_000_000; // fixed "now"
const INACTIVITY_SECONDS = 7_776_000n; // 90 d
const MIN_TVL_LAMPORTS = 500_000_000n; // 0.5 SOL
const THRESHOLDS = { inactivitySeconds: INACTIVITY_SECONDS, minTvlLamports: MIN_TVL_LAMPORTS };

function makeRecord(seed: number, opts?: { coinIsWsol?: boolean; noWsolSide?: boolean }): DiscoveredPoolRecord {
  const data = buildAmmInfo();
  const poolAddress = synth(seed);
  const coinIsWsol = opts?.coinIsWsol ?? false;
  const baseMint = synth(0x13);
  return {
    poolAddress,
    ammProgramId: synth(0x99),
    pool: {
      coinVault: synth(0x11),
      pcVault: synth(0x12),
      baseMint,
      quoteMint: coinIsWsol ? baseMint : WSOL_MINT,
      lpMint: synth(0x14),
    },
    wsolSide: opts?.noWsolSide ? null : { memecoinMint: baseMint, coinIsWsol },
    raw: {
      mode: "full",
      dataLen: data.length,
      fingerprint: accountFingerprint(poolAddress, data),
      owner: synth(0x99).toBase58(),
    },
    provenance: {
      source: "raydium-v4-gpa",
      cluster: "mainnet-beta",
      endpointKind: "public-rpc",
      slotLowerBound: 100,
      slotUpperBound: 110,
      fetchedAtUnixMs: NOW_MS - 5_000,
    },
  };
}

function makeEnrichment(over: Partial<PoolEnrichment> = {}): PoolEnrichment {
  return {
    wsolReserveLamports: "600000000",
    memecoinReserveRaw: "1000000",
    memecoinDecimals: 6,
    lpSupplyRaw: "10000000",
    lastSwap: { unixTs: Math.floor(NOW_MS / 1000) - 8_000_000, slot: 42, signature: "5" + "a".repeat(86) },
    fetchedAtUnixMs: NOW_MS - 4_000,
    ...over,
  };
}

function makeMeta(over: Record<string, unknown> = {}) {
  return {
    generatedAtUnixMs: NOW_MS,
    cluster: "mainnet-beta" as const,
    endpointKind: "public-rpc" as const,
    indexerGitHead: null,
    maxAgeMs: 86_400_000,
    thresholds: THRESHOLDS,
    counts: { rawAccounts: 706_002, parsedPools: 400, supportedWsolPairs: 2 },
    failures: [] as Array<{ stage: string; pool?: string; reason: string }>,
    slotLowerBound: 100,
    slotUpperBound: 110,
    ...over,
  };
}

describe("consoleSnapshot — artifact contract", () => {
  test("assembles, orders, and pins the exhaustive secret-free key set", () => {
    const a = makeRecord(1);
    const b = makeRecord(2, { coinIsWsol: true });
    const enrichments = new Map([
      [a.poolAddress.toBase58(), makeEnrichment()],
      [b.poolAddress.toBase58(), makeEnrichment({ wsolReserveLamports: "18446744073709551615" })],
    ]);
    // Deliberately pass records out of order — the builder must sort.
    const snap = buildConsoleSnapshot([b, a], enrichments, makeMeta());
    assert.equal(snap.schemaVersion, CONSOLE_SNAPSHOT_SCHEMA_VERSION);
    assert.equal(snap.schemaVersion, 1);
    assert.deepEqual(Object.keys(snap).sort(), [...CONSOLE_SNAPSHOT_KEYS].sort());
    const addresses = snap.pools.map((p) => p.address);
    assert.deepEqual(addresses, [...addresses].sort());
    // u64 crosses JSON as an exact decimal string (u64 max edge case).
    assert.equal(snap.pools[1]!.wsolReserveLamports, "18446744073709551615");
    assert.equal(snap.thresholds.inactivitySeconds, "7776000");
    assert.equal(snap.thresholds.minTvlLamports, "500000000");
    assert.equal(snap.counts.enriched, 2);
    assert.equal(snap.provenance.source, "raydium-v4-gpa");
    assert.equal(snap.provenance.ordering, "ascending base58 pool address (reproducible)");
    // Fingerprint passthrough — provenance survives the contract boundary.
    assert.equal(snap.pools[0]!.fingerprint, a.raw.fingerprint);
    // Secret-free: no URLs, no endpoint hosts, no key-ish material.
    const json = JSON.stringify(snap);
    assert.ok(!json.includes("http"), "artifact must not contain URL material");
    assert.ok(!json.includes("rpcUrl"), "artifact must not carry an rpcUrl field");
  });

  test("criteria math is honest: only C1/C3 evaluated, everything else pending", () => {
    const rec = makeRecord(1);
    const snap = buildConsoleSnapshot(
      [rec],
      new Map([[rec.poolAddress.toBase58(), makeEnrichment()]]),
      makeMeta(),
    );
    const c = snap.pools[0]!.criteria;
    // last swap 8,000,000s ago >= 7,776,000s → C1 pass.
    assert.equal(c.c1Inactivity, "pass");
    // 600,000,000 >= 500,000,000 lamports → C3 pass.
    assert.equal(c.c3MinTvl, "pass");
    assert.equal(c.c2PriceCollapse, "pending");
    assert.equal(c.c4LpBurned, "pending");
    assert.equal(c.c5LpLocked, "pending");
    assert.equal(c.c6MultiEpoch, "pending");
  });

  test("C1 fail on recent activity, C1 pending when not derivable", () => {
    const recent = deriveCriteria(
      { unixTs: Math.floor(NOW_MS / 1000) - 100 },
      "600000000",
      THRESHOLDS,
      NOW_MS,
    );
    assert.equal(recent.c1Inactivity, "fail");
    const noSwap = deriveCriteria(null, "600000000", THRESHOLDS, NOW_MS);
    assert.equal(noSwap.c1Inactivity, "pending");
  });

  test("C3 boundary: exactly minTvl passes", () => {
    assert.equal(deriveCriteria(null, "500000000", THRESHOLDS, NOW_MS).c3MinTvl, "pass");
    assert.equal(deriveCriteria(null, "499999999", THRESHOLDS, NOW_MS).c3MinTvl, "fail");
  });

  test("fail-closed: unsupported pool, missing enrichment, invalid meta", () => {
    const unsupported = makeRecord(3, { noWsolSide: true });
    assert.throws(
      () => buildSnapshotPool(unsupported, makeEnrichment(), THRESHOLDS, NOW_MS),
      /no WSOL side/,
    );

    const a = makeRecord(1);
    // Ordered record without enrichment → hard error, never a guessed pool.
    assert.throws(() => buildConsoleSnapshot([a], new Map(), makeMeta()), /missing enrichment/);
    assert.throws(
      () =>
        buildConsoleSnapshot(
          [a],
          new Map([[a.poolAddress.toBase58(), makeEnrichment()]]),
          makeMeta({ maxAgeMs: 0 }),
        ),
      /maxAgeMs/,
    );
    assert.throws(
      () =>
        buildConsoleSnapshot(
          [a],
          new Map([[a.poolAddress.toBase58(), makeEnrichment()]]),
          makeMeta({ generatedAtUnixMs: 0 }),
        ),
      /generatedAtUnixMs/,
    );
  });

  test("assertExactU64 rejects non-decimal, leading zeros, and u64 overflow", () => {
    assert.equal(assertExactU64("0", "x"), "0");
    assert.equal(assertExactU64("18446744073709551615", "x"), "18446744073709551615");
    assert.throws(() => assertExactU64("12a", "x"));
    assert.throws(() => assertExactU64("01", "x"));
    assert.throws(() => assertExactU64("1e9", "x"));
    assert.throws(() => assertExactU64("-1", "x"));
    assert.throws(() => assertExactU64("18446744073709551616", "x"));
    assert.throws(() => assertExactU64("", "x"));
  });

  test("per-pool failures ride along without polluting the pool list", () => {
    const a = makeRecord(1);
    const snap = buildConsoleSnapshot(
      [a],
      new Map([
        [a.poolAddress.toBase58(), makeEnrichment({ lastSwap: null })],
      ]),
      makeMeta({
        failures: [{ stage: "activity", pool: a.poolAddress.toBase58(), reason: "scan limit reached" }],
      }),
    );
    const p = snap.pools[0]!;
    assert.equal(p.lastSwap, null);
    assert.equal(p.criteria.c1Inactivity, "pending");
    assert.equal(snap.failures.length, 1);
    assert.equal(snap.failures[0]!.stage, "activity");
  });

  test("fingerprint is a stable sha256 over address and payload", () => {
    const data = buildAmmInfo();
    const fp = accountFingerprint(synth(1), data);
    assert.match(fp, /^[0-9a-f]{64}$/);
    assert.equal(fp, sha256Hex(Buffer.concat([synth(1).toBytes(), Buffer.from(data)])));
  });
});
