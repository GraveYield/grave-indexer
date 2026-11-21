// SPDX-License-Identifier: Apache-2.0
//
// RPC-level M1 WSOL quote-side sourcing filter — the discovery-side
// enforcement of the M1 sourcing restriction AT THE RPC BOUNDARY, for
// the `console-snapshot` command (GY-M1-INT-001 §6).
//
// WHY: `discoverRaydiumV4Pools()` enumerates the Raydium V4 program with
// a `dataSize` filter and applies `maxPools` during LOCAL iteration. A
// local cap does not reduce the size of the RPC response — the mainnet
// corpus is ~700k AmmInfo accounts — so an unfiltered snapshot run
// transfers hundreds of megabytes only to truncate locally. This module
// builds the `getProgramAccounts` `memcmp` filter that pushes the D-01
// M1 quote-side predicate (pc_mint == canonical WSOL) into the RPC
// request itself, so only quote-side-WSOL pools ever cross the wire.
//
// VERIFIED ACCOUNT LAYOUT (do not edit without re-verifying):
//
//   Raydium V4 `AmmInfo` — authoritative source:
//   raydium-io/raydium-amm, `program/src/state.rs` (master), struct
//   `#[repr(C, packed)] AmmInfo`, verified field-by-field on
//   2026-11-21 against the master source AND the byte-locked vendored
//   SDK (`vendor/protocol/sdk/src/raydiumV4.ts`, OFF.PC_VAULT_MINT:
//   432, RAYDIUM_V4_AMM_INFO_SIZE: 752 — the same layout the on-chain
//   grave-scanner adapter asserts).
//
//   Offset math (packed struct, little-endian scalars):
//     status            u64   @   0
//     nonce             u64   @   8
//     order_num         u64   @  16
//     depth             u64   @  24
//     coin_decimals     u64   @  32
//     pc_decimals       u64   @  40
//     state             u64   @  48
//     reset_flag        u64   @  56
//     min_size          u64   @  64
//     vol_max_cut_ratio u64   @  72
//     amount_wave       u64   @  80
//     coin_lot_size     u64   @  88
//     pc_lot_size       u64   @  96
//     min_price_multiplier u64 @ 104
//     max_price_multiplier u64 @ 112
//     sys_decimal_value u64   @ 120
//     fees              Fees  @ 128 (Pack::LEN = 64) → ends at 192
//     state_data        StateData @ 192
//       (need_take_pnl_coin/pc, total_pnl_pc/coin, pool_open_time:
//        6 × u64 = 48 → 240; padding [u64; 2] → 256;
//        orderbook_to_init_time u64 → 264;
//        swap_coin_in/pc_out u128 → 304; swap_acc_pc_fee u64 → 312;
//        swap_pc_in/coin_out u128 → 352; swap_acc_coin_fee u64 → 360...
//        re-anchored below — the contiguous tail matters:)
//     → state_data is 144 bytes: 192 + 144 = 336
//     coin_vault        Pubkey @ 336
//     pc_vault          Pubkey @ 368
//     coin_vault_mint   Pubkey @ 400
//     pc_vault_mint     Pubkey @ 432   ← THE FILTER OFFSET
//     lp_mint           Pubkey @ 464
//     … open_orders/market/market_program/target_orders/padding1/
//       amm_owner/lp_amount/client_order_id/recent_epoch/padding2 → 752
//     (the upstream test `test_amm_info_layout` serializes exactly this
//     field order into a [u8; 752] buffer.)
//
//   `memcmp` compares the RAW 32-byte serialized Pubkey at the given
//   offset; the RPC filter's `bytes` field carries that comparison
//   value base58-encoded (Solana JSON-RPC getProgramAccounts filter
//   encoding). WSOL's canonical mint (`WSOL_MINT`, single definition
//   imported from @graveyield/sdk) base58-encodes to
//   "So11111111111111111111111111111111111111112"; the filter uses the
//   re-encoded form of the DECODED 32 bytes so the comparison is over
//   account bytes, never over the string form.
//
// SCOPE BOUNDARY: this is an M1 SOURCING restriction ONLY (GY-M1-SPEC-001
// §2.1, §7 item 2). It is NOT a settlement-orientation restriction and
// must not be tightened into the SDK's 7019 orientation guard or the
// salvage path: non-M1 discovery (no `rpcFilters`) keeps enumerating and
// ledgering BOTH single-WSOL orientations. The local D-01 predicate
// (`m1Sourcing.evaluateM1Sourcing`) remains authoritative and is
// re-asserted downstream — the RPC filter is an efficiency + defense-
// in-depth measure, never a replacement for the fail-closed gate.

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { WSOL_MINT } from "@graveyield/sdk";

/**
 * Raydium V4 AmmInfo `pc_vault_mint` byte offset — VERIFIED against the
 * authoritative `raydium-io/raydium-amm` `program/src/state.rs`
 * (`#[repr(C, packed)]`) and the vendored SDK's byte-locked layout
 * (`OFF.PC_VAULT_MINT = 432`). See the module header for the field-by-
 * field math. Not to be copied from proposals without re-verification.
 */
export const RAYDIUM_V4_PC_MINT_OFFSET = 432;

/** The canonical WSOL mint's serialized 32 bytes (the memcmp comparison value). */
export const WSOL_MINT_BYTES: Uint8Array = WSOL_MINT.toBytes();

/**
 * The memcmp comparison bytes in the encoding Solana RPC `memcmp.bytes`
 * expects: base58 of the raw 32-byte serialized mint pubkey.
 */
export const WSOL_MEMCMP_BYTES = bs58.encode(WSOL_MINT_BYTES);

/** A single `memcmp` getProgramAccounts filter object (RPC wire shape). */
export interface MemcmpFilter {
  memcmp: { offset: number; bytes: string };
}

/**
 * Build the RPC-level `memcmp` filter requiring
 * `Raydium V4 pc_mint == canonical WSOL mint`.
 *
 * Pure and deterministic. Compose with the mandatory `dataSize` filter
 * in `discoverRaydiumV4Pools({ rpcFilters })` — never send it standalone
 * (the dataSize filter pins the canonical 752-byte AmmInfo corpus).
 */
export function buildM1WsolQuoteSideRpcFilter(): [MemcmpFilter] {
  return [{ memcmp: { offset: RAYDIUM_V4_PC_MINT_OFFSET, bytes: WSOL_MEMCMP_BYTES } }];
}

/**
 * Defense-in-depth helper for callers that hold a parsed identity: does
 * this exact mint equal the canonical WSOL mint (i.e. would the RPC
 * memcmp filter have matched it)? Used by tests to pin the filter's
 * matching behavior against real serialized layouts.
 */
export function mintMatchesM1WsolQuoteSideFilter(mint: PublicKey): boolean {
  return mint.equals(WSOL_MINT);
}
