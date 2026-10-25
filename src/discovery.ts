// SPDX-License-Identifier: Apache-2.0
//
// Raydium V4 pool discovery — Phase 2's first stage, hardened for
// reproducibility and provenance (the monorepo's indexer/sources/raydiumV4.ts
// enumerates pools but pins fetchedAtSlot = 0; this module closes that gap).
//
// Properties:
//
//   * POOL IDENTITY — every record carries the full identity tuple the
//     on-chain adapters key off: amm program, pool address, base/quote
//     mints, LP mint, coin/pc vaults, and the WSOL-side classification
//     (the 7019 guard, recorded — not thrown — so unsupported pairs stay
//     visible in the ledger while excluded from the salvage funnel).
//   * PROVENANCE — slot bracketing (slot before + slot after the
//     getProgramAccounts call), wall-clock capture, endpoint kind, and a
//     sha256 fingerprint of the raw 752-byte account payload.
//   * REPRODUCIBILITY — records are emitted in ascending base58
//     pool-address order, so two runs over identical chain state produce
//     byte-identical ledgers.
//   * DUPLICATE INGESTION — the raw enumeration may legitimately contain
//     repeats (pagination/rate-limit retries); dedupe happens here first
//     by fingerprint so the ingest ledger downstream sees unique records.

import { Connection, PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_V4_PROGRAM_ID,
  RAYDIUM_V4_AMM_INFO_SIZE,
  parseV4AmmInfo,
  identifyBaseToken,
  type V4PoolAccount,
} from "@graveyield/sdk";
import {
  accountFingerprint,
  endpointKindFor,
  type Cluster,
  type EndpointKind,
  type Provenance,
} from "./provenance.js";

/**
 * AmmInfo identity window: the SDK pins coin_vault@336, pc_vault@368,
 * coin_mint@400, pc_mint@432, lp_mint@464 — a contiguous 160-byte span.
 * Mainnet enumeration uses a `dataSlice` over this window (a full gPA
 * response exceeds Node's max string size); the slice-relative offsets
 * are the SDK offsets minus 336.
 */
const SLICE_OFFSET = 336;
const SLICE_LENGTH = 160;
const SLICE_OFF = { COIN_VAULT: 0, PC_VAULT: 32, COIN_VAULT_MINT: 64, PC_VAULT_MINT: 96, LP_MINT: 128 } as const;

/** Parse the identity fields from a 160-byte AmmInfo data slice. */
export function parseV4AmmInfoSlice(poolAddress: PublicKey, data: Uint8Array): V4PoolAccount {
  if (data.length !== SLICE_LENGTH) {
    throw new Error(
      `pool identity slice must be exactly ${SLICE_LENGTH} bytes (offset ${SLICE_OFFSET}, length ${SLICE_LENGTH}), got ${data.length}`,
    );
  }
  return {
    poolAddress,
    coinVault: new PublicKey(data.slice(SLICE_OFF.COIN_VAULT, SLICE_OFF.COIN_VAULT + 32)),
    pcVault: new PublicKey(data.slice(SLICE_OFF.PC_VAULT, SLICE_OFF.PC_VAULT + 32)),
    baseMint: new PublicKey(data.slice(SLICE_OFF.COIN_VAULT_MINT, SLICE_OFF.COIN_VAULT_MINT + 32)),
    quoteMint: new PublicKey(data.slice(SLICE_OFF.PC_VAULT_MINT, SLICE_OFF.PC_VAULT_MINT + 32)),
    lpMint: new PublicKey(data.slice(SLICE_OFF.LP_MINT, SLICE_OFF.LP_MINT + 32)),
  };
}

/** Full identity + provenance record for one discovered pool. */
export interface DiscoveredPoolRecord {
  poolAddress: PublicKey;
  /** AMM program owning the pool (Raydium V4 for v1). */
  ammProgramId: PublicKey;
  /** Canonical AmmInfo identity fields (mirrors the SDK's V4PoolAccount). */
  pool: {
    coinVault: PublicKey;
    pcVault: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    lpMint: PublicKey;
  };
  /** WSOL-side classification (7019 guard): null when the pair has zero or
   *  two WSOL sides and is therefore unsupported by the salvage funnel. */
  wsolSide: { memecoinMint: PublicKey; coinIsWsol: boolean } | null;
  /** Raw account facts. */
  raw: {
    /** "full" (752) or "identity-slice" (160 bytes @ offset 336). */
    mode: "full" | "identity-slice";
    dataLen: number;
    /** sha256 of (pool address bytes ‖ fetched payload bytes). */
    fingerprint: string;
    owner: string;
  };
  provenance: {
    source: "raydium-v4-gpa";
    cluster: Cluster;
    endpointKind: EndpointKind;
    /** Slot reported immediately BEFORE the enumeration call. */
    slotLowerBound: number;
    /** Slot reported immediately AFTER the enumeration call. */
    slotUpperBound: number;
    fetchedAtUnixMs: number;
  };
}

/** Statistics for one discovery run (feeds the health registry). */
export interface DiscoveryRunStats {
  rawAccounts: number;
  parsedPools: number;
  malformedSkipped: number;
  unsupportedPairs: number;
  duplicatesInBatch: number;
  slotLowerBound: number;
  slotUpperBound: number;
  durationMs: number;
}

export interface DiscoveryRun {
  records: DiscoveredPoolRecord[];
  stats: DiscoveryRunStats;
}

export interface DiscoverOptions {
  cluster: Cluster;
  rpcUrl: string;
  /** Cap the number of parsed pools (RPC politeness on mainnet). */
  maxPools?: number;
  /** "identity-slice" (default: mainnet-safe 160-byte dataSlice) or
   *  "full" (whole 752-byte payload; viable on devnet/small clusters). */
  mode?: "full" | "identity-slice";
  /** Injectable transport for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

interface RawProgramAccount {
  pubkey: string;
  account: { data: [string, string]; owner?: string };
}

/**
 * Raw JSON-RPC `getProgramAccounts` — bypasses the web3.js Connection
 * response decoder, which breaks on large enumeration responses (the
 * full mainnet corpus is ~706k × 752-byte accounts; even sliced to the
 * 160-byte identity window the response is ~300 MB and web3.js 3.x
 * throws `RangeError: Invalid array length` decoding it). Tolerates both
 * result shapes observed in the wild: a bare array and the classic
 * `{ context, value }` wrapper.
 */
export async function fetchProgramAccountsRaw(
  rpcEndpoint: string,
  programId: PublicKey,
  opts: { filters: unknown[]; dataSlice?: { offset: number; length: number }; fetchImpl?: typeof fetch },
): Promise<RawProgramAccount[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [
      programId.toBase58(),
      {
        encoding: "base64",
        filters: opts.filters,
        ...(opts.dataSlice !== undefined ? { dataSlice: opts.dataSlice } : {}),
      },
    ],
  };
  const res = await doFetch(rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`getProgramAccounts HTTP ${res.status} from ${endpointKindFor(rpcEndpoint)} endpoint`);
  }
  const json = (await res.json()) as {
    error?: unknown;
    result?: RawProgramAccount[] | { value?: RawProgramAccount[] };
  };
  if (json.error !== undefined && json.error !== null) {
    throw new Error(`getProgramAccounts RPC error: ${JSON.stringify(json.error).slice(0, 200)}`);
  }
  const value = Array.isArray(json.result) ? json.result : json.result?.value;
  if (!Array.isArray(value)) {
    throw new Error("unexpected getProgramAccounts response shape (no account array)");
  }
  return value;
}

/**
 * Enumerate Raydium V4 AmmInfo accounts (canonical 752-byte layout) via
 * `getProgramAccounts` with a dataSize filter, and produce provenance-
 * bearing, deterministically ordered pool records.
 */
export async function discoverRaydiumV4Pools(
  connection: Connection,
  opts: DiscoverOptions,
): Promise<DiscoveryRun> {
  const startedAt = Date.now();
  const endpointKind = endpointKindFor(opts.rpcUrl);
  const maxPools = opts.maxPools ?? Number.POSITIVE_INFINITY;
  const mode = opts.mode ?? "identity-slice";

  const slotLowerBound = Number(await connection.getSlot());

  const rawAccounts = await fetchProgramAccountsRaw(connection.rpcEndpoint, RAYDIUM_V4_PROGRAM_ID, {
    filters: [{ dataSize: RAYDIUM_V4_AMM_INFO_SIZE }],
    ...(mode === "identity-slice" ? { dataSlice: { offset: SLICE_OFFSET, length: SLICE_LENGTH } } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const slotUpperBound = Number(await connection.getSlot());

  const records = new Map<string, DiscoveredPoolRecord>();
  const stats: DiscoveryRunStats = {
    rawAccounts: rawAccounts.length,
    parsedPools: 0,
    malformedSkipped: 0,
    unsupportedPairs: 0,
    duplicatesInBatch: 0,
    slotLowerBound,
    slotUpperBound,
    durationMs: 0,
  };

  for (const raw of rawAccounts) {
    let poolAddress: PublicKey;
    try {
      poolAddress = new PublicKey(raw.pubkey);
    } catch {
      stats.malformedSkipped++;
      continue;
    }

    const data = new Uint8Array(Buffer.from(raw.account.data[0], "base64"));
    const expectedLen = mode === "identity-slice" ? SLICE_LENGTH : RAYDIUM_V4_AMM_INFO_SIZE;
    if (data.length !== expectedLen) {
      stats.malformedSkipped++;
      continue;
    }

    let parsed: V4PoolAccount;
    try {
      parsed = mode === "identity-slice"
        ? parseV4AmmInfoSlice(poolAddress, data)
        : parseV4AmmInfo(poolAddress, data);
    } catch {
      // Defensive: a corrupted (but correctly sized) account fails the parser.
      stats.malformedSkipped++;
      continue;
    }

    const key = poolAddress.toBase58();
    if (records.has(key)) {
      stats.duplicatesInBatch++;
      continue; // duplicate ingestion within one batch: keep the first
    }

    let wsolSide: DiscoveredPoolRecord["wsolSide"] = null;
    try {
      wsolSide = identifyBaseToken(parsed);
    } catch {
      stats.unsupportedPairs++;
      // 7019-guard failure: keep the record in the ledger, exclude from the funnel.
    }

    records.set(key, {
      poolAddress,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      pool: {
        coinVault: parsed.coinVault,
        pcVault: parsed.pcVault,
        baseMint: parsed.baseMint,
        quoteMint: parsed.quoteMint,
        lpMint: parsed.lpMint,
      },
      wsolSide,
      raw: {
        mode,
        dataLen: data.length,
        fingerprint: accountFingerprint(poolAddress, data),
        owner: RAYDIUM_V4_PROGRAM_ID.toBase58(),
      },
      provenance: {
        source: "raydium-v4-gpa",
        cluster: opts.cluster,
        endpointKind,
        slotLowerBound,
        slotUpperBound,
        fetchedAtUnixMs: startedAt,
      },
    });
    stats.parsedPools++;

    if (stats.parsedPools >= maxPools) break;
  }

  stats.durationMs = Date.now() - startedAt;

  // Deterministic order — ascending base58 pool address.
  const ordered = [...records.values()].sort((a, b) =>
    a.poolAddress.toBase58().localeCompare(b.poolAddress.toBase58()),
  );

  return { records: ordered, stats };
}

/** Provenance-shaped view of a discovery record (for ledgers/evidence). */
export function discoveryProvenance(record: DiscoveredPoolRecord): Provenance {
  return {
    source: record.provenance.source,
    cluster: record.provenance.cluster,
    endpointKind: record.provenance.endpointKind,
    slot: record.provenance.slotUpperBound,
    fetchedAtUnixMs: record.provenance.fetchedAtUnixMs,
    accountSha256: record.raw.fingerprint,
    owner: record.raw.owner,
  };
}

export const DISCOVERY_SLICE = { offset: SLICE_OFFSET, length: SLICE_LENGTH } as const;
