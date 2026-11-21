// SPDX-License-Identifier: Apache-2.0
//
// Executable publication sequence — a faithful, offline abstraction of
// the publication jobs in .github/workflows/publish-console-snapshot.yml
// (GY-M1-INT-001 §4.2/§4.5 correction; the workflow's second-round Task 1
// correction split the previous two-job layout into read-only
// generate/verify/verify-stable jobs plus a minimal privileged `publish`
// job — the SEQUENCE below is unchanged, only its execution boundary
// moved: the pre-publication re-verification now runs in the read-only
// verify job, and the post-activation stable gate now runs in the
// read-only verify-stable job).
//
// WHY THIS EXISTS: the previous engineering report validated the
// workflow by YAML parsing plus helper-level tests. That cannot prove
// last-known-good preservation under failure. This module encodes the
// workflow's EXACT step order as an executable sequence over an
// injectable `ReleaseStore` (the GitHub-side operations: create release,
// upload assets, fetch through the public tag/latest URLs, promote to
// latest), while all VERIFICATION gates are the REAL functions from
// `snapshotPublication.ts` and the REAL schema-v2 parser. The
// failure-injection battery drives this sequence with faults at every
// step and asserts the stable-reference invariant after each one.
//
// THE INVARIANT: for every failure BEFORE `activate-stable-latest`, the
// store's latest designation (and therefore the stable URL) is
// unchanged and still serves the complete previous artifact. For
// failures AFTER activation, the stable URL serves a complete artifact
// whose bytes verify against a sidecar naming the activated versioned
// tag — never a partial or mismatched publication.
//
// GITHUB SEMANTICS MODELLED (verified 2026-11-21 against GitHub's
// published behavior and live public repos):
//   * `releases/latest/download/<asset>` resolves the repo-wide latest
//     designation (drafts and prereleases excluded) and serves THAT
//     release's asset by name — one release's bytes, never a mixture.
//   * The designation is a single metadata field on the release record
//     (PATCH `make_latest`) — flipping it does not touch any asset.
//   * Assets on an already-published versioned release are immutable in
//     this design: the workflow never re-uploads to an existing tag
//     (duplicate tags abort before creation).

import { parseConsoleSnapshot } from "./consoleSnapshotParse.js";
import {
  assertStableAdvanceAllowed,
  assertStableReferenceServesVerifiedArtifact,
  assertVersionedTagAvailable,
  assertVersionedTagFormat,
  CHECKSUM_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  snapshotSha256,
  verifyChecksumFile,
  verifySnapshotIntegrity,
  type PublicationProvenance,
  type PublicationStep,
} from "./snapshotPublication.js";

// ─── GitHub-side store abstraction ─────────────────────────────────────────

/** Operations the workflow performs against GitHub releases. */
export interface ReleaseStore {
  /** Mirrors `git ls-remote --tags` (duplicate-tag gate). */
  listTags(): Promise<string[]>;
  /** Mirrors `gh release create` — `makeLatest: false` never moves the designation. */
  createRelease(tag: string, opts: { makeLatest: boolean }): Promise<void>;
  /** Mirrors one `gh release upload` asset (per-asset, order as in the workflow). */
  uploadAsset(tag: string, name: string, bytes: Uint8Array): Promise<void>;
  /** Mirrors an unauthenticated `releases/download/<tag>/<asset>` fetch (404 on miss). */
  fetchAssetByTag(tag: string, name: string): Promise<Uint8Array>;
  /** Mirrors `gh release edit <tag> --latest` — the single metadata promotion. */
  markLatest(tag: string): Promise<void>;
  /** Mirrors an unauthenticated `releases/latest/download/<asset>` fetch. */
  fetchAssetByLatest(name: string): Promise<Uint8Array>;
  /** Mirrors `gh api repos/:repo/releases/latest` (rollback pointer bookkeeping). */
  latestTag(): Promise<string | null>;
}

/**
 * In-memory GitHub release semantics: a map of releases plus ONE
 * repo-wide latest designation. Asset fetches resolve by tag or through
 * the latest designation; a missing release/asset is a 404 error, like
 * the real public HTTP path. The store never lets `fetchAssetByLatest`
 * serve assets from two different releases (the mixture the stable URL
 * must never produce).
 */
export class InMemoryReleaseStore implements ReleaseStore {
  private readonly releases = new Map<string, Map<string, Uint8Array>>();
  private latest: string | null = null;

  async listTags(): Promise<string[]> {
    return [...this.releases.keys()];
  }

  async createRelease(tag: string, opts: { makeLatest: boolean }): Promise<void> {
    if (this.releases.has(tag)) {
      throw new Error(`release for tag ${tag} already exists (HTTP 422)`);
    }
    this.releases.set(tag, new Map());
    if (opts.makeLatest) this.latest = tag;
  }

  async uploadAsset(tag: string, name: string, bytes: Uint8Array): Promise<void> {
    const assets = this.releases.get(tag);
    if (!assets) throw new Error(`release ${tag} does not exist (upload refused)`);
    assets.set(name, bytes);
  }

  async fetchAssetByTag(tag: string, name: string): Promise<Uint8Array> {
    const assets = this.releases.get(tag);
    const bytes = assets?.get(name);
    if (!bytes) throw new Error(`HTTP 404: releases/download/${tag}/${name}`);
    return bytes;
  }

  async markLatest(tag: string): Promise<void> {
    if (!this.releases.has(tag)) {
      throw new Error(`release ${tag} does not exist — promotion refused`);
    }
    this.latest = tag; // single metadata operation; assets untouched
  }

  async fetchAssetByLatest(name: string): Promise<Uint8Array> {
    if (this.latest === null) {
      throw new Error(`HTTP 404: releases/latest/download/${name} (no latest release designated)`);
    }
    return this.fetchAssetByTag(this.latest, name);
  }

  async latestTag(): Promise<string | null> {
    return this.latest;
  }
}

// ─── The publication bundle and the sequence itself ────────────────────────

/** The three staged files handed from the generate job to the publish job. */
export interface PublicationBundle {
  snapshotBytes: Uint8Array;
  provenanceBytes: Uint8Array;
  checksumBytes: Uint8Array;
  provenance: PublicationProvenance;
}

/** Result of one (attempted) publication run. */
export interface SequenceResult {
  /** Steps that completed without throwing, in execution order. */
  executed: PublicationStep[];
  /** The tag promoted to latest (null when the run failed before activation). */
  activatedTag: string | null;
  /** The latest designation before this run (the rollback pointer). */
  previousLatestTag: string | null;
}

// verifyChecksumFile has MOVED to snapshotPublication.ts (the integrity
// home of the release-ops bundle graph); re-exported here so existing
// import sites (tests, the sequence) keep working unchanged.
export { verifyChecksumFile };

/**
 * The publication sequence — the workflow's publish job, step for step.
 * Every gate is the real production verification logic; only the
 * GitHub-side operations are abstracted behind `ReleaseStore`.
 *
 * Failures propagate as thrown errors AFTER recording what already ran,
 * so the failure-injection battery can assert exactly where a fault
 * surfaced and what the stable reference looked like afterwards.
 */
export async function runPublicationSequence(opts: {
  store: ReleaseStore;
  bundle: PublicationBundle;
  /** The generate job's completeness verdict (false ⇒ the artifact must not activate). */
  artifactComplete: boolean;
}): Promise<SequenceResult> {
  const { store, bundle } = opts;
  const executed: PublicationStep[] = [];
  const previousLatestTag = await store.latestTag();
  let activatedTag: string | null = null;

  // ── Step: validate-schema (strict schema-v2 parser over the exact bytes) ──
  const parsedSnapshot = parseConsoleSnapshot(
    JSON.parse(Buffer.from(bundle.snapshotBytes).toString("utf8")) as unknown,
  );
  // Parity with `verify-snapshot` gate 3: an artifact with no enriched
  // pools can never be a production snapshot.
  if (!(parsedSnapshot.pools.length > 0 && bundle.provenance.counts.enriched > 0)) {
    throw new Error("verify-snapshot: zero enriched pools — refusing to endorse an empty snapshot");
  }
  executed.push("validate-schema");

  // ── Step: verify-integrity (digest + length over the exact bytes) ──
  verifySnapshotIntegrity(bundle.snapshotBytes, bundle.provenance);
  executed.push("verify-integrity");

  const tag = bundle.provenance.versionedTag;
  if (tag === null) {
    throw new Error("provenance carries no versioned tag — refusing to publish");
  }
  assertVersionedTagFormat(tag);

  // ── Step: publish-versioned-release (duplicate gate + create + upload) ──
  assertVersionedTagAvailable(tag, await store.listTags());
  await store.createRelease(tag, { makeLatest: false }); // NOT latest: activation is a separate, verified step
  await store.uploadAsset(tag, SNAPSHOT_ASSET_NAME, bundle.snapshotBytes);
  await store.uploadAsset(tag, PROVENANCE_ASSET_NAME, bundle.provenanceBytes);
  await store.uploadAsset(tag, CHECKSUM_ASSET_NAME, bundle.checksumBytes);
  executed.push("publish-versioned-release");

  // ── Step: verify-versioned-assets (roundtrip through the PUBLIC tag URLs) ──
  const rtSnapshot = await store.fetchAssetByTag(tag, SNAPSHOT_ASSET_NAME);
  const rtProvenanceBytes = await store.fetchAssetByTag(tag, PROVENANCE_ASSET_NAME);
  const rtChecksum = await store.fetchAssetByTag(tag, CHECKSUM_ASSET_NAME);
  verifyChecksumFile(rtSnapshot, rtChecksum, SNAPSHOT_ASSET_NAME);
  const rtProvenance = JSON.parse(Buffer.from(rtProvenanceBytes).toString("utf8")) as PublicationProvenance;
  verifySnapshotIntegrity(rtSnapshot, rtProvenance);
  executed.push("verify-versioned-assets");

  // ── Step: activate-stable-latest (single metadata promotion) ──
  assertStableAdvanceAllowed({
    artifactComplete: opts.artifactComplete,
    schemaValidated: true,
    versionedReleasePublished: true,
    versionedAssetsVerified: true,
  });
  await store.markLatest(tag);
  activatedTag = tag;
  executed.push("activate-stable-latest");

  // ── Step: verify-stable-reference (public latest URLs, bytes must be the activated release) ──
  const stableSnapshot = await store.fetchAssetByLatest(SNAPSHOT_ASSET_NAME);
  const stableProvenanceBytes = await store.fetchAssetByLatest(PROVENANCE_ASSET_NAME);
  const stableChecksum = await store.fetchAssetByLatest(CHECKSUM_ASSET_NAME);
  verifyChecksumFile(stableSnapshot, stableChecksum, SNAPSHOT_ASSET_NAME);
  const stableProvenance = JSON.parse(Buffer.from(stableProvenanceBytes).toString("utf8")) as PublicationProvenance;
  assertStableReferenceServesVerifiedArtifact({
    fetchedSnapshotBytes: stableSnapshot,
    fetchedProvenance: stableProvenance,
    activatedTag: tag,
  });
  executed.push("verify-stable-reference");

  return { executed, activatedTag, previousLatestTag };
}
