// SPDX-License-Identifier: Apache-2.0
//
// Shared test fixtures — deterministic AmmInfo payloads, synthetic
// pubkeys, and a fixed Ed25519 test signer (32-byte seed; public test
// material only — never a real key).

import { PublicKey } from "@solana/web3.js";
import { oracleSignerFromSeed, type OracleSigner } from "../src/sign.js";

export const AMM_INFO_SIZE = 752;
export const AMM_INFO_SLICE = { offset: 336, length: 160 } as const;

export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** Deterministic synthetic address from a seed byte. */
export function synth(seed: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(seed));
}

/**
 * Build a canonical 752-byte Raydium V4 AmmInfo payload with the given
 * identity fields at the SDK-pinned offsets. `quoteMint` defaults to
 * WSOL so the pool passes the 7019 guard with a synthetic base mint.
 */
export function buildAmmInfo(opts?: {
  baseMint?: PublicKey;
  quoteMint?: PublicKey;
  coinVault?: PublicKey;
  pcVault?: PublicKey;
  lpMint?: PublicKey;
}): Uint8Array {
  const data = new Uint8Array(AMM_INFO_SIZE);
  const view = new DataView(data.buffer);
  // status = 1 (initialized), state = 1 (V4 states: 1 = orderbook-like active)
  view.setBigUint64(0, 1n, true);
  const full = buildAmmIdentity(opts);
  data.set(full.coinVault, 336);
  data.set(full.pcVault, 368);
  data.set(full.baseMint, 400);
  data.set(full.quoteMint, 432);
  data.set(full.lpMint, 464);
  return data;
}

/** Identity fields at the dataSlice window (offset 336, length 160).
 *  Slice-relative offsets: vaults @0/32, mints @64/96, lp_mint @128. */
export function buildAmmInfoSlice(opts?: {
  baseMint?: PublicKey;
  quoteMint?: PublicKey;
  coinVault?: PublicKey;
  pcVault?: PublicKey;
  lpMint?: PublicKey;
}): Uint8Array {
  const data = new Uint8Array(160);
  const id = buildAmmIdentity(opts);
  data.set(id.coinVault, 0);
  data.set(id.pcVault, 32);
  data.set(id.baseMint, 64);
  data.set(id.quoteMint, 96);
  data.set(id.lpMint, 128);
  return data;
}

function buildAmmIdentity(opts?: {
  baseMint?: PublicKey;
  quoteMint?: PublicKey;
  coinVault?: PublicKey;
  pcVault?: PublicKey;
  lpMint?: PublicKey;
}): Record<string, Uint8Array> {
  return {
    coinVault: (opts?.coinVault ?? synth(0x11)).toBytes(),
    pcVault: (opts?.pcVault ?? synth(0x12)).toBytes(),
    baseMint: (opts?.baseMint ?? synth(0x13)).toBytes(),
    quoteMint: (opts?.quoteMint ?? WSOL_MINT).toBytes(),
    lpMint: (opts?.lpMint ?? synth(0x14)).toBytes(),
  };
}

/** The fixed TEST oracle signer — derived from a public constant seed. */
export async function testOracle(): Promise<OracleSigner> {
  const seed = new Uint8Array(32).fill(0x2a); // 42 — public test material
  return oracleSignerFromSeed(seed);
}
