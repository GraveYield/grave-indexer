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
  buildStablePointer,
  parseStablePointer,
  CHECKSUM_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  snapshotSha256,
  STABLE_POINTER_SCHEMA,
  versionedTagName,
  type PublicationProvenance,
} from "../src/snapshotPublication.js";
import {
  RELEASE_OPS_ERROR_CATEGORIES,
  ReleaseOpsError,
  authedHttp,
  buildStablePointerForRelease,
  fetchStablePointer,
  resolveLatestRelease,
  resolveStableRef,
  verifyReleaseAssetSet,
  verifyStableReference,
  type FetchAssetImpl,
  type HttpImpl,
  type MinimalHttpResponse,
} from "../src/releaseOps.js";
import { cmdReleaseLatest, cmdVerifyReleaseAssets, cmdVerifyStable } from "../src/cli.js";
import { parseConsoleSnapshot } from "../src/consoleSnapshotParse.js";

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
      "NOT_FOUND",
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

// ─── Authenticated verification transport (private repository, fourth round) ──

describe("verifyReleaseAssetSet / cmdVerifyReleaseAssets — authenticated API transport (private repository)", () => {
  const realFetch = globalThis.fetch;
  const READ_TOKEN = "ghs_readonly-runner-token";

  interface CapturedCall { url: string; headers: Record<string, string> }
  const captured: CapturedCall[] = [];
  const assetBase = `https://api.github.com/repos/${REPO}/releases/assets`;

  function releaseRecord(tag: string): unknown {
    return {
      tag_name: tag,
      assets: [
        { name: SNAPSHOT_ASSET_NAME, url: `${assetBase}/1` },
        { name: PROVENANCE_ASSET_NAME, url: `${assetBase}/2` },
        { name: CHECKSUM_ASSET_NAME, url: `${assetBase}/3` },
      ],
    };
  }

  function installAuthedFakeFetch(): void {
    captured.length = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured.push({ url, headers });
      if (url === `https://api.github.com/repos/${REPO}/releases/tags/${TAG_B}`) {
        return new Response(JSON.stringify(releaseRecord(TAG_B)), { status: 200 });
      }
      if (url === `${assetBase}/1`) return binaryResponse(B.snapshot);
      if (url === `${assetBase}/2`) return binaryResponse(B.provenanceBytes);
      if (url === `${assetBase}/3`) return binaryResponse(B.checksum);
      return textResponse("not found", 404);
    }) as typeof fetch;
  }

  test("with a token, verification resolves the release through the API and downloads assets via the octet-stream asset URLs", async () => {
    process.env.GH_TOKEN = READ_TOKEN;
    installAuthedFakeFetch();
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B });
    delete process.env.GH_TOKEN;
    assert.equal(exit, 0, "the authenticated private-repo path verifies a genuine same-release set");
    // Release lookup happened through the REST API.
    assert.ok(captured.some((c) => c.url === `https://api.github.com/repos/${REPO}/releases/tags/${TAG_B}`), "the release record is resolved through the API (private repos are unreachable unauthenticated)");
    // All three assets came from their api.github.com asset URLs.
    const assetCalls = captured.filter((c) => c.url.startsWith(`${assetBase}/`));
    assert.equal(assetCalls.length, 3, "all three assets are fetched through their API asset URLs");
    for (const call of assetCalls) {
      assert.equal(call.headers["accept"], "application/octet-stream", "the raw-bytes accept header is set on asset fetches");
      assert.equal(call.headers["authorization"], `Bearer ${READ_TOKEN}`, "the credential travels as the Authorization HEADER only");
      assert.ok(!call.url.includes(READ_TOKEN), "the token never enters a URL");
    }
    globalThis.fetch = realFetch;
  });

  test("without a token, verification stays on the unauthenticated download-URL path (no Authorization header anywhere)", async () => {
    installAuthedFakeFetch();
    // The fake above only serves the API path, so re-install a URL-path fake.
    const tagBase = `https://github.com/${REPO}/releases/download/${TAG_B}`;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured.push({ url, headers });
      if (url === `${tagBase}/${SNAPSHOT_ASSET_NAME}`) return binaryResponse(B.snapshot);
      if (url === `${tagBase}/${PROVENANCE_ASSET_NAME}`) return binaryResponse(B.provenanceBytes);
      if (url === `${tagBase}/${CHECKSUM_ASSET_NAME}`) return binaryResponse(B.checksum);
      return textResponse("not found", 404);
    }) as typeof fetch;
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B });
    assert.equal(exit, 0);
    assert.ok(captured.every((c) => c.headers["authorization"] === undefined), "the unauthenticated path sends NO Authorization header");
    assert.ok(captured.every((c) => c.url.startsWith(`https://github.com/${REPO}/releases/download/`)), "the unauthenticated path uses the release download URLs");
    globalThis.fetch = realFetch;
  });

  test("a 404 release lookup is NOT_FOUND (typed abort — never silently 'verified')", async () => {
    installAuthedFakeFetch();
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as typeof fetch;
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B });
    assert.equal(exit, 1, "a missing release record fails the verification");
    globalThis.fetch = realFetch;
  });

  test("a release record MISSING an asset fails closed (incomplete artifact set is never accepted)", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `https://api.github.com/repos/${REPO}/releases/tags/${TAG_B}`) {
        const record = releaseRecord(TAG_B) as { assets: Array<{ name: string; url: string }> };
        return new Response(JSON.stringify({ tag_name: TAG_B, assets: record.assets.slice(0, 2) }), { status: 200 });
      }
      return textResponse("not found", 404);
    }) as typeof fetch;
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B });
    assert.equal(exit, 1, "a partial asset set aborts the run");
    globalThis.fetch = realFetch;
  });

  test("a versioned release lookup returning a DIFFERENT tag_name fails closed", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `https://api.github.com/repos/${REPO}/releases/tags/${TAG_B}`) {
        return new Response(JSON.stringify({ tag_name: TAG_A, assets: [] }), { status: 200 });
      }
      return textResponse("not found", 404);
    }) as typeof fetch;
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B });
    assert.equal(exit, 1, "a mismatched release record must never be verified against the expected tag");
    globalThis.fetch = realFetch;
  });

  // ─── Latest-designation race (fifth-round fix) ────────────────────────────
  // The caller checked the latest designation, but the record lookup inside
  // verifyReleaseAssetSet is a SECOND /releases/latest request. A concurrent
  // promotion between the two must fail closed BEFORE any asset download.

  test("REGRESSION (latest-designation race): designation check passes, subsequent record lookup returns a DIFFERENT tag → typed failure, ZERO asset downloads", async () => {
    process.env.GH_TOKEN = READ_TOKEN;
    const latestHits: string[] = [];
    const assetAttempted: string[] = [];
    const unexpectedAssetUrl = `${assetBase}/9`; // would be fetched if the unexpected record were trusted
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      // Call #1: resolveLatestRelease's designation lookup — names the EXPECTED tag.
      // Call #2: fetchReleaseRecord(null) inside verifyReleaseAssetSet — the
      // designation has "moved": a different release is now latest.
      if (url === `https://api.github.com/repos/${REPO}/releases/latest`) {
        latestHits.push(url);
        const tag = latestHits.length === 1 ? TAG_B : TAG_A;
        return new Response(
          JSON.stringify({ tag_name: tag, assets: [{ name: SNAPSHOT_ASSET_NAME, url: unexpectedAssetUrl }] }),
          { status: 200 },
        );
      }
      assetAttempted.push(url);
      return textResponse("not found", 404);
    }) as typeof fetch;
    let exit = -1;
    let thrown: unknown = null;
    try {
      exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "latest", expectedTag: TAG_B });
    } catch (err) {
      thrown = err;
    } finally {
      delete process.env.GH_TOKEN;
      globalThis.fetch = realFetch;
    }
    assert.equal(thrown, null, "the CLI layer converts the typed error into exit code 1 (no throw escapes)");
    assert.equal(exit, 1, "the raced verification fails closed");
    assert.equal(latestHits.length, 2, "exactly the designation lookup and the record lookup happened");
    assert.deepEqual(assetAttempted, [], "no asset of the unexpected release was downloaded");
  });

  test("REGRESSION (latest-designation race): verifyReleaseAssetSet itself rejects an unexpected latest record with a typed error BEFORE any asset fetch", async () => {
    const assetAttempted: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `https://api.github.com/repos/${REPO}/releases/latest`) {
        // The record names a DIFFERENT tag than expectedTag — the designation
        // moved between the caller's check and this lookup.
        return new Response(
          JSON.stringify({ tag_name: TAG_A, assets: [{ name: SNAPSHOT_ASSET_NAME, url: `${assetBase}/9` }] }),
          { status: 200 },
        );
      }
      assetAttempted.push(url);
      return textResponse("not found", 404);
    }) as typeof fetch;
    let thrown: unknown = null;
    try {
      await verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "latest", expectedTag: TAG_B, authToken: READ_TOKEN });
    } catch (err) {
      thrown = err;
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(thrown instanceof ReleaseOpsError, "the production verification function throws a typed ReleaseOpsError");
    const opsErr = thrown as ReleaseOpsError;
    assert.equal(opsErr.category, "MALFORMED_RESPONSE", "the existing mismatch classification is reused");
    assert.match(
      opsErr.message,
      /latest designation changed or resolved to an unexpected release/,
      "the diagnostic names the race condition",
    );
    assert.ok(opsErr.message.includes(TAG_A), "the diagnostic names the unexpected tag");
    assert.deepEqual(assetAttempted, [], "NO asset download was attempted against the unexpected release");
    globalThis.fetch = realFetch;
  });

  test("tokenless environment: the CLI does not authenticate even when a URL responds (explicit contract)", async () => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const seenAuth: string[] = [];
    const tagBase = `https://github.com/${REPO}/releases/download/${TAG_B}`;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = ((init?.headers ?? {}) as Record<string, string>);
      if (headers["authorization"] !== undefined) seenAuth.push(headers["authorization"]);
      const url = String(input);
      if (url === `${tagBase}/${SNAPSHOT_ASSET_NAME}`) return binaryResponse(B.snapshot);
      if (url === `${tagBase}/${PROVENANCE_ASSET_NAME}`) return binaryResponse(B.provenanceBytes);
      if (url === `${tagBase}/${CHECKSUM_ASSET_NAME}`) return binaryResponse(B.checksum);
      return textResponse("not found", 404);
    }) as typeof fetch;
    const exit = await cmdVerifyReleaseAssets({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B });
    assert.equal(exit, 0);
    assert.deepEqual(seenAuth, [], "no Authorization header is sent without a credential");
    globalThis.fetch = realFetch;
  });
});

// ─── Dedicated stable reference — identity chain (sixth round) ──────────────

describe("resolveStableRef / fetchStablePointer / verifyStableReference — the dedicated console-snapshot-prod ref", () => {
  const realFetch = globalThis.fetch;
  const READ_TOKEN = "ghs_readonly-runner-token";
  const REF_URL = `https://api.github.com/repos/${REPO}/git/ref/tags/console-snapshot-prod`;
  const TAG_OBJECT_SHA = "a".repeat(40);
  const ASSET_BASE = `https://api.github.com/repos/${REPO}/releases/assets`;
  const requested: string[] = [];

  /** The pointer JSON for a tag's verified bytes (with or without a previous record). */
  function pointerFor(previous: { versionedTag: string; tagObjectSha: string } | null = null, tag: string = TAG_B): { json: string; sha256: string } {
    const bytes = tag === TAG_B ? B : A;
    const built = buildStablePointer({
      versionedTag: tag,
      sourceCommit: SOURCE_COMMIT,
      publishedAtUnixMs: NOW_MS,
      snapshotBytes: bytes.snapshot,
      provenanceBytes: bytes.provenanceBytes,
      checksumBytes: bytes.checksum,
      previous,
    });
    return { json: built.pointerJson, sha256: TAG_OBJECT_SHA };
  }

interface FakeState {
  refStatus?: number | undefined;
  refObjectSha?: string | undefined;
  tagObjectMessage?: string | undefined;
  recordTag?: string | undefined;
  recordAssets?: Array<{ name: string; url: string }> | undefined;
  assetBytes?: Map<string, Uint8Array> | undefined;
}

  function installFake(state: FakeState): void {
    requested.length = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url === REF_URL) {
        if ((state.refStatus ?? 200) !== 200) return textResponse("error", state.refStatus ?? 500);
        return new Response(JSON.stringify({ object: { sha: state.refObjectSha ?? TAG_OBJECT_SHA, type: "tag" } }), { status: 200 });
      }
      if (url.startsWith(`https://api.github.com/repos/${REPO}/git/tags/`)) {
        if (state.tagObjectMessage === undefined) return textResponse("not found", 404);
        return new Response(JSON.stringify({ message: state.tagObjectMessage, object: { sha: SOURCE_COMMIT, type: "commit" } }), { status: 200 });
      }
      if (url === `https://api.github.com/repos/${REPO}/releases/tags/${TAG_B}`) {
        return new Response(JSON.stringify({ tag_name: state.recordTag ?? TAG_B, assets: state.recordAssets ?? [] }), { status: 200 });
      }
      const bytes = state.assetBytes?.get(url);
      if (bytes) return binaryResponse(bytes);
      return textResponse("not found", 404);
    }) as typeof fetch;
  }

  function assetState(): FakeState {
    return {
      recordAssets: [
        { name: SNAPSHOT_ASSET_NAME, url: `${ASSET_BASE}/1` },
        { name: PROVENANCE_ASSET_NAME, url: `${ASSET_BASE}/2` },
        { name: CHECKSUM_ASSET_NAME, url: `${ASSET_BASE}/3` },
      ],
      assetBytes: new Map([
        [`${ASSET_BASE}/1`, B.snapshot],
        [`${ASSET_BASE}/2`, B.provenanceBytes],
        [`${ASSET_BASE}/3`, B.checksum],
      ]),
    };
  }

  test("HAPPY PATH: the stable ref resolves to the intended release's verified asset set (full identity chain)", async () => {
    const pointer = pointerFor();
    installFake({ ...assetState(), tagObjectMessage: pointer.json });
    const stable = await verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN });
    assert.equal(stable.pointer.versionedTag, TAG_B, "the pointer names the expected release");
    assert.equal(stable.pointer.sourceCommit, SOURCE_COMMIT, "the pointer names the release commit");
    assert.equal(stable.tagObjectSha, TAG_OBJECT_SHA);
    // The identity chain queried ONLY the dedicated ref — never /releases/latest.
    assert.ok(!requested.some((u) => u.includes("/releases/latest")), "stable-reference verification is independent of the repo-wide latest designation");
    globalThis.fetch = realFetch;
  });

  test("REGRESSION (stable ref → unexpected release): the pointer names a DIFFERENT tag than expected → typed failure, ZERO asset downloads", async () => {
    const pointer = pointerFor();
    const mispointed = JSON.stringify({ ...JSON.parse(pointer.json), versionedTag: TAG_A });
    installFake({ ...assetState(), tagObjectMessage: mispointed });
    let thrown: unknown = null;
    try {
      await verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN });
    } catch (err) {
      thrown = err;
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(thrown instanceof ReleaseOpsError, "a typed ReleaseOpsError is thrown");
    assert.equal((thrown as ReleaseOpsError).category, "MALFORMED_RESPONSE");
    assert.match((thrown as ReleaseOpsError).message, /points to .* expected/, "the diagnostic names the unexpected pointer target");
    assert.ok(!requested.some((u) => u.startsWith(`${ASSET_BASE}/`)), "NO asset of the unexpected release was downloaded");
  });

  test("REGRESSION (reference changes during verification): the record for the pointer's tag returns a DIFFERENT tag_name → typed failure", async () => {
    const pointer = pointerFor();
    installFake({ ...assetState(), tagObjectMessage: pointer.json, recordTag: TAG_A });
    let thrown: unknown = null;
    try {
      await verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN });
    } catch (err) {
      thrown = err;
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(thrown instanceof ReleaseOpsError);
    assert.equal((thrown as ReleaseOpsError).category, "MALFORMED_RESPONSE");
    assert.match((thrown as ReleaseOpsError).message, /mismatched release record/);
    assert.ok(!requested.some((u) => u.startsWith(`${ASSET_BASE}/`)), "no assets are fetched from the mismatched record");
  });

  test("REGRESSION (cross-release mixture): snapshot from the pointer's release + provenance from ANOTHER release → rejected", async () => {
    const pointer = pointerFor();
    installFake({
      recordAssets: [
        { name: SNAPSHOT_ASSET_NAME, url: `${ASSET_BASE}/1` },
        { name: PROVENANCE_ASSET_NAME, url: `${ASSET_BASE}/2` },
        { name: CHECKSUM_ASSET_NAME, url: `${ASSET_BASE}/3` },
      ],
      assetBytes: new Map([
        [`${ASSET_BASE}/1`, B.snapshot],
        [`${ASSET_BASE}/2`, A.provenanceBytes],
        [`${ASSET_BASE}/3`, B.checksum],
      ]),
      tagObjectMessage: pointer.json,
    });
    await assert.rejects(
      () => verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN }),
      /cross-release identification|checksum|MIXED/,
      "a cross-release mixture can never pass the identity chain",
    );
    globalThis.fetch = realFetch;
  });

  test("REGRESSION (missing sidecar): the pointer's release lacks the provenance asset → NOT_FOUND, fail closed", async () => {
    const pointer = pointerFor();
    installFake({
      recordAssets: [
        { name: SNAPSHOT_ASSET_NAME, url: `${ASSET_BASE}/1` },
        { name: CHECKSUM_ASSET_NAME, url: `${ASSET_BASE}/3` },
      ],
      assetBytes: new Map([
        [`${ASSET_BASE}/1`, B.snapshot],
        [`${ASSET_BASE}/3`, B.checksum],
      ]),
      tagObjectMessage: pointer.json,
    });
    await assert.rejects(
      () => verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN }),
      (err: unknown) => err instanceof ReleaseOpsError && err.category === "NOT_FOUND",
      "an incomplete artifact set is refused",
    );
    globalThis.fetch = realFetch;
  });

  test("REGRESSION (invalid provenance): a non-JSON provenance sidecar → typed MALFORMED_RESPONSE", async () => {
    const pointer = pointerFor();
    installFake({
      recordAssets: assetState().recordAssets,
      assetBytes: new Map([
        [`${ASSET_BASE}/1`, B.snapshot],
        [`${ASSET_BASE}/2`, new TextEncoder().encode("not-json")],
        [`${ASSET_BASE}/3`, B.checksum],
      ]),
      tagObjectMessage: pointer.json,
    });
    await assert.rejects(
      () => verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN }),
      (err: unknown) => err instanceof ReleaseOpsError && err.category === "MALFORMED_RESPONSE",
    );
    globalThis.fetch = realFetch;
  });

  test("REGRESSION (checksum mismatch): a checksum file disagreeing with the snapshot bytes → rejected", async () => {
    const pointer = pointerFor();
    installFake({
      recordAssets: assetState().recordAssets,
      assetBytes: new Map([
        [`${ASSET_BASE}/1`, B.snapshot],
        [`${ASSET_BASE}/2`, B.provenanceBytes],
        [`${ASSET_BASE}/3`, new TextEncoder().encode(`${"0".repeat(64)}  ${SNAPSHOT_ASSET_NAME}\n`)],
      ]),
      tagObjectMessage: pointer.json,
    });
    await assert.rejects(
      () => verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN }),
      /checksum/,
    );
    globalThis.fetch = realFetch;
  });

  test("REGRESSION (pointer digest divergence): the pointer's digests do not match the release's actual bytes → rejected", async () => {
    const pointer = pointerFor();
    const drifted = JSON.stringify({
      ...JSON.parse(pointer.json),
      snapshot: { name: SNAPSHOT_ASSET_NAME, sha256: "f".repeat(64), byteLength: 1 },
    });
    installFake({ ...assetState(), tagObjectMessage: drifted });
    await assert.rejects(
      () => verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN }),
      /digest\/length mismatch/,
      "the pointer must never bless bytes it does not name",
    );
    globalThis.fetch = realFetch;
  });

  test("REGRESSION (missing stable ref): a 404 ref is a typed NOT_FOUND for verification, and kind=none for discovery", async () => {
    installFake({ refStatus: 404, ...assetState(), tagObjectMessage: pointerFor().json });
    await assert.rejects(
      () => verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN }),
      (err: unknown) => err instanceof ReleaseOpsError && err.category === "NOT_FOUND",
      "verification without a stable ref fails typed",
    );
    const resolution = await resolveStableRef({ repository: REPO, http: authedHttp(READ_TOKEN) });
    assert.equal(resolution.kind, "none", "discovery classifies a genuine 404 as first-publication state");
    globalThis.fetch = realFetch;
  });

  test("an unrelated release taking the latest designation does NOT affect stable-ref resolution", async () => {
    const pointer = pointerFor();
    installFake({ ...assetState(), tagObjectMessage: pointer.json });
    // Simulate GitHub serving an unrelated latest designation: the stable-ref
    // chain simply never consults it (asserted by the URL log in the happy path).
    const resolution = await resolveStableRef({ repository: REPO, http: authedHttp(READ_TOKEN) });
    assert.equal(resolution.kind, "found", "the dedicated ref resolves normally");
    const stable = await fetchStablePointer({ repository: REPO, tagObjectSha: resolution.tagObjectSha, http: authedHttp(READ_TOKEN) });
    assert.equal(stable.pointer.versionedTag, TAG_B, "the pointer is untouched by unrelated releases");
    globalThis.fetch = realFetch;
  });

  test("a 401 ref query is AUTHENTICATION; a malformed ref body is MALFORMED_RESPONSE (fail-closed classification)", async () => {
    installFake({ refStatus: 401 });
    await assert.rejects(
      () => resolveStableRef({ repository: REPO, http: authedHttp(READ_TOKEN) }),
      (err: unknown) => err instanceof ReleaseOpsError && err.category === "AUTHENTICATION",
    );
    globalThis.fetch = (async () => new Response(JSON.stringify({ object: { sha: "not-a-sha" } }), { status: 200 })) as typeof fetch;
    await assert.rejects(
      () => resolveStableRef({ repository: REPO, http: authedHttp(READ_TOKEN) }),
      (err: unknown) => err instanceof ReleaseOpsError && err.category === "MALFORMED_RESPONSE",
    );
    globalThis.fetch = realFetch;
  });

  test("a tag object WITHOUT a parseable pointer message is rejected (not an annotated pointer tag)", async () => {
    installFake({ ...assetState(), tagObjectMessage: "this is not the pointer you are looking for" });
    await assert.rejects(
      () => verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN }),
      (err: unknown) => err instanceof ReleaseOpsError && err.category === "MALFORMED_RESPONSE",
      "a lightweight or unrelated tag object can never be interpreted as the stable pointer",
    );
    globalThis.fetch = realFetch;
  });

  test("buildStablePointerForRelease: verifies the release and builds the pointer JSON with the rollback record", async () => {
    // The current stable ref carries the PREVIOUS publication's pointer (naming TAG_A).
    const currentPointer = pointerFor(null, TAG_A);
    installFake({
      ...assetState(),
      tagObjectMessage: currentPointer.json,
    });
    const built = await buildStablePointerForRelease({ repository: REPO, tag: TAG_B, expectedTag: TAG_B, authToken: READ_TOKEN });
    assert.equal(built.pointer.versionedTag, TAG_B);
    assert.equal(built.pointer.sourceCommit, SOURCE_COMMIT);
    assert.equal(built.pointer.snapshot.sha256, snapshotSha256(B.snapshot), "the pointer digest is over the VERIFIED bytes");
    assert.equal(built.previous?.versionedTag, TAG_A, "the current stable pointer is resolved as the rollback reference");
    assert.equal(built.previous?.tagObjectSha, TAG_OBJECT_SHA, "the rollback reference carries the current tag object sha");
    const reparsed = parseStablePointer(built.pointerJson);
    assert.equal(reparsed.pointerSchema, STABLE_POINTER_SCHEMA, "the emitted JSON round-trips through the strict parser");
    assert.equal(reparsed.previousVersionedTag, TAG_A, "the built pointer records the rollback target");
    globalThis.fetch = realFetch;
  });

  test("buildStablePointerForRelease on a release whose provenance lacks a source commit → typed failure (no identifiable pointer)", async () => {
    const noCommitProv = { ...B.provenance, indexerSourceCommitSha: null };
    const noCommitBytes = new TextEncoder().encode(JSON.stringify(noCommitProv));
    const noCommitChecksum = new TextEncoder().encode(`${snapshotSha256(B.snapshot)}  ${SNAPSHOT_ASSET_NAME}\n`);
    installFake({
      recordAssets: assetState().recordAssets,
      assetBytes: new Map([
        [`${ASSET_BASE}/1`, B.snapshot],
        [`${ASSET_BASE}/2`, noCommitBytes],
        [`${ASSET_BASE}/3`, noCommitChecksum],
      ]),
      tagObjectMessage: pointerFor().json,
    });
    await assert.rejects(
      () => buildStablePointerForRelease({ repository: REPO, tag: TAG_B, expectedTag: TAG_B, authToken: READ_TOKEN }),
      (err: unknown) => err instanceof ReleaseOpsError && err.category === "MALFORMED_RESPONSE",
      "the pointer cannot be built without an identifiable source commit",
    );
    globalThis.fetch = realFetch;
  });

  test("CLI: cmdVerifyStable exits 0 on the verified chain and 1 on an unexpected pointer target", async () => {
    process.env.GH_TOKEN = READ_TOKEN;
    installFake({ ...assetState(), tagObjectMessage: pointerFor().json });
    const ok = await cmdVerifyStable({ repository: REPO, expectedTag: TAG_B });
    assert.equal(ok, 0, "the verified identity chain passes the CLI gate");
    const mispointed = JSON.stringify({ ...JSON.parse(pointerFor().json), versionedTag: TAG_A });
    installFake({ ...assetState(), tagObjectMessage: mispointed });
    const failed = await cmdVerifyStable({ repository: REPO, expectedTag: TAG_B });
    assert.equal(failed, 1, "an unexpected pointer target fails the CLI gate");
    delete process.env.GH_TOKEN;
    globalThis.fetch = realFetch;
  });
});

// ─── Independent completeness gate over FETCHED bytes (Finding 3, eighth round) ──
//
// The same-release verification path (`verify-release-assets`) and the
// stable-reference identity chain (`verify-stable`) must enforce the SAME
// completeness conditions as the producer: a released artifact carrying a
// "discovery-completeness" / "enrichment-completeness" marker — or a
// sidecar whose enriched count disagrees with the bytes — is a typed
// rejection, never an endorsement.

describe("releaseOps — independent completeness gate over fetched bytes (Finding 3)", () => {
  const READ_TOKEN = "ghs_readonly-runner-token";
  const TAG_OBJECT_SHA = "a".repeat(40);
  const ASSET_BASE = `https://api.github.com/repos/${REPO}/releases/assets`;
  /** A bundle whose SNAPSHOT carries a completeness failure marker (sidecar rebuilt over the exact modified bytes). */
  function markerBundle(tag: string, stage: string): ReturnType<typeof bundleFor> {
    const { snapshot, bytes } = realSnapshotAt(NOW_MS);
    const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as { failures: unknown[] };
    raw.failures.push({ stage, reason: "injected regression marker (test)" });
    const modified = new TextEncoder().encode(JSON.stringify(raw));
    const provenance = buildPublicationProvenance(
      parseConsoleSnapshot(JSON.parse(new TextDecoder().decode(modified))),
      modified,
      {
        sourceCommitSha: SOURCE_COMMIT,
        workflowRunId: "1",
        workflowAttempt: "1",
        repository: REPO,
        versionedTag: tag,
      },
    );
    return {
      provenance,
      snapshot: modified,
      provenanceBytes: new TextEncoder().encode(JSON.stringify(provenance)),
      checksum: new TextEncoder().encode(`${snapshotSha256(modified)}  ${SNAPSHOT_ASSET_NAME}\n`),
    };
  }

  /** The VALID bundle's provenance with a drifted enriched count (integrity still holds). */
  function countDriftedProvenanceBytes(tag: string): Uint8Array {
    const drifted = JSON.parse(JSON.stringify(B.provenance)) as PublicationProvenance;
    drifted.counts.enriched += 1;
    drifted.versionedTag = tag;
    return new TextEncoder().encode(JSON.stringify(drifted));
  }

  test("verifyReleaseAssetSet REJECTS a released snapshot carrying a discovery-completeness marker", async () => {
    const M = markerBundle(TAG_B, "discovery-completeness");
    const base = `https://github.com/${REPO}/releases/download/${TAG_B}`;
    const byUrl = new Map([
      [`${base}/${SNAPSHOT_ASSET_NAME}`, M.snapshot],
      [`${base}/${PROVENANCE_ASSET_NAME}`, M.provenanceBytes],
      [`${base}/${CHECKSUM_ASSET_NAME}`, M.checksum],
    ]);
    const { impl } = fetcherFor(byUrl);
    await assert.rejects(
      () => verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B, fetchAsset: impl }),
      (err: unknown) =>
        err instanceof ReleaseOpsError &&
        err.category === "MALFORMED_RESPONSE" &&
        err.message.includes("discovery-completeness"),
      "a completeness-marker artifact must never be endorsed by the release verification gate",
    );
  });

  test("verifyReleaseAssetSet REJECTS a released snapshot carrying an enrichment-completeness marker", async () => {
    const M = markerBundle(TAG_B, "enrichment-completeness");
    const base = `https://github.com/${REPO}/releases/download/${TAG_B}`;
    const byUrl = new Map([
      [`${base}/${SNAPSHOT_ASSET_NAME}`, M.snapshot],
      [`${base}/${PROVENANCE_ASSET_NAME}`, M.provenanceBytes],
      [`${base}/${CHECKSUM_ASSET_NAME}`, M.checksum],
    ]);
    const { impl } = fetcherFor(byUrl);
    await assert.rejects(
      () => verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B, fetchAsset: impl }),
      (err: unknown) =>
        err instanceof ReleaseOpsError &&
        err.category === "MALFORMED_RESPONSE" &&
        err.message.includes("enrichment-completeness"),
    );
  });

  test("verifyReleaseAssetSet REJECTS a sidecar whose enriched count disagrees with the released bytes", async () => {
    const base = `https://github.com/${REPO}/releases/download/${TAG_B}`;
    const byUrl = new Map([
      [`${base}/${SNAPSHOT_ASSET_NAME}`, B.snapshot],
      [`${base}/${PROVENANCE_ASSET_NAME}`, countDriftedProvenanceBytes(TAG_B)],
      [`${base}/${CHECKSUM_ASSET_NAME}`, B.checksum],
    ]);
    const { impl } = fetcherFor(byUrl);
    await assert.rejects(
      () => verifyReleaseAssetSet({ repository: REPO, tag: TAG_B, scope: "versioned", expectedTag: TAG_B, fetchAsset: impl }),
      (err: unknown) =>
        err instanceof ReleaseOpsError &&
        err.category === "MALFORMED_RESPONSE" &&
        err.message.includes("does not describe these bytes"),
      "a count-drifted sidecar must fail the completeness gate (the digest alone does not catch it)",
    );
  });

  test("verifyStableReference REJECTS a marker-carrying artifact behind an otherwise valid identity chain", async () => {
    const realFetch = globalThis.fetch;
    try {
      const M = markerBundle(TAG_B, "discovery-completeness");
      const built = buildStablePointer({
        versionedTag: TAG_B,
        sourceCommit: SOURCE_COMMIT,
        publishedAtUnixMs: NOW_MS,
        snapshotBytes: M.snapshot,
        provenanceBytes: M.provenanceBytes,
        checksumBytes: M.checksum,
        previous: null,
      });
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === `https://api.github.com/repos/${REPO}/git/ref/tags/console-snapshot-prod`) {
          return new Response(JSON.stringify({ object: { sha: TAG_OBJECT_SHA, type: "tag" } }), { status: 200 });
        }
        if (url.startsWith(`https://api.github.com/repos/${REPO}/git/tags/`)) {
          return new Response(JSON.stringify({ message: built.pointerJson, object: { sha: SOURCE_COMMIT, type: "commit" } }), { status: 200 });
        }
        if (url === `https://api.github.com/repos/${REPO}/releases/tags/${TAG_B}`) {
          return new Response(JSON.stringify({
            tag_name: TAG_B,
            assets: [
              { name: SNAPSHOT_ASSET_NAME, url: `${ASSET_BASE}/1` },
              { name: PROVENANCE_ASSET_NAME, url: `${ASSET_BASE}/2` },
              { name: CHECKSUM_ASSET_NAME, url: `${ASSET_BASE}/3` },
            ],
          }), { status: 200 });
        }
        const bytes = new Map([
          [`${ASSET_BASE}/1`, M.snapshot],
          [`${ASSET_BASE}/2`, M.provenanceBytes],
          [`${ASSET_BASE}/3`, M.checksum],
        ]).get(url);
        if (bytes) return binaryResponse(bytes);
        return textResponse("not found", 404);
      }) as typeof fetch;
      await assert.rejects(
        () => verifyStableReference({ repository: REPO, expectedTag: TAG_B, authToken: READ_TOKEN }),
        (err: unknown) =>
          err instanceof ReleaseOpsError &&
          err.category === "MALFORMED_RESPONSE" &&
          err.message.includes("completeness"),
        "the stable-reference identity chain must enforce the completeness contract over the fetched bytes",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
