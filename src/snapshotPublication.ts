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
// STABLE REFERENCE MECHANISM (GY-M1-INT-001 correction, owner-approved
// investigation §4.3): the stable reference is GitHub's
// "latest release" designation, NOT a mutable stable release whose
// assets are clobbered in place. The stable URL is the CONSTANT
// `https://github.com/<repo>/releases/latest/download/console-snapshot.json`.
// The pointer flip is a single metadata operation on one release record
// (`make_latest=true`); the previous release and its assets are never
// touched, so the stable URL resolves to a COMPLETE old artifact or a
// COMPLETE new artifact — never a mixture, never a missing-asset window.
// The superseded clobber design is rejected precisely because a multi-
// asset in-place replacement is not atomic: GitHub deletes the old
// asset before creating the replacement, so a mid-upload failure (or a
// fetch racing the swap) leaves the stable URL 404 or serving mismatched
// snapshot/provenance pairs, and a failed upload can destroy the
// last-known-good bytes permanently.
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
 * The stable production tag PREFIX (GY-M1-INT-001 §4).
 *
 * NOTE ON SEMANTICS: there is deliberately NO mutable release named
 * `console-snapshot-prod` in the corrected design. The string survives
 * only as the versioned-tag prefix (`console-snapshot-prod-<stamp>-<commit>`)
 * so historical tags stay recognizably production-snapshot tags. The
 * stable RETRIEVAL reference is the repo-wide "latest release" pointer
 * (see `stableSnapshotUrl`), not a fixed tag.
 */
export const STABLE_TAG = "console-snapshot-prod";

/** Exact asset filenames published on every release (stable and versioned). */
export const SNAPSHOT_ASSET_NAME = "console-snapshot.json";
export const PROVENANCE_ASSET_NAME = "console-snapshot-provenance.json";
export const CHECKSUM_ASSET_NAME = "console-snapshot.sha256";

/**
 * The stable, CONSTANT Console retrieval URL for a repository: the
 * "latest release" asset path. Resolves to whatever release currently
 * holds the repo-wide latest designation. NOTE (repository is now
 * PRIVATE): the URL is unchanged, but it now requires authentication —
 * unauthenticated consumers get HTTP 404 (see
 * docs/SNAPSHOT_PUBLICATION.md §12 for the Console-side blocker).
 */
export function stableSnapshotUrl(repository: string): string {
  return `https://github.com/${repository}/releases/latest/download/${SNAPSHOT_ASSET_NAME}`;
}

/** Stable URL for the provenance sidecar (same latest-release mechanism). */
export function stableProvenanceUrl(repository: string): string {
  return `https://github.com/${repository}/releases/latest/download/${PROVENANCE_ASSET_NAME}`;
}

/** Stable URL for the SHA-256 checksum file (same latest-release mechanism). */
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
 * order). The stable reference is a PROMOTION (repo-wide latest-release
 * designation), executed as one metadata operation AFTER the versioned
 * release has been published AND its assets verified (through the
 * authenticated API path on a private repository; the unauthenticated
 * download-URL path was valid only while the repository was public),
 * and followed by a stable-URL re-verification.
 */
export const PUBLICATION_STEPS = [
  "generate",
  "validate-schema",
  "verify-integrity",
  "publish-versioned-release",
  "verify-versioned-assets",
  "activate-stable-latest",
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
}): void {
  if (args.fetchedProvenance.versionedTag !== args.activatedTag) {
    throw new SnapshotPublicationError(
      `stable reference is NOT serving the activated artifact: provenance names ` +
        `${args.fetchedProvenance.versionedTag ?? "<none>"}, expected ${args.activatedTag}`,
    );
  }
  verifySnapshotIntegrity(args.fetchedSnapshotBytes, args.fetchedProvenance);
}

/**
 * The stable reference update is a LATEST-RELEASE PROMOTION: a single
 * metadata operation (`make_latest=true` on the verified versioned
 * release record) that atomically re-points the repo-wide latest
 * designation. Rationale (documented for audit):
 *
 *   * The superseded design — replacing the three assets on a permanent
 *     `console-snapshot-prod` release via `gh release upload --clobber`
 *     — is NOT atomic: GitHub deletes each old asset before creating
 *     the new one, so the stable URL can 404 mid-swap, and a failed
 *     upload after the first deletion permanently destroys the
 *     last-known-good bytes. A client racing the swap can also receive
 *     a NEW snapshot beside an OLD provenance (mismatched pair).
 *   * With the promotion design, every publication lives on its own
 *     immutable versioned release; the stable URL
 *     (`releases/latest/download/console-snapshot.json`) always
 *     resolves to ONE complete release's assets. The promotion moves
 *     the whole pointer in one metadata update — the previous release
 *     and its assets are never modified or deleted, so the old
 *     artifact remains fully available until (and after) the moment
 *     the new one is activated, and rollback is another single
 *     metadata operation (`gh release edit <previous-tag> --latest`).
 *   * The promotion step runs ONLY after the versioned release's
 *     assets have been downloaded back and re-verified (authenticated
 *     API path on a private repository; enforced by
 *     `assertStableAdvanceAllowed`); post-activation verification
 *     re-confirms the stable reference serves the activated bytes
 *     (`assertStableReferenceServesVerifiedArtifact`).
 *
 * Residual non-atomicity / disclosed risks (see docs/SNAPSHOT_PUBLICATION.md):
 *   * "latest" is a REPO-WIDE designation — any other non-draft,
 *     non-prerelease release created in this repository would move the
 *     pointer. Mitigations: repository release policy, the workflow's
 *     post-activation verification, and operator auditability.
 *   * GitHub CDN caching on the latest-release path is short-lived;
 *     consumers must re-fetch and rely on the sidecar digest for
 *     integrity.
 */
export function describeStableReferenceUpdate(): string {
  return (
    "latest-release promotion: the verified versioned release is activated with a single " +
    "make_latest=true metadata operation (gh release edit <tag> --latest). The stable URL " +
    "(releases/latest/download/console-snapshot.json) is constant and always resolves to one " +
    "complete release's assets; the previous release is never modified or deleted, so the " +
    "last-known-good artifact remains fully available until activation and can be restored by " +
    "re-promoting its release. The previous assets are never removed before the verified " +
    "replacement exists on its own immutable versioned release."
  );
}
