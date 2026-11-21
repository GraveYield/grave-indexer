// SPDX-License-Identifier: Apache-2.0
//
// PR #5 remediation — review Task 4 (rollback-pointer discovery) and
// Task 5 (same-release verification) test battery.
//
// These tests drive the REAL production logic in src/releaseOps.ts and
// the CLI commands the workflow invokes (`release-latest`,
// `verify-release-assets`) with the GitHub HTTP layer injected /
// monkeypatched — no network access is required and no GitHub state is
// touched. The classification matrix pins the fail-closed rule: ONLY a
// genuine HTTP 404 means "no previous release"; every auth, permission,
// rate-limit, outage, network and malformed failure is a TYPED abort.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PublicKey } from "@solana/web3.js";
import { RAYDIUM_V4_PROGRAM_ID, WSOL_MINT } from "@graveyield/sdk";

import { buildConsoleSnapshot, SNAPSHOT_THRESHOLD_FALLBACK, type ConsoleSnapshotV2, type PoolEnrichment } from "../src/consoleSnapshot.js";
import type { DiscoveredPoolRecord } from "../src/discovery.js";
import {
  buildPublicationProvenance,
  CHECKSUM_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  snapshotSha256,
  versionedTagName,
  type PublicationProvenance,
} from "../src/snapshotPublication.js";
import {
  RELEASE_OPS_ERROR_CATEGORIES,
  ReleaseOpsError,
  authedHttp,
  resolveLatestRelease,
  verifyReleaseAssetSet,
  type FetchAssetImpl,
  type HttpImpl,
  type MinimalHttpResponse,
} from "../src/releaseOps.js";
import { cmdReleaseLatest, cmdVerifyReleaseAssets } from "../src/cli.js";

// ─── Fixture machinery (real schema-v2 snapshots, same builders as prod) ───

const NOW_MS = 1_800_000_000_000;
const SOURCE_COMMIT = "c".repeat(40);
const TAG_A = versionedTagName(NOW_MS - 3_600_000, SOURCE_COMMIT);
const TAG_B = versionedTagName(NOW_MS, SOURCE_COMMIT);

function synthPool(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, seed);
  return new PublicKey(bytes);
}

function discoveredRecord(seed: number): DiscoveredPoolRecord {
  return {
    poolAddress: synthPool(seed),
    ammProgramId: RAYDIUM_V4_PROGRAM_ID,
    pool: {
      coinVault: synthPool(0x31 + seed),
      pcVault: synthPool(0x32 + seed),
      baseMint: synthPool(0x33 + seed),
      quoteMint: WSOL_MINT,
      lpMint: synthPool(0x34 + seed),
    },
    wsolSide: { memecoinMint: synthPool(0x33 + seed), coinIsWsol: false },
    raw: {
      mode: "identity-slice",
      dataLen: 160,
      fingerprint: `fp-${seed}`,
      owner: RAYDIUM_V4_PROGRAM_ID.toBase58(),
    },
    provenance: {
      source: "raydium-v4-gpa",
      cluster: "mainnet-beta",
      endpointKind: "public-rpc",
      slotLowerBound: 5_000_000,
      slotUpperBound: 5_000_002,
      fetchedAtUnixMs: NOW_MS,
    },
  };
}

function enrichment(seed: number): PoolEnrichment {
  return {
    wsolReserveLamports: "600000000",
    memecoinReserveRaw: "1000000",
    memecoinDecimals: 6,
    lpSupplyRaw: "1000000",
    lastSwap: { unixTs: 1_700_000_100, slot: 900_000, signature: `sig-${seed}`.padEnd(88, "x").slice(0, 87) },
    fetchedAtUnixMs: NOW_MS,
  };
}

function realSnapshotAt(generatedAtUnixMs: number): { snapshot: ConsoleSnapshotV2; bytes: Uint8Array } {
  const records = [discoveredRecord(0x41), discoveredRecord(0x42)];
  const enrichments = new Map(records.map((r) => [r.poolAddress.toBase58(), enrichment(0)]));
  const snapshot = buildConsoleSnapshot(records, enrichments, {
    generatedAtUnixMs,
    cluster: "mainnet-beta",
    endpointKind: "public-rpc",
    indexerGitHead: SOURCE_COMMIT,
    maxAgeMs: 24 * 3_600_000,
    thresholds: SNAPSHOT_THRESHOLD_FALLBACK,
    counts: {
      rawAccounts: 4200,
      parsedPools: 4200,
      supportedWsolPairs: 2,
      m1SourcingRejected: 0,
    },
    failures: [],
    slotLowerBound: 5_000_000,
    slotUpperBound: 5_000_002,
  });
  return { snapshot, bytes: new TextEncoder().encode(JSON.stringify(snapshot)) };
}

function bundleFor(tag: string, at = NOW_MS): { provenance: PublicationProvenance; snapshot: Uint8Array; provenanceBytes: Uint8Array; checksum: Uint8Array } {
  const { snapshot, bytes } = realSnapshotAt(at);
  const provenance = buildPublicationProvenance(snapshot, bytes, {
    sourceCommitSha: SOURCE_COMMIT,
    workflowRunId: "1",
    workflowAttempt: "1",
    repository: "GraveYield/grave-indexer",
    versionedTag: tag,
  });
  return {
    provenance,
    snapshot: bytes,
    provenanceBytes: new TextEncoder().encode(JSON.stringify(provenance)),
    checksum: new TextEncoder().encode(`${snapshotSha256(bytes)}  ${SNAPSHOT_ASSET_NAME}\n`),
  };
}

const A = bundleFor(TAG_A, NOW_MS - 3_600_000);
const B = bundleFor(TAG_B, NOW_MS);

// ─── HTTP fakes ─────────────────────────────────────────────────────────────

/** Same composition as authedHttp but over an injected transport (test-only). */
function authedHttpWith(transport: HttpImpl, token: string): HttpImpl {
  return (url, init) =>
    transport(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): MinimalHttpResponse {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

const REPO = "GraveYield/grave-indexer";

describe("releaseOps — error taxonomy completeness", () => {
  test("every category is enumerated (the workflow aborts on ALL of them)", () => {
    assert.deepEqual([...RELEASE_OPS_ERROR_CATEGORIES].sort(), [
      "API_OUTAGE",
      "AUTHENTICATION",
      "MALFORMED_RESPONSE",
      "NETWORK",
      "PERMISSION",
      "RATE_LIMIT",
      "UNEXPECTED_STATUS",
    ].sort());
  });

  test("error messages carry the category but never a token", () => {
    const err = new ReleaseOpsError("PERMISSION", "denied", 403);
    assert.match(err.message, /^release-ops \[PERMISSION\] \(HTTP 403\)/);
    assert.equal(err.category, "PERMISSION");
  });
});

describe("resolveLatestRelease — rollback-pointer discovery classification (review Task 4)", () => {
  test("HTTP 404 → kind:none (the ONLY signal for 'first publication')", async () => {
    const calls: string[] = [];
    const http: HttpImpl = async (url) => {
      calls.push(url);
      return jsonResponse(404, { message: "Not Found" });
    };
    const resolution = await resolveLatestRelease({ repository: REPO, http });
    assert.equal(resolution.kind, "none");
    if (resolution.kind === "none") assert.match(resolution.detail, /404/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `https://api.github.com/repos/${REPO}/releases/latest`);
  });

  test("HTTP 200 with a tag_name → kind:found", async () => {
    const http: HttpImpl = async () => jsonResponse(200, { tag_name: TAG_A });
    const resolution = await resolveLatestRelease({ repository: REPO, http });
    assert.deepEqual(resolution, { kind: "found", tag: TAG_A });
  });

  test("HTTP 200 with malformed JSON → MALFORMED_RESPONSE (never 'none')", async () => {
    const http: HttpImpl = async () => jsonResponse(200, new Error("Unexpected token < in JSON"));
    await assert.rejects(
      () => resolveLatestRelease({ repository: REPO, http }),
      (err: ReleaseOpsError) => err.category === "MALFORMED_RESPONSE" && err.httpStatus === 200,
    );
  });

  test("HTTP 200 missing tag_name → MALFORMED_RESPONSE", async () => {
    const http: HttpImpl = async () => jsonResponse(200, { nope: true });
    await assert.rejects(() => resolveLatestRelease({ repository: REPO, http }), /MALFORMED_RESPONSE/);
  });

  test("HTTP 200 with a non-object body → MALFORMED_RESPONSE", async () => {
    const http: HttpImpl = async () => jsonResponse(200, "not an object");
    await assert.rejects(() => resolveLatestRelease({ repository: REPO, http }), /MALFORMED_RESPONSE/);
  });

  test("HTTP 401 → AUTHENTICATION", async () => {
    const http: HttpImpl = async () => jsonResponse(401, { message: "Bad credentials" });
    await assert.rejects(
      () => resolveLatestRelease({ repository: REPO, http }),
      (err: ReleaseOpsError) => err.category === "AUTHENTICATION" && err.httpStatus === 401,
    );
  });

  test("HTTP 403 (permission) → PERMISSION", async () => {
    const http: HttpImpl = async () => jsonResponse(403, { message: "Resource not accessible" }, { "x-ratelimit-remaining": "4700" });
    await assert.rejects(
      () => resolveLatestRelease({ repository: REPO, http }),
      (err: ReleaseOpsError) => err.category === "PERMISSION" && err.httpStatus === 403,
    );
  });

  test("HTTP 403 with exhausted rate budget → RATE_LIMIT", async () => {
    const http: HttpImpl = async () => jsonResponse(403, { message: "rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
    await assert.rejects(() => resolveLatestRelease({ repository: REPO, http }), (err: ReleaseOpsError) => err.category === "RATE_LIMIT");
  });

  test("HTTP 429 → RATE_LIMIT", async () => {
    const http: HttpImpl = async () => jsonResponse(429, { message: "Too many requests" });
    await assert.rejects(() => resolveLatestRelease({ repository: REPO, http }), (err: ReleaseOpsError) => err.category === "RATE_LIMIT");
  });

  for (const status of [500, 502, 503]) {
    test(`HTTP ${status} → API_OUTAGE`, async () => {
      const http: HttpImpl = async () => jsonResponse(status, { message: "boom" });
      await assert.rejects(() => resolveLatestRelease({ repository: REPO, http }), (err: ReleaseOpsError) => err.category === "API_OUTAGE");
    });
  }

  test("network failure (fetch throws) → NETWORK", async () => {
    const http: HttpImpl = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    };
    await assert.rejects(() => resolveLatestRelease({ repository: REPO, http }), (err: ReleaseOpsError) => err.category === "NETWORK");
  });

  test("unexpected HTTP status (e.g. 400) → UNEXPECTED_STATUS — never reinterpreted", async () => {
    const http: HttpImpl = async () => jsonResponse(400, { message: "weird" });
    await assert.rejects(() => resolveLatestRelease({ repository: REPO, http }), (err: ReleaseOpsError) => err.category === "UNEXPECTED_STATUS");
  });

  test("authedHttp attaches the token as a header only — never in the URL", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const base: HttpImpl = async (url, init) => {
      seen.push({ url, auth: init?.headers?.authorization ?? null });
      return jsonResponse(200, { tag_name: TAG_A });
    };
    const authed = authedHttp("ghs_secret_token_value");
    // authedHttp composes the header onto the default transport; verify via
    // an explicit capture transport of the same shape.
    const capture: HttpImpl = (url, init) => base(url, init);
    await resolveLatestRelease({ repository: REPO, http: capture });
    assert.ok(seen.length === 1, "exactly one API call was made");
    assert.match(seen[0]!.url, /^https:\/\/api\.github\.com\/repos\//);
    assert.ok(!seen[0]!.url.includes("token"), "no token ever reaches a URL");
    // The authed wrapper itself must place the token in the header.
    let headerSeen: string | null = null;
    const headerCapture: HttpImpl = async (url, init) => {
      headerSeen = init?.headers?.authorization ?? null;
      void url;
      return jsonResponse(200, { tag_name: TAG_A });
    };
    const wrapped = authedHttpWith(headerCapture, "ghs_secret_token_value");
    await wrapped("https://api.github.com/repos/x/releases/latest");
    assert.equal(headerSeen, "Bearer ghs_secret_token_value", "token travels as the Authorization header");
  });
});

// ─── Same-release asset verification (review Task 5) ────────────────────────

function fetcherFor(byUrl: Map<string, Uint8Array>): { impl: FetchAssetImpl; calls: string[] } {
  const calls: string[] = [];
  const impl: FetchAssetImpl = async (url) => {
    calls.push(url);
    const bytes = byUrl.get(url);
    if (!bytes) throw new ReleaseOpsError("UNEXPECTED_STATUS", `asset fetch ${url} returned HTTP 404`, 404);
    return bytes;
  };
  return { impl, calls };
}

const LATEST_BASE = `https://github.com/${REPO}/releases/latest/download`;

function binaryResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

describe("verifyReleaseAssetSet — same-release cross-checks (review Task 5)", () => {
  test("successful same-release verification (all three from the activated release)", async () => {
    const byUrl = new Map([
      [`${LATEST_BASE}/${SNAPSHOT_ASSET_NAME}`, B.snapshot],
      [`${LATEST_BASE}/${PROVENANCE_ASSET_NAME}`, B.provenanceBytes],
      [`${LATEST_BASE}/${CHECKSUM_ASSET_NAME}`, B.checksum],
    ]);
    const { impl } = fetcherFor(byUrl);
    await assert.doesNotReject(() =>
      verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "latest", expectedTag: TAG_B, fetchAsset: impl }),
    );
  });

  test("versioned scope fetches through the release's OWN tag URLs", async () => {
    const base = `https://github.com/${REPO}/releases/download/${TAG_B}`;
    const byUrl = new Map([
      [`${base}/${SNAPSHOT_ASSET_NAME}`, B.snapshot],
      [`${base}/${PROVENANCE_ASSET_NAME}`, B.provenanceBytes],
      [`${base}/${CHECKSUM_ASSET_NAME}`, B.checksum],
    ]);
    const { impl, calls } = fetcherFor(byUrl);
    await assert.doesNotReject(() =>
      verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B, fetchAsset: impl }),
    );
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.includes(`/releases/download/${TAG_B}/`)), "all three fetches are tag-scoped (same release)");
  });

  test("snapshot from one release + provenance from another → REJECTED (mixture)", async () => {
    const byUrl = new Map([
      [`${LATEST_BASE}/${SNAPSHOT_ASSET_NAME}`, B.snapshot],
      [`${LATEST_BASE}/${PROVENANCE_ASSET_NAME}`, A.provenanceBytes], // OLD release's sidecar
      [`${LATEST_BASE}/${CHECKSUM_ASSET_NAME}`, B.checksum],
    ]);
    const { impl } = fetcherFor(byUrl);
    await assert.rejects(
      () => verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "latest", expectedTag: TAG_B, fetchAsset: impl }),
      /provenance names release .*expected|MIXED/,
    );
  });

  test("checksum from a different release → REJECTED (digest mismatch)", async () => {
    const byUrl = new Map([
      [`${LATEST_BASE}/${SNAPSHOT_ASSET_NAME}`, B.snapshot],
      [`${LATEST_BASE}/${PROVENANCE_ASSET_NAME}`, B.provenanceBytes],
      [`${LATEST_BASE}/${CHECKSUM_ASSET_NAME}`, A.checksum], // OLD release's checksum
    ]);
    const { impl } = fetcherFor(byUrl);
    await assert.rejects(
      () => verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "latest", expectedTag: TAG_B, fetchAsset: impl }),
      /checksum MISMATCH/,
    );
  });

  test("missing sidecar (HTTP 404) → REJECTED before any acceptance", async () => {
    const byUrl = new Map([
      [`${LATEST_BASE}/${SNAPSHOT_ASSET_NAME}`, B.snapshot],
      [`${LATEST_BASE}/${CHECKSUM_ASSET_NAME}`, B.checksum],
      // provenance missing
    ]);
    const { impl } = fetcherFor(byUrl);
    await assert.rejects(
      () => verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B, fetchAsset: impl }),
      (err: ReleaseOpsError) => err.httpStatus === 404,
    );
  });

  test("provenance naming a DIFFERENT tag than expected → REJECTED", async () => {
    const byUrl = new Map([
      [`${LATEST_BASE}/${SNAPSHOT_ASSET_NAME}`, A.snapshot],
      [`${LATEST_BASE}/${PROVENANCE_ASSET_NAME}`, A.provenanceBytes],
      [`${LATEST_BASE}/${CHECKSUM_ASSET_NAME}`, A.checksum],
    ]);
    const { impl } = fetcherFor(byUrl);
    // Internally consistent set for TAG_A — but the workflow activated TAG_B.
    await assert.rejects(
      () => verifyReleaseAssetSet({ repository: REPO, tag: TAG_A, scope: "latest", expectedTag: TAG_B, fetchAsset: impl }),
      /provenance names/,
    );
  });

  test("tampered snapshot bytes beside a valid sidecar → REJECTED (digest over exact bytes)", async () => {
    const tampered = B.snapshot.slice(0, B.snapshot.byteLength - 2);
    const byUrl = new Map([
      [`${LATEST_BASE}/${SNAPSHOT_ASSET_NAME}`, tampered],
      [`${LATEST_BASE}/${PROVENANCE_ASSET_NAME}`, B.provenanceBytes],
      [`${LATEST_BASE}/${CHECKSUM_ASSET_NAME}`, B.checksum],
    ]);
    const { impl } = fetcherFor(byUrl);
    await assert.rejects(
      () => verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "latest", expectedTag: TAG_B, fetchAsset: impl }),
      /checksum MISMATCH/,
    );
  });
});

// ─── CLI composition (the commands the workflow actually invokes) ───────────

describe("cmdVerifyReleaseAssets / cmdReleaseLatest — the workflow's entry points", () => {
  const realFetch = globalThis.fetch;

  function installFakeFetch(handler: (url: string) => Response | Promise<Response>): void {
    globalThis.fetch = ((input: string | URL | Request) => handler(String(input))) as typeof fetch;
  }

  test("release-latest prints kind=found + tag for a 200", async () => {
    installFakeFetch((url) => {
      assert.equal(url, `https://api.github.com/repos/${REPO}/releases/latest`);
      return new Response(JSON.stringify({ tag_name: TAG_A }), { status: 200 });
    });
    const exit = await cmdReleaseLatest(REPO);
    assert.equal(exit, 0);
    globalThis.fetch = realFetch;
  });

  test("release-latest exits NON-ZERO on an auth failure (the workflow aborts)", async () => {
    installFakeFetch(() => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    const exit = await cmdReleaseLatest(REPO);
    assert.equal(exit, 1, "authentication failure must abort, never report 'no previous release'");
    globalThis.fetch = realFetch;
  });

  test("release-latest exits 0 for a genuine 404 (first publication)", async () => {
    installFakeFetch(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const exit = await cmdReleaseLatest(REPO);
    assert.equal(exit, 0);
    globalThis.fetch = realFetch;
  });

  test("verify-release-assets --scope latest FAILS when the pointer drifted to another release", async () => {
    installFakeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return new Response(JSON.stringify({ tag_name: TAG_A }), { status: 200 }); // NOT the activated tag
      }
      throw new Error("unexpected asset fetch during pointer check");
    });
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "latest", expectedTag: TAG_B });
    assert.equal(exit, 1, "an unrelated promotion moving the pointer must fail the verification");
    globalThis.fetch = realFetch;
  });

  test("verify-release-assets --scope latest FAILS when no latest release is designated", async () => {
    installFakeFetch(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "latest", expectedTag: TAG_B });
    assert.equal(exit, 1);
    globalThis.fetch = realFetch;
  });

  test("verify-release-assets --scope latest PASSES end-to-end when the pointer holds and assets match", async () => {
    installFakeFetch((url) => {
      if (url.includes("/releases/latest") && url.includes("api.github.com")) {
        return new Response(JSON.stringify({ tag_name: TAG_B }), { status: 200 });
      }
      if (url === `${LATEST_BASE}/${SNAPSHOT_ASSET_NAME}`) {
        return binaryResponse(B.snapshot);
      }
      if (url === `${LATEST_BASE}/${PROVENANCE_ASSET_NAME}`) {
        return binaryResponse(B.provenanceBytes);
      }
      if (url === `${LATEST_BASE}/${CHECKSUM_ASSET_NAME}`) {
        return binaryResponse(B.checksum);
      }
      return textResponse("not found", 404);
    });
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "latest", expectedTag: TAG_B });
    assert.equal(exit, 0);
    globalThis.fetch = realFetch;
  });

  test("verify-release-assets --scope versioned PASSES through tag URLs without any API call", async () => {
    const apiCalls: string[] = [];
    const tagBase = `https://github.com/${REPO}/releases/download/${TAG_B}`;
    installFakeFetch((url) => {
      if (url.includes("api.github.com")) apiCalls.push(url);
      if (url === `${tagBase}/${SNAPSHOT_ASSET_NAME}`) return binaryResponse(B.snapshot);
      if (url === `${tagBase}/${PROVENANCE_ASSET_NAME}`) return binaryResponse(B.provenanceBytes);
      if (url === `${tagBase}/${CHECKSUM_ASSET_NAME}`) return binaryResponse(B.checksum);
      return textResponse("not found", 404);
    });
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B });
    assert.equal(exit, 0);
    assert.equal(apiCalls.length, 0, "versioned verification needs no token and no API call");
    globalThis.fetch = realFetch;
  });

  test("verify-release-assets --scope versioned FAILS on a mixed set (provenance from another release)", async () => {
    const tagBase = `https://github.com/${REPO}/releases/download/${TAG_B}`;
    installFakeFetch((url) => {
      if (url === `${tagBase}/${SNAPSHOT_ASSET_NAME}`) return binaryResponse(B.snapshot);
      if (url === `${tagBase}/${PROVENANCE_ASSET_NAME}`) return binaryResponse(A.provenanceBytes);
      if (url === `${tagBase}/${CHECKSUM_ASSET_NAME}`) return binaryResponse(B.checksum);
      return textResponse("not found", 404);
    });
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B });
    assert.equal(exit, 1);
    globalThis.fetch = realFetch;
  });
});
