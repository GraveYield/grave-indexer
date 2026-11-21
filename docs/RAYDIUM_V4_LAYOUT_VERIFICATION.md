# Raydium V4 `AmmInfo` layout verification record

GY-M1-INT-001 (correction §6 — reproducibility pinning). This document
records the exact upstream source used for the `pc_mint` offset
verification so any reviewer can re-verify it independently.

## Pinned upstream source

| Item | Value |
| --- | --- |
| Repository | `raydium-io/raydium-amm` |
| File | `program/src/state.rs` |
| Struct | `AmmInfo`, `#[repr(C, packed)]` |
| Pinned commit | `27f461dd439086c774055f771b253fb0fbc52008` |
| Commit date | 2026-07-23 ("Remove openbook dependency (#69)") |
| Selection rule | The most recent commit touching `program/src/state.rs` at verification time |
| Commit-specific URL | <https://github.com/raydium-io/raydium-amm/blob/27f461dd439086c774055f771b253fb0fbc52008/program/src/state.rs> |
| Verified on | 2026-11-21 |
| Upstream drift check | `git diff 27f461dd..HEAD -- program/src/state.rs` is empty (master HEAD `9c54069c6bd86d52cd6622705b98c274ee33ba4a` carries the identical layout) |

The layout constants live in `src/m1SourcingFilter.ts`
(`RAYDIUM_V4_LAYOUT_SOURCE_COMMIT`, `RAYDIUM_V4_LAYOUT_SOURCE_URL`,
`RAYDIUM_V4_PC_MINT_OFFSET`) and are pinned by
`test/m1SourcingFilter.test.ts`. Do not update the pinned commit merely
because upstream moved: any future mismatch must be re-verified
field-by-field and documented here first.

## Field-by-field packed layout (recomputed from the pinned source)

Little-endian scalars, `#[repr(C, packed)]` — no padding, offsets are
running sums of field sizes:

| Field | Type | Size | Offset |
| --- | --- | ---: | ---: |
| status | u64 | 8 | 0 |
| nonce | u64 | 8 | 8 |
| order_num | u64 | 8 | 16 |
| depth | u64 | 8 | 24 |
| coin_decimals | u64 | 8 | 32 |
| pc_decimals | u64 | 8 | 40 |
| state | u64 | 8 | 48 |
| reset_flag | u64 | 8 | 56 |
| min_size | u64 | 8 | 64 |
| vol_max_cut_ratio | u64 | 8 | 72 |
| amount_wave | u64 | 8 | 80 |
| coin_lot_size | u64 | 8 | 88 |
| pc_lot_size | u64 | 8 | 96 |
| min_price_multiplier | u64 | 8 | 104 |
| max_price_multiplier | u64 | 8 | 112 |
| sys_decimal_value | u64 | 8 | 120 |
| fees | Fees (8 × u64) | 64 | 128 |
| state_data | StateData (see below) | 144 | 192 |
| coin_vault | Pubkey | 32 | 336 |
| pc_vault | Pubkey | 32 | 368 |
| coin_vault_mint | Pubkey | 32 | 400 |
| **pc_vault_mint** | **Pubkey** | **32** | **432** ← THE FILTER OFFSET |
| lp_mint | Pubkey | 32 | 464 |
| open_orders | Pubkey | 32 | 496 |
| market | Pubkey | 32 | 528 |
| market_program | Pubkey | 32 | 560 |
| target_orders | Pubkey | 32 | 592 |
| padding1 | [u64; 8] | 64 | 624 |
| amm_owner | Pubkey | 32 | 688 |
| lp_amount | u64 | 8 | 720 |
| client_order_id | u64 | 8 | 728 |
| recent_epoch | u64 | 8 | 736 |
| padding2 | u64 | 8 | 744 |
| **total** | | **752** | |

`StateData` (144 bytes, from the pinned source): need_take_pnl_coin (8),
need_take_pnl_pc (8), total_pnl_pc (8), total_pnl_coin (8),
pool_open_time (8), padding [u64; 2] (16), orderbook_to_init_time (8),
swap_coin_in_amount u128 (16), swap_pc_out_amount u128 (16),
swap_acc_pc_fee (8), swap_pc_in_amount u128 (16),
swap_coin_out_amount u128 (16), swap_acc_coin_fee (8) = 144.

Upstream's own test (`test_amm_info_layout`, `program/src/state.rs` at
the pinned commit, line ~900) serializes exactly this field order into
a `[u8; 752]` buffer and asserts
`pool_data.len() == core::mem::size_of::<AmmInfo>()`.

## Vendored SDK cross-check

`vendor/protocol/sdk/src/raydiumV4.ts` (byte-locked, submodule-pinned):

* `OFF.PC_VAULT_MINT = 432` — identical offset
* `RAYDIUM_V4_AMM_INFO_SIZE = 752` — identical account size
* `parseV4AmmInfo` reads `quoteMint` at exactly `[432, 464)`
* `src/discovery.ts` slices `[336, 496)` and asserts slice-relative
  offsets (432 − 336 = 96)

The on-chain `grave-scanner` adapter (`vendor/protocol/programs/grave-scanner/src/adapters/raydium_v4.rs`)
asserts the same layout.

## WSOL byte encoding

* Canonical WSOL mint: `So11111111111111111111111111111111111111112`
  (single definition, `WSOL_MINT` from `@graveyield/sdk`).
* The `memcmp` filter compares the RAW 32-byte serialized Pubkey at
  offset 432. The RPC `memcmp.bytes` field carries that comparison
  value base58-encoded — re-encoded from the DECODED 32 bytes
  (`bs58.encode(WSOL_MINT.toBytes())`), so the comparison is over
  account bytes, never over the string form. Pinned by
  `test/m1SourcingFilter.test.ts` (base58 round-trip exactness).

## Why the old proposal's offset needed this record

The pre-implementation proposal cited offset 432 without a reproducible
source. This record pins the exact upstream commit, reproduces the
offset field-by-field from that commit's source, and cross-checks it
against the vendored SDK — any future reviewer can repeat all three
steps from this document alone.
