// SPDX-License-Identifier: Apache-2.0
//
// RPC-level M1 WSOL quote-side sourcing filter (GY-M1-INT-001 §6):
// layout verification, filter wire shape, matching behavior, discovery
// plumbing, and server-side (RPC) application — all offline, over
// deterministic synthetic accounts. NO public RPC, NO cluster contact.
//
// The pc_mint@432 offset asserted here is INDEPENDENTLY recomputed from
// the authoritative raydium-io/raydium-amm `program/src/state.rs`
// `#[repr(C, packed)] AmmInfo` field list (the same layout the vendored
// SDK pins at OFF.PC_VAULT_MINT = 432 and the on-chain adapter asserts),
// so the filter cannot drift from the struct without a failing test.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";

import { PublicKey } from "@solana/web3.js";
import { RAYDIUM_V4_AMM_INFO_SIZE, RAYDIUM_V4_PROGRAM_ID, WSOL_MINT } from "@graveyield/sdk";

import { discoverRaydiumV4Pools, type DiscoverOptions } from "../src/discovery.js";
import {
  RAYDIUM_V4_PC_MINT_OFFSET,
  WSOL_MEMCMP_BYTES,
  WSOL_MINT_BYTES,
  buildM1WsolQuoteSideRpcFilter,
  mintMatchesM1WsolQuoteSideFilter,
} from "../src/m1SourcingFilter.js";
import { parseV4AmmInfoSlice, DISCOVERY_SLICE } from "../src/discovery.js";
import { buildAmmInfo, buildAmmInfoSlice, synth, WSOL_MINT as FIXTURE_WSOL } from "./fixtures.js";

const MEMECOIN = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// ─── Authoritative layout recomputation ─────────────────────────────────────

/**
 * The packed AmmInfo field list, transcribed from the authoritative
 * raydium-io/raydium-amm `program/src/state.rs` (struct AmmInfo,
 * #[repr(C, packed)]): every field's byte size in declaration order.
 * Fees is the Pack::LEN=64 blob; StateData is the 144-byte blob
 * (6×u64 + [u64;2] + u64 + 3×u128… = 4*8+16+8+8+2*16+16+8+2*16 … the
 * serialized tail: need_take_pnl_coin/pc, total_pnl_pc/coin,
 * pool_open_time (5×8), padding [u64;2] (16), orderbook_to_init_time
 * (8), swap_coin_in_amount (16), swap_pc_out_amount (16),
 * swap_acc_pc_fee (8), swap_pc_in_amount (16), swap_coin_out_amount
 * (16), swap_acc_coin_fee (8) = 40+16+8+16+16+8+16+16+8 = 144).
 */
const AMM_INFO_PACKED_FIELDS: Array<[string, number]> = [
  ["status", 8],
  ["nonce", 8],
  ["order_num", 8],
  ["depth", 8],
  ["coin_decimals", 8],
  ["pc_decimals", 8],
  ["state", 8],
  ["reset_flag", 8],
  ["min_size", 8],
  ["vol_max_cut_ratio", 8],
  ["amount_wave", 8],
  ["coin_lot_size", 8],
  ["pc_lot_size", 8],
  ["min_price_multiplier", 8],
  ["max_price_multiplier", 8],
  ["sys_decimal_value", 8],
  ["fees (Pack::LEN)", 64],
  ["state_data", 144],
  ["coin_vault", 32],
  ["pc_vault", 32],
  ["coin_vault_mint", 32],
  ["pc_vault_mint", 32],
  ["lp_mint", 32],
  ["open_orders", 32],
  ["market", 32],
  ["market_program", 32],
  ["target_orders", 32],
  ["padding1 [u64;8]", 64],
  ["amm_owner", 32],
  ["lp_amount", 8],
  ["client_order_id", 8],
  ["recent_epoch", 8],
  ["padding2", 8],
];

function computedOffsets(): Map<string, number> {
  const offsets = new Map<string, number>();
  let at = 0;
  for (const [name, size] of AMM_INFO_PACKED_FIELDS) {
    offsets.set(name, at);
    at += size;
  }
  offsets.set("<end>", at);
  return offsets;
}

describe("Raydium V4 AmmInfo layout — authoritative offset verification", () => {
  test("the independently recomputed pc_vault_mint offset is exactly 432", () => {
    const offsets = computedOffsets();
    assert.equal(offsets.get("pc_vault_mint"), 432);
  });

  test("the packed struct total is exactly the canonical 752-byte account size", () => {
    const offsets = computedOffsets();
    assert.equal(offsets.get("<end>"), RAYDIUM_V4_AMM_INFO_SIZE);
    assert.equal(RAYDIUM_V4_AMM_INFO_SIZE, 752);
  });

  test("the filter constant equals the recomputed offset (never the unverified proposal by assumption)", () => {
    assert.equal(RAYDIUM_V4_PC_MINT_OFFSET, computedOffsets().get("pc_vault_mint"));
    assert.equal(RAYDIUM_V4_PC_MINT_OFFSET, 432);
  });

  test("the SDK parser reads pc_mint (quoteMint) at the SAME offset in the identity slice", () => {
    // The discovery identity slice starts at 336; pc_mint's slice-
    // relative offset is 432 - 336 = 96. Parse a synthetic slice and
    // confirm quoteMint IS the bytes at [96, 128).
    const data = buildAmmInfoSlice();
    const parsed = parseV4AmmInfoSlice(synth(0x77), data);
    assert.deepEqual(parsed.quoteMint.toBytes(), FIXTURE_WSOL.toBytes());
    assert.deepEqual(data.slice(96, 128), FIXTURE_WSOL.toBytes());
    assert.equal(DISCOVERY_SLICE.offset, 336);
    assert.equal(RAYDIUM_V4_PC_MINT_OFFSET - DISCOVERY_SLICE.offset, 96);
  });

  test("a full 752-byte AmmInfo payload carries WSOL exactly at [432, 464)", () => {
    const data = buildAmmInfo();
    assert.deepEqual(data.slice(432, 464), FIXTURE_WSOL.toBytes());
    const coinSide = data.slice(400, 432);
    assert.notDeepEqual(coinSide, FIXTURE_WSOL.toBytes());
  });
});

// ─── Filter wire shape + matching behavior ──────────────────────────────────

describe("M1 WSOL quote-side RPC memcmp filter", () => {
  test("the serialized WSOL bytes are the 32-byte decoded canonical mint, base58 round-trip exact", () => {
    assert.equal(WSOL_MINT_BYTES.length, 32);
    assert.deepEqual(WSOL_MINT_BYTES, WSOL_MINT.toBytes());
    assert.equal(WSOL_MEMCMP_BYTES, bs58.encode(WSOL_MINT_BYTES));
    assert.deepEqual(bs58.decode(WSOL_MEMCMP_BYTES), WSOL_MINT.toBytes());
    // The canonical single WSOL definition — re-encoded from bytes, not copied from the string.
    assert.equal(bs58.encode(WSOL_MINT_BYTES), "So11111111111111111111111111111111111111112");
  });

  test("the filter is exactly one memcmp at offset 432 over the serialized WSOL bytes", () => {
    const filter = buildM1WsolQuoteSideRpcFilter();
    assert.equal(filter.length, 1);
    assert.deepEqual(filter, [{ memcmp: { offset: 432, bytes: WSOL_MEMCMP_BYTES } }]);
  });

  test("an account with WSOL in pc_mint matches the filter bytes", () => {
    const data = buildAmmInfo(); // quoteMint = WSOL by default
    const atOffset = data.slice(RAYDIUM_V4_PC_MINT_OFFSET, RAYDIUM_V4_PC_MINT_OFFSET + 32);
    assert.deepEqual(atOffset, WSOL_MINT_BYTES);
    assert.equal(mintMatchesM1WsolQuoteSideFilter(WSOL_MINT), true);
  });

  test("an account with a non-WSOL pc_mint does NOT match the filter bytes", () => {
    const data = buildAmmInfo({ quoteMint: MEMECOIN });
    const atOffset = data.slice(RAYDIUM_V4_PC_MINT_OFFSET, RAYDIUM_V4_PC_MINT_OFFSET + 32);
    assert.notDeepEqual(atOffset, WSOL_MINT_BYTES);
    assert.equal(mintMatchesM1WsolQuoteSideFilter(MEMECOIN), false);
  });

  test("a WSOL-on-coin_mint account (base-side WSOL) does NOT match either — the offset discriminates the side", () => {
    const data = buildAmmInfo({ baseMint: FIXTURE_WSOL, quoteMint: MEMECOIN });
    assert.notDeepEqual(data.slice(RAYDIUM_V4_PC_MINT_OFFSET, RAYDIUM_V4_PC_MINT_OFFSET + 32), WSOL_MINT_BYTES);
    assert.deepEqual(data.slice(400, 432), WSOL_MINT_BYTES); // WSOL sits at coin_mint @400 instead
  });
});

// ─── Discovery plumbing ──────────────────────────────────────────────────────

interface CapturedRequest {
  body: {
    method: string;
    params: [string, { filters: Array<Record<string, unknown>>; dataSlice?: { offset: number; length: number } }];
  };
}

/** Fetch seam: captures the JSON-RPC body, optionally simulates the
 *  SERVER-SIDE application of the filters (dataSize + memcmp over the
 *  full 752-byte payloads) and returns the identity slices of the
 *  surviving accounts. This is how the tests prove the filter is applied
 *  BY THE RPC (it shapes the response), not merely post-fetched. */
function capturingGpaFetch(allAccounts: Array<{ pubkey: string; data: Uint8Array }>, opts?: { simulateServerFilter?: boolean }): { fetch: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (_url: string | URL, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest["body"];
    requests.push({ body });
    let accounts = allAccounts;
    if (opts?.simulateServerFilter) {
      const { filters } = body.params[1];
      accounts = accounts.filter((a) =>
        filters.every((f) => {
          if ("dataSize" in f) return a.data.length === f.dataSize;
          if ("memcmp" in f) {
            const bytes = bs58.decode(String((f.memcmp as { bytes: string }).bytes));
            const offset = Number((f.memcmp as { offset: number }).offset);
            return a.data.slice(offset, offset + bytes.length).every((b, i) => b === bytes[i]);
          }
          return true;
        }),
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: accounts.map((a) => ({
          pubkey: a.pubkey,
          account: { data: [Buffer.from(a.data.slice(336, 496)).toString("base64"), "base64"], owner: RAYDIUM_V4_PROGRAM_ID.toBase58() },
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function fakeConnection(rpcEndpoint: string): import("@solana/web3.js").Connection {
  return { rpcEndpoint, getSlot: async () => 1_000_000n } as unknown as import("@solana/web3.js").Connection;
}

function poolAccounts(n: number, quoteMint: PublicKey): Array<{ pubkey: string; data: Uint8Array }> {
  return Array.from({ length: n }, (_, i) => ({
    pubkey: synth(0x80 + i).toBase58(),
    data: buildAmmInfo({ quoteMint }),
  }));
}

describe("discoverRaydiumV4Pools — optional RPC filter plumbing", () => {
  test("with rpcFilters: the RPC request carries dataSize + the exact memcmp filter", async () => {
    const { fetch: fetchImpl, requests } = capturingGpaFetch(poolAccounts(2, FIXTURE_WSOL));
    const conn = fakeConnection("http://discovery.invalid");
    const runOpts: DiscoverOptions = {
      cluster: "mainnet-beta",
      rpcUrl: "http://discovery.invalid",
      rpcFilters: buildM1WsolQuoteSideRpcFilter(),
      fetchImpl,
    };
    const run = await discoverRaydiumV4Pools(conn, runOpts);
    assert.equal(requests.length, 1);
    const filters = requests[0]!.body.params[1].filters;
    assert.deepEqual(filters, [
      { dataSize: 752 },
      { memcmp: { offset: 432, bytes: WSOL_MEMCMP_BYTES } },
    ]);
    assert.equal(run.stats.rawAccounts, 2);
    assert.equal(run.stats.truncated, false);
    assert.equal(run.stats.iteratedAccounts, 2);
  });

  test("without rpcFilters: the request preserves the previous behavior (dataSize only)", async () => {
    const { fetch: fetchImpl, requests } = capturingGpaFetch(poolAccounts(2, MEMECOIN));
    const conn = fakeConnection("http://discovery.invalid");
    const run = await discoverRaydiumV4Pools(conn, {
      cluster: "mainnet-beta",
      rpcUrl: "http://discovery.invalid",
      fetchImpl,
    });
    const filters = requests[0]!.body.params[1].filters;
    assert.deepEqual(filters, [{ dataSize: 752 }]);
    assert.equal(run.stats.rawAccounts, 2);
  });

  test("the filter is applied BY THE RPC (server-side simulation): non-WSOL pc_mint accounts never come back", async () => {
    // 3 WSOL-quote pools + 3 non-WSOL-quote pools in the program corpus.
    const corpus = [...poolAccounts(3, FIXTURE_WSOL), ...poolAccounts(3, MEMECOIN)];
    const { fetch: fetchImpl, requests } = capturingGpaFetch(corpus, { simulateServerFilter: true });
    const conn = fakeConnection("http://discovery.invalid");
    const run = await discoverRaydiumV4Pools(conn, {
      cluster: "mainnet-beta",
      rpcUrl: "http://discovery.invalid",
      rpcFilters: buildM1WsolQuoteSideRpcFilter(),
      fetchImpl,
    });
    // The RESPONSE was already narrowed by the server: the local parse
    // loop never sees a non-WSOL pc_mint account.
    assert.equal(requests[0]!.body.params[1].filters.length, 2, "dataSize + memcmp were sent");
    assert.equal(run.stats.rawAccounts, 3, "the RPC returned only pc_mint-WSOL accounts");
    assert.equal(run.stats.parsedPools, 3);
    assert.ok(run.records.every((r) => r.pool.quoteMint.equals(FIXTURE_WSOL)));
    assert.ok(run.records.every((r) => r.pool.baseMint.toBase58() !== WSOL_MINT.toBase58()));
    assert.equal(run.stats.unsupportedPairs, 0);
  });

  test("completeness stats: a maxPools cap that stops iteration with accounts left over is reported, never swallowed", async () => {
    const { fetch: fetchImpl } = capturingGpaFetch(poolAccounts(5, FIXTURE_WSOL));
    const conn = fakeConnection("http://discovery.invalid");
    const run = await discoverRaydiumV4Pools(conn, {
      cluster: "mainnet-beta",
      rpcUrl: "http://discovery.invalid",
      maxPools: 2,
      rpcFilters: buildM1WsolQuoteSideRpcFilter(),
      fetchImpl,
    });
    assert.equal(run.stats.rawAccounts, 5);
    assert.equal(run.stats.iteratedAccounts, 2);
    assert.equal(run.stats.parsedPools, 2);
    assert.equal(run.stats.truncated, true, "truncation is explicitly reported");
  });

  test("completeness stats: full coverage of the filtered account set reports truncated=false", async () => {
    const { fetch: fetchImpl } = capturingGpaFetch(poolAccounts(5, FIXTURE_WSOL));
    const conn = fakeConnection("http://discovery.invalid");
    const run = await discoverRaydiumV4Pools(conn, {
      cluster: "mainnet-beta",
      rpcUrl: "http://discovery.invalid",
      maxPools: 10,
      rpcFilters: buildM1WsolQuoteSideRpcFilter(),
      fetchImpl,
    });
    assert.equal(run.stats.rawAccounts, 5);
    assert.equal(run.stats.iteratedAccounts, 5);
    assert.equal(run.stats.truncated, false);
  });
});
