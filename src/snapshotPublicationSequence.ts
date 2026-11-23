// SPDX-License-Identifier: Apache-2.0
//
// Executable publication sequence — a faithful, offline abstraction of
// the publication jobs in .github/workflows/publish-console-snapshot.yml
// (GY-M1-INT-001 §4.2/§4.5; sixth-round correction — the OWNER-SELECTED
// dedicated `console-snapshot-prod` stable reference replaces the
// interim repo-wide latest-release promotion).
//
// WHY THIS EXISTS: the previous engineering report validated the
// workflow by YAML parsing plus helper-level tests. That cannot prove
// last-known-good preservation under failure. This module encodes the
// workflow's EXACT step order as an executable sequence over an
// injectable `ReleaseStore` (the GitHub-side operations: create release,
// upload assets, fetch through the versioned tag URLs, create annotated
// tag objects, atomically update the stable ref), while all VERIFICATION
// gates are the REAL functions from `snapshotPublication.ts` and the
// REAL schema-v2 parser. The failure-injection battery drives this
// sequence with faults at every step and asserts the stable-reference
// invariant after each one.
//
// THE INVARIANT (dedicated stable reference): for every failure BEFORE
// `activate-stable-reference`, the stable ref
// `refs/tags/console-snapshot-prod` is UNCHANGED and still identifies
// the complete previous versioned publication. For failures AFTER
// activation, the ref identifies a COMPLETE versioned publication whose
// bytes verify against the pointer's digests and a sidecar naming the
// activated versioned tag — never a partial or mismatched publication.
//
// THE STABLE-REFERENCE MECHANISM (sixth round): the pointer JSON
// (graveyield.console-snapshot-stable-pointer.v1) is carried in the
// MESSAGE of an ANNOTATED tag object. Promotion creates a NEW immutable
// tag object (POST /git/tags) and then moves the ref with ONE atomic
// update (PATCH /git/refs, force). The payload BYTES are never copied
// onto the stable reference — they live exclusively on immutable
// versioned releases, so the pointer can never become a second mutable
// copy of the snapshot. A reader of the ref sees the old pointer or the
// new pointer — never a missing window or a partial state.

import { parseConsoleSnapshot } from "./consoleSnapshotParse.js";
import {
  assertStableAdvanceAllowed,
  assertStableReferenceServesVerifiedArtifact,
  assertVersionedTagAvailable,
  assertVersionedTagFormat,
  buildStablePointer,
  CHECKSUM_ASSET_NAME,
  parseStablePointer,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  verifyChecksumFile,
  verifySnapshotIntegrity,
  verifyStablePointerMatchesArtifacts,
  type PublicationProvenance,
  type PublicationStep,
  type StablePointerV1,
} from "./snapshotPublication.js";

// ─── GitHub-side store abstraction ─────────────────────────────────────────

/**
 * Operations the workflow performs against GitHub releases and the
 * dedicated stable reference. Mirrors the real API surface:
 * `gh release create/upload`, `GET /releases/tags/...` asset downloads,
 * `POST /git/tags` (annotated tag object), `GET/PATCH /git/refs/tags/console-snapshot-prod`.
 */
export interface ReleaseStore {
  /** Mirrors the authenticated tag-collision gate (duplicate-tag gate). */
  listTags(): Promise<string[]>;
  /** Mirrors `gh release create` — `makeLatest: false` never touches the (retired) latest designation. */
  createRelease(tag: string, opts: { makeLatest: boolean }): Promise<void>;
  /** Mirrors one `gh release upload` asset (per-asset, order as in the workflow). */
  uploadAsset(tag: string, name: string, bytes: Uint8Array): Promise<void>;
  /** Mirrors an unauthenticated `releases/download/<tag>/<asset>` fetch (404 on miss). */
  fetchAssetByTag(tag: string, name: string): Promise<Uint8Array>;
  /** Mirrors `POST /git/tags` — creates an immutable annotated tag object; returns its sha. */
  createTagObject(args: { message: string; commitSha: string }): Promise<string>;
  /** Mirrors `GET /git/ref/tags/console-snapshot-prod` — null when the ref does not exist yet. */
  stableRefSha(): Promise<string | null>;
  /** Mirrors the SINGLE atomic ref create-or-update (POST/PATCH /git/refs). */
  updateStableRef(tagObjectSha: string): Promise<void>;
  /** Mirrors `GET /git/tags/<sha>` — the annotated tag object (message + commit). */
  fetchTagObject(tagObjectSha: string): Promise<{ message: string; commitSha: string }>;
}

/**
 * In-memory GitHub semantics: releases with assets, immutable annotated
 * tag objects, and ONE stable-ref pointer. The (retired, non-production)
 * repo-wide latest designation is still tracked for realism — the
 * "unrelated release" interference tests rely on it to prove that
 * taking the latest designation does NOT move the stable reference.
 */
export class InMemoryReleaseStore implements ReleaseStore {
  private readonly releases = new Map<string, Map<string, Uint8Array>>();
  private readonly tagObjects = new Map<string, { message: string; commitSha: string }>();
  private stableRef: string | null = null;
  private latest: string | null = null;
  private objectCounter = 0;

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

  async createTagObject(args: { message: string; commitSha: string }): Promise<string> {
    this.objectCounter += 1;
    const sha = this.objectCounter.toString(16).padStart(40, "0");
    this.tagObjects.set(sha, { message: args.message, commitSha: args.commitSha });
    return sha;
  }

  async stableRefSha(): Promise<string | null> {
    return this.stableRef;
  }

  async updateStableRef(tagObjectSha: string): Promise<void> {
    if (!this.tagObjects.has(tagObjectSha)) {
      throw new Error(`tag object ${tagObjectSha} does not exist — ref update refused (HTTP 422)`);
    }
    this.stableRef = tagObjectSha; // the single atomic pointer move
  }

  async fetchTagObject(tagObjectSha: string): Promise<{ message: string; commitSha: string }> {
    const object = this.tagObjects.get(tagObjectSha);
    if (!object) throw new Error(`HTTP 404: git/tags/${tagObjectSha}`);
    return object;
  }

  // Retired-designation realism (used only by the interference tests):
  async markLatest(tag: string): Promise<void> {
    if (!this.releases.has(tag)) {
      throw new Error(`release ${tag} does not exist — promotion refused`);
    }
    this.latest = tag;
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

/** The previously-identified stable pointer (the rollback reference). */
export interface PreviousStablePointer {
  versionedTag: string;
  tagObjectSha: string;
  pointerJson: string;
  pointer: StablePointerV1;
}

/** Result of one (attempted) publication run. */
export interface SequenceResult {
  /** Steps that completed without throwing, in execution order. */
  executed: PublicationStep[];
  /** The tag identified by the stable reference after the run (null when the run failed before activation). */
  activatedTag: string | null;
  /** The stable pointer BEFORE this run (the rollback reference; null on first publication). */
  previousStable: PreviousStablePointer | null;
}

// verifyChecksumFile has MOVED to snapshotPublication.ts (the integrity
// home of the release-ops bundle graph); re-exported here so existing
// import sites (tests, the sequence) keep working unchanged.
export { verifyChecksumFile };

/** Read + strictly parse the stable pointer at a concrete tag object sha. */
async function readStablePointerAt(store: ReleaseStore, tagObjectSha: string): Promise<PreviousStablePointer> {
  const object = await store.fetchTagObject(tagObjectSha);
  const pointer = parseStablePointer(object.message);
  return { versionedTag: pointer.versionedTag, tagObjectSha, pointerJson: object.message, pointer };
}

/**
 * The publication sequence — the workflow's publish/release/promote/verify
 * jobs, step for step. Every gate is the real production verification
 * logic; only the GitHub-side operations are abstracted behind
 * `ReleaseStore`. The activation mirrors the workflow's privileged steps
 * exactly: build the pointer from the VERIFIED bytes, create the
 * annotated tag object, move the ref ONCE.
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
  let previousStable: PreviousStablePointer | null = null;
  const previousRefSha = await store.stableRefSha();
  if (previousRefSha !== null) {
    previousStable = await readStablePointerAt(store, previousRefSha);
  }
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
  await store.createRelease(tag, { makeLatest: false }); // the versioned release is NEVER the stable reference on creation
  await store.uploadAsset(tag, SNAPSHOT_ASSET_NAME, bundle.snapshotBytes);
  await store.uploadAsset(tag, PROVENANCE_ASSET_NAME, bundle.provenanceBytes);
  await store.uploadAsset(tag, CHECKSUM_ASSET_NAME, bundle.checksumBytes);
  executed.push("publish-versioned-release");

  // ── Step: verify-versioned-assets (roundtrip through the tag URLs) ──
  const rtSnapshot = await store.fetchAssetByTag(tag, SNAPSHOT_ASSET_NAME);
  const rtProvenanceBytes = await store.fetchAssetByTag(tag, PROVENANCE_ASSET_NAME);
  const rtChecksum = await store.fetchAssetByTag(tag, CHECKSUM_ASSET_NAME);
  verifyChecksumFile(rtSnapshot, rtChecksum, SNAPSHOT_ASSET_NAME);
  const rtProvenance = JSON.parse(Buffer.from(rtProvenanceBytes).toString("utf8")) as PublicationProvenance;
  verifySnapshotIntegrity(rtSnapshot, rtProvenance);
  executed.push("verify-versioned-assets");

  // ── Step: activate-stable-reference (new tag object + ONE atomic ref update) ──
  assertStableAdvanceAllowed({
    artifactComplete: opts.artifactComplete,
    schemaValidated: true,
    versionedReleasePublished: true,
    versionedAssetsVerified: true,
  });
  // The pointer is built from the EXACT verified roundtrip bytes and the
  // release's source commit (fail-closed: a provenance without a usable
  // commit cannot build a pointer, so nothing activates).
  const sourceCommit = rtProvenance.indexerSourceCommitSha;
  const built = buildStablePointer({
    versionedTag: tag,
    sourceCommit: sourceCommit ?? "",
    publishedAtUnixMs: rtProvenance.snapshotGeneratedAtUnixMs,
    snapshotBytes: rtSnapshot,
    provenanceBytes: rtProvenanceBytes,
    checksumBytes: rtChecksum,
    previous: previousStable === null ? null : { versionedTag: previousStable.versionedTag, tagObjectSha: previousStable.tagObjectSha },
  });
  const newSha = await store.createTagObject({ message: built.pointerJson, commitSha: built.pointer.sourceCommit });
  await store.updateStableRef(newSha); // THE single atomic pointer move; nothing is deleted or overwritten
  activatedTag = tag;
  executed.push("activate-stable-reference");

  // ── Step: verify-stable-reference (identity chain over the moved ref) ──
  const refSha = await store.stableRefSha();
  if (refSha !== newSha) {
    throw new Error("verify-stable-reference: the stable ref no longer names the object created by this run — a concurrent ref move was detected");
  }
  const activatedObject = await store.fetchTagObject(refSha);
  const activatedPointer = parseStablePointer(activatedObject.message);
  if (activatedPointer.versionedTag !== tag) {
    throw new Error("verify-stable-reference: the activated pointer does not name the activated versioned tag");
  }
  // The assets must come from the POINTER's identity (the exact versioned
  // release), and must match the pointer's digests AND the release's own
  // sidecar — a cross-release mixture can never pass.
  const stableSnapshot = await store.fetchAssetByTag(activatedPointer.versionedTag, SNAPSHOT_ASSET_NAME);
  const stableProvenanceBytes = await store.fetchAssetByTag(activatedPointer.versionedTag, PROVENANCE_ASSET_NAME);
  const stableChecksum = await store.fetchAssetByTag(activatedPointer.versionedTag, CHECKSUM_ASSET_NAME);
  verifyChecksumFile(stableSnapshot, stableChecksum, SNAPSHOT_ASSET_NAME);
  const stableProvenance = JSON.parse(Buffer.from(stableProvenanceBytes).toString("utf8")) as PublicationProvenance;
  verifyStablePointerMatchesArtifacts({
    pointer: activatedPointer,
    snapshotBytes: stableSnapshot,
    provenanceBytes: stableProvenanceBytes,
    checksumBytes: stableChecksum,
    provenance: stableProvenance,
  });
  assertStableReferenceServesVerifiedArtifact({
    fetchedSnapshotBytes: stableSnapshot,
    fetchedProvenance: stableProvenance,
    activatedTag: tag,
    pointer: activatedPointer,
  });
  executed.push("verify-stable-reference");

  return { executed, activatedTag, previousStable };
}
