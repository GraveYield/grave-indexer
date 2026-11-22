// SPDX-License-Identifier: Apache-2.0
//
// Snapshot publication — provenance sidecar, SHA-256 integrity, and the
// release-sequencing rules for the manual GitHub-Release publication of
// a schema-v2 ConsoleSnapshot (GY-M1-INT-001 §4, §8, §10).
//
// Three responsibilities, all offline-testable and side-effect-free:
//
//   1. PROVENANCE SIDECAR — `buildPublicationProvenance` derives the
//      publication metadata from the EXACT artifact bytes and the EXACT
//      parsed snapshot, plus explicitly supplied workflow context. Every
//      context value that is genuinely unavailable is `null` — never
//      guessed, never fabricated, never sourced from ambient state
//      except through the explicit `ctx` the caller controls.
//
//   2. INTEGRITY — `verifySnapshotIntegrity` recomputes the SHA-256 and
//      byte length over the exact published bytes and refuses any
//      mismatch, so a corrupted or substituted artifact can never be
//      endorsed (generation-time, pre-release, and post-download checks
//      all run this same gate).
//
//   3. RELEASE SEQUENCING — the pure ordering rules the publication
//      workflow must follow: unique versioned tags that never clobber
//      history, and a stable reference that may only move AFTER its
//      versioned predecessor has been published AND verified. Any
//      failure at any earlier step leaves the previously served stable
//      reference untouched (last-known-good preservation).
//
// STABLE REFERENCE MECHANISM (sixth-round correction — the OWNER SELECTED
// the dedicated `console-snapshot-prod` architecture): the stable
// reference is the git ref `refs/tags/console-snapshot-prod`, whose
// ANNOTATED TAG OBJECT MESSAGE carries a small pointer JSON naming ONE
// immutable versioned release (tag, source commit, per-asset digests).
// Promotion = create a NEW immutable tag object (POST /git/tags), then
// move the ref with ONE atomic update (PATCH /git/refs, force). A reader
// of the ref sees either the old pointer or the new pointer — never a
// missing window, never a partial state. The snapshot/provenance/checksum
// BYTES are never copied onto the stable reference: they live exclusively
// on immutable versioned releases, so the pointer cannot become a second
// mutable copy of the payload. The superseded repo-wide "latest release"
// promotion is retired from the production path (an unrelated release
// taking the designation could move the pointer); the
// `releases/latest/download/...` URL helpers survive only as utilities
// for the non-production verification path.
//
// SECURITY: the provenance is secret-free by construction — it carries
// only the fields listed in `PUBLICATION_PROVENANCE_KEYS`, which tests
// pin exhaustively. No URLs with credentials, no key material, no RPC
// endpoints, no environment dumps. Values are supplied as explicit
// arguments; the module never reads `process.env` itself.

import { createHash } from "node:crypto";
// The schema-version VALUE comes from the leaf module (see
// src/consoleSnapshotVersion.ts) so this module — and the release-ops
// bundle built on top of it — never pulls in the builder's heavy
// dependency tree. Only the TYPE is read from the builder module; type
// imports are erased at compile time.
import { CONSOLE_SNAPSHOT_SCHEMA_VERSION } from "./consoleSnapshotVersion.js";
import type { ConsoleSnapshotV2 } from "./consoleSnapshot.js";

/**
 * The dedicated stable reference name (GY-M1-INT-001 §4; OWNER-SELECTED
 * architecture, sixth-round correction): the git ref
 * `refs/tags/console-snapshot-prod` — an ANNOTATED tag whose tag-object
 * message carries the stable-pointer JSON (see `StablePointerV1`).
 *
 * NOTE ON SEMANTICS: versioned release tags are
 * `console-snapshot-prod-<stamp>-<commit>` (the same prefix with a
 * suffix); the stable ref name has NO suffix and is never a versioned
 * release tag. The stable ref NEVER carries the payload bytes — the
 * pointer names one immutable versioned release which holds them.
 */
export const STABLE_TAG = "console-snapshot-prod";

/** Exact asset filenames published on every release (stable and versioned). */
export const SNAPSHOT_ASSET_NAME = "console-snapshot.json";
export const PROVENANCE_ASSET_NAME = "console-snapshot-provenance.json";
export const CHECKSUM_ASSET_NAME = "console-snapshot.sha256";

/**
 * SUPERSEDED (retained as a utility for the non-production verification
 * path): the repo-wide "latest release" asset URL. The production stable
 * reference is the dedicated `console-snapshot-prod` git-ref pointer
 * (see `stableRefApiUrl`); this URL family is no longer used by the
 * publication workflow and must never be relied on for production
 * distribution — an unrelated release can take the latest designation.
 */
export function stableSnapshotUrl(repository: string): string {
  return `https://github.com/${repository}/releases/latest/download/${SNAPSHOT_ASSET_NAME}`;
}

/** Stable URL for the provenance sidecar (same superseded latest-release mechanism). */
export function stableProvenanceUrl(repository: string): string {
  return `https://github.com/${repository}/releases/latest/download/${PROVENANCE_ASSET_NAME}`;
}

/** Stable URL for the SHA-256 checksum file (same superseded latest-release mechanism). */
export function stableChecksumUrl(repository: string): string {
  return `https://github.com/${repository}/releases/latest/download/${CHECKSUM_ASSET_NAME}`;
}

/**
 * A versioned release download URL (immutable: the assets on a versioned
 * release are never replaced once uploaded).
 */
export function versionedAssetUrl(repository: string, tag: string, assetName: string): string {
  return `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
}

// ─── Dedicated stable reference (owner-selected architecture) ──────────────

/**
 * The EXACT production resolution entry point: the git-ref API URL for
 * the dedicated `console-snapshot-prod` ref. `object.sha` of the response
 * is the ANNOTATED TAG OBJECT sha; fetching that object
 * (`stableTagObjectApiUrl`) yields the pointer JSON in its `message`
 * field. Unauthenticated access works on a public repository
 * (rate-limited); the workflow's verification jobs authenticate with the
 * READ-ONLY automatic token.
 */
export function stableRefApiUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/git/ref/tags/${STABLE_TAG}`;
}

/** The annotated tag-object URL for a concrete stable-ref tag-object sha. */
export function stableTagObjectApiUrl(repository: string, tagObjectSha: string): string {
  return `https://api.github.com/repos/${repository}/git/tags/${tagObjectSha}`;
}

/** Schema discriminator of the stable pointer carried in the tag-object message. */
export const STABLE_POINTER_SCHEMA = "graveyield.console-snapshot-stable-pointer.v1";

/** Per-asset identification carried by the pointer (digest + length, NEVER the bytes). */
export interface StablePointerAssetDigest {
  name: string;
  sha256: string;
  byteLength: number;
}

/**
 * The stable-pointer JSON (`graveyield.console-snapshot-stable-pointer.v1`)
 * — the ENTIRE content of the annotated tag object behind
 * `refs/tags/console-snapshot-prod`. It IDENTIFIES one immutable
 * versioned release; it never carries the payload bytes (the payload
 * lives exclusively on the versioned release, so the stable reference
 * can never become a second mutable copy of the snapshot).
 */
export interface StablePointerV1 {
  pointerSchema: string;
  stableRef: string;
  /** The versioned release the stable reference currently identifies. */
  versionedTag: string;
  /** The release's source commit (40-hex) — must equal the release's target commit. */
  sourceCommit: string;
  publishedAtUnixMs: number;
  snapshot: StablePointerAssetDigest;
  provenance: StablePointerAssetDigest;
  checksum: StablePointerAssetDigest;
  /** Rollback record: the pointer this one replaced (null on first publication). */
  previousVersionedTag: string | null;
  previousTagObjectSha: string | null;
}

/** The exhaustive pointer key set — tests pin this to keep the pointer secret-free. */
export const STABLE_POINTER_KEYS = [
  "pointerSchema",
  "stableRef",
  "versionedTag",
  "sourceCommit",
  "publishedAtUnixMs",
  "snapshot",
  "provenance",
  "checksum",
  "previousVersionedTag",
  "previousTagObjectSha",
] as const;

const STABLE_POINTER_ASSET_KEYS = ["name", "sha256", "byteLength"] as const;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function parseAssetDigest(value: unknown, expectedName: string, field: string): StablePointerAssetDigest {
  if (typeof value !== "object" || value === null) {
    throw new SnapshotPublicationError(`stable pointer field '${field}' must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...STABLE_POINTER_ASSET_KEYS].sort())) {
    throw new SnapshotPublicationError(`stable pointer field '${field}' carries an unexpected key set: ${keys.join(",")}`);
  }
  if (record["name"] !== expectedName) {
    throw new SnapshotPublicationError(`stable pointer field '${field}.name' must be ${expectedName}`);
  }
  if (typeof record["sha256"] !== "string" || !HEX64.test(record["sha256"])) {
    throw new SnapshotPublicationError(`stable pointer field '${field}.sha256' must be 64-hex`);
  }
  if (typeof record["byteLength"] !== "number" || !Number.isInteger(record["byteLength"]) || record["byteLength"] <= 0) {
    throw new SnapshotPublicationError(`stable pointer field '${field}.byteLength' must be a positive integer`);
  }
  return { name: record["name"] as string, sha256: record["sha256"] as string, byteLength: record["byteLength"] as number };
}

/**
 * Build the stable pointer for one verified versioned publication.
 * Digests are computed over the EXACT verified bytes. `previous` records
 * the pointer content this publication replaces (rollback reference).
 * The JSON is the canonical single-line serialization — the exact text
 * written into the annotated tag object message.
 */
export function buildStablePointer(args: {
  versionedTag: string;
  sourceCommit: string;
  publishedAtUnixMs: number;
  snapshotBytes: Uint8Array;
  provenanceBytes: Uint8Array;
  checksumBytes: Uint8Array;
  previous?: { versionedTag: string; tagObjectSha: string } | null;
}): { pointer: StablePointerV1; pointerJson: string } {
  assertVersionedTagFormat(args.versionedTag);
  if (!HEX40.test(args.sourceCommit)) {
    throw new SnapshotPublicationError(`stable pointer sourceCommit must be 40-hex, got ${JSON.stringify(args.sourceCommit)}`);
  }
  if (!Number.isInteger(args.publishedAtUnixMs) || args.publishedAtUnixMs <= 0) {
    throw new SnapshotPublicationError(`stable pointer publishedAtUnixMs must be a positive integer`);
  }
  if (args.previous !== null && args.previous !== undefined) {
    assertVersionedTagFormat(args.previous.versionedTag);
    if (!HEX40.test(args.previous.tagObjectSha)) {
      throw new SnapshotPublicationError(`stable pointer previousTagObjectSha must be 40-hex`);
    }
  }
  const pointer: StablePointerV1 = {
    pointerSchema: STABLE_POINTER_SCHEMA,
    stableRef: STABLE_TAG,
    versionedTag: args.versionedTag,
    sourceCommit: args.sourceCommit,
    publishedAtUnixMs: args.publishedAtUnixMs,
    snapshot: { name: SNAPSHOT_ASSET_NAME, sha256: snapshotSha256(args.snapshotBytes), byteLength: args.snapshotBytes.byteLength },
    provenance: { name: PROVENANCE_ASSET_NAME, sha256: snapshotSha256(args.provenanceBytes), byteLength: args.provenanceBytes.byteLength },
    checksum: { name: CHECKSUM_ASSET_NAME, sha256: snapshotSha256(args.checksumBytes), byteLength: args.checksumBytes.byteLength },
    previousVersionedTag: args.previous?.versionedTag ?? null,
    previousTagObjectSha: args.previous?.tagObjectSha ?? null,
  };
  return { pointer, pointerJson: JSON.stringify(pointer) };
}

/**
 * Strict, fail-closed parse of a stable-pointer JSON (the annotated tag
 * object message). Every field is validated; an unexpected key set, a
 * wrong schema discriminator, a malformed tag/commit/digest or a
 * non-positive length throws. Never returns an unvalidated shape.
 */
export function parseStablePointer(text: string): StablePointerV1 {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new SnapshotPublicationError(`stable pointer is not JSON: ${String((err as Error).message ?? err)}`);
  }
  if (typeof body !== "object" || body === null) {
    throw new SnapshotPublicationError("stable pointer is not a JSON object");
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...STABLE_POINTER_KEYS].sort())) {
    throw new SnapshotPublicationError(`stable pointer carries an unexpected key set: ${keys.join(",")}`);
  }
  if (record["pointerSchema"] !== STABLE_POINTER_SCHEMA) {
    throw new SnapshotPublicationError(`stable pointer pointerSchema must be ${STABLE_POINTER_SCHEMA}`);
  }
  if (record["stableRef"] !== STABLE_TAG) {
    throw new SnapshotPublicationError(`stable pointer stableRef must be ${STABLE_TAG}`);
  }
  if (typeof record["versionedTag"] !== "string") {
    throw new SnapshotPublicationError("stable pointer versionedTag must be a string");
  }
  assertVersionedTagFormat(record["versionedTag"] as string);
  if (typeof record["sourceCommit"] !== "string" || !HEX40.test(record["sourceCommit"])) {
    throw new SnapshotPublicationError("stable pointer sourceCommit must be 40-hex");
  }
  if (typeof record["publishedAtUnixMs"] !== "number" || !Number.isInteger(record["publishedAtUnixMs"]) || record["publishedAtUnixMs"] <= 0) {
    throw new SnapshotPublicationError("stable pointer publishedAtUnixMs must be a positive integer");
  }
  const pointer = record as unknown as StablePointerV1;
  pointer.snapshot = parseAssetDigest(record["snapshot"], SNAPSHOT_ASSET_NAME, "snapshot");
  pointer.provenance = parseAssetDigest(record["provenance"], PROVENANCE_ASSET_NAME, "provenance");
  pointer.checksum = parseAssetDigest(record["checksum"], CHECKSUM_ASSET_NAME, "checksum");
  if (record["previousVersionedTag"] !== null && typeof record["previousVersionedTag"] !== "string") {
    throw new SnapshotPublicationError("stable pointer previousVersionedTag must be a string or null");
  }
  if (typeof record["previousVersionedTag"] === "string") {
    assertVersionedTagFormat(record["previousVersionedTag"] as string);
  }
  if (record["previousTagObjectSha"] !== null && (typeof record["previousTagObjectSha"] !== "string" || !HEX40.test(record["previousTagObjectSha"]))) {
    throw new SnapshotPublicationError("stable pointer previousTagObjectSha must be 40-hex or null");
  }
  if ((record["previousVersionedTag"] === null) !== (record["previousTagObjectSha"] === null)) {
    throw new SnapshotPublicationError("stable pointer previous fields must be both null or both set");
  }
  return pointer;
}

/**
 * Cross-check a stable pointer against the EXACT artifact triple fetched
 * from the versioned release it names, and against that release's own
 * provenance sidecar. Any digest, length, tag or commit divergence is a
 * hard failure — the pointer must never bless bytes it does not name.
 */
export function verifyStablePointerMatchesArtifacts(args: {
  pointer: StablePointerV1;
  snapshotBytes: Uint8Array;
  provenanceBytes: Uint8Array;
  checksumBytes: Uint8Array;
  provenance: PublicationProvenance;
}): void {
  const pairs: Array<[StablePointerAssetDigest, Uint8Array, string]> = [
    [args.pointer.snapshot, args.snapshotBytes, "snapshot"],
    [args.pointer.provenance, args.provenanceBytes, "provenance"],
    [args.pointer.checksum, args.checksumBytes, "checksum"],
  ];
  for (const [digest, bytes, field] of pairs) {
    const actual = snapshotSha256(bytes);
    if (actual !== digest.sha256 || bytes.byteLength !== digest.byteLength) {
      throw new SnapshotPublicationError(
        `stable pointer ${field} digest/length mismatch: pointer says ${digest.sha256}/${digest.byteLength}, fetched bytes hash to ${actual}/${bytes.byteLength}`,
      );
    }
  }
  if (args.provenance.versionedTag !== args.pointer.versionedTag) {
    throw new SnapshotPublicationError(
      `stable pointer names ${args.pointer.versionedTag} but the release's provenance names ${args.provenance.versionedTag ?? "<none>"} — refusing a cross-release identification`,
    );
  }
  if (args.provenance.indexerSourceCommitSha !== null && args.provenance.indexerSourceCommitSha !== args.pointer.sourceCommit) {
    throw new SnapshotPublicationError(
      `stable pointer sourceCommit ${args.pointer.sourceCommit} does not match the release provenance commit ${args.provenance.indexerSourceCommitSha}`,
    );
  }
  verifySnapshotIntegrity(args.snapshotBytes, args.provenance);
}

// ─── Integrity ─────────────────────────────────────────────────────────────

/** sha256 hex over the exact artifact bytes. */
export function snapshotSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify a `<sha256>␠␠<filename>` checksum file against the exact
 * snapshot bytes — the same check the workflow runs as
 * `sha256sum -c <file>` inside the download directory.
 *
 * LIVES HERE (not in snapshotPublicationSequence.ts) so the release-ops
 * bundle graph (src/releaseOpsCli.ts) stays free of the strict schema
 * parser's dependency tree: this module imports only `node:crypto`.
 */
export function verifyChecksumFile(snapshotBytes: Uint8Array, checksumBytes: Uint8Array, assetName: string): void {
  const text = Buffer.from(checksumBytes).toString("utf8");
  const match = /^([0-9a-f]{64})  ([^\n]+)\n?$/.exec(text);
  if (!match) {
    throw new Error(`checksum file is not sha256sum-compatible: ${JSON.stringify(text.slice(0, 120))}`);
  }
  const [, expected, file] = match;
  if (file !== assetName) {
    throw new Error(`checksum file names ${file}, expected ${assetName}`);
  }
  const actual = snapshotSha256(snapshotBytes);
  if (actual !== expected) {
    throw new Error(`checksum MISMATCH for ${assetName}: file says ${expected}, bytes hash to ${actual}`);
  }
}

/** Error thrown by any publication-integrity or sequencing violation. */
export class SnapshotPublicationError extends Error {
  constructor(message: string) {
    super(`snapshot-publication: ${message}`);
    this.name = "SnapshotPublicationError";
  }
}

// ─── Provenance sidecar ────────────────────────────────────────────────────

/**
 * Workflow/run context for the sidecar. Every field is optional and may
 * be null: unavailable values are recorded as null, never fabricated.
 */
export interface PublicationContext {
  /** Indexer source commit the artifact was generated at (null off-repo). */
  sourceCommitSha: string | null;
  /** GitHub Actions run ID (null outside Actions). */
  workflowRunId: string | null;
  /** GitHub Actions attempt number (null outside Actions). */
  workflowAttempt: string | null;
  /** Repository identity ("owner/repo"), when known. */
  repository: string | null;
  /** Versioned release tag planned/used for this publication (null during generation). */
  versionedTag: string | null;
}

export interface PublicationProvenance {
  schemaVersion: number;
  snapshotGeneratedAtUnixMs: number;
  indexerSourceCommitSha: string | null;
  cluster: string;
  freshness: { maxAgeMs: number };
  counts: {
    rawAccounts: number;
    parsedPools: number;
    supportedWsolPairs: number;
    m1SourcingRejected: number;
    enriched: number;
  };
  snapshotSha256: string;
  snapshotByteLength: number;
  workflowRunId: string | null;
  workflowAttempt: string | null;
  repository: string | null;
  versionedTag: string | null;
}

/** The exhaustive provenance key set — tests pin this to keep the sidecar secret-free. */
export const PUBLICATION_PROVENANCE_KEYS = [
  "schemaVersion",
  "snapshotGeneratedAtUnixMs",
  "indexerSourceCommitSha",
  "cluster",
  "freshness",
  "counts",
  "snapshotSha256",
  "snapshotByteLength",
  "workflowRunId",
  "workflowAttempt",
  "repository",
  "versionedTag",
] as const;

/**
 * Build the provenance sidecar for one exact artifact. All snapshot
 * facts (schema version, generation time, cluster, freshness, counts)
 * come from the parsed artifact; the digest and byte length come from
 * the exact bytes being published. Workflow context comes from `ctx`
 * verbatim — null stays null.
 */
export function buildPublicationProvenance(
  snapshot: ConsoleSnapshotV2,
  snapshotBytes: Uint8Array,
  ctx: PublicationContext,
): PublicationProvenance {
  return {
    schemaVersion: CONSOLE_SNAPSHOT_SCHEMA_VERSION,
    snapshotGeneratedAtUnixMs: snapshot.generatedAtUnixMs,
    indexerSourceCommitSha: ctx.sourceCommitSha,
    cluster: snapshot.cluster,
    freshness: { maxAgeMs: snapshot.freshness.maxAgeMs },
    counts: {
      rawAccounts: snapshot.counts.rawAccounts,
      parsedPools: snapshot.counts.parsedPools,
      supportedWsolPairs: snapshot.counts.supportedWsolPairs,
      m1SourcingRejected: snapshot.counts.m1SourcingRejected,
      enriched: snapshot.counts.enriched,
    },
    snapshotSha256: snapshotSha256(snapshotBytes),
    snapshotByteLength: snapshotBytes.byteLength,
    workflowRunId: ctx.workflowRunId,
    workflowAttempt: ctx.workflowAttempt,
    repository: ctx.repository,
    versionedTag: ctx.versionedTag,
  };
}

/**
 * Verify an artifact against its provenance sidecar: recompute the
 * digest and length over the exact bytes and require an exact match.
 * Throws `SnapshotPublicationError` on any mismatch (wrong bytes,
 * truncation, tampering, sidecar drift).
 */
export function verifySnapshotIntegrity(
  snapshotBytes: Uint8Array,
  provenance: PublicationProvenance,
): void {
  const actualSha = snapshotSha256(snapshotBytes);
  if (actualSha !== provenance.snapshotSha256) {
    throw new SnapshotPublicationError(
      `snapshot SHA-256 mismatch: sidecar declares ${provenance.snapshotSha256}, actual bytes hash to ${actualSha}`,
    );
  }
  if (snapshotBytes.byteLength !== provenance.snapshotByteLength) {
    throw new SnapshotPublicationError(
      `snapshot byte length mismatch: sidecar declares ${provenance.snapshotByteLength}, actual ${snapshotBytes.byteLength}`,
    );
  }
}

// ─── Versioned tag naming ──────────────────────────────────────────────────

/**
 * A versioned release tag: `console-snapshot-prod-<UTC generation
 * timestamp>-<source commit short sha>` (or `-notrack` when the source
 * commit is genuinely unavailable — e.g. an off-repo generation run;
 * the timestamp alone keeps the tag unique and traceable). Deterministic
 * for the same (timestamp, commit) pair; two generations at different
 * times or commits never collide.
 */
export function versionedTagName(generatedAtUnixMs: number, sourceCommitSha: string | null): string {
  if (!Number.isInteger(generatedAtUnixMs) || generatedAtUnixMs <= 0) {
    throw new SnapshotPublicationError(`generation timestamp must be a positive integer, got ${generatedAtUnixMs}`);
  }
  const stamp = new Date(generatedAtUnixMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const commitPart = sourceCommitSha ? sourceCommitSha.slice(0, 12) : "notrack";
  return `${STABLE_TAG}-${stamp}-${commitPart}`;
}

/**
 * Fail-safe duplicate protection: refuse to publish a versioned tag
 * that already exists among `existingTags`. Historical versioned
 * releases are immutable — this gate runs BEFORE any release creation
 * so a collision aborts the publication with the stable reference
 * untouched (never clobbered, never deleted, never moved).
 */
export function assertVersionedTagAvailable(newTag: string, existingTags: readonly string[]): void {
  if (existingTags.includes(newTag)) {
    throw new SnapshotPublicationError(
      `versioned tag ${newTag} already exists — historical versioned releases are immutable; publication aborted with the stable reference untouched`,
    );
  }
  if (newTag === STABLE_TAG) {
    throw new SnapshotPublicationError(
      `a publication must never be issued under the stable tag ${STABLE_TAG} — use a versioned tag and advance the stable reference through the verified sequence`,
    );
  }
  if (!newTag.startsWith(`${STABLE_TAG}-`)) {
    throw new SnapshotPublicationError(
      `versioned tag ${newTag} must be derived from ${STABLE_TAG}- (timestamp + commit) — refusing an off-policy tag`,
    );
  }
}

/**
 * The exact tag shape produced by `versionedTagName`:
 * `console-snapshot-prod-<YYYYMMDDTHHMMSSZ>-<12-hex-commit|notrack>`.
 *
 * The workflow validates the tag read back from the provenance sidecar
 * against this pattern BEFORE the tag is interpolated into any shell or
 * `gh` command — a malformed or hostile sidecar value can never reach a
 * command line as a crafted argument.
 */
export const VERSIONED_TAG_PATTERN =
  /^console-snapshot-prod-\d{8}T\d{6}Z-(?:[0-9a-f]{12}|notrack)$/;

/** Validate a provenance-carried versioned tag against `VERSIONED_TAG_PATTERN`. */
export function assertVersionedTagFormat(tag: string): void {
  if (!VERSIONED_TAG_PATTERN.test(tag)) {
    throw new SnapshotPublicationError(
      `versioned tag ${JSON.stringify(tag)} does not match the expected shape ` +
        `${STABLE_TAG}-<YYYYMMDDTHHMMSSZ>-<commit12|notrack> — refusing to publish with an unvalidated tag`,
    );
  }
}

// ─── Stable-reference sequencing ───────────────────────────────────────────

/**
 * The ordered publication steps (the workflow MUST execute them in this
 * order). The stable reference is the DEDICATED `console-snapshot-prod`
 * git-ref pointer (owner-selected architecture): activation creates a
 * new annotated tag object carrying the pointer JSON and moves the ref
 * with ONE atomic update, executed AFTER the versioned release has been
 * published AND its assets verified, and followed by an identity
 * re-verification of the ref → pointer → versioned release chain.
 */
export const PUBLICATION_STEPS = [
  "generate",
  "validate-schema",
  "verify-integrity",
  "publish-versioned-release",
  "verify-versioned-assets",
  "activate-stable-reference",
  "verify-stable-reference",
] as const;

export type PublicationStep = (typeof PUBLICATION_STEPS)[number];

/** State observed by the workflow at the stable-advance decision point. */
export interface StableAdvanceState {
  /** The versioned release was successfully created (tag + assets uploaded). */
  versionedReleasePublished: boolean;
  /** The versioned release assets were downloaded back and re-verified (digest + parse). */
  versionedAssetsVerified: boolean;
  /** The artifact passed the schema-v2 parser (always true by this point). */
  schemaValidated: boolean;
  /** The artifact is complete (no discovery/enrichment-completeness failure). */
  artifactComplete: boolean;
}

/**
 * The stable reference (latest-release designation) may move ONLY when
 * the full versioned sequence has succeeded and the artifact is
 * complete. Any unmet condition throws — the workflow catches it and
 * exits non-zero, leaving the previously designated latest release (the
 * last known good artifact) untouched.
 */
export function assertStableAdvanceAllowed(state: StableAdvanceState): void {
  if (!state.artifactComplete) {
    throw new SnapshotPublicationError("stable reference must not advance: the artifact is INCOMPLETE");
  }
  if (!state.schemaValidated) {
    throw new SnapshotPublicationError("stable reference must not advance: the artifact failed schema-v2 validation");
  }
  if (!state.versionedReleasePublished) {
    throw new SnapshotPublicationError(
      "stable reference must not advance: the versioned release has not been published (order violation)",
    );
  }
  if (!state.versionedAssetsVerified) {
    throw new SnapshotPublicationError(
      "stable reference must not advance: the versioned release assets have not been verified after publication (order violation)",
    );
  }
}

/**
 * Post-activation gate: the artifact served by the STABLE URL must be
 * byte-identical to the verified versioned publication. Checks (in
 * order):
 *
 *   1. the stable provenance sidecar names the versioned tag being
 *      activated (not the previous publication);
 *   2. the stable snapshot bytes verify against that sidecar (digest +
 *      length over the EXACT bytes, reusing `verifySnapshotIntegrity`).
 *
 * A failure here means the stable URL is NOT serving the new verified
 * artifact (CDN lag, wrong designation, tampering) — the workflow must
 * report failure for operator investigation, never success.
 */
export function assertStableReferenceServesVerifiedArtifact(args: {
  fetchedSnapshotBytes: Uint8Array;
  fetchedProvenance: PublicationProvenance;
  activatedTag: string;
  pointer?: StablePointerV1;
}): void {
  if (args.fetchedProvenance.versionedTag !== args.activatedTag) {
    throw new SnapshotPublicationError(
      `stable reference is NOT serving the activated artifact: provenance names ` +
        `${args.fetchedProvenance.versionedTag ?? "<none>"}, expected ${args.activatedTag}`,
    );
  }
  verifySnapshotIntegrity(args.fetchedSnapshotBytes, args.fetchedProvenance);
  if (args.pointer !== undefined && args.pointer.versionedTag !== args.activatedTag) {
    throw new SnapshotPublicationError(
      `stable reference is NOT serving the activated artifact: the pointer names ` +
        `${args.pointer.versionedTag}, expected ${args.activatedTag}`,
    );
  }
}

/**
 * The stable reference update is a DEDICATED-REF ACTIVATION (owner-
 * selected architecture): a NEW annotated tag object carrying the
 * pointer JSON is created (immutable git object), then the ref
 * `refs/tags/console-snapshot-prod` is moved with ONE atomic update
 * (`PATCH /git/refs`, force). Rationale (documented for audit):
 *
 *   * The previously-rejected design — replacing the three assets on a
 *     permanent `console-snapshot-prod` release via `gh release upload
 *     --clobber` — is NOT atomic: GitHub deletes each old asset before
 *     creating the new one, so the stable URL can 404 mid-swap and a
 *     failed upload permanently destroys the last-known-good bytes.
 *   * The repo-wide "latest" promotion (the interim mechanism) is
 *     retired from production: an unrelated release taking the
 *     designation would move the production pointer.
 *   * With the dedicated-ref design, the payload bytes live ONLY on
 *     immutable versioned releases; the pointer is a small immutable
 *     git object re-created for every promotion, and the ref moves in a
 *     single atomic operation. Readers see the old pointer or the new
 *     pointer — never a missing or partial state. The previous pointer
 *     content is recorded (run summary + pointer's `previous*` fields),
 *     so rollback re-creates the old pointer object and re-points the
 *     ref, verified by read-back — without depending on the old object
 *     remaining reachable.
 *
 * Residual limitations (see docs/SNAPSHOT_PUBLICATION.md):
 *   * the ref update is atomic per GitHub's ref API, but a reader
 *     racing it may see either pointer — every consumer MUST verify the
 *     fetched bytes against the pointer digests (fail-closed).
 *   * consumption requires the documented two-step resolution (ref →
 *     tag object → versioned release) — a Console-side change that is
 *     documented for owner approval, not yet shipped.
 */
export function describeStableReferenceUpdate(): string {
  return (
    "dedicated stable reference activation: a new annotated tag object carrying the " +
    "stable-pointer JSON is created, and the ref refs/tags/console-snapshot-prod is moved " +
    "with one atomic ref update. The pointer names one immutable versioned release; the " +
    "payload bytes are never copied onto the stable reference. The previous pointer content " +
    "is recorded for rollback; restoring it re-creates the old pointer object and re-points " +
    "the ref, verified by read-back. The previous assets are never removed before the " +
    "verified replacement exists on its own immutable versioned release."
  );
}
