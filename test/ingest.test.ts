// SPDX-License-Identifier: Apache-2.0
//
// Ingest ledger tests — duplicate ingestion idempotence, change tracking,
// same-slot conflict detection (fail-closed), staleness policy, and JSONL
// persistence round-trip.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { IngestLedger } from "../src/ingest.js";
import { discoverRaydiumV4Pools, type DiscoveredPoolRecord } from "../src/discovery.js";
import { accountFingerprint, sha256Hex } from "../src/provenance.js";
import { buildAmmInfo, buildAmmInfoSlice, synth, WSOL_MINT } from "./fixtures.js";
import type { Connection } from "@solana/web3.js";

function makeRecord(seed: number, fingerprintSalt = 0): DiscoveredPoolRecord {
  const data = buildAmmInfo();
  if (fingerprintSalt !== 0) data[100] = fingerprintSalt; // perturb payload
  const poolAddress = synth(seed);
  return {
    poolAddress,
    ammProgramId: synth(0x99),
    pool: {
      coinVault: synth(0x11),
      pcVault: synth(0x12),
      baseMint: synth(0x13),
      quoteMint: WSOL_MINT,
      lpMint: synth(0x14),
    },
    wsolSide: { memecoinMint: synth(0x13), coinIsWsol: false },
    raw: {
      dataLen: data.length,
      fingerprint: accountFingerprint(poolAddress, data),
      owner: synth(0x99).toBase58(),
    },
    provenance: {
      source: "raydium-v4-gpa",
      cluster: "mainnet-beta",
      endpointKind: "public-rpc",
      slotLowerBound: 5_000_000,
      slotUpperBound: 5_000_001,
      fetchedAtUnixMs: 1_760_000_000_000,
    },
  };
}

describe("ingest ledger", () => {
  test("first ingest is new; identical re-ingest is duplicate-unchanged and idempotent", () => {
    const ledger = new IngestLedger();
    const record = makeRecord(0xa1);
    const first = ledger.ingestOne(record, 1000);
    assert.equal(first.status, "new");
    const second = ledger.ingestOne(record, 2000);
    assert.equal(second.status, "duplicate-unchanged");
    assert.equal(second.entry.ingestCount, 2);
    assert.equal(ledger.size, 1, "no duplicate entries");
    // Repeated duplicate ingestion must not grow history.
    ledger.ingestOne(record, 3000);
    const entry = ledger.get(record.poolAddress.toBase58())!;
    assert.equal(entry.fingerprintHistory.length, 0, "unchanged records keep empty history");
  });

  test("different bytes at a later slot is a tracked change with history", () => {
    const ledger = new IngestLedger();
    const seed = 0xa2;
    ledger.ingestOne(makeRecord(seed), 1000);
    const changed = makeRecord(seed, 0xff); // perturbed payload
    (changed.provenance as { slotLowerBound: number }).slotLowerBound = 5_000_100;
    (changed.provenance as { slotUpperBound: number }).slotUpperBound = 5_000_101;
    const outcome = ledger.ingestOne(changed, 2000);
    assert.equal(outcome.status, "changed");
    assert.ok(outcome.previousFingerprint !== undefined, "previous fingerprint recorded");
    const entry = ledger.get(changed.poolAddress.toBase58())!;
    assert.equal(entry.fingerprintHistory.length, 1, "history bounded and populated");
    assert.equal(entry.conflicted, false);
  });

  test("same slot with different bytes is a CONFLICT and blocks evidence issuance", () => {
    const ledger = new IngestLedger();
    const seed = 0xa3;
    ledger.ingestOne(makeRecord(seed), 1000);
    const divergent = makeRecord(seed, 0x77); // different payload, same slot
    const outcome = ledger.ingestOne(divergent, 2000);
    assert.equal(outcome.status, "conflict");
    const entry = ledger.get(divergent.poolAddress.toBase58())!;
    assert.equal(entry.conflicted, true);
    assert.ok(ledger.blockedEntries(5_000_010, 100_000).some((e) => e.poolAddress === entry.poolAddress));
  });

  test("a fresh unambiguous observation clears a past conflict", () => {
    const ledger = new IngestLedger();
    const seed = 0xa4;
    ledger.ingestOne(makeRecord(seed), 1000);
    const divergent = makeRecord(seed, 0x77);
    ledger.ingestOne(divergent, 2000);
    assert.equal(ledger.get(synth(seed).toBase58())!.conflicted, true);
    const fresh = makeRecord(seed); // original bytes again, later slot
    (fresh.provenance as { slotLowerBound: number }).slotLowerBound = 5_000_200;
    (fresh.provenance as { slotUpperBound: number }).slotUpperBound = 5_000_201;
    ledger.ingestOne(fresh, 3000);
    assert.equal(ledger.get(synth(seed).toBase58())!.conflicted, false);
  });

  test("staleness policy flags entries older than the slot budget", () => {
    const ledger = new IngestLedger();
    ledger.ingestOne(makeRecord(0xa5), 1000);
    const stale = ledger.staleEntries(5_000_000 + 500, 400);
    assert.equal(stale.length, 1);
    assert.ok(stale[0]!.ageSlots > 400);
    assert.equal(ledger.staleEntries(5_000_000 + 100, 400).length, 0);
  });

  test("JSONL round-trip preserves entries in deterministic order", () => {
    const ledger = new IngestLedger();
    ledger.ingestOne(makeRecord(0xa6), 1000);
    ledger.ingestOne(makeRecord(0xa7), 1000);
    ledger.ingestOne(makeRecord(0xa8), 1000);
    const restored = IngestLedger.fromJSONL(ledger.toJSONL());
    assert.equal(restored.size, 3);
    assert.deepEqual(
      restored.list().map((e) => e.poolAddress),
      ledger.list().map((e) => e.poolAddress),
      "ascending base58 order preserved",
    );
    // Torn trailing line tolerated.
    const torn = `${ledger.toJSONL()}\n{"poolAddress":"torn`;
    assert.equal(IngestLedger.fromJSONL(torn).size, 3);
  });
});

describe("discovery (mocked RPC)", () => {
  function mockConnection(_accounts: unknown[]): Connection {
    return {
      getSlot: async () => 5_000_000,
      rpcEndpoint: "https://api.mainnet-beta.solana.com",
    } as unknown as Connection;
  }

  function mockFetch(accounts: Array<{ pubkey: string; payload: Uint8Array }>): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: accounts.map((a) => ({
            pubkey: a.pubkey,
            account: { data: [Buffer.from(a.payload).toString("base64"), "base64"], owner: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
  }

  test("slice mode (default): parses identity from the 160-byte dataSlice window", async () => {
    const accounts = [
      { pubkey: synth(0x41).toBase58(), payload: buildAmmInfoSlice() },
      { pubkey: synth(0x43).toBase58(), payload: buildAmmInfoSlice({ baseMint: synth(0x21), coinVault: synth(0x22) }) },
      { pubkey: synth(0x42).toBase58(), payload: new Uint8Array(100) },
      { pubkey: synth(0x41).toBase58(), payload: buildAmmInfoSlice() }, // in-batch duplicate
    ];
    const run = await discoverRaydiumV4Pools(mockConnection([]), {
      cluster: "mainnet-beta",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      fetchImpl: mockFetch(accounts),
    });
    assert.equal(run.stats.rawAccounts, 4);
    assert.equal(run.stats.parsedPools, 2);
    assert.equal(run.stats.duplicatesInBatch, 1);
    assert.equal(run.stats.malformedSkipped, 1);
    assert.equal(run.stats.unsupportedPairs, 0);
    assert.equal(run.records.length, 2);
    // Deterministic ordering: ascending base58.
    const [first, second] = [run.records[0]!, run.records[1]!];
    assert.ok(first.poolAddress.toBase58() < second.poolAddress.toBase58());
    // Provenance + identity.
    assert.equal(first.provenance.slotLowerBound, 5_000_000);
    assert.equal(first.provenance.endpointKind, "public-rpc");
    assert.equal(first.raw.mode, "identity-slice");
    assert.equal(first.raw.dataLen, 160);
    assert.deepEqual(first.pool.quoteMint, WSOL_MINT);
    assert.equal(first.wsolSide?.coinIsWsol, false);
    assert.notEqual(first.raw.fingerprint, sha256Hex(new Uint8Array(0)), "fingerprint is non-trivial");
  });

  test("full mode: parses the whole 752-byte payload via the SDK parser", async () => {
    const accounts = [{ pubkey: synth(0x45).toBase58(), payload: buildAmmInfo() }];
    const run = await discoverRaydiumV4Pools(mockConnection([]), {
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      mode: "full",
      fetchImpl: mockFetch(accounts),
    });
    assert.equal(run.records.length, 1);
    const rec = run.records[0]!;
    assert.equal(rec.raw.mode, "full");
    assert.equal(rec.raw.dataLen, 752);
    assert.deepEqual(rec.pool.quoteMint, WSOL_MINT);
  });

  test("7019 guard: zero-or-two WSOL sides are recorded but excluded from the funnel", async () => {
    const run = await discoverRaydiumV4Pools(mockConnection([]), {
      cluster: "mainnet-beta",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      fetchImpl: mockFetch([{ pubkey: synth(0x44).toBase58(), payload: buildAmmInfoSlice({ baseMint: WSOL_MINT, quoteMint: WSOL_MINT }) }]),
    });
    assert.equal(run.stats.unsupportedPairs, 1);
    assert.equal(run.records[0]?.wsolSide, null);
  });

  test("maxPools caps the run", async () => {
    const accounts = [1, 2, 3, 4, 5].map((i) => ({
      pubkey: synth(0x50 + i).toBase58(),
      payload: buildAmmInfoSlice({ baseMint: synth(i) }),
    }));
    const run = await discoverRaydiumV4Pools(mockConnection([]), {
      cluster: "mainnet-beta",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      maxPools: 2,
      fetchImpl: mockFetch(accounts),
    });
    assert.equal(run.records.length, 2);
  });

  test("tolerates the { context, value } result shape and surfaces RPC errors", async () => {
    const valueShape = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { context: { slot: 5_000_000 }, value: [{ pubkey: synth(0x41).toBase58(), account: { data: [Buffer.from(buildAmmInfoSlice()).toString("base64"), "base64"] } }] },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const run = await discoverRaydiumV4Pools(mockConnection([]), {
      cluster: "mainnet-beta",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      fetchImpl: valueShape,
    });
    assert.equal(run.records.length, 1);

    const errorShape = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "scan in progress" } }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      () =>
        discoverRaydiumV4Pools(mockConnection([]), {
          cluster: "mainnet-beta",
          rpcUrl: "https://api.mainnet-beta.solana.com",
          fetchImpl: errorShape,
        }),
      /RPC error/,
    );
  });
});
