// SPDX-License-Identifier: Apache-2.0
//
// D-01 M1 WSOL quote-side sourcing guard tests (GY-M1-ODR-001 §3) for
// the grave-indexer enforcement boundaries:
//
//   * the predicate module (discovery/operator boundary expression,
//     anchored on the canonical SDK WSOL_MINT constant);
//   * the console-snapshot builder (fail-closed operator artifact);
//   * the collect-path ingestion gate (the alternate --pool/ledger
//     route cannot bypass the discovery filter).
//
// The SDK-side predicate vectors live in graveyield-protocol
// (sdk/test/m1Sourcing.test.ts) and the protocol-indexer pipeline
// vectors in its indexer/test/m1Sourcing.test.ts; this suite pins the
// grave-indexer boundaries independently, as D-01 requires.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PublicKey } from "@solana/web3.js";
import {
  assertM1Sourcing,
  evaluateM1Sourcing,
  M1SourcingError,
  type M1SourcingRejected,
  type M1SourcingVerdict,
} from "../src/m1Sourcing.js";
import { buildConsoleSnapshot, buildSnapshotPool, CONSOLE_SNAPSHOT_SCHEMA_VERSION } from "../src/consoleSnapshot.js";
import type { DiscoveredPoolRecord } from "../src/discovery.js";
import { accountFingerprint } from "../src/provenance.js";
import { buildAmmInfo, synth, WSOL_MINT } from "./fixtures.js";

const MEMECOIN = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OTHER = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

const NOW_MS = 1_800_000_000_000;
const THRESHOLDS = { inactivitySeconds: 7_776_000n, minTvlLamports: 500_000_000n };

function expectRejected(verdict: M1SourcingVerdict, reason: M1SourcingRejected["reason"]): M1SourcingRejected {
  assert.equal(verdict.accepted, false, `expected rejection (${reason})`);
  assert.equal((verdict as M1SourcingRejected).reason, reason);
  return verdict as M1SourcingRejected;
}

// ---------------------------------------------------------------------------
// Predicate — the ten D-01 required vectors
// ---------------------------------------------------------------------------

describe("evaluateM1Sourcing — D-01 predicate vectors (grave-indexer boundary)", () => {
  test("PASS: WSOL is pc_mint and the other mint is non-WSOL", () => {
    const verdict = evaluateM1Sourcing({ coinMint: MEMECOIN, pcMint: WSOL_MINT });
    assert.equal(verdict.accepted, true);
    if (verdict.accepted) {
      assert.ok(verdict.wsolMint.equals(WSOL_MINT));
      assert.ok(verdict.memecoinMint.equals(MEMECOIN));
    }
  });

  test("REJECT: WSOL is coin_mint (base side)", () => {
    expectRejected(evaluateM1Sourcing({ coinMint: WSOL_MINT, pcMint: MEMECOIN }), "wsol-on-coin-side");
  });

  test("REJECT: neither mint is WSOL", () => {
    expectRejected(evaluateM1Sourcing({ coinMint: MEMECOIN, pcMint: OTHER }), "no-wsol-side");
  });

  test("REJECT: both mints are WSOL", () => {
    expectRejected(evaluateM1Sourcing({ coinMint: WSOL_MINT, pcMint: WSOL_MINT }), "both-sides-wsol");
  });

  test("REJECT: missing pc_mint", () => {
    expectRejected(evaluateM1Sourcing({ coinMint: MEMECOIN, pcMint: undefined }), "missing-pc-mint");
  });

  test("REJECT: missing coin_mint", () => {
    expectRejected(evaluateM1Sourcing({ coinMint: null, pcMint: WSOL_MINT }), "missing-coin-mint");
  });

  test("REJECT: malformed / unverifiable mint data (never reinterpreted)", () => {
    expectRejected(
      evaluateM1Sourcing({ coinMint: "So11111111111111111111111111111111111111112" as unknown as PublicKey, pcMint: MEMECOIN }),
      "unverifiable-orientation",
    );
    expectRejected(
      evaluateM1Sourcing({ coinMint: MEMECOIN, pcMint: 42 as unknown as PublicKey }),
      "unverifiable-orientation",
    );
  });

  test("the WSOL anchor is the canonical SDK constant (no second definition)", () => {
    // Acceptance requires an EXACT match against the canonical mint.
    const lookalike = new PublicKey(new Uint8Array(32).fill(0xab));
    expectRejected(evaluateM1Sourcing({ coinMint: MEMECOIN, pcMint: lookalike }), "no-wsol-side");
  });
});

// ---------------------------------------------------------------------------
// Operator artifact — the console snapshot builder fails closed
// ---------------------------------------------------------------------------

const BASE_MINT = synth(0x13);

function makeRecord(seed: number, opts?: { base?: PublicKey; quote?: PublicKey; noWsolSide?: boolean }): DiscoveredPoolRecord {
  const data = buildAmmInfo();
  const poolAddress = synth(seed);
  const base = opts?.base ?? BASE_MINT;
  const quote = opts?.quote ?? WSOL_MINT;
  return {
    poolAddress,
    ammProgramId: synth(0x99),
    pool: {
      coinVault: synth(0x11),
      pcVault: synth(0x12),
      baseMint: base,
      quoteMint: quote,
      lpMint: synth(0x14),
    },
    wsolSide: opts?.noWsolSide
      ? null
      : base.equals(WSOL_MINT)
        ? { memecoinMint: quote, coinIsWsol: true }
        : { memecoinMint: base, coinIsWsol: false },
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

function makeEnrichment(over: Record<string, unknown> = {}) {
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

describe("consoleSnapshot — D-01 operator acceptance assertion", () => {
  test("schema v2: records coin_mint/pc_mint and the machine-checkable M1 verdict", () => {
    const rec = makeRecord(1);
    const snap = buildConsoleSnapshot(
      [rec],
      new Map([[rec.poolAddress.toBase58(), makeEnrichment()]]),
      makeMeta(),
    );
    assert.equal(snap.schemaVersion, CONSOLE_SNAPSHOT_SCHEMA_VERSION);
    assert.equal(snap.schemaVersion, 2);
    const p = snap.pools[0]!;
    // Raydium field names displayed as required by D-01 §C.
    assert.equal(p.coinMint, BASE_MINT.toBase58());
    assert.equal(p.pcMint, WSOL_MINT.toBase58());
    assert.equal(p.baseMint, p.coinMint);
    assert.equal(p.quoteMint, p.pcMint);
    assert.deepEqual(p.m1Sourcing, { eligible: true, wsolSide: "pc_mint", reason: null });
    assert.equal(snap.counts.m1SourcingRejected, 0);
    // A verifier can re-derive the exact predicate from the artifact.
    assert.notEqual(p.pcMint, p.coinMint);
  });

  test("REJECT: WSOL on coin_mint — the builder refuses to emit the pool", () => {
    const coinWsol = makeRecord(2, { base: WSOL_MINT, quote: MEMECOIN });
    try {
      buildSnapshotPool(coinWsol, makeEnrichment(), THRESHOLDS, NOW_MS);
      assert.fail("expected M1SourcingError");
    } catch (err) {
      assert.ok(err instanceof M1SourcingError);
      assert.equal((err as M1SourcingError).reason, "wsol-on-coin-side");
    }
    assert.throws(
      () =>
        buildConsoleSnapshot(
          [coinWsol],
          new Map([[coinWsol.poolAddress.toBase58(), makeEnrichment()]]),
          makeMeta(),
        ),
      M1SourcingError,
    );
  });

  test("REJECT: neither mint WSOL / both WSOL / no WSOL side", () => {
    assert.throws(
      () => buildSnapshotPool(makeRecord(3, { base: MEMECOIN, quote: OTHER }), makeEnrichment(), THRESHOLDS, NOW_MS),
      M1SourcingError,
    );
    assert.throws(
      () => buildSnapshotPool(makeRecord(4, { base: WSOL_MINT, quote: WSOL_MINT }), makeEnrichment(), THRESHOLDS, NOW_MS),
      M1SourcingError,
    );
    // The pre-existing 7019-unsupported record still fails (no WSOL side).
    assert.throws(
      () => buildSnapshotPool(makeRecord(5, { noWsolSide: true }), makeEnrichment(), THRESHOLDS, NOW_MS),
      /no WSOL side/,
    );
  });

  test("rejected pools stay visible as machine-checkable failures without entering the pool list", () => {
    const ok = makeRecord(1);
    const bad = makeRecord(2, { base: WSOL_MINT, quote: MEMECOIN });
    const snap = buildConsoleSnapshot(
      [ok],
      new Map([[ok.poolAddress.toBase58(), makeEnrichment()]]),
      makeMeta({
        counts: { rawAccounts: 10, parsedPools: 2, supportedWsolPairs: 2, m1SourcingRejected: 1 },
        failures: [
          {
            stage: "m1-sourcing",
            pool: bad.poolAddress.toBase58(),
            reason: "wsol-on-coin-side — WSOL is coin_mint (base side) — M1 requires WSOL on pc_mint (quote side)",
          },
        ],
      }),
    );
    assert.equal(snap.pools.length, 1, "only the M1-eligible pool is emitted");
    assert.equal(snap.pools[0]!.address, ok.poolAddress.toBase58());
    assert.equal(snap.counts.enriched, 1);
    assert.equal(snap.counts.m1SourcingRejected, 1);
    assert.equal(snap.failures[0]!.stage, "m1-sourcing");
    assert.equal(snap.failures[0]!.pool, bad.poolAddress.toBase58());
  });
});

// ---------------------------------------------------------------------------
// Collect-path ingestion gate — the alternate route cannot bypass
// ---------------------------------------------------------------------------

describe("collect-path ingestion gate — D-01 alternate-route coverage", () => {
  test("a fetched coin-WSOL identity fails the gate (no bundle, pool skipped)", () => {
    // Mirrors cmdCollect's exact gate call on a freshly fetched identity:
    // assertM1Sourcing({ coinMint: identity.baseMint, pcMint: identity.quoteMint }).
    const coinWsolIdentity = { baseMint: WSOL_MINT, quoteMint: MEMECOIN };
    assert.throws(
      () => assertM1Sourcing({ coinMint: coinWsolIdentity.baseMint, pcMint: coinWsolIdentity.quoteMint }),
      (err: unknown) => err instanceof M1SourcingError && err.reason === "wsol-on-coin-side",
    );
    // The ledger-consistent pc-WSOL identity passes the same gate.
    assert.equal(
      assertM1Sourcing({ coinMint: MEMECOIN, pcMint: WSOL_MINT }).accepted,
      true,
    );
  });
});
