// SPDX-License-Identifier: Apache-2.0
//
// Claims-artifact publication (D4) — pointer contract + draft-first
// sequence. Logically SEPARATE from ConsoleSnapshotV2 pool-discovery
// publication (snapshotPublication.ts / snapshotPublicationSequence.ts):
// its own stable ref, asset names, pointer schema, validators, and
// versioned-tag namespace. Safe mechanisms are REUSED (ReleaseStore
// abstraction, immutable versioned releases, annotated-tag-object
// pointer, ONE ownership-checked ref update, read-back verification, last-known-good
// preservation) but no console-snapshot pointer, asset, or ref is
// touched or interpreted.
//
// THE DRAFT-FIRST LIFECYCLE (strictly ordered; every gate is the real
// verification logic from claimsArtifact.ts):
//
//   1. validate-artifact        claims-grade verification over the exact bytes
//   2. compute-digest           SHA-256 + byte length over the exact bytes
//   3. create-draft-release     draft, unique versioned tag (duplicate aborts);
//                               NEVER the stable reference
//   4. upload-draft-assets      artifact + checksum + manifest, to the draft
//   5. verify-draft-readback    fetch back from the draft; digest + length +
//                               checksum + FULL claims-grade re-verification
//   6. publish-immutable-release   flip draft → published (--latest=false);
//                                  the versioned identity is immutable from
//                                  here (assets never re-uploaded)
//   7. verify-versioned-release    fetch the assets from the VERSIONED
//                                  release and run the FULL pointer-identity
//                                  verification BEFORE any stable-ref write
//                                  (I-05 architecture: every content failure
//                                  is caught while the stable pointer is
//                                  still untouched, so destructive rollback
//                                  is needed only for failures of the ref
//                                  move itself or of the post-move read)
//   8. activate-stable-reference   pointer JSON into a NEW annotated tag
//                                  object, ONE ownership-checked ref update on
//                                  `claims-artifact-prod` (previous
//                                  last-known-good preserved on any
//                                  earlier failure)
//   9. verify-stable-reference     re-read the ref; pointer identity chain;
//                                  fetch assets from the POINTER's versioned
//                                  release; digest/length/checksum + claims
//                                  verification again
//
// A failure BEFORE step 8 deletes ONLY this run's un-published draft and
// leaves the previous stable pointer serving. A failure AFTER activation
// is rolled back by `rollbackStableReference` to the recorded previous
// pointer (or first-publication ref deletion), verified by read-back.
//
// Immutable identity: a versioned tag is unique per publication
// (`claims-artifact-prod-<stamp>-<commit12>`); a duplicate aborts the
// run; existing published identities are never overwritten or mutated.

import { createHash } from "node:crypto";

import {
  verifyClaimsArtifactBytes,
  CLAIMS_ARTIFACT_FORMAT_VERSION,
} from "./claimsArtifact.js";

// ─── Namespaces ────────────────────────────────────────────────────────────

/** The dedicated stable reference for CLAIMS publications. */
export const CLAIMS_STABLE_REF = "claims-artifact-prod";

/** Exact asset filenames on every claims versioned release. */
export const CLAIMS_ARTIFACT_ASSET_NAME = "claims-artifact.json";
export const CLAIMS_CHECKSUM_ASSET_NAME = "claims-artifact.sha256";
export const CLAIMS_MANIFEST_ASSET_NAME = "claims-artifact-manifest.json";

/** The claims stable-pointer schema discriminator (distinct from the console-snapshot pointer). */
export const CLAIMS_POINTER_SCHEMA = "graveyield.claims-artifact-stable-pointer.v1";

/** Versioned tag shape: `claims-artifact-prod-<YYYYMMDDTHHMMSSZ>-<commit12|notrack>`. */
export const CLAIMS_VERSIONED_TAG_PATTERN =
  /^claims-artifact-prod-\d{8}T\d{6}Z-(?:[0-9a-f]{12}|notrack)$/;

export class ClaimsPublicationError extends Error {
  constructor(message: string) {
    super(`claims-publication: ${message}`);
    this.name = "ClaimsPublicationError";
  }
}

/** One observation recorded during a rollback attempt (I-05 audit trail). */
export interface RollbackAuditEvent {
  /** The point in the rollback where the observation was made. */
  at: string;
  /** What was observed (ref state, action taken or refused). NEVER a secret. */
  detail: string;
}

/**
 * The structured rollback outcome (I-05: rollback outcomes are
 * observable and auditable — never a bare string in a log line).
 * Thrown (as part of the publication-failure error) for EVERY
 * post-activation failure, carrying the outcome class and the full
 * audit trail of ref observations and actions taken or refused.
 */
export class ClaimsRollbackOutcomeError extends ClaimsPublicationError {
  /** "restored" | "first-publication-removed" | "foreign-reference-untouched" | "unverified". */
  readonly rollbackOutcome: string;
  /** Ordered observations of the ref state during the rollback. */
  readonly rollbackAudit: RollbackAuditEvent[];

  constructor(message: string, rollbackOutcome: string, rollbackAudit: RollbackAuditEvent[]) {
    super(message);
    this.name = "ClaimsRollbackOutcomeError";
    this.rollbackOutcome = rollbackOutcome;
    this.rollbackAudit = rollbackAudit;
  }
}

// ─── Pointer contract ──────────────────────────────────────────────────────

export interface ClaimsPointerAssetDigest {
  name: string;
  sha256: string;
  byteLength: number;
}

/**
 * The claims stable-pointer JSON — the ENTIRE content of the annotated
 * tag object. Carries the immutable artifact identity plus the integrity
 * metadata a consumer needs: exact digest, byte length, schema version,
 * pool, LP mint, snapshot slot, Merkle root, and producer identity.
 */
export interface ClaimsStablePointerV1 {
  pointerSchema: string;
  stableRef: string;
  versionedTag: string;
  sourceCommit: string;
  publishedAtUnixMs: number;
  artifact: ClaimsPointerAssetDigest;
  manifest: ClaimsPointerAssetDigest;
  checksum: ClaimsPointerAssetDigest;
  /** The immutable artifact identity (all verified against the exact bytes). */
  artifactSchemaVersion: number;
  pool: string;
  lpMint: string;
  snapshotSlot: number;
  merkleRoot: string;
  producer: { identity: string; version: string };
  previousVersionedTag: string | null;
  previousTagObjectSha: string | null;
}

export const CLAIMS_POINTER_KEYS = [
  "pointerSchema",
  "stableRef",
  "versionedTag",
  "sourceCommit",
  "publishedAtUnixMs",
  "artifact",
  "manifest",
  "checksum",
  "artifactSchemaVersion",
  "pool",
  "lpMint",
  "snapshotSlot",
  "merkleRoot",
  "producer",
  "previousVersionedTag",
  "previousTagObjectSha",
] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

export function claimsSha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build the pointer for one verified publication (canonical single-line JSON). */
export function buildClaimsPointer(args: {
  versionedTag: string;
  sourceCommit: string;
  publishedAtUnixMs: number;
  artifactBytes: Uint8Array;
  manifestBytes: Uint8Array;
  checksumBytes: Uint8Array;
  artifactSchemaVersion: number;
  pool: string;
  lpMint: string;
  snapshotSlot: number;
  merkleRoot: string;
  producer: { identity: string; version: string };
  previous: { versionedTag: string; tagObjectSha: string } | null;
}): { pointer: ClaimsStablePointerV1; pointerJson: string } {
  const pointer: ClaimsStablePointerV1 = {
    pointerSchema: CLAIMS_POINTER_SCHEMA,
    stableRef: CLAIMS_STABLE_REF,
    versionedTag: args.versionedTag,
    sourceCommit: args.sourceCommit,
    publishedAtUnixMs: args.publishedAtUnixMs,
    artifact: {
      name: CLAIMS_ARTIFACT_ASSET_NAME,
      sha256: claimsSha256Hex(args.artifactBytes),
      byteLength: args.artifactBytes.byteLength,
    },
    manifest: {
      name: CLAIMS_MANIFEST_ASSET_NAME,
      sha256: claimsSha256Hex(args.manifestBytes),
      byteLength: args.manifestBytes.byteLength,
    },
    checksum: {
      name: CLAIMS_CHECKSUM_ASSET_NAME,
      sha256: claimsSha256Hex(args.checksumBytes),
      byteLength: args.checksumBytes.byteLength,
    },
    artifactSchemaVersion: args.artifactSchemaVersion,
    pool: args.pool,
    lpMint: args.lpMint,
    snapshotSlot: args.snapshotSlot,
    merkleRoot: args.merkleRoot,
    producer: args.producer,
    previousVersionedTag: args.previous?.versionedTag ?? null,
    previousTagObjectSha: args.previous?.tagObjectSha ?? null,
  };
  return { pointer, pointerJson: JSON.stringify(pointer) };
}

/** Strict parse of a claims stable pointer (exhaustive keys, supported values). */
export function parseClaimsPointer(text: string): ClaimsStablePointerV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ClaimsPublicationError("pointer message is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ClaimsPublicationError("pointer must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expected = [...CLAIMS_POINTER_KEYS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new ClaimsPublicationError("pointer keys do not match the strict schema (unknown or missing fields)");
  }
  if (obj.pointerSchema !== CLAIMS_POINTER_SCHEMA) {
    throw new ClaimsPublicationError(`unsupported pointerSchema ${JSON.stringify(obj.pointerSchema)}`);
  }
  if (obj.stableRef !== CLAIMS_STABLE_REF) {
    throw new ClaimsPublicationError(`pointer names stableRef ${JSON.stringify(obj.stableRef)} (expected ${CLAIMS_STABLE_REF})`);
  }
  const p = raw as ClaimsStablePointerV1;
  if (!CLAIMS_VERSIONED_TAG_PATTERN.test(p.versionedTag)) {
    throw new ClaimsPublicationError(`versionedTag does not match the claims tag namespace: ${p.versionedTag}`);
  }
  if (typeof p.sourceCommit !== "string" || (!HEX40.test(p.sourceCommit) && p.sourceCommit !== "notrack")) {
    throw new ClaimsPublicationError("sourceCommit must be a 40-hex sha or 'notrack'");
  }
  if (typeof p.publishedAtUnixMs !== "number" || !Number.isInteger(p.publishedAtUnixMs) || p.publishedAtUnixMs <= 0) {
    throw new ClaimsPublicationError("publishedAtUnixMs must be a positive integer");
  }
  for (const key of ["artifact", "manifest", "checksum"] as const) {
    const d = p[key];
    if (
      typeof d !== "object" || d === null ||
      d.name !== (key === "artifact" ? CLAIMS_ARTIFACT_ASSET_NAME : key === "manifest" ? CLAIMS_MANIFEST_ASSET_NAME : CLAIMS_CHECKSUM_ASSET_NAME) ||
      !HEX64.test(d.sha256) ||
      typeof d.byteLength !== "number" || !Number.isInteger(d.byteLength) || d.byteLength <= 0
    ) {
      throw new ClaimsPublicationError(`pointer.${key} is not a valid asset digest`);
    }
  }
  if (p.artifactSchemaVersion !== CLAIMS_ARTIFACT_FORMAT_VERSION) {
    throw new ClaimsPublicationError(`pointer artifactSchemaVersion ${p.artifactSchemaVersion} != supported ${CLAIMS_ARTIFACT_FORMAT_VERSION}`);
  }
  for (const key of ["pool", "lpMint", "merkleRoot"] as const) {
    if (typeof p[key] !== "string" || (p[key] as string).length === 0) {
      throw new ClaimsPublicationError(`pointer.${key} must be a non-empty string`);
    }
  }
  if (!HEX64.test(p.merkleRoot)) throw new ClaimsPublicationError("pointer.merkleRoot must be a 64-hex digest");
  if (typeof p.snapshotSlot !== "number" || !Number.isInteger(p.snapshotSlot) || p.snapshotSlot <= 0) {
    throw new ClaimsPublicationError("pointer.snapshotSlot must be a positive integer");
  }
  if (
    typeof p.producer !== "object" || p.producer === null ||
    typeof p.producer.identity !== "string" || p.producer.identity.trim().length === 0 ||
    typeof p.producer.version !== "string" || p.producer.version.trim().length === 0
  ) {
    throw new ClaimsPublicationError("pointer.producer must carry non-empty identity and version");
  }
  if (p.previousVersionedTag !== null && typeof p.previousVersionedTag !== "string") {
    throw new ClaimsPublicationError("previousVersionedTag must be a string or null");
  }
  if (p.previousTagObjectSha !== null && (typeof p.previousTagObjectSha !== "string" || !HEX40.test(p.previousTagObjectSha))) {
    throw new ClaimsPublicationError("previousTagObjectSha must be a 40-hex sha or null");
  }
  return p;
}

/** The pointer's digests must match the exact fetched bytes (identity + integrity). */
export function verifyClaimsPointerMatchesBytes(args: {
  pointer: ClaimsStablePointerV1;
  artifactBytes: Uint8Array;
  manifestBytes: Uint8Array;
  checksumBytes: Uint8Array;
}): void {
  const pairs: Array<[ClaimsPointerAssetDigest, Uint8Array, string]> = [
    [args.pointer.artifact, args.artifactBytes, "artifact"],
    [args.pointer.manifest, args.manifestBytes, "manifest"],
    [args.pointer.checksum, args.checksumBytes, "checksum"],
  ];
  for (const [digest, bytes, what] of pairs) {
    if (bytes.byteLength !== digest.byteLength) {
      throw new ClaimsPublicationError(
        `${what} byte length ${bytes.byteLength} != pointer ${digest.byteLength}`,
      );
    }
    const hex = claimsSha256Hex(bytes);
    if (hex !== digest.sha256) {
      throw new ClaimsPublicationError(`${what} sha256 ${hex} != pointer ${digest.sha256}`);
    }
  }
}

/** The checksum sidecar must carry the artifact's exact digest (as the workflow's belt). */
export function verifyClaimsChecksumFile(artifactBytes: Uint8Array, checksumBytes: Uint8Array): void {
  const text = Buffer.from(checksumBytes).toString("utf8").trim();
  const expected = `${claimsSha256Hex(artifactBytes)}  ${CLAIMS_ARTIFACT_ASSET_NAME}`;
  if (text !== expected) {
    throw new ClaimsPublicationError(`checksum sidecar mismatch (expected "${expected}")`);
  }
}

// ─── Store abstraction (GitHub-side operations, incl. draft semantics) ─────

/**
 * GitHub-side operations for the claims publication. Extends the
 * console-snapshot store surface with DRAFT semantics (the draft-first
 * lifecycle): create draft → upload into draft → verify from draft →
 * publish (draft → immutable release) → promote stable ref. Each method
 * documents its exact real-API mirror.
 */
export interface ClaimsReleaseStore {
  /** Mirrors GET /repos/{repo}/tags (paginated names) — the duplicate-tag gate. */
  listTags(): Promise<string[]>;
  /** Mirrors POST /repos/{repo}/releases {draft: true, make_latest: "false"}. */
  createDraftRelease(tag: string): Promise<void>;
  /** Mirrors POST/PUT release assets (upload-by-release-id) into the draft. */
  uploadDraftAsset(tag: string, name: string, bytes: Uint8Array): Promise<void>;
  /** Mirrors GET the draft release's asset by name (upload host URL, authed). */
  fetchDraftAsset(tag: string, name: string): Promise<Uint8Array>;
  /** Mirrors PATCH /releases/{id} {draft: false, make_latest: "false"} — the immutable flip. */
  publishDraftRelease(tag: string): Promise<void>;
  /** Mirrors DELETE /releases/{id} — ONLY ever called on this run's un-published draft. */
  deleteDraftRelease(tag: string): Promise<void>;
  /** Mirrors GET /repos/{repo}/git/ref/tags/claims-artifact-prod — null when absent. */
  stableRefSha(): Promise<string | null>;
  /** Mirrors POST /git/tags — creates an immutable annotated tag object. */
  createTagObject(args: { message: string; commitSha: string }): Promise<string>;
  /** Mirrors POST/PATCH /git/refs/tags/claims-artifact-prod — the ONE ownership-checked pointer move. */
  updateStableRef(tagObjectSha: string, opts?: { expectCurrentSha?: string | null }): Promise<void>;
  /** Mirrors DELETE /git/refs/tags/claims-artifact-prod — first-publication rollback only. */
  deleteStableRef(opts?: { expectCurrentSha?: string | null }): Promise<void>;
  /** Mirrors GET /git/tags/{sha}. */
  fetchTagObject(tagObjectSha: string): Promise<{ message: string; commitSha: string }>;
  /** Mirrors GET /repos/{repo}/releases/tags/{tag} asset fetch (versioned tag URLs). */
  fetchAssetByTag(tag: string, name: string): Promise<Uint8Array>;
}

/** In-memory GitHub semantics (drafts, immutable tag objects, one stable ref). */
export class InMemoryClaimsReleaseStore implements ClaimsReleaseStore {
  private readonly drafts = new Map<string, Map<string, Uint8Array>>();
  private readonly releases = new Map<string, Map<string, Uint8Array>>();
  private readonly tagObjects = new Map<string, { message: string; commitSha: string }>();
  private stableRef: string | null = null;
  private objectCounter = 0;

  async listTags(): Promise<string[]> {
    return [...this.releases.keys(), ...this.drafts.keys()];
  }

  async createDraftRelease(tag: string): Promise<void> {
    if (this.releases.has(tag) || this.drafts.has(tag)) {
      throw new ClaimsPublicationError(`release for tag ${tag} already exists (HTTP 422)`);
    }
    this.drafts.set(tag, new Map());
  }

  async uploadDraftAsset(tag: string, name: string, bytes: Uint8Array): Promise<void> {
    const assets = this.drafts.get(tag);
    if (!assets) throw new ClaimsPublicationError(`draft release ${tag} does not exist (upload refused)`);
    if (assets.has(name)) throw new ClaimsPublicationError(`asset ${name} already exists on draft ${tag} (never overwritten)`);
    assets.set(name, bytes);
  }

  async fetchDraftAsset(tag: string, name: string): Promise<Uint8Array> {
    const bytes = this.drafts.get(tag)?.get(name);
    if (!bytes) throw new ClaimsPublicationError(`HTTP 404: draft ${tag} asset ${name}`);
    return bytes;
  }

  async publishDraftRelease(tag: string): Promise<void> {
    const assets = this.drafts.get(tag);
    if (!assets) throw new ClaimsPublicationError(`draft release ${tag} does not exist (publish refused)`);
    this.drafts.delete(tag);
    this.releases.set(tag, assets);
  }

  async deleteDraftRelease(tag: string): Promise<void> {
    if (!this.drafts.has(tag)) {
      throw new ClaimsPublicationError(`draft release ${tag} does not exist (cleanup refused)`);
    }
    this.drafts.delete(tag);
  }

  async stableRefSha(): Promise<string | null> {
    return this.stableRef;
  }

  async createTagObject(args: { message: string; commitSha: string }): Promise<string> {
    this.objectCounter += 1;
    const sha = this.objectCounter.toString(16).padStart(40, "0");
    this.tagObjects.set(sha, { message: args.message, commitSha: args.commitSha });
    return sha;
  }

  async updateStableRef(tagObjectSha: string, _opts?: { expectCurrentSha?: string | null }): Promise<void> {
    if (!this.tagObjects.has(tagObjectSha)) {
      throw new ClaimsPublicationError(`tag object ${tagObjectSha} does not exist — ref update refused (HTTP 422)`);
    }
    this.stableRef = tagObjectSha;
  }

  async deleteStableRef(opts?: { expectCurrentSha?: string | null }): Promise<void> {
    // I-05: absent ref → no-op success. The real GitHub adapter answers 404
    // for an absent ref and treats it as already-absent; both stores mirror
    // that so "already gone" is never an error and never a DELETE call.
    if (this.stableRef === null) return;
    // I-05: conditional delete — a ref that no longer names the caller's
    // expected sha is refused, never deleted.
    const expect = opts?.expectCurrentSha;
    if (expect !== undefined && this.stableRef !== expect) {
      throw new ClaimsPublicationError(
        `stable ref moved concurrently (expected ${expect}, found ${this.stableRef}) — deletion refused: this run does not own the reference`,
      );
    }
    this.stableRef = null;
  }

  async fetchTagObject(tagObjectSha: string): Promise<{ message: string; commitSha: string }> {
    const object = this.tagObjects.get(tagObjectSha);
    if (!object) throw new ClaimsPublicationError(`HTTP 404: git/tags/${tagObjectSha}`);
    return object;
  }

  async fetchAssetByTag(tag: string, name: string): Promise<Uint8Array> {
    const bytes = this.releases.get(tag)?.get(name);
    if (!bytes) throw new ClaimsPublicationError(`HTTP 404: releases/download/${tag}/${name}`);
    return bytes;
  }

  // Introspection for tests.
  hasDraft(tag: string): boolean {
    return this.drafts.has(tag);
  }
  hasRelease(tag: string): boolean {
    return this.releases.has(tag);
  }
}

// ─── The sequence ──────────────────────────────────────────────────────────

export const CLAIMS_PUBLICATION_STEPS = [
  "validate-artifact",
  "compute-digest",
  "create-draft-release",
  "upload-draft-assets",
  "verify-draft-readback",
  "publish-immutable-release",
  "verify-versioned-release",
  "activate-stable-reference",
  "verify-stable-reference",
] as const;
export type ClaimsPublicationStep = (typeof CLAIMS_PUBLICATION_STEPS)[number];

/** The publication input (the staged bundle + identity metadata). */
export interface ClaimsPublicationInput {
  /** The EXACT D3-produced artifact bytes (digest is computed over these). */
  artifactBytes: Uint8Array;
  /** The source commit the publication records (40-hex or "notrack"). */
  sourceCommit: string;
  /** Producer identity + version (recorded in pointer + manifest). */
  producer: { identity: string; version: string };
  /** Wall-clock publication stamp (unix ms). */
  publishedAtUnixMs: number;
}

export interface ClaimsSequenceResult {
  executed: ClaimsPublicationStep[];
  activatedTag: string | null;
  previous: { versionedTag: string; tagObjectSha: string; pointer: ClaimsStablePointerV1 } | null;
  /** The digest of the exact published artifact bytes. */
  artifactSha256: string;
  artifactByteLength: number;
}

/** `claims-artifact-prod-<stamp>-<commit12>` from the publication stamp + commit. */
export function claimsVersionedTag(publishedAtUnixMs: number, sourceCommit: string): string {
  const d = new Date(publishedAtUnixMs);
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}Z`;
  const commit12 = /^[0-9a-f]{40}$/.test(sourceCommit) ? sourceCommit.slice(0, 12) : "notrack";
  return `claims-artifact-prod-${stamp}-${commit12}`;
}

/**
 * The FULL pointer-identity verification over assets fetched from a
 * versioned release (I-05): digest + byte length per asset, checksum
 * sidecar, claims-grade re-verification, and artifact identity vs the
 * pointer. Used BOTH before the stable-ref move (verify-versioned-release —
 * a content failure there costs ZERO destructive rollback, because the
 * stable pointer has not been touched) and after it (verify-stable-
 * reference — the final identity chain over the moved ref).
 */
async function verifyPointerAssetsAgainstRelease(
  store: ClaimsReleaseStore,
  pointer: ClaimsStablePointerV1,
): Promise<void> {
  const artifact = await store.fetchAssetByTag(pointer.versionedTag, CLAIMS_ARTIFACT_ASSET_NAME);
  const manifest = await store.fetchAssetByTag(pointer.versionedTag, CLAIMS_MANIFEST_ASSET_NAME);
  const checksum = await store.fetchAssetByTag(pointer.versionedTag, CLAIMS_CHECKSUM_ASSET_NAME);
  verifyClaimsPointerMatchesBytes({
    pointer,
    artifactBytes: artifact,
    manifestBytes: manifest,
    checksumBytes: checksum,
  });
  verifyClaimsChecksumFile(artifact, checksum);
  const v = verifyClaimsArtifactBytes(artifact);
  if (
    v.rootHex !== pointer.merkleRoot ||
    v.artifact.pool_address !== pointer.pool ||
    v.artifact.lp_mint !== pointer.lpMint ||
    v.snapshotSlot !== pointer.snapshotSlot
  ) {
    throw new ClaimsPublicationError("the published artifact's identity does not match its pointer");
  }
}

/**
 * The draft-first claims publication sequence, step for step as
 * documented at the top of this module. Failures propagate after
 * recording executed steps; cleanup of this run's draft happens for any
 * failure before the immutable flip. The stable reference moves ONLY at
 * `activate-stable-reference`, after the draft round-trip AND the
 * versioned-release content have both fully verified, so every earlier
 * failure preserves the last-known-good pointer exactly.
 */
export async function runClaimsPublicationSequence(opts: {
  store: ClaimsReleaseStore;
  input: ClaimsPublicationInput;
}): Promise<ClaimsSequenceResult> {
  const { store, input } = opts;
  const executed: ClaimsPublicationStep[] = [];
  const artifactBytes = input.artifactBytes;

  // D4 review: source identity is REQUIRED before any network write. A
  // publication that cannot name the exact commit it publishes from is
  // refused — "notrack" (or any non-SHA) never reaches draft creation.
  if (!/^[0-9a-f]{40}$/.test(input.sourceCommit)) {
    throw new ClaimsPublicationError(
      `sourceCommit must be a real 40-hex Git commit SHA for publication (got ${JSON.stringify(input.sourceCommit)}) — resolve and validate the commit before publishing`,
    );
  }

  // Identify the previous last-known-good pointer FIRST (rollback ref).
  const previousRefSha = await store.stableRefSha();
  let previous: ClaimsSequenceResult["previous"] = null;
  if (previousRefSha !== null) {
    const object = await store.fetchTagObject(previousRefSha);
    previous = {
      versionedTag: parseClaimsPointer(object.message).versionedTag,
      tagObjectSha: previousRefSha,
      pointer: parseClaimsPointer(object.message),
    };
  }

  let draftCreated = false;
  const tag = claimsVersionedTag(input.publishedAtUnixMs, input.sourceCommit);

  // ── 1. validate-artifact ────────────────────────────────────────────────
  const verified = verifyClaimsArtifactBytes(artifactBytes);
  executed.push("validate-artifact");

  // ── 2. compute-digest ───────────────────────────────────────────────────
  const artifactSha256 = claimsSha256Hex(artifactBytes);
  const artifactByteLength = artifactBytes.byteLength;
  executed.push("compute-digest");

  // The manifest records the immutable identity (verified against bytes).
  const manifest = {
    manifestSchema: "graveyield.claims-artifact-manifest.v1",
    artifact: {
      asset: CLAIMS_ARTIFACT_ASSET_NAME,
      sha256: artifactSha256,
      byteLength: artifactByteLength,
      formatVersion: CLAIMS_ARTIFACT_FORMAT_VERSION,
      pool: verified.artifact.pool_address,
      lpMint: verified.artifact.lp_mint,
      snapshotSlot: verified.snapshotSlot,
      merkleRoot: verified.rootHex,
      leafCount: verified.leafCount,
      producer: input.producer,
    },
    sourceCommit: input.sourceCommit,
    publishedAtUnixMs: input.publishedAtUnixMs,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const checksumBytes = Buffer.from(
    `${artifactSha256}  ${CLAIMS_ARTIFACT_ASSET_NAME}\n`,
    "utf8",
  );

  // The pointer is built ONCE from the verified bytes (deterministic) and
  // is reused by the draft-readback check, the pre-activation versioned-
  // release check, and the activated tag object itself.
  const { pointer: claimsPointer, pointerJson: claimsPointerJson } = buildClaimsPointer({
    versionedTag: tag,
    sourceCommit: input.sourceCommit,
    publishedAtUnixMs: input.publishedAtUnixMs,
    artifactBytes,
    manifestBytes,
    checksumBytes,
    artifactSchemaVersion: CLAIMS_ARTIFACT_FORMAT_VERSION,
    pool: verified.artifact.pool_address,
    lpMint: verified.artifact.lp_mint,
    snapshotSlot: verified.snapshotSlot,
    merkleRoot: verified.rootHex,
    producer: input.producer,
    previous: previous === null ? null : { versionedTag: previous.versionedTag, tagObjectSha: previous.tagObjectSha },
  });

  try {
    // ── 3. create-draft-release (duplicate gate; never the stable ref) ──
    if (!(await store.listTags()).includes(tag)) {
      await store.createDraftRelease(tag);
      draftCreated = true;
    } else {
      throw new ClaimsPublicationError(
        `versioned tag ${tag} already exists — refusing to overwrite an immutable claims identity`,
      );
    }
    executed.push("create-draft-release");

    // ── 4. upload-draft-assets ────────────────────────────────────────────
    await store.uploadDraftAsset(tag, CLAIMS_ARTIFACT_ASSET_NAME, artifactBytes);
    await store.uploadDraftAsset(tag, CLAIMS_MANIFEST_ASSET_NAME, manifestBytes);
    await store.uploadDraftAsset(tag, CLAIMS_CHECKSUM_ASSET_NAME, checksumBytes);
    executed.push("upload-draft-assets");

    // ── 5. verify-draft-readback (digest + length + checksum + full re-verification) ──
    const rtArtifact = await store.fetchDraftAsset(tag, CLAIMS_ARTIFACT_ASSET_NAME);
    const rtManifest = await store.fetchDraftAsset(tag, CLAIMS_MANIFEST_ASSET_NAME);
    const rtChecksum = await store.fetchDraftAsset(tag, CLAIMS_CHECKSUM_ASSET_NAME);
    if (rtArtifact.byteLength !== artifactByteLength || claimsSha256Hex(rtArtifact) !== artifactSha256) {
      throw new ClaimsPublicationError("draft readback digest/length mismatch — refusing to publish");
    }
    verifyClaimsChecksumFile(rtArtifact, rtChecksum);
    const reVerified = verifyClaimsArtifactBytes(rtArtifact);
    if (reVerified.rootHex !== verified.rootHex) {
      throw new ClaimsPublicationError("draft readback re-verification changed the artifact root");
    }
    verifyClaimsPointerMatchesBytes({
      pointer: claimsPointer,
      artifactBytes: rtArtifact,
      manifestBytes: rtManifest,
      checksumBytes: rtChecksum,
    });
    executed.push("verify-draft-readback");

    // ── 6. publish-immutable-release (draft → published; --latest=false) ──
    await store.publishDraftRelease(tag);
    draftCreated = false;
    executed.push("publish-immutable-release");

    // ── 7. verify-versioned-release (I-05) — the FULL pointer-identity
    // verification over the PUBLISHED versioned release, BEFORE any
    // stable-ref write. Every content failure is caught while the stable
    // pointer is still untouched, so destructive rollback is needed ONLY
    // for failures of the ref move itself or of the post-move read —
    // the stable-pointer architecture deliberately minimizes the
    // scenarios that require a destructive rollback.
    await verifyPointerAssetsAgainstRelease(store, claimsPointer);
    executed.push("verify-versioned-release");
  } catch (err) {
    // Cleanup: delete ONLY this run's un-published draft. The previous
    // stable pointer is untouched (it was never read from or written).
    if (draftCreated) {
      try {
        await store.deleteDraftRelease(tag);
      } catch {
        // A failed cleanup is surfaced, never silent.
        throw new ClaimsPublicationError(
          `publication failed AND draft cleanup failed for ${tag}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw err;
  }

  // ── 8. activate-stable-reference (ONE ownership-checked pointer move; verify-then-write with POST-WRITE READ-BACK — the GitHub refs API has no conditional write) ───
  // I-05: ANY failure at or after activation automatically restores the
  // previous known-good reference — but ONLY if the stable ref still
  // belongs to THIS attempt (exact activated tag-object SHA). If another
  // publisher moved it concurrently, rollback leaves the ref untouched
  // and the run reports TERMINAL UNVERIFIED. Every outcome carries a
  // structured audit trail (ClaimsRollbackOutcomeError.rollbackAudit),
  // and ambiguous failures are reported explicitly — never silently.
  let activated = false;
  let activatedTagObjectSha: string | null = null;
  try {
  const newSha = await store.createTagObject({ message: claimsPointerJson, commitSha: input.sourceCommit });
  await store.updateStableRef(newSha, { expectCurrentSha: previous?.tagObjectSha ?? null });
  activatedTagObjectSha = newSha;
  executed.push("activate-stable-reference");

  // ── 9. verify-stable-reference (identity chain over the moved ref) ──────
  const refSha = await store.stableRefSha();
  if (refSha !== newSha) {
    throw new ClaimsPublicationError(
      "the stable ref no longer names the object created by this run — a concurrent ref move was detected",
    );
  }
  const activatedObject = await store.fetchTagObject(refSha);
  const activatedPointer = parseClaimsPointer(activatedObject.message);
  if (activatedPointer.versionedTag !== tag) {
    throw new ClaimsPublicationError("the activated pointer does not name the activated versioned tag");
  }
  await verifyPointerAssetsAgainstRelease(store, activatedPointer);
  executed.push("verify-stable-reference");
  activated = true;
  } catch (activationErr) {
    const detail = activationErr instanceof Error ? activationErr.message : String(activationErr);
    const audit: RollbackAuditEvent[] = [
      { at: "post-activation-failure", detail },
      { at: "attempt-identity", detail: `activatedTag=${tag} activatedTagObjectSha=${activatedTagObjectSha ?? "<never-activated>"} previous=${previous?.tagObjectSha ?? "<first-publication>"}` },
    ];
    try {
      const outcome = await rollbackClaimsStableReference({
        store,
        previous,
        activatedTag: tag,
        activatedTagObjectSha: activatedTagObjectSha ?? "<never-activated>",
        audit,
      });
      const report =
        outcome === "restored"
          ? "rollback RESTORED the previous known-good pointer and the restoration was verified by read-back"
          : outcome === "first-publication-removed"
            ? "first-publication rollback removed THIS attempt's reference after ownership verification; the absence was verified by re-read"
            : outcome === "foreign-reference-untouched"
              ? "the stable reference NO LONGER names this attempt's tag object — a concurrent publisher or external writer owns it now. Rollback left the reference UNTOUCHED to avoid clobbering the other writer's update — TERMINAL UNVERIFIED STATE: inspect the stable reference manually before any further publication"
              : "rollback could NOT be verified — TERMINAL UNVERIFIED STATE: the stable reference must be inspected manually before any further publication";
      throw new ClaimsRollbackOutcomeError(
        `publication failed after stable-reference activation (${detail}); ${report}`,
        outcome,
        audit,
      );
    } catch (rbErr) {
      if (rbErr instanceof ClaimsRollbackOutcomeError) throw rbErr;
      // Ambiguous/failed rollback attempt itself: handled conservatively —
      // this is an explicit TERMINAL UNVERIFIED state.
      audit.push({ at: "rollback-attempt-failed", detail: rbErr instanceof Error ? rbErr.message : String(rbErr) });
      throw new ClaimsRollbackOutcomeError(
        `publication failed after stable-reference activation (${detail}); rollback could NOT be attempted or completed (${rbErr instanceof Error ? rbErr.message : String(rbErr)}) — TERMINAL UNVERIFIED STATE: the stable reference must be inspected manually before any further publication`,
        "unverified",
        audit,
      );
    }
  }

  return { executed, activatedTag: tag, previous, artifactSha256, artifactByteLength };
}

/**
 * Rollback after a failure AT OR AFTER activation: restore the previous
 * pointer (create its tag object if needed, move the ref) — or delete the
 * first-publication ref — and VERIFY the restoration by read-back. An
 * unverifiable restoration is reported loudly, never silent.
 *
 * I-05: when `audit` is supplied, EVERY ref observation and every action
 * taken or refused is appended to it as a `RollbackAuditEvent`, so the
 * outcome is observable and auditable end-to-end (the caller attaches
 * the trail to the thrown ClaimsRollbackOutcomeError).
 */
export async function rollbackClaimsStableReference(opts: {
  store: ClaimsReleaseStore;
  previous: ClaimsSequenceResult["previous"];
  /** The pointer this run had activated (for the verify step). */
  activatedTag: string;
  /**
   * The tag-object SHA this attempt activated. Rollback touches the ref
   * ONLY if the stable ref still names THIS sha — a ref that has been
   * moved by a concurrent publisher is left untouched (review finding 2).
   */
  activatedTagObjectSha: string;
  /** Optional audit sink — observations are appended in execution order. */
  audit?: RollbackAuditEvent[];
}): Promise<"restored" | "first-publication-removed" | "foreign-reference-untouched" | "unverified"> {
  const { store, previous, activatedTagObjectSha, audit } = opts;
  const note = (at: string, detail: string): void => {
    audit?.push({ at, detail });
  };

  // OWNERSHIP GATE (I-05): the ref may be restored or deleted ONLY while
  // its current target belongs to THIS failed attempt. Every branch below
  // either verifies the ref state first or refuses to act. Uncertain
  // ownership NEVER triggers a destructive call — the caller reports
  // TERMINAL UNVERIFIED.
  const currentSha = await store.stableRefSha();
  note("ownership-gate", `stable ref currently names ${currentSha ?? "<absent>"}`);

  if (previous === null) {
    // First publication. The ref is either absent (activation never
    // landed, or the ref is simply not there) or still names THIS
    // attempt's activation.
    if (currentSha === null) {
      // I-05 (1): the ref is already absent — VERIFY the absence and
      // treat it as absent. NO DELETE request is issued for an absent
      // ref (the old code called deleteStableRef unconditionally).
      const recheck = await store.stableRefSha();
      if (recheck !== null) {
        // A writer created the ref between the two reads — ownership of
        // the reference is now foreign/uncertain: no destructive action.
        note("absence-recheck", `ref reappeared between reads as ${recheck} — no destructive action (UNVERIFIED)`);
        return "unverified";
      }
      note("absence-recheck", "absence verified by re-read — no DELETE issued");
      return "first-publication-removed";
    }
    if (currentSha !== activatedTagObjectSha) {
      // A concurrent publisher owns the ref — never delete it.
      note("ownership-gate-refusal", `ref names ${currentSha}, not this attempt's ${activatedTagObjectSha} — deletion refused (foreign reference untouched)`);
      return "foreign-reference-untouched";
    }
    note("delete", `ref still names this attempt's activation (${currentSha}) — ownership-verified DELETE`);
    await store.deleteStableRef({ expectCurrentSha: activatedTagObjectSha });
    const after = await store.stableRefSha();
    if (after !== null) {
      note("delete-read-back", `ref exists again after deletion (${after}) — concurrent writer detected, outcome UNVERIFIED`);
      return "unverified";
    }
    note("delete-read-back", "absence verified by re-read after deletion");
    return "first-publication-removed";
  }

  if (currentSha === null) {
    // The stable ref is GONE while a previous pointer is known. Ownership
    // of the absence cannot be established (a concurrent publisher or
    // external writer may have deleted it) — leave everything untouched.
    note("ownership-gate-refusal", "ref is absent while a previous pointer is known — ownership of the absence cannot be established, no destructive action (UNVERIFIED)");
    return "unverified";
  }
  if (currentSha === previous.tagObjectSha) {
    // This attempt never actually moved the ref: it still names the
    // previous known-good pointer. Nothing to restore — verify by
    // read-back and report success WITHOUT any write.
    const untouched = await store.fetchTagObject(currentSha);
    if (parseClaimsPointer(untouched.message).versionedTag !== previous.versionedTag) {
      note("restore-read-back", `ref still names the previous tag object but its pointer names ${parseClaimsPointer(untouched.message).versionedTag}, not ${previous.versionedTag} — outcome UNVERIFIED`);
      return "unverified";
    }
    note("restore-read-back", "ref already names the previous known-good pointer — verified by read-back, NO write issued");
    return "restored";
  }
  if (currentSha !== activatedTagObjectSha) {
    // A concurrent publisher moved the ref — never overwrite it.
    note("ownership-gate-refusal", `ref names ${currentSha}, not this attempt's ${activatedTagObjectSha} — restore refused (foreign reference untouched)`);
    return "foreign-reference-untouched";
  }

  const object = await store.fetchTagObject(previous.tagObjectSha);
  const restoredPointer = parseClaimsPointer(object.message);
  if (restoredPointer.versionedTag !== previous.versionedTag) {
    note("restore-source-check", `the previous tag object's pointer names ${restoredPointer.versionedTag}, not ${previous.versionedTag} — restore refused (UNVERIFIED)`);
    return "unverified";
  }
  note("restore", `ref still names this attempt's activation (${currentSha}) — ownership-verified restore to the previous pointer`);
  const newSha = await store.createTagObject({ message: object.message, commitSha: object.commitSha });
  await store.updateStableRef(newSha, { expectCurrentSha: activatedTagObjectSha });
  const refSha = await store.stableRefSha();
  const readBack = refSha === null ? null : await store.fetchTagObject(refSha).then((o) => parseClaimsPointer(o.message));
  if (readBack?.versionedTag !== previous.versionedTag) {
    note("restore-read-back", `post-restore read-back names ${readBack?.versionedTag ?? "<absent>"}, not ${previous.versionedTag} — outcome UNVERIFIED`);
    return "unverified";
  }
  note("restore-read-back", "restoration verified by read-back");
  return "restored";
}
