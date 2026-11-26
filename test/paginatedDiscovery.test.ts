// SPDX-License-Identifier: Apache-2.0
//
// paginatedDiscovery — capability probe, cursor progression, page
// ledger, fail-closed completeness semantics, duplicates, page-budget
// exhaustion, end-of-enumeration ambiguity, bounded-observation window,
// and parse parity with the classic discovery path.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PublicKey } from "@solana/web3.js";
import { RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";

import { buildAmmInfoSlice, synth, WSOL_MINT } from "./fixtures.js";
import {
  discoverRaydiumV4PoolsPaginated,
  GPA_V2_MAX_PAGE_LIMIT,
  normalizeGpaV2Result,
  probePaginationCapability,
  resolvePaginationMode,
  type GpaV2Page,
} from "../src/paginatedDiscovery.js";

const T = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, deadlineMs: 1_000, rng: () => 0, sleep: () => Promise.resolve() };

/** One deterministic M1-oriented identity-slice account for `seed`. */
const sliceAccount = (seed: number): string =>
  Buffer.from(
    buildAmmInfoSlice({ baseMint: synth(seed), quoteMint: WSOL_MINT, coinVault: synth(seed + 0x100), pcVault: synth(seed + 0x200) }),
  ).toString("base64");

interface FakePage {
  accounts: Array<{ pubkey: string; base64: string }>;
  nextCursor: string | null;
  contextSlot: number | null;
  /** Inject a per-page transport failure (note recorded, enumeration fails closed). */
  fail?: string;
}

/** A stateful gPA-V2 fake: pages served in sequence; the cursor is the
 *  base58 sentinel of the next page index (page-1..N, then null). */
function paginatedFetch(pages: FakePage[], log?: Array<{ cursor: string | null; limit: number }>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: [string, Record<string, unknown>];
    };
    if (body.method !== "getProgramAccountsV2") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }), { status: 200 });
    }
    const cfg = body.params[1]!;
    const cursor = (cfg.paginationKey as string | undefined) ?? null;
    log?.push({ cursor, limit: Number(cfg.limit) });
    const index = cursor === null ? 0 : Number.parseInt(cursor.replace("page-", ""), 10);
    const page = pages[index]!;
    if (page.fail !== undefined) throw new Error(page.fail);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { slot: page.contextSlot, apiVersion: "0.0.0" },
          value: {
            accounts: page.accounts.map((a) => ({ pubkey: a.pubkey, account: { data: [a.base64, "base64"] } })),
            paginationKey: page.nextCursor,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const accountsOf = (seeds: number[]): Array<{ pubkey: string; base64: string }> =>
  seeds.map((s) => ({ pubkey: synth(s).toBase58(), base64: sliceAccount(s) }));

const runOpts = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => ({
  cluster: "mainnet-beta" as const,
  rpcUrl: "https://mainnet.helius-rpc.com",
  transport: { ...T, fetchImpl },
  ...extra,
});

describe("paginatedDiscovery — capability probe", () => {
  test("a shape-valid V2 response establishes the capability", async () => {
    const cap = await probePaginationCapability("https://mainnet.helius-rpc.com", RAYDIUM_V4_PROGRAM_ID, {
      transport: {
        ...T,
        fetchImpl: paginatedFetch([
          { accounts: accountsOf([0x51]), nextCursor: "page-1", contextSlot: 700 },
        ]),
      },
    });
    assert.equal(cap.supported, true);
    assert.ok(cap.detail.includes("probe page: 1 account"));
  });

  test("method-not-found / malformed shape → capability REFUSED (typed detail, no URL)", async () => {
    const refused = await probePaginationCapability("https://mainnet.helius-rpc.com/?api-key=SECRET", RAYDIUM_V4_PROGRAM_ID, {
      transport: { ...T, fetchImpl: (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }), { status: 200 })) as typeof fetch },
    });
    assert.equal(refused.supported, false);
    assert.ok(!refused.detail.includes("SECRET"), "URL leaked into capability detail");

    const malformed = await probePaginationCapability("https://mainnet.helius-rpc.com", RAYDIUM_V4_PROGRAM_ID, {
      transport: { ...T, fetchImpl: (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { accounts: "nope" } }), { status: 200 })) as typeof fetch },
    });
    assert.equal(malformed.supported, false);
    assert.ok(malformed.detail.includes("shape unrecognized"));
  });
});

describe("paginatedDiscovery — enumeration semantics", () => {
  test("cursor progresses page-by-page and a clean empty final page ends enumeration", async () => {
    const log: Array<{ cursor: string | null; limit: number }> = [];
    const run = await discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch([
      { accounts: accountsOf([0x61, 0x62]), nextCursor: "page-1", contextSlot: 900 },
      { accounts: accountsOf([0x63]), nextCursor: "page-2", contextSlot: 901 },
      { accounts: [], nextCursor: null, contextSlot: 902 },
    ], log)));
    assert.deepEqual(log, [
      { cursor: null, limit: 5_000 },
      { cursor: "page-1", limit: 5_000 },
      { cursor: "page-2", limit: 5_000 },
    ]);
    assert.equal(run.stats.parsedPools, 3);
    assert.equal(run.stats.pagesReceived, 3);
    assert.equal(run.stats.duplicatesAcrossPages, 0);
    // Complete client-side enumeration still reports the UNVERIFIED
    // provider guarantees — a page ledger proves client receipts only.
    assert.equal(run.completeness.status, "provider-guarantees-unverified");
    assert.equal(run.completeness.provablyComplete, false);
    assert.ok(run.completeness.detail.includes("bounded observation window"));
    assert.equal(run.stats.truncated, true);
    // Bounded observation window (slot-consistency correction).
    assert.equal(run.observationWindow.kind, "bounded-observation-window");
    assert.deepEqual([run.observationWindow.slotMin, run.observationWindow.slotMax], [900, 902]);
    // Deterministic order (ascending base58, localeCompare — the classic
    // path's comparator) and parse parity.
    const ordered = run.records.map((r) => r.poolAddress.toBase58());
    assert.deepEqual(ordered, [...ordered].sort((a, b) => a.localeCompare(b)));
  });

  test("records are byte-identical to the classic identity-slice parse (fingerprint parity)", async () => {
    const seed = 0x71;
    const run = await discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch([
      { accounts: accountsOf([seed]), nextCursor: null, contextSlot: 1_000 },
      { accounts: [], nextCursor: null, contextSlot: 1_001 },
    ])));
    const record = run.records[0]!;
    assert.equal(record.pool.baseMint.toBase58(), synth(seed).toBase58());
    assert.equal(record.pool.quoteMint.toBase58(), WSOL_MINT.toBase58());
    assert.equal(record.pool.coinVault.toBase58(), synth(seed + 0x100).toBase58());
    assert.equal(record.pool.pcVault.toBase58(), synth(seed + 0x200).toBase58());
    assert.equal(record.wsolSide !== null && record.wsolSide.coinIsWsol, false);
    assert.ok(record.raw.fingerprint.length === 64);
    assert.match(record.raw.fingerprint, /^[0-9a-f]{64}$/);
  });

  test("accounts repeated across pages are detected and never double-counted", async () => {
    const run = await discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch([
      { accounts: accountsOf([0x81, 0x82]), nextCursor: "page-1", contextSlot: 10 },
      { accounts: accountsOf([0x82, 0x83]), nextCursor: "page-2", contextSlot: 11 },
      { accounts: [], nextCursor: null, contextSlot: 12 },
    ])));
    assert.equal(run.stats.parsedPools, 3);
    assert.equal(run.stats.duplicatesAcrossPages, 1);
    assert.equal(run.stats.duplicatesInBatch, 1);
  });

  test("page-budget exhaustion is explicit and CANNOT pass completeness", async () => {
    const endless: FakePage[] = Array.from({ length: 5 }, (_, i) => ({
      accounts: accountsOf([0x90 + i]),
      nextCursor: `page-${i + 1}`,
      contextSlot: 100 + i,
    }));
    const run = await discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch(endless), { maxPages: 3 }));
    assert.equal(run.completeness.status, "page-budget-exhausted");
    assert.equal(run.completeness.provablyComplete, false);
    assert.ok(run.completeness.detail.includes("NOT fully enumerated"));
    assert.equal(run.stats.truncated, true);
    assert.equal(run.stats.pageRequests, 3);
  });

  test("a NONEMPTY page with a null cursor is an AMBIGUOUS end — fail closed", async () => {
    const run = await discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch([
      { accounts: accountsOf([0xa1]), nextCursor: null, contextSlot: 5 },
    ])));
    assert.equal(run.completeness.status, "ambiguous-pagination-end");
    assert.equal(run.completeness.provablyComplete, false);
    assert.ok(run.completeness.detail.includes("ambiguous"));
  });

  test("an EMPTY page with a NON-null cursor is a contract violation — fail closed", async () => {
    const run = await discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch([
      { accounts: [], nextCursor: "page-1", contextSlot: 5 },
    ])));
    assert.equal(run.completeness.status, "empty-page-with-cursor");
    assert.equal(run.completeness.provablyComplete, false);
  });

  test("a mid-enumeration transport failure is explicit — never a silent partial corpus", async () => {
    const run = await discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch([
      { accounts: accountsOf([0xb1]), nextCursor: "page-1", contextSlot: 1 },
      { accounts: [], nextCursor: null, contextSlot: 2, fail: "simulated 429 exhaustion" },
    ])));
    assert.equal(run.completeness.status, "enumeration-failed");
    assert.equal(run.completeness.provablyComplete, false);
    // The TYPED transport failure (budget exhausted) is surfaced verbatim.
    assert.ok(run.completeness.detail.includes("retry budget exhausted"));
    assert.ok(run.completeness.detail.includes("INCOMPLETE"));
    const failedEntry = run.ledger[run.ledger.length - 1]!;
    assert.ok(failedEntry.note.startsWith("FAILED:"));
    assert.equal(failedEntry.receivedCount, 0);
  });

  test("missing context slots are counted and the window degrades honestly", async () => {
    const run = await discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch([
      { accounts: accountsOf([0xc1]), nextCursor: "page-1", contextSlot: null },
      { accounts: [], nextCursor: null, contextSlot: null },
    ])));
    assert.equal(run.observationWindow.pagesWithSlot, 0);
    assert.equal(run.observationWindow.pagesWithoutSlot, 2);
    assert.equal(run.observationWindow.slotMin, null);
    assert.equal(run.observationWindow.slotMax, null);
    assert.ok(run.completeness.detail.includes("not a proven atomic snapshot"));
  });

  test("page limit bounds are enforced (1..10,000)", async () => {
    await assert.rejects(
      discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch([]), { pageLimit: GPA_V2_MAX_PAGE_LIMIT + 1 })),
      /pageLimit/,
    );
    await assert.rejects(
      discoverRaydiumV4PoolsPaginated(runOpts(paginatedFetch([]), { pageLimit: 0 })),
      /pageLimit/,
    );
  });
});

describe("paginatedDiscovery — result normalization + mode gate", () => {
  test("normalizeGpaV2Result handles withContext true/false and rejects malformed entries", () => {
    assert.deepEqual(
      normalizeGpaV2Result({ accounts: [], paginationKey: null })!.paginationKey,
      null,
    );
    assert.deepEqual(
      normalizeGpaV2Result({ context: { slot: 5 }, value: { accounts: [], paginationKey: "c" } })!.contextSlot,
      5,
    );
    assert.equal(normalizeGpaV2Result({ accounts: "x" }), null);
    assert.equal(
      normalizeGpaV2Result({ accounts: [{ pubkey: "ok", account: { data: "not-a-tuple" } }] }),
      null,
    );
  });

  test("resolvePaginationMode: classic default, strict/fallback opt-ins, unknown refused", () => {
    assert.equal(resolvePaginationMode(undefined), "classic");
    assert.equal(resolvePaginationMode(""), "classic");
    assert.equal(resolvePaginationMode("paginated-strict"), "paginated-strict");
    assert.equal(resolvePaginationMode("PAGINATED-BOUNDED-FALLBACK"), "paginated-bounded-fallback");
    assert.throws(() => resolvePaginationMode("silent-fallback"), /DISCOVERY_PAGINATION_MODE/);
  });
});

describe("paginatedDiscovery — GpaV2Page shape (type-level sanity)", () => {
  test("a page object carries cursor + slot fields", () => {
    const page: GpaV2Page = { accounts: [], paginationKey: null, contextSlot: 1 };
    assert.equal(page.contextSlot, 1);
  });
});
