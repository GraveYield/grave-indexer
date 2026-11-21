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
//      history, and a stable `console-snapshot-prod` reference that may
//      only advance AFTER its versioned predecessor has been published
//      AND verified. Any failure at any earlier step leaves the
//      previously published stable reference untouched (last-known-good
//      preservation).
//
// SECURITY: the provenance is secret-free by construction — it carries
// only the fields listed in `PUBLICATION_PROVENANCE_KEYS`, which tests
// pin exhaustively. No URLs with credentials, no key material, no RPC
// endpoints, no environment dumps. Values are supplied as explicit
// arguments; the module never reads `process.env` itself.

import { createHash } from "node:crypto";
import {
  CONSOLE_SNAPSHOT_SCHEMA_VERSION,
  type ConsoleSnapshotV2,
} from "./consoleSnapshot.js";

/** The approved stable production tag (GY-M1-INT-001 §4). */
export const STABLE_TAG = "console-snapshot-prod";

/** Exact asset filenames published on every release (stable and versioned). */
export const SNAPSHOT_ASSET_NAME = "console-snapshot.json";
export const PROVENANCE_ASSET_NAME = "console-snapshot-provenance.json";
export const CHECKSUM_ASSET_NAME = "console-snapshot.sha256";

// ─── Integrity ─────────────────────────────────────────────────────────────

/** sha256 hex over the exact artifact bytes. */
export function snapshotSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

// ─── Stable-reference sequencing ───────────────────────────────────────────

/** The ordered publication steps (the workflow MUST execute them in this order). */
export const PUBLICATION_STEPS = [
  "generate",
  "validate-schema",
  "verify-integrity",
  "publish-versioned-release",
  "verify-versioned-assets",
  "advance-stable-reference",
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
 * The stable reference may advance ONLY when the full versioned
 * sequence has succeeded and the artifact is complete. Any unmet
 * condition throws — the workflow catches it and exits non-zero,
 * leaving the previously published stable reference (the last known
 * good artifact) untouched.
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
 * The stable reference update is a REPLACE-ASSETS operation on the
 * existing `console-snapshot-prod` release (same tag, same asset
 * names), NOT a tag move. Rationale (documented for audit):
 *
 *   * Moving a tag on GitHub = delete tag + delete release + recreate
 *     both. Between the delete and the recreate the stable asset URL
 *     404s for the WHOLE window, and a partial failure leaves NO stable
 *     artifact at all — that operation cannot preserve the
 *     last-known-good artifact and is therefore rejected here.
 *   * Replacing release assets in place (upload with the same name)
 *     keeps the stable URL constant and only swaps bytes. The swap is
 *     NOT atomic (GitHub deletes the old asset, then creates the new
 *     one) — there is a short window (seconds) in which a fetch can
 *     observe the asset missing. The console maps that to the honest
 *     "missing / unavailable" state — never to wrong data — and the
 *     last-known-good artifact is destroyed only in the same instant
 *     the verified replacement lands.
 *   * The previous stable asset is never deleted BEFORE the new
 *     artifact has been published and verified on its immutable
 *     versioned release (enforced by `assertStableAdvanceAllowed`).
 */
export function describeStableReferenceUpdate(): string {
  return (
    "replace-in-place: upload console-snapshot.json / console-snapshot-provenance.json / " +
    "console-snapshot.sha256 to the existing console-snapshot-prod release (same tag, same asset " +
    "names, constant URL). Not atomic (brief 404 window during the asset clobber); the previous " +
    "last-known-good artifact is never removed before the verified replacement exists on the " +
    "immutable versioned release."
  );
}
