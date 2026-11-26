// SPDX-License-Identifier: Apache-2.0
//
// Paginated discovery — provider-adapter for `getProgramAccountsV2`
// (Option 2, Part 2 item 2 / Part 3) behind an EXPLICIT capability gate.
//
// PROVIDER CONTRACT (Helius docs, https://www.helius.dev/docs/api-
// reference/rpc/http/getprogramaccountsv2 — verified 2026-11-26):
//
//   * `limit` 1..10,000 accounts per page; `paginationKey` is a base58
//     cursor to pass back verbatim for the next page.
//   * `withContext: true` nests `accounts`/`paginationKey` under
//     `result.value` and adds `result.context.{slot, apiVersion}`.
//   * END OF PAGINATION: "End of pagination is only indicated when no
//     accounts are returned... always continue pagination until
//     `paginationKey` is `null`." (The two sentences are jointly
//     ambiguous for a NONEMPTY page that returns a null cursor — this
//     module treats that case as an AMBIGUOUS end and reports the run
//     incomplete. Fail closed.)
//   * filters / dataSlice / commitment / minContextSlot are supported as
//     in classic gPA.
//
// WHAT THE DOCS DO **NOT** GUARANTEE (the production blocker, recorded in
// docs/OPTION2_FINDINGS.md):
//
//   * NO documented no-gap / no-duplicate guarantee across pages.
//   * NO documented consistent-snapshot semantics: an account CREATED
//     before the current cursor position during iteration has unknown
//     behavior (missed silently? returned? depends on implementation).
//   * NO documented cursor-stability guarantee under concurrent account
//     mutations between page requests.
//   * NO documented maximum page count / per-run budget.
//
// Therefore: a PAGE LEDGER proves which pages the CLIENT received — it
// does NOT prove the provider returned every matching account. Until a
// live probe against the configured provider establishes the missing
// guarantees, ANY paginated run is reported as a BOUNDED OBSERVATION
// WINDOW with explicit completeness status — never as a complete,
// atomic-snapshot enumeration. Classic unpaginated gPA remains available
// ONLY as a bounded, incompleteness-marked fallback (never silently
// swapped in for a corpus-scale run).

import { PublicKey } from "@solana/web3.js";
import { RAYDIUM_V4_AMM_INFO_SIZE, RAYDIUM_V4_PROGRAM_ID, identifyBaseToken, type V4PoolAccount } from "@graveyield/sdk";

import {
  DISCOVERY_SLICE,
  parseV4AmmInfoSlice,
  type DiscoveredPoolRecord,
} from "./discovery.js";
import { accountFingerprint, endpointKindFor, type Cluster, type EndpointKind } from "./provenance.js";
import { governed, rpcJsonRequest, type RpcTransportOptions } from "./rpcTransport.js";

/** The paginated RPC method this adapter speaks. */
export const GPA_V2_METHOD = "getProgramAccountsV2";

/** Max documented page size (Helius: limit 1..10,000). */
export const GPA_V2_MAX_PAGE_LIMIT = 10_000;

/** One raw program-account entry (shared shape with discovery.ts). */
interface RawProgramAccount {
  pubkey: string;
  account: { data: [string, string]; owner?: string };
}

/** Normalized one-page result. */
export interface GpaV2Page {
  accounts: RawProgramAccount[];
  /** Next cursor (null when the provider signals pagination end). */
  paginationKey: string | null;
  /** `result.context.slot` when withContext was honored; null otherwise. */
  contextSlot: number | null;
}

/** One ledger entry per RECEIVED page (client-side receipt proof). */
export interface PageLedgerEntry {
  /** 0-based page index within this run. */
  pageIndex: number;
  /** Cursor SENT with this request (null = first page). */
  cursorSent: string | null;
  /** Accounts received on this page. */
  receivedCount: number;
  /** Approximate decoded-payload size of this page's account data (bytes). */
  approxBytes: number;
  /** Next cursor returned (null = provider-signaled end). */
  nextCursor: string | null;
  /** Provider context slot for this page (bounded-observation evidence). */
  contextSlot: number | null;
  latencyMs: number;
  /** HTTP/transport note recorded for the page ("" when clean). */
  note: string;
}

/** Why a paginated run is NOT provably complete (fail-closed taxonomy). */
export type PaginationCompletenessStatus =
  | /** every matching account was received and the provider signaled a clean end */
    "complete"
  | /** the operator work cap (--max-pools) stopped enumeration before a provider-signaled end */
    "operator-cap-reached"
  | /** the page budget was exhausted before a provider-signaled end */
    "page-budget-exhausted"
  | /** a nonempty page returned a null cursor — end semantics ambiguous */
    "ambiguous-pagination-end"
  | /** an empty page returned a NON-null cursor — contract violation */
    "empty-page-with-cursor"
  | /** retry exhaustion / deadline / transport failure mid-enumeration */
    "enumeration-failed"
  | /** provider supports pagination but the no-gap/no-duplicate/snapshot guarantees are unverified */
    "provider-guarantees-unverified";

export interface PaginationCompleteness {
  status: PaginationCompletenessStatus;
  /** True ONLY for `complete`. */
  provablyComplete: boolean;
  /** Human-readable, operator-facing explanation (secret-free). */
  detail: string;
}

/** Explicit bounded-observation-window record (slot-consistency correction). */
export interface ObservationWindow {
  kind: "bounded-observation-window";
  /** NOT an atomic snapshot: pages may have been served at different slots. */
  commitment: "finalized";
  /** Lowest / highest provider context slot observed across pages. */
  slotMin: number | null;
  slotMax: number | null;
  pagesWithSlot: number;
  pagesWithoutSlot: number;
  providerEndpointKind: EndpointKind;
}

export interface PaginatedDiscoveryRun {
  records: DiscoveredPoolRecord[];
  stats: {
    rawAccounts: number;
    parsedPools: number;
    malformedSkipped: number;
    unsupportedPairs: number;
    duplicatesInBatch: number;
    /** Accounts seen MORE than once across pages (client-side detection). */
    duplicatesAcrossPages: number;
    pagesReceived: number;
    pageRequests: number;
    durationMs: number;
    iteratedAccounts: number;
    truncated: boolean;
    slotLowerBound: number | null;
    slotUpperBound: number | null;
  };
  /** Per-page receipt ledger (proof of what the CLIENT received). */
  ledger: PageLedgerEntry[];
  completeness: PaginationCompleteness;
  observationWindow: ObservationWindow;
}

export interface PaginatedDiscoveryOptions {
  cluster: Cluster;
  rpcUrl: string;
  /** Accounts per page (1..10,000; provider-documented bound). Default 5,000. */
  pageLimit?: number;
  /** Hard page budget — exhaustion is reported, never hidden. Default 200. */
  maxPages?: number;
  /** OPERATOR WORK CAP (Option 2 — ``--max-pools`` propagation). Bounds
   *  the number of PARSED pool records the run may ACCEPT — the SAME
   *  semantics as classic `DiscoverOptions.maxPools` (parsed-pool count,
   *  NOT raw accounts and NOT post-sourcing accepted pools). When the cap
   *  is full and any further matching account appears (on the current
   *  page or any later page), enumeration STOPS and the run is reported
   *  `operator-cap-reached` (incomplete): a work cap is not evidence of
   *  corpus completeness. Empty pages after the cap is full only
   *  determine whether the provider signals a clean end (they accept no
   *  pools, so they never exceed the cap). Undefined = unbounded. */
  maxPools?: number;
  /** Extra RPC-level filters (e.g. the M1 WSOL quote-side memcmp). */
  rpcFilters?: unknown[];
  /** Transport options (retry/backoff/deadline; injectable for tests). */
  transport?: RpcTransportOptions;
}

// ---------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------

export interface PaginationCapability {
  supported: boolean;
  /** Secret-free explanation (endpoint kind only, never the URL). */
  detail: string;
}

interface GpaV2RawResult {
  accounts?: unknown;
  paginationKey?: unknown;
  context?: { slot?: unknown };
  value?: { accounts?: unknown; paginationKey?: unknown; context?: { slot?: unknown } };
}

/** Normalize a gPA-V2 result (withContext true or false) into a GpaV2Page. */
export function normalizeGpaV2Result(result: unknown): GpaV2Page | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as GpaV2RawResult;
  const withContext = r.value !== undefined;
  const accountsRaw = withContext ? r.value?.accounts : r.accounts;
  const cursorRaw = withContext ? r.value?.paginationKey : r.paginationKey;
  const slotRaw = withContext ? r.value?.context?.slot ?? r.context?.slot : r.context?.slot;
  if (!Array.isArray(accountsRaw)) return null;
  if (cursorRaw !== null && typeof cursorRaw !== "string") return null;
  const accounts: RawProgramAccount[] = [];
  for (const a of accountsRaw) {
    if (a === null || typeof a !== "object") return null;
    const entry = a as { pubkey?: unknown; account?: { data?: unknown } };
    if (typeof entry.pubkey !== "string") return null;
    const data = (entry.account as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data) || data.length !== 2 || typeof data[0] !== "string" || typeof data[1] !== "string") {
      return null;
    }
    accounts.push({ pubkey: entry.pubkey, account: { data: [data[0]!, data[1]!] } });
  }
  return {
    accounts,
    paginationKey: cursorRaw as string | null,
    contextSlot: typeof slotRaw === "number" && Number.isSafeInteger(slotRaw) ? slotRaw : null,
  };
}

/**
 * Probe whether the configured endpoint speaks `getProgramAccountsV2`
 * with pagination semantics. A probe issues a minimal (limit 1) V2
 * request with the mandatory dataSize filter and validates the response
 * shape. Never throws for capability absence — returns a typed verdict.
 */
export async function probePaginationCapability(
  rpcUrl: string,
  programId: PublicKey,
  opts?: { rpcFilters?: unknown[]; transport?: RpcTransportOptions },
): Promise<PaginationCapability> {
  const kind = endpointKindFor(rpcUrl);
  let raw: unknown;
  try {
    raw = await governed(kind, () =>
      rpcJsonRequest(
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: GPA_V2_METHOD,
          params: [
            programId.toBase58(),
            {
              encoding: "base64",
              filters: [{ dataSize: RAYDIUM_V4_AMM_INFO_SIZE }, ...(opts?.rpcFilters ?? [])],
              limit: 1,
              withContext: true,
            },
          ],
        },
        { ...opts?.transport, retryJsonRpcErrors: true },
      ),
    );
  } catch (err) {
    return {
      supported: false,
      detail: `${GPA_V2_METHOD} probe failed on ${kind} endpoint: ${String((err as Error).message ?? err).slice(0, 160)}`,
    };
  }
  if (raw === null || typeof raw !== "object") {
    return { supported: false, detail: `${GPA_V2_METHOD} probe returned a non-object body on ${kind} endpoint` };
  }
  const envelope = raw as { error?: unknown; result?: unknown };
  if (envelope.error !== undefined && envelope.error !== null) {
    return {
      supported: false,
      detail: `${GPA_V2_METHOD} not usable on ${kind} endpoint — RPC error: ${JSON.stringify(envelope.error).slice(0, 160)}`,
    };
  }
  const page = normalizeGpaV2Result(envelope.result);
  if (page === null) {
    return {
      supported: false,
      detail: `${GPA_V2_METHOD} probe result shape unrecognized on ${kind} endpoint (accounts array or paginationKey missing)`,
    };
  }
  return {
    supported: true,
    detail: `${GPA_V2_METHOD} available on ${kind} endpoint (probe page: ${page.accounts.length} account(s), cursor ${page.paginationKey === null ? "null" : "present"}, context slot ${page.contextSlot ?? "absent"})`,
  };
}

// ---------------------------------------------------------------------
// Paginated enumeration
// ---------------------------------------------------------------------

/** Fetch ONE page. Throws typed transport errors (caller classifies).
 *  Rate-governed: pages share the process-global provider budget with
 *  enrichment and activity traffic (Option 2 — consistent governance). */
async function fetchGpaV2Page(
  rpcUrl: string,
  programId: PublicKey,
  cursor: string | null,
  opts: PaginatedDiscoveryOptions,
  pageLimit: number,
): Promise<GpaV2Page> {
  const raw = await governed(endpointKindFor(rpcUrl), () =>
    rpcJsonRequest(
      rpcUrl,
      {
        jsonrpc: "2.0",
        id: 1,
        method: GPA_V2_METHOD,
        params: [
          programId.toBase58(),
          {
            encoding: "base64",
            filters: [{ dataSize: RAYDIUM_V4_AMM_INFO_SIZE }, ...(opts.rpcFilters ?? [])],
            dataSlice: { offset: DISCOVERY_SLICE.offset, length: DISCOVERY_SLICE.length },
            limit: pageLimit,
            commitment: "finalized",
            withContext: true,
            ...(cursor !== null ? { paginationKey: cursor } : {}),
          },
        ],
      },
      // In-band JSON-RPC errors (HTTP 200 + error object) are classified
      // and retried within the same bounded budget as HTTP-level failures.
      { ...opts.transport, retryJsonRpcErrors: true },
    ),
  );
  const envelope = raw as { error?: unknown; result?: unknown } | null;
  if (envelope === null || typeof envelope !== "object") {
    throw new Error(`${GPA_V2_METHOD} returned a non-object body`);
  }
  if (envelope.error !== undefined && envelope.error !== null) {
    throw new Error(`${GPA_V2_METHOD} RPC error: ${JSON.stringify(envelope.error).slice(0, 200)}`);
  }
  const page = normalizeGpaV2Result(envelope.result);
  if (page === null) {
    throw new Error(`${GPA_V2_METHOD} page shape unrecognized (accounts array or paginationKey missing)`);
  }
  return page;
}

/** Parse one raw account exactly like discovery.ts (identity slice). */
function parseSliceAccount(
  poolAddress: PublicKey,
  data: Uint8Array,
): V4PoolAccount | null {
  try {
    return parseV4AmmInfoSlice(poolAddress, data);
  } catch {
    return null;
  }
}

/**
 * Slot bracket (classic-parity provenance): a getSlot taken immediately
 * BEFORE the first page request and one taken immediately AFTER the last
 * one — the SAME bounded-bracket semantics as the classic path's
 * `slotLowerBound`/`slotUpperBound`. These are DISTINCT from the
 * per-page observation-window min/max (`observationWindow.slotMin/Max`):
 * a bracket is a wall-clock slot reading around the WHOLE run, the
 * window is the range of provider CONTEXT slots across pages. The two
 * concepts are never mapped onto each other. Rate-governed like pages.
 * Returns null only for the CLOSING bracket when the closing getSlot
 * fails or is malformed (recorded honestly as unavailable); the OPENING
 * bracket is mandatory — without it the run has no provenance anchor and
 * throws, exactly like the classic path's getSlot would.
 */
async function rpcSlotBracket(rpcUrl: string, transport: RpcTransportOptions | undefined): Promise<number | null> {
  const json = await governed(endpointKindFor(rpcUrl), () =>
    rpcJsonRequest(
      rpcUrl,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getSlot",
        params: [{ commitment: "confirmed" }],
      },
      { ...transport, retryJsonRpcErrors: true },
    ),
  );
  const result = (json as { result?: unknown } | null)?.result;
  return typeof result === "number" && Number.isSafeInteger(result) ? result : null;
}

/**
 * Enumerate Raydium V4 AmmInfo accounts via paginated `getProgramAccountsV2`.
 *
 * CALLERS MUST FIRST PROBE CAPABILITY (`probePaginationCapability`) and
 * route through a mode gate: this function NEVER silently falls back to
 * classic gPA and NEVER claims a complete, atomic-snapshot enumeration
 * unless every completeness condition below is satisfied:
 *
 *   1. the provider signaled a clean end (empty page with null cursor);
 *   2. the page budget was not exhausted;
 *   3. no mid-enumeration transport failure;
 *   4. no client-observed duplicate or contract-violating page;
 *   5. (ALWAYS) the provider's no-gap / no-duplicate / snapshot
 *      guarantees remain documented+verified — until then a run is at
 *      best `provider-guarantees-unverified` (bounded observation).
 */
export async function discoverRaydiumV4PoolsPaginated(
  opts: PaginatedDiscoveryOptions,
): Promise<PaginatedDiscoveryRun> {
  const startedAt = Date.now();
  const endpointKind = endpointKindFor(opts.rpcUrl);
  const pageLimit = opts.pageLimit ?? 5_000;
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > GPA_V2_MAX_PAGE_LIMIT) {
    throw new Error(`pageLimit must be in 1..${GPA_V2_MAX_PAGE_LIMIT}, got ${pageLimit}`);
  }
  const maxPages = opts.maxPages ?? 200;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`maxPages must be a positive integer, got ${maxPages}`);
  }
  if (opts.maxPools !== undefined && (!Number.isInteger(opts.maxPools) || opts.maxPools < 1)) {
    throw new Error(`maxPools must be a positive integer, got ${opts.maxPools}`);
  }
  const maxPools = opts.maxPools;

  // Classic-parity slot bracket around the WHOLE enumeration (distinct
  // from the per-page observation window). The opening bracket is
  // mandatory: without it the run has no provenance anchor — same
  // contract as the classic path, whose opening getSlot failure aborts
  // the run.
  const slotLowerBound = await rpcSlotBracket(opts.rpcUrl, opts.transport);
  if (slotLowerBound === null) {
    throw new Error(
      `paginated discovery could not take its OPENING slot bracket (getSlot) on the ${endpointKind} endpoint — run aborted (classic parity: an opening getSlot failure aborts the run)`,
    );
  }

  const ledger: PageLedgerEntry[] = [];
  const records = new Map<string, DiscoveredPoolRecord>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pageRequests = 0;
  let duplicatesAcrossPages = 0;
  let slotMin: number | null = null;
  let slotMax: number | null = null;
  let pagesWithSlot = 0;
  let pagesWithoutSlot = 0;
  let rawAccounts = 0;
  let iteratedAccounts = 0;
  let parsedPools = 0;
  let malformedSkipped = 0;
  let unsupportedPairs = 0;
  let completeness: PaginationCompleteness | null = null;

  enumeration: for (;;) {
    if (pageRequests >= maxPages) {
      completeness = {
        status: "page-budget-exhausted",
        provablyComplete: false,
        detail:
          `page budget (${maxPages}) exhausted after ${pageRequests} page request(s) and ` +
          `${rawAccounts} raw account(s) with the provider NOT yet signaling pagination end — ` +
          `the (filtered) account set is NOT fully enumerated; raise the budget only with measured page sizes`,
      };
      break enumeration;
    }

    // Work cap at a page boundary: NO pre-fetch break. When the cap is
    // full, further page requests are issued ONLY to determine whether
    // the provider signals a clean end — the boundary probe must not
    // mistake non-contributing traffic (duplicates, malformed records,
    // invalid addresses — none of which can add a parsed pool) for a
    // genuine cap overflow. The first account that would ACTUALLY add a
    // new parsed pool beyond the cap trips the in-loop cap check below →
    // `operator-cap-reached` (fail closed: unaccepted matching pools
    // exist). An empty page never exceeds the cap (classic parity: a cap
    // landing exactly on the last accepted pool is NOT a truncation). The
    // page budget still bounds this probing exactly like enumeration.

    const pageStart = Date.now();
    let page: GpaV2Page;
    try {
      pageRequests++;
      page = await fetchGpaV2Page(opts.rpcUrl, RAYDIUM_V4_PROGRAM_ID, cursor, opts, pageLimit);
    } catch (err) {
      ledger.push({
        pageIndex: ledger.length,
        cursorSent: cursor,
        receivedCount: 0,
        approxBytes: 0,
        nextCursor: null,
        contextSlot: null,
        latencyMs: Date.now() - pageStart,
        note: `FAILED: ${String((err as Error).message ?? err).slice(0, 160)}`,
      });
      completeness = {
        status: "enumeration-failed",
        provablyComplete: false,
        detail:
          `page ${ledger.length} (cursor ${cursor === null ? "<first>" : "…"}) failed: ` +
          `${String((err as Error).message ?? err).slice(0, 160)} — enumeration is INCOMPLETE; ` +
          `never treat a partial paginated run as a full corpus`,
      };
      break enumeration;
    }

    const approxBytes = page.accounts.reduce((n, a) => n + Buffer.from(a.account.data[0]!, "base64").length + a.pubkey.length, 0);
    ledger.push({
      pageIndex: ledger.length,
      cursorSent: cursor,
      receivedCount: page.accounts.length,
      approxBytes,
      nextCursor: page.paginationKey,
      contextSlot: page.contextSlot,
      latencyMs: Date.now() - pageStart,
      note: "",
    });

    if (page.contextSlot !== null) {
      pagesWithSlot++;
      slotMin = slotMin === null ? page.contextSlot : Math.min(slotMin, page.contextSlot);
      slotMax = slotMax === null ? page.contextSlot : Math.max(slotMax, page.contextSlot);
    } else {
      pagesWithoutSlot++;
    }

    for (const raw of page.accounts) {
      rawAccounts++;
      iteratedAccounts++;
      if (seen.has(raw.pubkey)) {
        duplicatesAcrossPages++;
        continue; // client-side duplicate detection: counted, never re-parsed
      }
      seen.add(raw.pubkey);
      let poolAddress: PublicKey;
      try {
        poolAddress = new PublicKey(raw.pubkey);
      } catch {
        malformedSkipped++;
        continue;
      }
      const data = new Uint8Array(Buffer.from(raw.account.data[0]!, "base64"));
      if (data.length !== DISCOVERY_SLICE.length) {
        malformedSkipped++;
        continue;
      }
      const parsed = parseSliceAccount(poolAddress, data);
      if (parsed === null) {
        malformedSkipped++;
        continue;
      }
      // Work cap — checked ONLY after duplicate detection, address
      // validation and parsing have succeeded. The cap bounds PARSED
      // POOL RECORDS (--max-pools semantics), not raw accounts received:
      // a duplicate, malformed or invalid-address account can never add
      // a parsed pool, so it must never consume the cap and must never
      // trip "operator-cap-reached". The trip fires exactly when THIS
      // account is the first that would push the accepted parsed-pool
      // count beyond the configured limit — stop IMMEDIATELY, before
      // accepting it, and report the run incomplete (fail closed).
      if (maxPools !== undefined && parsedPools >= maxPools) {
        completeness = {
          status: "operator-cap-reached",
          provablyComplete: false,
          detail:
            `the operator work cap (--max-pools ${maxPools}) stopped enumeration after ${parsedPools} parsed pool(s) ` +
            `and ${iteratedAccounts} of ${rawAccounts} raw account(s) — the account just examined on page ` +
            `${ledger.length - 1} parses as a NEW pool beyond the cap and was NOT accepted; ` +
            `${rawAccounts - iteratedAccounts} account(s) on that page and any later page(s) were never examined; ` +
            `the (filtered) account set is NOT fully enumerated: ` +
            `a work cap is not evidence of corpus completeness`,
        };
        break enumeration;
      }
      let wsolSide: DiscoveredPoolRecord["wsolSide"] = null;
      try {
        wsolSide = identifyBaseToken(parsed);
      } catch {
        unsupportedPairs++;
        // 7019-guard failure: record stays in the ledger, excluded from the funnel.
      }
      records.set(raw.pubkey, {
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
          mode: "identity-slice",
          dataLen: data.length,
          fingerprint: accountFingerprint(poolAddress, data),
          owner: RAYDIUM_V4_PROGRAM_ID.toBase58(),
        },
        // The provenance SOURCE stays the canonical "raydium-v4-gpa": the
        // data IS Raydium V4 gPA output; the paginated transport is recorded
        // separately (stats.pagesReceived / ledger / completeness), keeping
        // the DiscoveredPoolRecord type (and every downstream consumer)
        // byte-identical to the classic path.
        provenance: {
          source: "raydium-v4-gpa",
          cluster: opts.cluster,
          endpointKind,
          // Genuine classic-parity slot BRACKETS around the whole run —
          // NOT the observation-window min/max (never mapped across).
          slotLowerBound: slotLowerBound,
          slotUpperBound: 0, // filled from the closing bracket below
          fetchedAtUnixMs: startedAt,
        },
      });
      parsedPools++;
    }

    // End-of-enumeration semantics (fail-closed interpretation of the
    // documented contract):
    if (page.accounts.length === 0) {
      if (page.paginationKey === null) {
        completeness = {
          status: "complete",
          provablyComplete: true,
          detail:
            `provider signaled pagination end (empty page, null cursor) after ${pageRequests} page request(s), ` +
            `${rawAccounts} raw account(s), ${duplicatesAcrossPages} duplicate(s). CLIENT-side enumeration is ` +
            `complete; provider no-gap/no-duplicate/snapshot guarantees remain UNVERIFIED — the run is a ` +
            `bounded observation window, not a proven atomic snapshot`,
        };
      } else {
        completeness = {
          status: "empty-page-with-cursor",
          provablyComplete: false,
          detail:
            `contract violation: an empty page returned a NON-null cursor — the provider's end-of-` +
            `enumeration semantics could not be established; fail closed`,
        };
      }
      break enumeration;
    }
    if (page.paginationKey === null) {
      // Nonempty page with null cursor: the documented pattern implies
      // end, but the documented sentence says end is "only indicated
      // when no accounts are returned" — ambiguous. Fail closed.
      completeness = {
        status: "ambiguous-pagination-end",
        provablyComplete: false,
        detail:
          `a NONEMPTY page (index ${ledger.length - 1}, ${page.accounts.length} account(s)) returned a null ` +
          `paginationKey — documented end-of-enumeration semantics are ambiguous for this case; ` +
          `fail closed instead of guessing completeness`,
      };
      break enumeration;
    }
    cursor = page.paginationKey;
  }

  // Closing slot bracket (classic parity). Failure here is recorded
  // honestly (null → "unavailable") rather than discarding the received
  // pages; consumers see 0 = unavailable (the established convention).
  const slotUpperBound = await rpcSlotBracket(opts.rpcUrl, opts.transport).catch(
    () => null,
  );
  if (slotUpperBound !== null) {
    for (const record of records.values()) {
      record.provenance.slotUpperBound = slotUpperBound;
    }
  }

  const durationMs = Date.now() - startedAt;
  if (completeness === null) {
    // Unreachable in the current loop structure; defensive.
    completeness = {
      status: "enumeration-failed",
      provablyComplete: false,
      detail: "enumeration ended without a completeness verdict (defensive) — fail closed",
    };
  }
  const finalStatus: PaginationCompletenessStatus =
    completeness.status === "complete" ? "provider-guarantees-unverified" : completeness.status;
  const final: PaginationCompleteness =
    completeness.status === "complete"
      ? {
          status: finalStatus,
          provablyComplete: false,
          detail:
            `${completeness.detail}. The page ledger proves which pages the CLIENT received — it does NOT ` +
            `prove the provider returned every matching account. A live probe establishing no-gap, ` +
            `no-duplicate and cursor-stability-under-mutation guarantees is required before ANY run may ` +
            `be presented as a complete production enumeration`,
        }
      : completeness;

  const ordered = [...records.values()].sort((a, b) =>
    a.poolAddress.toBase58().localeCompare(b.poolAddress.toBase58()),
  );

  return {
    records: ordered,
    stats: {
      rawAccounts,
      parsedPools,
      malformedSkipped,
      unsupportedPairs,
      duplicatesInBatch: duplicatesAcrossPages,
      duplicatesAcrossPages,
      pagesReceived: ledger.filter((e) => e.note === "").length,
      pageRequests,
      durationMs,
      iteratedAccounts,
      truncated: !final.provablyComplete,
      // Classic-parity BRACKETS (getSlot before/after the run) — kept
      // semantically DISTINCT from the observation-window min/max below.
      slotLowerBound,
      slotUpperBound,
    },
    ledger,
    completeness: final,
    observationWindow: {
      kind: "bounded-observation-window",
      commitment: "finalized",
      slotMin,
      slotMax,
      pagesWithSlot,
      pagesWithoutSlot,
      providerEndpointKind: endpointKind,
    },
  };
}

/**
 * Mode gate resolution (env-driven; default "classic" — behavior-
 * preserving). Exposed for the CLI and tests.
 */
export type PaginationMode = "classic" | "paginated-strict" | "paginated-bounded-fallback";

export function resolvePaginationMode(env?: string): PaginationMode {
  const raw = (env ?? process.env.DISCOVERY_PAGINATION_MODE ?? "classic").trim().toLowerCase();
  if (raw === "classic" || raw === "" || raw === undefined) return "classic";
  if (raw === "paginated-strict") return "paginated-strict";
  if (raw === "paginated-bounded-fallback") return "paginated-bounded-fallback";
  throw new Error(
    `DISCOVERY_PAGINATION_MODE must be "classic", "paginated-strict" or "paginated-bounded-fallback", got ${JSON.stringify(raw)}`,
  );
}
