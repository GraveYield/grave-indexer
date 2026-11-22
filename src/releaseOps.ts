// SPDX-License-Identifier: Apache-2.0
//
// Hardened GitHub release operations for the snapshot publication workflow
// (PR #5 remediation — review Tasks 4 and 5).
//
// TWO PROBLEMS THIS MODULE FIXES:
//
//   1. ROLLBACK-POINTER DISCOVERY SUPPRESSED ERRORS (review Task 4). The
//      workflow previously read the current latest release with
//      `gh api ... 2>/dev/null || echo ""` — ANY failure (authentication,
//      permission, rate limit, outage, malformed response) was silently
//      reinterpreted as "no previous release exists". That corrupts the
//      rollback record and can hide an outage behind a bogus
//      "first publication" label. `resolveLatestRelease` classifies the
//      exact HTTP outcome: only a genuine 404 means "no published
//      releases"; every other failure is a TYPED error the workflow must
//      abort on. There is no catch-all suppression.
//
//   2. MULTI-ASSET VERIFICATION ACROSS SEPARATE LATEST-URL DOWNLOADS
//      (review Task 5). The workflow previously downloaded snapshot,
//      provenance and checksum through three independent
//      `/releases/latest/download/...` requests. Those requests can
//      resolve to DIFFERENT releases if the repo-wide latest pointer
//      moves between them — a mixed artifact set could then pass naive
//      per-file checks. `verifyReleaseAssetSet` closes this: it fetches
//      the three files and REQUIRES them to be mutually consistent AND
//      attributable to ONE exact versioned release:
//        * the checksum file must match the EXACT snapshot bytes;
//        * the provenance sidecar must verify over the EXACT snapshot
//          bytes (SHA-256 + byte length);
//        * the provenance sidecar must NAME the expected versioned tag —
//          provenance is the release's self-identification, so any file
//          from a different release is detected (only the activated
//          release's provenance carries its tag);
//        * for `scope: "latest"` the caller must ALSO confirm the
//          repo-wide latest designation resolves to the intended
//          versioned release (see `cmdVerifyReleaseAssets`), so a pointer
//          that moved between fetch and API query fails the run.
//
//   3. PRIVATE-REPOSITORY ASSET VERIFICATION (fourth-round correction).
//      The owner changed `GraveYield/grave-indexer` visibility to PRIVATE
//      and provisioned a fine-grained release PAT as the repository
//      secret `GY_RELEASE_PAT`. A private release asset 404s for
//      unauthenticated requests, so the same-release verification gates
//      can no longer fetch through the unauthenticated
//      `releases/download/...` URLs. When the caller supplies a token,
//      `verifyReleaseAssetSet` switches to the DOCUMENTED authenticated
//      path: the release record is resolved through the REST API and the
//      three assets are downloaded through their `api.github.com` asset
//      URLs with `Accept: application/octet-stream` — the mechanism `gh
//      release download` itself uses. The verification jobs supply the
//      READ-ONLY automatic workflow token for this; the release-write PAT
//      is never present in those jobs.
//
// DESIGN RULES:
//   * GitHub-side operations are injectable (`HttpImpl`, `FetchAssetImpl`)
//     so every behavior is offline-testable.
//   * No token ever enters a URL, log line, or error message. The token
//     is passed as a request header by the CALLER-provided http impl.
//   * All error categories are enumerated and pinned by tests; unknown
//     HTTP statuses are UNEXPECTED_STATUS (fail-closed), never "none".

import {
  CHECKSUM_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  SnapshotPublicationError,
  STABLE_TAG,
  verifySnapshotIntegrity,
  verifyRawArtifactCompleteness,
  stableProvenanceUrl,
  stableRefApiUrl,
  stableSnapshotUrl,
  stableTagObjectApiUrl,
  verifyChecksumFile,
  versionedAssetUrl,
  buildStablePointer,
  parseStablePointer,
  verifyStablePointerMatchesArtifacts,
  type PublicationProvenance,
  type StablePointerV1,
} from "./snapshotPublication.js";

// ─── Error taxonomy ────────────────────────────────────────────────────────

/** Every distinct failure mode of the GitHub release API interaction. */
export type ReleaseOpsErrorCategory =
  | "AUTHENTICATION" // 401 — bad/expired credentials
  | "PERMISSION" // 403 without rate-limit exhaustion — token lacks access
  | "RATE_LIMIT" // 403 with x-ratelimit-remaining: 0, or 429
  | "API_OUTAGE" // 5xx from api.github.com
  | "NETWORK" // fetch itself threw (DNS, TLS, connection reset)
  | "MALFORMED_RESPONSE" // 200 but body is not JSON / wrong shape
  | "NOT_FOUND" // 404 where the queried release/asset MUST exist (authenticated verification)
  | "UNEXPECTED_STATUS"; // any other HTTP status — fail closed, never guess

const RELEASE_OPS_CATEGORIES: readonly ReleaseOpsErrorCategory[] = [
  "AUTHENTICATION",
  "PERMISSION",
  "RATE_LIMIT",
  "API_OUTAGE",
  "NETWORK",
  "MALFORMED_RESPONSE",
  "NOT_FOUND",
  "UNEXPECTED_STATUS",
];

/** Typed error carrying the failure category and (when known) HTTP status. */
export class ReleaseOpsError extends Error {
  constructor(
    public readonly category: ReleaseOpsErrorCategory,
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(`release-ops [${category}]${httpStatus !== null ? ` (HTTP ${httpStatus})` : ""}: ${message}`);
    this.name = "ReleaseOpsError";
  }
}

/** Test exhaustiveness pin: every category must stay constructible and listed. */
export const RELEASE_OPS_ERROR_CATEGORIES = RELEASE_OPS_CATEGORIES;

// ─── Injectable HTTP plumbing ──────────────────────────────────────────────

/**
 * Minimal HTTP response surface (compatible with the global `Response`).
 * `headers.get` is case-insensitive, like the real spec.
 */
export interface MinimalHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type HttpImpl = (url: string, init?: { headers?: Record<string, string> }) => Promise<MinimalHttpResponse>;

/** Default transport: global fetch, redirect-following, JSON accept header. */
export const defaultHttp: HttpImpl = (url, init) =>
  fetch(url, {
    redirect: "follow",
    headers: { accept: "application/vnd.github+json", ...(init?.headers ?? {}) },
  });

/**
 * Build an http impl that authenticates GitHub API calls with a bearer
 * token. The token NEVER enters a URL or a message — it is attached as
 * the Authorization header only.
 */
export function authedHttp(token: string): HttpImpl {
  return (url, init) =>
    defaultHttp(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
}

/** Injectable asset downloader (compatible with global fetch). */
export type FetchAssetImpl = (url: string) => Promise<Uint8Array>;

async function fetchAssetWithHeaders(url: string, headers: Record<string, string>): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", headers });
  } catch (err) {
    throw new ReleaseOpsError("NETWORK", `asset fetch failed: ${String((err as Error).message ?? err)}`);
  }
  if (res.status !== 200) {
    throw new ReleaseOpsError("UNEXPECTED_STATUS", `asset fetch ${url} returned HTTP ${res.status}`, res.status);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Default unauthenticated asset downloader (redirect-following, 200-only). */
export const defaultFetchAsset: FetchAssetImpl = (url) => fetchAssetWithHeaders(url, {});

// ─── 1. Rollback-pointer discovery (review Task 4) ─────────────────────────

/**
 * The outcome of looking at the repository-wide latest-release pointer.
 * `kind: "none"` is produced EXCLUSIVELY by a genuine HTTP 404 from the
 * latest-release endpoint — GitHub's unambiguous "no published
 * (non-draft, non-prerelease) releases exist" response. Every other
 * failure is a thrown `ReleaseOpsError`; nothing is reinterpreted.
 */
export type LatestReleaseResolution =
  | { kind: "none"; detail: string }
  | { kind: "found"; tag: string };

/**
 * Resolve the current latest release of `repository`.
 *
 * Status classification (fail-closed — an unknown status never degrades
 * into "no previous release"):
 *   * 200 → validate the body is an object with a non-empty string
 *     `tag_name` → `{kind:"found", tag}`; anything else is
 *     MALFORMED_RESPONSE.
 *   * 404 → `{kind:"none"}` — genuine first publication.
 *   * 401 → AUTHENTICATION. 403 → RATE_LIMIT when the rate-limit budget
 *     is exhausted (`x-ratelimit-remaining: 0`), otherwise PERMISSION.
 *   * 429 → RATE_LIMIT. 5xx → API_OUTAGE. Network throw → NETWORK.
 *   * Everything else → UNEXPECTED_STATUS.
 */
export async function resolveLatestRelease(args: {
  repository: string;
  http?: HttpImpl;
}): Promise<LatestReleaseResolution> {
  const http = args.http ?? defaultHttp;
  const url = `https://api.github.com/repos/${args.repository}/releases/latest`;
  let res: MinimalHttpResponse;
  try {
    res = await http(url);
  } catch (err) {
    throw new ReleaseOpsError("NETWORK", `latest-release query failed: ${String((err as Error).message ?? err)}`);
  }
  if (res.status === 404) {
    return { kind: "none", detail: "HTTP 404 from /releases/latest — no published releases exist (genuine first publication)" };
  }
  if (res.status === 200) {
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", `latest-release response is not JSON: ${String((err as Error).message ?? err)}`, 200);
    }
    if (typeof body !== "object" || body === null) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", "latest-release response is not a JSON object", 200);
    }
    const tag = (body as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string" || tag.length === 0) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", "latest-release response carries no usable tag_name", 200);
    }
    return { kind: "found", tag };
  }
  if (res.status === 401) {
    throw new ReleaseOpsError("AUTHENTICATION", "latest-release query rejected the credentials", 401);
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 429 || remaining === "0") {
      throw new ReleaseOpsError("RATE_LIMIT", "GitHub API rate limit exhausted during latest-release discovery", res.status);
    }
    throw new ReleaseOpsError("PERMISSION", "latest-release query was denied (token lacks repository access)", res.status);
  }
  if (res.status >= 500) {
    throw new ReleaseOpsError("API_OUTAGE", `api.github.com unavailable (HTTP ${res.status})`, res.status);
  }
  throw new ReleaseOpsError("UNEXPECTED_STATUS", `latest-release query returned an unexpected HTTP status`, res.status);
}

// ─── 2. Same-release asset verification (review Task 5) ────────────────────

/** Which URL family the three assets are fetched through. */
export type AssetScope = "versioned" | "latest";

function assetUrls(repository: string, tag: string, scope: AssetScope): { snapshot: string; provenance: string; checksum: string } {
  if (scope === "versioned") {
    return {
      snapshot: versionedAssetUrl(repository, tag, SNAPSHOT_ASSET_NAME),
      provenance: versionedAssetUrl(repository, tag, PROVENANCE_ASSET_NAME),
      checksum: versionedAssetUrl(repository, tag, CHECKSUM_ASSET_NAME),
    };
  }
  return {
    snapshot: stableSnapshotUrl(repository),
    provenance: stableProvenanceUrl(repository),
    checksum: stableProvenanceUrl(repository).replace(PROVENANCE_ASSET_NAME, CHECKSUM_ASSET_NAME),
  };
}

/** Minimal shape of a GitHub release record the verification consumes. */
interface ReleaseRecord {
  tag_name?: unknown;
  assets?: Array<{ name?: unknown; url?: unknown }>;
}

/**
 * Resolve a release record through the REST API (authenticated http impl)
 * and classify the outcome fail-closed. Used by the authenticated
 * verification path: on a private repository the release record itself is
 * also unreachable for unauthenticated requests.
 */
async function fetchReleaseRecord(repository: string, byTag: string | null, http: HttpImpl): Promise<ReleaseRecord> {
  const url = byTag === null
    ? `https://api.github.com/repos/${repository}/releases/latest`
    : `https://api.github.com/repos/${repository}/releases/tags/${byTag}`;
  let res: MinimalHttpResponse;
  try {
    res = await http(url);
  } catch (err) {
    throw new ReleaseOpsError("NETWORK", `release lookup failed: ${String((err as Error).message ?? err)}`);
  }
  if (res.status === 404) {
    throw new ReleaseOpsError("NOT_FOUND", `release lookup returned HTTP 404 — the ${byTag === null ? "latest designation" : `release for tag ${byTag}`} does not exist (private repository: unauthenticated requests also 404)`, 404);
  }
  if (res.status === 401) {
    throw new ReleaseOpsError("AUTHENTICATION", "release lookup rejected the credentials", 401);
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 429 || remaining === "0") {
      throw new ReleaseOpsError("RATE_LIMIT", "GitHub API rate limit exhausted during release lookup", res.status);
    }
    throw new ReleaseOpsError("PERMISSION", "release lookup was denied (token lacks repository access)", res.status);
  }
  if (res.status >= 500) {
    throw new ReleaseOpsError("API_OUTAGE", `api.github.com unavailable during release lookup (HTTP ${res.status})`, res.status);
  }
  if (res.status !== 200) {
    throw new ReleaseOpsError("UNEXPECTED_STATUS", `release lookup returned an unexpected HTTP status`, res.status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ReleaseOpsError("MALFORMED_RESPONSE", `release lookup response is not JSON: ${String((err as Error).message ?? err)}`, 200);
  }
  if (typeof body !== "object" || body === null) {
    throw new ReleaseOpsError("MALFORMED_RESPONSE", "release lookup response is not a JSON object", 200);
  }
  return body as ReleaseRecord;
}

/**
 * Fetch one asset's RAW bytes through its api.github.com asset URL with
 * `Accept: application/octet-stream` — the documented authenticated
 * download path for release assets, including on private repositories
 * (this is what `gh release download` uses). The token travels ONLY as
 * the Authorization request header — never in a URL, log line or error
 * message. Redirects to the signed asset host drop the Authorization
 * header per the fetch spec; the signed URL requires none.
 */
async function fetchAssetOctetStream(url: string, token: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { accept: "application/octet-stream", authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new ReleaseOpsError("NETWORK", `asset fetch failed: ${String((err as Error).message ?? err)}`);
  }
  if (res.status !== 200) {
    throw new ReleaseOpsError("UNEXPECTED_STATUS", `asset fetch returned HTTP ${res.status}`, res.status);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Fetch the three assets THROUGH the release record's `api.github.com`
 * asset URLs. Every wanted asset must exist BY NAME on the record — an
 * incomplete artifact set fails closed.
 */
async function fetchAssetsFromRecord(
  record: ReleaseRecord,
  token: string,
): Promise<{ snapshotBytes: Uint8Array; provenanceBytes: Uint8Array; checksumBytes: Uint8Array }> {
  const assets = Array.isArray(record.assets) ? record.assets : [];
  const byName = new Map<string, string>();
  for (const asset of assets) {
    if (typeof asset?.name === "string" && typeof asset?.url === "string") {
      byName.set(asset.name, asset.url);
    }
  }
  const wanted: Array<[string, "snapshot" | "provenance" | "checksum"]> = [
    [SNAPSHOT_ASSET_NAME, "snapshot"],
    [PROVENANCE_ASSET_NAME, "provenance"],
    [CHECKSUM_ASSET_NAME, "checksum"],
  ];
  const out: { snapshotBytes: Uint8Array; provenanceBytes: Uint8Array; checksumBytes: Uint8Array } = { snapshotBytes: new Uint8Array(), provenanceBytes: new Uint8Array(), checksumBytes: new Uint8Array() };
  for (const [name, slot] of wanted) {
    const assetUrl = byName.get(name);
    if (assetUrl === undefined) {
      throw new ReleaseOpsError("NOT_FOUND", `the release record does not contain the asset '${name}' — refusing to verify an incomplete artifact set`, 200);
    }
    const bytes = await fetchAssetOctetStream(assetUrl, token);
    if (slot === "snapshot") out.snapshotBytes = bytes;
    else if (slot === "provenance") out.provenanceBytes = bytes;
    else out.checksumBytes = bytes;
  }
  return out;
}

/**
 * The INDEPENDENT completeness gate over fetched bytes (eighth round —
 * review Finding 3): the verifier that inspects a released/staged
 * artifact enforces the SAME completeness conditions as the producer's
 * staging gate. The snapshot bytes are strictly parsed (a malformed
 * artifact never verifies), completeness failure stages
 * ("discovery-completeness" / "enrichment-completeness") are rejected,
 * the provenance's enriched count must be present and well-formed, and
 * it must EXACTLY equal the artifact's own enriched count. Any violation
 * is a typed MALFORMED_RESPONSE failure — never an endorsement.
 */
function verifyFetchedArtifactCompleteness(
  snapshotBytes: Uint8Array,
  provenance: PublicationProvenance,
): void {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(snapshotBytes).toString("utf8")) as unknown;
  } catch (err) {
    throw new ReleaseOpsError("MALFORMED_RESPONSE", `the released snapshot bytes are not JSON: ${String((err as Error).message ?? err)}`);
  }
  try {
    verifyRawArtifactCompleteness(raw, provenance);
  } catch (err) {
    if (err instanceof SnapshotPublicationError) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", `independent completeness verification failed: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Verify that the snapshot / provenance / checksum triple fetched through
 * `scope` URLs is ONE release's complete, internally consistent artifact
 * set naming `expectedTag`.
 *
 * TWO TRANSPORTS:
 *   * Unauthenticated (default): the three files are fetched through the
 *     `releases/download/...` URLs — valid only for a PUBLIC repository.
 *   * Authenticated (`authToken` supplied): the release record is
 *     resolved through the REST API and the three assets are downloaded
 *     through their api.github.com asset URLs with
 *     `Accept: application/octet-stream` — the documented private-repo-
 *     safe path. The credential must be a READ-scoped token (the
 *     verification jobs use the automatic workflow token; the release-
 *     write PAT is never present in verification jobs).
 *
 * WHY THIS IS RACE-SAFE (review Task 5): the three requests are issued
 * independently, so a concurrent promotion CAN deliver bytes from two
 * releases — but the provenance sidecar names its own release, so:
 *   * provenance from the old release  → `versionedTag` mismatch → fail;
 *   * provenance from the new release beside old snapshot/checksum →
 *     digest/length mismatch → fail;
 *   * ALL three from an unrelated release whose provenance happens to
 *     name `expectedTag` is impossible — only the release created for
 *     `expectedTag` carries a sidecar naming it.
 * The `scope: "latest"` caller additionally pins the repo-wide pointer
 * itself (see `cmdVerifyReleaseAssets`), so a pointer that moved between
 * the downloads and the designation query also fails.
 */
export async function verifyReleaseAssetSet(args: {
  repository: string;
  tag: string;
  scope: AssetScope;
  expectedTag: string;
  fetchAsset?: FetchAssetImpl;
  /** Read-scoped API token; switches to the private-repo-safe authenticated path. */
  authToken?: string;
}): Promise<void> {
  let snapshotBytes: Uint8Array;
  let provenanceBytes: Uint8Array;
  let checksumBytes: Uint8Array;
  if (args.authToken !== undefined) {
    const record = await fetchReleaseRecord(
      args.repository,
      args.scope === "versioned" ? args.tag : null,
      authedHttp(args.authToken),
    );
    // Record-identity gate, applied BEFORE any asset download (fifth-round
    // race fix): the fetched record must name the tag this verification is
    // authorized to inspect.
    //   * scope "versioned": the record must be the release `args.tag`.
    //   * scope "latest": the record must still be `args.expectedTag`.
    //     The caller (`cmdVerifyReleaseAssets`) already checked the latest
    //     designation, but between that check and THIS record lookup a
    //     concurrent promotion can move the repo-wide pointer. This gate
    //     closes that race: an unexpected record is rejected immediately —
    //     no asset is downloaded from it, the run does not retry against
    //     the new latest release, and the unexpected record is never
    //     treated as valid.
    const expectedRecordTag = args.scope === "versioned" ? args.tag : args.expectedTag;
    if (record.tag_name !== expectedRecordTag) {
      throw new ReleaseOpsError(
        "MALFORMED_RESPONSE",
        args.scope === "versioned"
          ? `release lookup returned tag_name ${String(record.tag_name ?? "<none>")}, expected ${args.tag} — refusing to verify a mismatched release record`
          : `latest-release lookup returned tag_name ${String(record.tag_name ?? "<none>")}, expected ${args.expectedTag} — the latest designation changed or resolved to an unexpected release between the designation check and the record lookup; refusing to download assets from an unexpected release`,
        200,
      );
    }
    ({ snapshotBytes, provenanceBytes, checksumBytes } = await fetchAssetsFromRecord(record, args.authToken));
  } else {
    const fetchAsset = args.fetchAsset ?? defaultFetchAsset;
    const urls = assetUrls(args.repository, args.tag, args.scope);
    // Three independent requests — exactly what a racing client or the
    // workflow would issue; the cross-checks below make any mixture detectable.
    snapshotBytes = await fetchAsset(urls.snapshot);
    provenanceBytes = await fetchAsset(urls.provenance);
    checksumBytes = await fetchAsset(urls.checksum);
  }

  // Checksum file must be sha256sum-compatible, must name the snapshot
  // asset, and must match the EXACT snapshot bytes we received.
  verifyChecksumFile(snapshotBytes, checksumBytes, SNAPSHOT_ASSET_NAME);

  // Provenance must parse, must verify over the exact snapshot bytes
  // (SHA-256 + byte length), and must NAME the expected versioned tag.
  let provenance: PublicationProvenance;
  try {
    provenance = JSON.parse(Buffer.from(provenanceBytes).toString("utf8")) as PublicationProvenance;
  } catch (err) {
    throw new ReleaseOpsError("MALFORMED_RESPONSE", `provenance sidecar is not JSON: ${String((err as Error).message ?? err)}`);
  }
  if (provenance.versionedTag !== args.expectedTag) {
    throw new ReleaseOpsError(
      "MALFORMED_RESPONSE",
      `provenance names release ${provenance.versionedTag ?? "<none>"}, expected ${args.expectedTag} — the fetched files are a MIXED artifact set`,
    );
  }
  try {
    verifySnapshotIntegrity(snapshotBytes, provenance);
  } catch (err) {
    if (err instanceof SnapshotPublicationError) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", `integrity verification failed: ${err.message}`);
    }
    throw err;
  }
  // Eighth round (Finding 3): the same-release verification gate ALSO
  // enforces the producer's completeness contract over the fetched bytes.
  verifyFetchedArtifactCompleteness(snapshotBytes, provenance);
}

// ─── 3. Dedicated stable reference — resolve, verify, build (sixth round) ──
//
// The owner-selected stable reference is the git ref
// `refs/tags/console-snapshot-prod`: an ANNOTATED tag whose tag-object
// message carries the stable-pointer JSON (graveyield.console-snapshot-
// stable-pointer.v1) naming ONE immutable versioned release. This module
// is strictly READ-ONLY: the ref mutations live in the workflow's
// privileged `gh api` steps (the release-ops bundle must never hold the
// release-write credential).
//
// IDENTITY CHAIN (every link fail-closed):
//   ref → tag object → parse pointer → pointer.versionedTag === expected
//   → release record by THAT tag (record.tag_name === pointer.versionedTag)
//   → assets from THAT exact record → checksum + provenance + integrity
//   → pointer digests must match the fetched bytes.

/** Outcome of resolving the dedicated stable reference. `kind: "none"` is
 * produced EXCLUSIVELY by a genuine HTTP 404 — "the ref does not exist
 * yet" (first publication). Every other failure is a thrown error. */
export type StableRefResolution =
  | { kind: "none"; detail: string }
  | { kind: "found"; tagObjectSha: string; objectType: string };

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Resolve the dedicated stable reference (`refs/tags/console-snapshot-prod`).
 * Same fail-closed classification as `resolveLatestRelease`: 404 = none,
 * 200 = found (tag object sha), everything else typed.
 */
export async function resolveStableRef(args: { repository: string; http?: HttpImpl }): Promise<StableRefResolution> {
  const http = args.http ?? defaultHttp;
  let res: MinimalHttpResponse;
  try {
    res = await http(stableRefApiUrl(args.repository));
  } catch (err) {
    throw new ReleaseOpsError("NETWORK", `stable-ref query failed: ${String((err as Error).message ?? err)}`);
  }
  if (res.status === 404) {
    return { kind: "none", detail: `HTTP 404 from git/ref/tags/${STABLE_TAG} — the stable reference does not exist yet (first publication)` };
  }
  if (res.status === 200) {
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", `stable-ref response is not JSON: ${String((err as Error).message ?? err)}`, 200);
    }
    if (typeof body !== "object" || body === null) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", "stable-ref response is not a JSON object", 200);
    }
    const object = (body as { object?: { sha?: unknown; type?: unknown } }).object;
    if (typeof object !== "object" || object === null || typeof object.sha !== "string" || !HEX40.test(object.sha)) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", "stable-ref response carries no usable object.sha", 200);
    }
    return {
      kind: "found",
      tagObjectSha: object.sha,
      objectType: typeof object.type === "string" ? object.type : "<unknown>",
    };
  }
  if (res.status === 401) {
    throw new ReleaseOpsError("AUTHENTICATION", "stable-ref query rejected the credentials", 401);
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 429 || remaining === "0") {
      throw new ReleaseOpsError("RATE_LIMIT", "GitHub API rate limit exhausted during stable-ref query", res.status);
    }
    throw new ReleaseOpsError("PERMISSION", "stable-ref query was denied (token lacks repository access)", res.status);
  }
  if (res.status >= 500) {
    throw new ReleaseOpsError("API_OUTAGE", `api.github.com unavailable during stable-ref query (HTTP ${res.status})`, res.status);
  }
  throw new ReleaseOpsError("UNEXPECTED_STATUS", `stable-ref query returned an unexpected HTTP status`, res.status);
}

/** The stable pointer plus the annotated tag object's identity. */
export interface StablePointerResolution {
  pointer: StablePointerV1;
  /** The annotated tag object sha this pointer was read from. */
  tagObjectSha: string;
  /** The commit the tag object points at (the versioned release's source commit). */
  commitSha: string;
}

/**
 * Fetch the annotated tag object behind the stable ref and parse its
 * message as the stable-pointer JSON. The message parse is strict
 * (`parseStablePointer`); any malformed message is a typed failure.
 */
export async function fetchStablePointer(args: {
  repository: string;
  tagObjectSha: string;
  http?: HttpImpl;
}): Promise<StablePointerResolution> {
  if (!HEX40.test(args.tagObjectSha)) {
    throw new ReleaseOpsError("MALFORMED_RESPONSE", `tag object sha ${JSON.stringify(args.tagObjectSha)} is not 40-hex — refusing to query`);
  }
  const http = args.http ?? defaultHttp;
  let res: MinimalHttpResponse;
  try {
    res = await http(stableTagObjectApiUrl(args.repository, args.tagObjectSha));
  } catch (err) {
    throw new ReleaseOpsError("NETWORK", `stable tag-object query failed: ${String((err as Error).message ?? err)}`);
  }
  if (res.status === 404) {
    throw new ReleaseOpsError("NOT_FOUND", `the stable-ref tag object ${args.tagObjectSha} does not exist — the ref is dangling; refusing to interpret`, 404);
  }
  if (res.status === 401) {
    throw new ReleaseOpsError("AUTHENTICATION", "stable tag-object query rejected the credentials", 401);
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 429 || remaining === "0") {
      throw new ReleaseOpsError("RATE_LIMIT", "GitHub API rate limit exhausted during stable tag-object query", res.status);
    }
    throw new ReleaseOpsError("PERMISSION", "stable tag-object query was denied (token lacks repository access)", res.status);
  }
  if (res.status >= 500) {
    throw new ReleaseOpsError("API_OUTAGE", `api.github.com unavailable during stable tag-object query (HTTP ${res.status})`, res.status);
  }
  if (res.status !== 200) {
    throw new ReleaseOpsError("UNEXPECTED_STATUS", `stable tag-object query returned an unexpected HTTP status`, res.status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ReleaseOpsError("MALFORMED_RESPONSE", `stable tag-object response is not JSON: ${String((err as Error).message ?? err)}`, 200);
  }
  if (typeof body !== "object" || body === null) {
    throw new ReleaseOpsError("MALFORMED_RESPONSE", "stable tag-object response is not a JSON object", 200);
  }
  const record = body as { message?: unknown; object?: { sha?: unknown } };
  if (typeof record.message !== "string" || record.message.length === 0) {
    throw new ReleaseOpsError("MALFORMED_RESPONSE", "stable tag-object carries no message — not an annotated pointer tag", 200);
  }
  let pointer: StablePointerV1;
  try {
    pointer = parseStablePointer(record.message);
  } catch (err) {
    if (err instanceof SnapshotPublicationError) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", `stable pointer parse failed: ${err.message}`, 200);
    }
    throw err;
  }
  const commitSha = record.object && typeof record.object.sha === "string" ? record.object.sha : "<none>";
  return { pointer, tagObjectSha: args.tagObjectSha, commitSha };
}

/** The verified versioned artifact triple (internal shared loader). */
interface VerifiedVersionedArtifacts {
  snapshotBytes: Uint8Array;
  provenanceBytes: Uint8Array;
  checksumBytes: Uint8Array;
  provenance: PublicationProvenance;
}

/**
 * Fetch a versioned release's OWN asset triple and verify it completely:
 * record identity, checksum file, provenance parse, provenance tag and
 * byte integrity. Shared by `verifyStableReference` and
 * `buildStablePointerForRelease`.
 */
async function loadVerifiedVersionedArtifacts(args: {
  repository: string;
  tag: string;
  expectedTag: string;
  authToken?: string;
}): Promise<VerifiedVersionedArtifacts> {
  const http = args.authToken !== undefined ? authedHttp(args.authToken) : defaultHttp;
  const record = await fetchReleaseRecord(args.repository, args.tag, http);
  if (record.tag_name !== args.tag) {
    throw new ReleaseOpsError(
      "MALFORMED_RESPONSE",
      `release lookup returned tag_name ${String(record.tag_name ?? "<none>")}, expected ${args.tag} — refusing to verify a mismatched release record`,
      200,
    );
  }
  let snapshotBytes: Uint8Array;
  let provenanceBytes: Uint8Array;
  let checksumBytes: Uint8Array;
  if (args.authToken !== undefined) {
    ({ snapshotBytes, provenanceBytes, checksumBytes } = await fetchAssetsFromRecord(record, args.authToken));
  } else {
    const urls = assetUrls(args.repository, args.tag, "versioned");
    snapshotBytes = await defaultFetchAsset(urls.snapshot);
    provenanceBytes = await defaultFetchAsset(urls.provenance);
    checksumBytes = await defaultFetchAsset(urls.checksum);
  }
  verifyChecksumFile(snapshotBytes, checksumBytes, SNAPSHOT_ASSET_NAME);
  let provenance: PublicationProvenance;
  try {
    provenance = JSON.parse(Buffer.from(provenanceBytes).toString("utf8")) as PublicationProvenance;
  } catch (err) {
    throw new ReleaseOpsError("MALFORMED_RESPONSE", `provenance sidecar is not JSON: ${String((err as Error).message ?? err)}`);
  }
  if (provenance.versionedTag !== args.expectedTag) {
    throw new ReleaseOpsError(
      "MALFORMED_RESPONSE",
      `provenance names release ${provenance.versionedTag ?? "<none>"}, expected ${args.expectedTag} — the fetched files are a MIXED artifact set`,
    );
  }
  try {
    verifySnapshotIntegrity(snapshotBytes, provenance);
  } catch (err) {
    if (err instanceof SnapshotPublicationError) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", `integrity verification failed: ${err.message}`);
    }
    throw err;
  }
  // Eighth round (Finding 3): completeness is enforced over the EXACT
  // fetched bytes everywhere — the stable-reference identity chain and
  // the versioned-release loader share this gate, so a released artifact
  // carrying a completeness failure marker (or a sidecar whose enriched
  // count disagrees with the bytes) can never be endorsed by
  // `verify-release-assets` or `verify-stable` either.
  verifyFetchedArtifactCompleteness(snapshotBytes, provenance);
  return { snapshotBytes, provenanceBytes, checksumBytes, provenance };
}

/**
 * Verify the DEDICATED stable reference end-to-end (sixth-round Task 4
 * identity chain). The stable reference must resolve to a concrete
 * versioned release identity, and the assets must be verified against
 * THAT exact identity — never against a moving alias:
 *
 *   1. the ref exists and its annotated tag object parses as a pointer;
 *   2. the pointer names EXACTLY `expectedTag` (an unexpected release is
 *      a typed failure — no assets are downloaded from it);
 *   3. the release record for the pointer's tag carries THAT tag;
 *   4. the three assets come from that exact record;
 *   5. checksum + provenance + integrity verify over the bytes;
 *   6. the pointer digests/lengths match the fetched bytes, the
 *      provenance names the pointer's tag, and the pointer's
 *      sourceCommit matches the provenance commit.
 */
export async function verifyStableReference(args: {
  repository: string;
  expectedTag: string;
  authToken?: string;
}): Promise<StablePointerResolution> {
  const http = args.authToken !== undefined ? authedHttp(args.authToken) : defaultHttp;
  const resolution = await resolveStableRef({ repository: args.repository, http });
  if (resolution.kind === "none") {
    throw new ReleaseOpsError("NOT_FOUND", `the dedicated stable reference (${STABLE_TAG}) does not exist — the stable pointer is missing`, 404);
  }
  const stable = await fetchStablePointer({ repository: args.repository, tagObjectSha: resolution.tagObjectSha, http });
  if (stable.pointer.versionedTag !== args.expectedTag) {
    throw new ReleaseOpsError(
      "MALFORMED_RESPONSE",
      `the stable reference points to ${stable.pointer.versionedTag}, expected ${args.expectedTag} — the stable reference resolved to an unexpected release; refusing to verify assets it does not name`,
      200,
    );
  }
  const artifacts = await loadVerifiedVersionedArtifacts({
    repository: args.repository,
    tag: stable.pointer.versionedTag,
    expectedTag: stable.pointer.versionedTag,
    ...(args.authToken !== undefined ? { authToken: args.authToken } : {}),
  });
  try {
    verifyStablePointerMatchesArtifacts({
      pointer: stable.pointer,
      snapshotBytes: artifacts.snapshotBytes,
      provenanceBytes: artifacts.provenanceBytes,
      checksumBytes: artifacts.checksumBytes,
      provenance: artifacts.provenance,
    });
  } catch (err) {
    if (err instanceof SnapshotPublicationError) {
      throw new ReleaseOpsError("MALFORMED_RESPONSE", `stable pointer identity verification failed: ${err.message}`);
    }
    throw err;
  }
  return stable;
}

/**
 * Verify a versioned release and BUILD the stable pointer JSON for it
 * (read-only preparation for the workflow's privileged activation step:
 * the bundle builds and emits the pointer; ONLY the workflow's `gh api`
 * steps — holding the release-write credential — create the tag object
 * and move the ref). Also resolves the CURRENT stable pointer as the
 * rollback reference (recorded BEFORE the mutation).
 */
export async function buildStablePointerForRelease(args: {
  repository: string;
  tag: string;
  expectedTag: string;
  authToken?: string;
  http?: HttpImpl;
}): Promise<{
  pointer: StablePointerV1;
  pointerJson: string;
  previous: { versionedTag: string; tagObjectSha: string } | null;
}> {
  const http = args.authToken !== undefined ? authedHttp(args.authToken) : (args.http ?? defaultHttp);
  const artifacts = await loadVerifiedVersionedArtifacts({
    repository: args.repository,
    tag: args.tag,
    expectedTag: args.expectedTag,
    ...(args.authToken !== undefined ? { authToken: args.authToken } : {}),
  });
  const sourceCommit = artifacts.provenance.indexerSourceCommitSha;
  if (sourceCommit === null || !HEX40.test(sourceCommit)) {
    throw new ReleaseOpsError(
      "MALFORMED_RESPONSE",
      `the provenance carries no usable source commit (${String(artifacts.provenance.indexerSourceCommitSha ?? "<none>")}) — the stable pointer cannot be built without one`,
      200,
    );
  }
  const resolution = await resolveStableRef({ repository: args.repository, http });
  let previous: { versionedTag: string; tagObjectSha: string } | null = null;
  if (resolution.kind === "found") {
    const current = await fetchStablePointer({ repository: args.repository, tagObjectSha: resolution.tagObjectSha, http });
    previous = { versionedTag: current.pointer.versionedTag, tagObjectSha: resolution.tagObjectSha };
  }
  const built = buildStablePointer({
    versionedTag: args.expectedTag,
    sourceCommit,
    publishedAtUnixMs: artifacts.provenance.snapshotGeneratedAtUnixMs,
    snapshotBytes: artifacts.snapshotBytes,
    provenanceBytes: artifacts.provenanceBytes,
    checksumBytes: artifacts.checksumBytes,
    previous,
  });
  return { pointer: built.pointer, pointerJson: built.pointerJson, previous };
}
