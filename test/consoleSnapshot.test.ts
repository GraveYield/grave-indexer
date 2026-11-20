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
  type ConsoleSnapshotFailure,
  type ConsoleSnapshotV2,
  type PoolEnrichment,
} from "../src/consoleSnapshot.js";
import { ConsoleSnapshotParseError, parseConsoleSnapshot } from "../src/consoleSnapshotParse.js";
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
  const baseMint = coinIsWsol ? WSOL_MINT : synth(0x13);
  return {
    poolAddress,
    ammProgramId: synth(0x99),
    pool: {
      coinVault: synth(0x11),
      pcVault: synth(0x12),
      baseMint,
      quoteMint: coinIsWsol ? synth(0x17) : WSOL_MINT,
      lpMint: synth(0x14),
    },
    wsolSide: opts?.noWsolSide ? null : { memecoinMint: coinIsWsol ? synth(0x17) : baseMint, coinIsWsol },
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
    counts: { rawAccounts: 706_002, parsedPools: 400, supportedWsolPairs: 2, m1SourcingRejected: 0 },
    failures: [] as Array<{ stage: string; pool?: string; reason: string }>,
    slotLowerBound: 100,
    slotUpperBound: 110,
    ...over,
  };
}

describe("consoleSnapshot — artifact contract", () => {
  test("assembles, orders, and pins the exhaustive secret-free key set", () => {
    const a = makeRecord(1);
    const b = makeRecord(2);
    const enrichments = new Map([
      [a.poolAddress.toBase58(), makeEnrichment()],
      [b.poolAddress.toBase58(), makeEnrichment({ wsolReserveLamports: "18446744073709551615" })],
    ]);
    // Deliberately pass records out of order — the builder must sort.
    const snap = buildConsoleSnapshot([b, a], enrichments, makeMeta());
    assert.equal(snap.schemaVersion, CONSOLE_SNAPSHOT_SCHEMA_VERSION);
    // Schema v2: per-pool coin_mint/pc_mint + the D-01 M1 sourcing
    // assertion (see test/m1Sourcing.test.ts for the full vectors).
    assert.equal(snap.schemaVersion, 2);
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

// ---------------------------------------------------------------------------
// parseConsoleSnapshot — the fail-closed v2 READER (review finding 3)
// ---------------------------------------------------------------------------

const WSOL_B58 = WSOL_MINT.toBase58();

/** A valid v2 artifact: one emitted pool + one M1-rejected pool counted
 *  in counts.m1SourcingRejected and failures — the producer-true shape. */
function buildValidV2(): ConsoleSnapshotV2 {
  const rec = makeRecord(1);
  const rejectedAddress = synth(0x21).toBase58();
  const snap = buildConsoleSnapshot(
    [rec],
    new Map([[rec.poolAddress.toBase58(), makeEnrichment()]]),
    makeMeta({
      counts: { rawAccounts: 10, parsedPools: 2, supportedWsolPairs: 2, m1SourcingRejected: 1 },
      failures: [
        {
          stage: "m1-sourcing",
          pool: rejectedAddress,
          reason: "wsol-on-coin-side — WSOL is coin_mint (base side) — M1 requires WSOL on pc_mint (quote side)",
        },
      ],
    }),
  );
  return snap;
}

function roundTrip(snap: ConsoleSnapshotV2): unknown {
  return JSON.parse(JSON.stringify(snap));
}

describe("consoleSnapshotParse — schema v2 consumer contract (review finding 3)", () => {
  test("a valid v2 artifact parses and preserves every field", () => {
    const snap = buildValidV2();
    const parsed = parseConsoleSnapshot(roundTrip(snap));
    assert.deepEqual(parsed, snap, "the parsed contract is exactly the produced artifact");
    assert.equal(parsed.schemaVersion, 2);
    const p = parsed.pools[0]!;
    assert.equal(p.coinMint, synth(0x13).toBase58());
    assert.notEqual(p.coinMint, WSOL_B58, "coinMint is non-WSOL");
    assert.equal(p.pcMint, WSOL_B58, "pcMint is the canonical WSOL mint");
    assert.deepEqual(p.m1Sourcing, { eligible: true, wsolSide: "pc_mint", reason: null });
    assert.equal(parsed.counts.m1SourcingRejected, 1);
  });

  test("malformed sourcing metadata is rejected (exact D-01 requirement)", () => {
    const base = buildValidV2();
    const mutate = (fn: (snap: ConsoleSnapshotV2) => void): unknown => {
      const copy = JSON.parse(JSON.stringify(base)) as ConsoleSnapshotV2;
      fn(copy);
      return copy;
    };
    // coinMint must be non-WSOL.
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { s.pools[0]!.coinMint = WSOL_B58; })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /coinMint.*non-WSOL/.test(e.message),
    );
    // pcMint must be the canonical WSOL mint.
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { s.pools[0]!.pcMint = synth(0x17).toBase58(); })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /pcMint.*canonical WSOL/.test(e.message),
    );
    // The machine-checkable acceptance, exactly: eligible true.
    assert.throws(
      () =>
        parseConsoleSnapshot(
          mutate((s) => { (s.pools[0]!.m1Sourcing.eligible as boolean) = false; }),
        ),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /m1Sourcing.eligible/.test(e.message),
    );
    // ... wsolSide "pc_mint".
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { (s.pools[0]!.m1Sourcing.wsolSide as string) = "coin_mint"; })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /m1Sourcing.wsolSide/.test(e.message),
    );
    // ... reason null.
    assert.throws(
      () =>
        parseConsoleSnapshot(
          mutate((s) => { (s.pools[0]!.m1Sourcing.reason as string | null) = "wsol-on-coin-side"; }),
        ),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /m1Sourcing.reason/.test(e.message),
    );
    // The aliasing must agree (baseMint IS coin_mint, quoteMint IS pc_mint).
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { s.pools[0]!.baseMint = synth(0x30).toBase58(); })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /baseMint.*coinMint/.test(e.message),
    );
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { s.pools[0]!.quoteMint = synth(0x31).toBase58(); })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /quoteMint.*pcMint/.test(e.message),
    );
    // wsolSide must agree with the validated orientation.
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { s.pools[0]!.wsolSide.coinIsWsol = true; })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /coinIsWsol.*false/.test(e.message),
    );
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { s.pools[0]!.wsolSide.memecoinMint = synth(0x32).toBase58(); })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /memecoinMint.*coinMint/.test(e.message),
    );
  });

  test("unsupported schema versions are rejected with an actionable error — v1 is never reinterpreted", () => {
    const base = buildValidV2();
    // Explicit v1 policy: actionable error, no silent reinterpretation.
    const v1 = roundTrip(base) as Record<string, unknown>;
    v1.schemaVersion = 1;
    // A real v1 artifact also lacks the v2 fields entirely.
    delete (v1.pools as Array<Record<string, unknown>>)[0]!.coinMint;
    assert.throws(
      () => parseConsoleSnapshot(v1),
      (e: unknown) =>
        e instanceof ConsoleSnapshotParseError &&
        /schemaVersion 1 is not supported.*never reinterpreted/.test(e.message) &&
        /Regenerate/.test(e.message),
    );
    // Unknown future versions are rejected the same way.
    const v3 = roundTrip(base) as Record<string, unknown>;
    v3.schemaVersion = 3;
    assert.throws(
      () => parseConsoleSnapshot(v3),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /unsupported schemaVersion.*3/.test(e.message),
    );
    // Missing version is unsupported too (the exhaustive root key set
    // flags it: schemaVersion is a required contract key).
    const missing = roundTrip(base) as Record<string, unknown>;
    delete missing.schemaVersion;
    assert.throws(
      () => parseConsoleSnapshot(missing),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /schemaVersion/.test(e.message),
    );
  });

  test("unknown or missing fields are never silently ignored", () => {
    const base = buildValidV2();
    const extraTop = roundTrip(base) as Record<string, unknown>;
    extraTop.operatorNote = "hello";
    assert.throws(
      () => parseConsoleSnapshot(extraTop),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /root.*unknown operatorNote/.test(e.message),
    );
    const missingField = roundTrip(base) as Record<string, unknown>;
    delete (missingField.pools as Array<Record<string, unknown>>)[0]!.coinMint;
    assert.throws(
      () => parseConsoleSnapshot(missingField),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /pools\[0\].*missing coinMint/.test(e.message),
    );
    const extraPoolKey = roundTrip(base) as Record<string, unknown>;
    (extraPoolKey.pools as Array<Record<string, unknown>>)[0]!.score = 99;
    assert.throws(
      () => parseConsoleSnapshot(extraPoolKey),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /pools\[0\].*unknown score/.test(e.message),
    );
    const extraCountsKey = roundTrip(base) as Record<string, unknown>;
    (extraCountsKey.counts as Record<string, unknown>).rejected = 1;
    assert.throws(
      () => parseConsoleSnapshot(extraCountsKey),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /counts.*unknown rejected/.test(e.message),
    );
  });

  test("m1SourcingRejected counts cannot drift into misleading totals", () => {
    const base = buildValidV2();
    const mutate = (fn: (snap: ConsoleSnapshotV2) => void): unknown => {
      const copy = JSON.parse(JSON.stringify(base)) as ConsoleSnapshotV2;
      fn(copy);
      return copy;
    };
    // enriched must equal the emitted pool list.
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { s.counts.enriched = 2; })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /counts.enriched \(2\) != pools\.length \(1\)/.test(e.message),
    );
    // Rejections cannot exceed the WSOL-supported corpus.
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { s.counts.m1SourcingRejected = 5; })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /exceeds counts\.supportedWsolPairs/.test(e.message),
    );
    // The emitted list cannot exceed supported minus rejected (enrichment
    // failures shrink it, never grow it).
    assert.throws(
      () => parseConsoleSnapshot(mutate((s) => { s.counts.supportedWsolPairs = 1; })),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /never grow it/.test(e.message),
    );
    // Every rejected pool must appear exactly once under stage m1-sourcing.
    assert.throws(
      () =>
        parseConsoleSnapshot(
          mutate((s) => { s.counts.m1SourcingRejected = 0; }),
        ),
      (e: unknown) =>
        e instanceof ConsoleSnapshotParseError &&
        /counts\.m1SourcingRejected \(0\) != failures with stage "m1-sourcing" \(1\)/.test(e.message),
    );
    assert.throws(
      () =>
        parseConsoleSnapshot(
          mutate((s) => {
            const dup = { ...(s.failures[0] as ConsoleSnapshotFailure) };
            s.failures.push(dup);
            // The count tracks the (now twice-reported) rejection — the
            // per-pool distinctness check is what must catch this.
            s.counts.m1SourcingRejected = 2;
          }),
        ),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /more than once under stage "m1-sourcing"/.test(e.message),
    );
  });

  test("criteria honesty: a future index cannot quietly invent evaluations", () => {
    const base = buildValidV2();
    const copy = JSON.parse(JSON.stringify(base)) as ConsoleSnapshotV2;
    (copy.pools[0]!.criteria.c2PriceCollapse as string) = "pass";
    assert.throws(
      () => parseConsoleSnapshot(copy),
      (e: unknown) => e instanceof ConsoleSnapshotParseError && /c2PriceCollapse must be "pending"/.test(e.message),
    );
  });
});
