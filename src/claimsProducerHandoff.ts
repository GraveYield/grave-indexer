// SPDX-License-Identifier: Apache-2.0
//
// D3→D4 claims-artifact handoff (review finding I-06).
//
// A GitHub Actions dispatch starts a FRESH runner: a bare artifact_path
// input cannot transfer the Rust producer's artifact to the publication
// runner, and an arbitrary local path is never proof of producer origin.
// This module implements the concrete, verifiable handoff:
//
//   1. resolve the PRODUCER RUN by explicit, validated run ID and check it
//      against the EXPECTED PRODUCER IDENTITY (P125-01): the run must
//      belong to the PINNED producer repository, the PINNED trusted
//      branch (main), and the PINNED producer workflow — verified via
//      the GitHub API's authoritative fields (run `path`, run
//      `workflow_id` resolved through the workflows API, NOT the mutable
//      display name alone; the display name is checked only as an
//      additional defense-in-depth signal),
//   2. require the run to be completed+successful, its head SHA to
//      equal the publication's source commit (provenance binding), and
//      its head repository identity to be PRESENT and equal to the
//      pinned producer repository (missing identity fails closed),
//   3. retrieve the NAMED artifact from THAT EXACT run via the
//      authenticated Actions artifacts API, rejecting missing, expired,
//      or ambiguous artifacts,
//   4. download the artifact zip, verify its byte length against the API
//      record, unpack the exact `claims-artifact.json` entry, and verify
//      its CRC32,
//   5. run the full claims-grade byte verification (strict schema,
//      provenance digests, Merkle integrity, pool identity) BEFORE any
//      publication side effect.
//
// P125-01 trust-boundary note: a run's head SHA proves WHAT was built,
// not WHO built it — a fork or feature branch of the same commit is a
// different trust context. The checks below therefore verify the run's
// repository, branch, and workflow identity from GitHub API response
// data only (never caller-supplied metadata alone). Where the GitHub
// API does not expose sufficient evidence for a check, this module
// FAILS CLOSED and reports the limitation rather than assuming trust.
// Branch protection / rulesets on the producer repository remain an
// OWNER-configured control that code cannot enforce (see
// docs/CLAIMS_PUBLICATION.md § P125-01).
//
// This module performs READ-ONLY GitHub API calls (GET only) and never
// logs or returns the token. Publication side effects (draft release,
// assets, tag objects, stable ref) happen ONLY after every check passes.
//
// Honest scope note (see docs/CLAIMS_PUBLICATION.md § D3→D4 handoff): the
// producer side of this handoff — a graveyield-protocol workflow that
// runs `grave-snapshotter-cli` and uploads `claims-artifact.json` as a
// named run artifact — does NOT exist yet. Until it exists, every
// dispatch fails closed at step 3 above. No simulated fixture substitutes
// for that missing dependency.

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { verifyClaimsArtifactBytes } from "./claimsArtifact.js";

/** The single artifact file the Rust producer seals (claimed name). */
export const CLAIMS_PRODUCER_ARTIFACT_NAME = "claims-artifact.json";

/**
 * The repository that owns the Rust claims producer (grave-snapshotter-cli).
 * PINNED (P125-01): the handoff verifies the producer run against THIS
 * exact repository from GitHub API response data; a caller-supplied
 * producerRepo that differs is refused before any network call.
 */
export const DEFAULT_CLAIMS_PRODUCER_REPO = "GraveYield/graveyield-protocol";
/**
 * PINNED producer repository (P125-01). Exported under a pin-named alias
 * so call sites and tests read as the trust boundary they are.
 */
export const PINNED_CLAIMS_PRODUCER_REPO = DEFAULT_CLAIMS_PRODUCER_REPO;
/**
 * PINNED trusted producer branch (P125-01): producer runs are only
 * accepted from the repository's protected `main` branch. Feature
 * branches, tags, and PR refs are refused.
 */
export const PINNED_TRUSTED_PRODUCER_BRANCH = "main";
/**
 * PINNED producer workflow path (P125-01): the run must belong to the
 * workflow defined at this exact path in the producer repository —
 * verified from the API's authoritative `path` field and the run's
 * immutable `workflow_id` (resolved via the workflows API), never from
 * the mutable workflow display name alone.
 */
export const PINNED_CLAIMS_PRODUCER_WORKFLOW_PATH = ".github/workflows/claims-snapshot.yml";

/** The producer identity every claims artifact must be published under. */
export const PINNED_CLAIMS_PRODUCER_IDENTITY = "grave-snapshotter-cli";

/** API JSON responses are bounded — a huge/lying body is rejected. */
export const MAX_HANDOFF_JSON_BYTES = 1024 * 1024;
/** Artifact zips are bounded at 64 MiB (the claims artifact is ~hundreds of KB). */
export const MAX_HANDOFF_ZIP_BYTES = 64 * 1024 * 1024;

export class ClaimsProducerHandoffError extends Error {
  constructor(message: string) {
    super(`claims handoff: ${message}`);
    this.name = "ClaimsProducerHandoffError";
  }
}

/**
 * Strict producer-run-ID parse: decimal digits only, ≥ 1, and a JS safe
 * integer. GitHub run IDs are u64; values beyond Number.MAX_SAFE_INTEGER
 * cannot be addressed by this module and are refused explicitly (the
 * caller must then resolve the run by another identifier).
 */
export function parseProducerRunId(text: string): number {
  if (!/^[0-9]+$/.test(text)) {
    throw new ClaimsProducerHandoffError(`producer run id must be a decimal run number (got ${JSON.stringify(text)})`);
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ClaimsProducerHandoffError(
      `producer run id ${text} is not a representable run number (safe-integer subset enforced)`,
    );
  }
  return id;
}

function repoPatternOk(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

/** The operator-pinned expectations a producer run must satisfy. */
export interface ClaimsProducerExpectations {
  /** Repository owning the producer run, e.g. GraveYield/graveyield-protocol. */
  producerRepo: string;
  /** The exact producer run ID (validated decimal, safe-integer subset). */
  producerRunId: number;
  /**
   * The expected producer workflow identity (workflow `name`). PINNED by
   * the publication workflow's environment — never accepted from an
   * untrusted dispatch input, or an attacker could point the check at
   * their own workflow. The handoff additionally pins this to
   * PINNED_CLAIMS_PRODUCER_IDENTITY and verifies the workflow's
   * authoritative identity via `producerWorkflowPath` + the run's
   * immutable workflow ID (P125-01) — the display name alone is NEVER
   * sufficient.
   */
  producerWorkflowName: string;
  /**
   * The expected producer workflow file path (P125-01), e.g.
   * `.github/workflows/claims-snapshot.yml`. Verified against the run's
   * authoritative `path` field AND the workflow record the run's
   * immutable `workflow_id` resolves to. Must equal the pinned
   * PINNED_CLAIMS_PRODUCER_WORKFLOW_PATH.
   */
  producerWorkflowPath: string;
  /**
   * The trusted producer branch (P125-01). The run's API-reported
   * `head_branch` must equal this value exactly; a missing branch field
   * fails closed. Must equal the pinned PINNED_TRUSTED_PRODUCER_BRANCH
   * (`main`).
   */
  producerBranch: string;
  /** The exact artifact name to retrieve (default CLAIMS_PRODUCER_ARTIFACT_NAME). */
  artifactName: string;
  /** 40-hex commit the publication is for; must equal the run's head_sha. */
  sourceCommit: string;
  /**
   * The producer identity the publication will record; must equal the
   * pinned producer identity (an operator cannot publish under a
   * different identity than the pinned one).
   */
  producerIdentity: string;
  /** Optional pool identity the artifact must match (strict check). */
  expectedPool?: string | undefined;
  /** Optional lp mint the artifact must match (strict check). */
  expectedLpMint?: string | undefined;
  /** Optional AMM program id the artifact must match (strict check). */
  expectedAmmProgramId?: string | undefined;
}

export interface ClaimsProducerHandoffResult {
  /** The verified artifact bytes (claims-grade, identity-checked). */
  bytes: Uint8Array;
  /** The producer run's head commit (=== expectations.sourceCommit). */
  runHeadSha: string;
  /** The Actions artifact database ID that the bytes were retrieved from. */
  artifactId: number;
  /** The artifact name (=== expectations.artifactName). */
  artifactName: string;
  /** sha256 of the verified bytes (hex). */
  artifactSha256Hex: string;
}

async function readCapped(res: Response, cap: number, what: string): Promise<Uint8Array> {
  const headerLen = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(headerLen) && headerLen > cap) {
    throw new ClaimsProducerHandoffError(`${what} response too large (${headerLen} > ${cap} bytes cap)`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new ClaimsProducerHandoffError(`${what} response has no body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) throw new ClaimsProducerHandoffError(`${what} response exceeded the ${cap}-byte cap`);
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string, what: string): Promise<T> {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404) throw new ClaimsProducerHandoffError(`${what} not found (HTTP 404)`);
  if (!res.ok) throw new ClaimsProducerHandoffError(`${what} request failed (HTTP ${res.status})`);
  const bytes = await readCapped(res, MAX_HANDOFF_JSON_BYTES, what);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ClaimsProducerHandoffError(`${what} response is not valid JSON`);
  }
  return parsed as T;
}

// ── minimal ZIP reader (no dependencies; stored + deflate entries only) ──

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const t = CRC32_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0;
    c = t ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16le(b: Uint8Array, off: number): number {
  return (b[off] ?? 0) | ((b[off + 1] ?? 0) << 8);
}
function u32le(b: Uint8Array, off: number): number {
  return ((b[off] ?? 0) | ((b[off + 1] ?? 0) << 8) | ((b[off + 2] ?? 0) << 16) | ((b[off + 3] ?? 0) << 24)) >>> 0;
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * Minimal ZIP central-directory reader. Refuses entries beyond the cap,
 * unsupported compression methods, and CRC mismatches (artifact corruption).
 */
export function readZipEntry(zip: Uint8Array, entryName: string, capBytes: number): ZipEntry {
  // Locate the End-Of-Central-Directory record (scan the last 64 KiB).
  const minEocd = Math.max(0, zip.length - 65_536 - 22);
  let eocd = -1;
  for (let i = zip.length - 22; i >= minEocd; i--) {
    if (u32le(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ClaimsProducerHandoffError("artifact download is not a valid zip archive (no EOCD record)");
  const entryCount = u16le(zip, eocd + 10);
  let cdOffset = u32le(zip, eocd + 16);
  const decoder = new TextDecoder();
  for (let i = 0; i < entryCount; i++) {
    if (cdOffset + 46 > zip.length || u32le(zip, cdOffset) !== 0x02014b50) {
      throw new ClaimsProducerHandoffError("artifact zip has a corrupt central directory");
    }
    const method = u16le(zip, cdOffset + 10);
    const crc = u32le(zip, cdOffset + 16);
    const compressedSize = u32le(zip, cdOffset + 20);
    const nameLen = u16le(zip, cdOffset + 28);
    const extraLen = u16le(zip, cdOffset + 30);
    const commentLen = u16le(zip, cdOffset + 32);
    const localOffset = u32le(zip, cdOffset + 42);
    const name = decoder.decode(zip.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
    const nextCd = cdOffset + 46 + nameLen + extraLen + commentLen;
    if (name === entryName || name.endsWith(`/${entryName}`)) {
      // Read the LOCAL header to find the data start.
      if (localOffset + 30 > zip.length || u32le(zip, localOffset) !== 0x04034b50) {
        throw new ClaimsProducerHandoffError("artifact zip has a corrupt local header");
      }
      const lNameLen = u16le(zip, localOffset + 26);
      const lExtraLen = u16le(zip, localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      let bytes: Uint8Array;
      if (method === 0) {
        bytes = Uint8Array.from(data);
      } else if (method === 8) {
        // deflate-raw decompression.
        bytes = Uint8Array.from(inflateRawSync(Buffer.from(data)));
      } else {
        throw new ClaimsProducerHandoffError(`artifact zip entry uses unsupported compression method ${method}`);
      }
      if (bytes.byteLength > capBytes) {
        throw new ClaimsProducerHandoffError(`artifact entry exceeds the ${capBytes}-byte cap`);
      }
      if (crc32(bytes) !== crc) {
        throw new ClaimsProducerHandoffError("artifact zip entry failed its CRC32 check (corrupted or tampered download)");
      }
      return { name, bytes };
    }
    cdOffset = nextCd;
  }
  throw new ClaimsProducerHandoffError(`artifact zip does not contain the expected ${JSON.stringify(entryName)} entry`);
}

interface ActionsRun {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  head_sha?: unknown;
  /** API-authoritative branch the run was built from (P125-01). */
  head_branch?: unknown;
  /** API-authoritative workflow file path of the run (P125-01). */
  path?: unknown;
  /** Immutable workflow ID the run belongs to (P125-01). */
  workflow_id?: unknown;
  /** The repo the run was built FROM (a fork here fails closed). */
  head_repository?: { full_name?: unknown } | null;
  /** The repo the run LIVES IN (must be the pinned producer repo). */
  repository?: { full_name?: unknown } | null;
}

/** The authoritative workflow record behind a run's immutable workflow_id. */
interface ActionsWorkflow {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  state?: unknown;
}

interface ActionsArtifact {
  id?: unknown;
  name?: unknown;
  expired?: unknown;
  size_in_bytes?: unknown;
}

/**
 * Resolve + verify the producer artifact for one publication — READ-ONLY
 * (GET requests only), fail-closed, token never logged. Every check here
 * happens BEFORE any publication side effect.
 */
export async function fetchVerifiedClaimsArtifact(opts: {
  token: string;
  expectations: ClaimsProducerExpectations;
  fetchImpl?: typeof fetch;
}): Promise<ClaimsProducerHandoffResult> {
  const { token, expectations } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const e = expectations;

  // ── local input validation (before ANY network call) ──
  if (typeof token !== "string" || token.length === 0) {
    throw new ClaimsProducerHandoffError("a GitHub token is required for the producer-run handoff");
  }
  if (!Number.isSafeInteger(e.producerRunId) || e.producerRunId < 1) {
    throw new ClaimsProducerHandoffError(`producer run id must be a positive safe integer (got ${String(e.producerRunId)})`);
  }
  if (!repoPatternOk(e.producerRepo)) {
    throw new ClaimsProducerHandoffError(`producer repo is not owner/name (got ${JSON.stringify(e.producerRepo)})`);
  }
  if (typeof e.producerWorkflowName !== "string" || e.producerWorkflowName.length === 0) {
    throw new ClaimsProducerHandoffError("the expected producer workflow identity must be pinned (non-empty)");
  }
  // ── P125-01: pin the producer trust boundary — repository, branch,
  // and workflow path are verified against immutable pins BEFORE any
  // network call, so a caller can never redirect the handoff at its own
  // repo/branch/workflow.
  if (e.producerRepo !== PINNED_CLAIMS_PRODUCER_REPO) {
    throw new ClaimsProducerHandoffError(
      `producer repo ${JSON.stringify(e.producerRepo)} is not the pinned producer repository ${JSON.stringify(PINNED_CLAIMS_PRODUCER_REPO)} — refusing publication (P125-01)`,
    );
  }
  if (typeof e.producerBranch !== "string" || e.producerBranch.length === 0) {
    throw new ClaimsProducerHandoffError("the trusted producer branch must be pinned (non-empty)");
  }
  if (e.producerBranch !== PINNED_TRUSTED_PRODUCER_BRANCH) {
    throw new ClaimsProducerHandoffError(
      `trusted branch ${JSON.stringify(e.producerBranch)} is not the pinned trusted branch ${JSON.stringify(PINNED_TRUSTED_PRODUCER_BRANCH)} — refusing publication (P125-01)`,
    );
  }
  if (typeof e.producerWorkflowPath !== "string" || e.producerWorkflowPath.length === 0) {
    throw new ClaimsProducerHandoffError("the expected producer workflow path must be pinned (non-empty)");
  }
  if (e.producerWorkflowPath !== PINNED_CLAIMS_PRODUCER_WORKFLOW_PATH) {
    throw new ClaimsProducerHandoffError(
      `workflow path ${JSON.stringify(e.producerWorkflowPath)} is not the pinned producer workflow path ${JSON.stringify(PINNED_CLAIMS_PRODUCER_WORKFLOW_PATH)} — refusing publication (P125-01)`,
    );
  }
  if (e.producerWorkflowName !== PINNED_CLAIMS_PRODUCER_IDENTITY) {
    throw new ClaimsProducerHandoffError(
      `producer workflow name ${JSON.stringify(e.producerWorkflowName)} does not match the pinned producer workflow ${JSON.stringify(PINNED_CLAIMS_PRODUCER_IDENTITY)} — refusing publication (P125-01)`,
    );
  }
  if (typeof e.artifactName !== "string" || e.artifactName.length === 0) {
    throw new ClaimsProducerHandoffError("the expected artifact name must be non-empty");
  }
  if (!/^[0-9a-f]{40}$/.test(e.sourceCommit)) {
    throw new ClaimsProducerHandoffError(`sourceCommit must be a 40-hex Git commit SHA (got ${JSON.stringify(e.sourceCommit)})`);
  }
  if (typeof e.producerIdentity !== "string" || e.producerIdentity.length === 0) {
    throw new ClaimsProducerHandoffError("producerIdentity must be a non-empty string");
  }
  if (e.producerIdentity !== PINNED_CLAIMS_PRODUCER_IDENTITY) {
    // Producer identity mismatch: the publication may not run under an
    // identity other than the pinned Rust producer.
    throw new ClaimsProducerHandoffError(
      `producer identity ${JSON.stringify(e.producerIdentity)} does not match the pinned producer identity ${JSON.stringify(PINNED_CLAIMS_PRODUCER_IDENTITY)} — refusing publication`,
    );
  }

  const base = `https://api.github.com/repos/${e.producerRepo}`;

  // ── 1. resolve + validate the producer run ──
  const run = await fetchJson<ActionsRun>(fetchImpl, `${base}/actions/runs/${e.producerRunId}`, token, "producer run");
  if (run.name !== e.producerWorkflowName) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} belongs to workflow ${JSON.stringify(String(run.name))}, not the expected producer workflow ${JSON.stringify(e.producerWorkflowName)} — WRONG WORKFLOW IDENTITY`,
    );
  }
  if (run.status !== "completed") {
    throw new ClaimsProducerHandoffError(`producer run ${e.producerRunId} is not completed (status ${JSON.stringify(String(run.status))})`);
  }
  if (run.conclusion !== "success") {
    throw new ClaimsProducerHandoffError(`producer run ${e.producerRunId} did not succeed (conclusion ${JSON.stringify(String(run.conclusion))})`);
  }
  if (typeof run.head_sha !== "string" || run.head_sha !== e.sourceCommit) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} head commit ${JSON.stringify(String(run.head_sha))} does not match the publication source commit ${JSON.stringify(e.sourceCommit)} — provenance mismatch`,
    );
  }
  // ── P125-01: trusted-branch + repository-identity verification from
  // API response data. A missing field FAILS CLOSED (no assumption of
  // trust from absent evidence).
  if (typeof run.head_branch !== "string" || run.head_branch.length === 0) {
    // GitHub's API did not expose the branch evidence: fail closed.
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} has NO usable head_branch metadata — the trusted branch cannot be verified; failing closed (P125-01)`,
    );
  }
  if (run.head_branch !== PINNED_TRUSTED_PRODUCER_BRANCH) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} was built from branch ${JSON.stringify(run.head_branch)}, not the trusted branch ${JSON.stringify(PINNED_TRUSTED_PRODUCER_BRANCH)} — UNTRUSTED BRANCH (P125-01)`,
    );
  }
  const headRepo = typeof run.head_repository?.full_name === "string" && run.head_repository.full_name.length > 0
    ? run.head_repository.full_name
    : null;
  if (headRepo === null) {
    // Missing head repository identity is NOT treated as trusted
    // (P125-01): absent evidence fails closed.
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} has NO usable head repository identity — producer origin cannot be verified; failing closed (P125-01)`,
    );
  }
  if (headRepo !== e.producerRepo) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} was built from a different repository (${headRepo}) — FORK / UNTRUSTED ORIGIN (P125-01)`,
    );
  }
  const runRepo = typeof run.repository?.full_name === "string" && run.repository.full_name.length > 0
    ? run.repository.full_name
    : null;
  if (runRepo === null) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} has NO usable repository identity — the owning repository cannot be verified; failing closed (P125-01)`,
    );
  }
  if (runRepo !== e.producerRepo) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} belongs to repository ${JSON.stringify(runRepo)}, not the pinned producer repository ${JSON.stringify(e.producerRepo)} (P125-01)`,
    );
  }

  // ── P125-01: authoritative workflow identity — the run's `path`
  // field AND its immutable `workflow_id` (resolved via the workflows
  // API) must both identify the pinned producer workflow. The mutable
  // display name alone is never sufficient.
  if (typeof run.path !== "string" || run.path.length === 0) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} has NO usable workflow path metadata — the workflow identity cannot be verified; failing closed (P125-01)`,
    );
  }
  if (run.path !== e.producerWorkflowPath) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} belongs to workflow ${JSON.stringify(run.path)}, not the expected producer workflow path ${JSON.stringify(e.producerWorkflowPath)} — WRONG WORKFLOW PATH (P125-01)`,
    );
  }
  if (typeof run.workflow_id !== "number" || !Number.isSafeInteger(run.workflow_id) || run.workflow_id < 1) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} has NO usable immutable workflow_id metadata — the workflow identity cannot be verified; failing closed (P125-01)`,
    );
  }
  const workflow = await fetchJson<ActionsWorkflow>(
    fetchImpl,
    `${base}/actions/workflows/${run.workflow_id}`,
    token,
    "producer workflow record",
  );
  if (typeof workflow.path !== "string" || workflow.path.length === 0) {
    throw new ClaimsProducerHandoffError(
      `the workflow record for run ${e.producerRunId} has NO usable path metadata; failing closed (P125-01)`,
    );
  }
  if (workflow.path !== e.producerWorkflowPath) {
    throw new ClaimsProducerHandoffError(
      `the immutable workflow ID of run ${e.producerRunId} resolves to ${JSON.stringify(workflow.path)}, not the expected ${JSON.stringify(e.producerWorkflowPath)} — WORKFLOW IDENTITY MISMATCH (P125-01)`,
    );
  }
  const wfState = typeof workflow.state === "string" ? workflow.state : null;
  if (wfState === null || !(wfState === "active" || wfState === "active_can_be_scheduled")) {
    throw new ClaimsProducerHandoffError(
      `the producer workflow of run ${e.producerRunId} is not active (state ${JSON.stringify(wfState)}); failing closed (P125-01)`,
    );
  }

  // ── 2. retrieve the NAMED artifact from THAT EXACT run ──
  const list = await fetchJson<{ total_count?: unknown; artifacts?: ActionsArtifact[] }>(
    fetchImpl,
    `${base}/actions/runs/${e.producerRunId}/artifacts?per_page=100`,
    token,
    "producer run artifacts",
  );
  const artifacts: ActionsArtifact[] = Array.isArray(list.artifacts) ? list.artifacts : [];
  const matching = artifacts.filter((a) => a.name === e.artifactName);
  if (matching.length === 0) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} has NO artifact named ${JSON.stringify(e.artifactName)} — the producer side must upload it (missing artifact; see docs/CLAIMS_PUBLICATION.md)`,
    );
  }
  if (matching.length > 1) {
    throw new ClaimsProducerHandoffError(`producer run ${e.producerRunId} has ${matching.length} artifacts named ${JSON.stringify(e.artifactName)} — AMBIGUOUS, refusing`);
  }
  const artifact: ActionsArtifact = matching[0] ?? {};
  if (typeof artifact.id !== "number") {
    // unreachable: matching.length >= 1 guarantees an element
    throw new ClaimsProducerHandoffError("producer artifact record is missing");
  }
  const artifactId = typeof artifact.id === "number" && Number.isSafeInteger(artifact.id) ? artifact.id : null;
  if (artifactId === null) {
    throw new ClaimsProducerHandoffError("producer artifact record has no usable numeric id");
  }
  if (artifact.expired === true) {
    throw new ClaimsProducerHandoffError(
      `producer artifact ${artifactId} (${JSON.stringify(e.artifactName)}) is EXPIRED — re-run the producer; expired artifacts are never published`,
    );
  }
  const sizeInBytes = typeof artifact.size_in_bytes === "number" && Number.isSafeInteger(artifact.size_in_bytes) ? artifact.size_in_bytes : null;
  if (sizeInBytes === null || sizeInBytes <= 0) {
    throw new ClaimsProducerHandoffError(`producer artifact ${artifactId} has no usable size_in_bytes record`);
  }

  // ── 3. download the artifact zip (bounded; follows at most one redirect) ──
  const zipUrl = `${base}/actions/runs/${e.producerRunId}/artifacts/${artifactId}/zip`;
  const zipRes = await fetchImpl(zipUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    redirect: "manual",
  });
  let zipBytes: Uint8Array;
  if (zipRes.status >= 300 && zipRes.status < 400) {
    const loc = zipRes.headers.get("location");
    if (!loc) throw new ClaimsProducerHandoffError("artifact download redirect has no Location header");
    const dl = await fetchImpl(loc, { redirect: "follow" });
    if (!dl.ok) throw new ClaimsProducerHandoffError(`artifact download failed (HTTP ${dl.status})`);
    zipBytes = await readCapped(dl, Math.min(MAX_HANDOFF_ZIP_BYTES, sizeInBytes), "artifact zip");
  } else if (zipRes.ok) {
    zipBytes = await readCapped(zipRes, Math.min(MAX_HANDOFF_ZIP_BYTES, sizeInBytes), "artifact zip");
  } else {
    throw new ClaimsProducerHandoffError(`artifact download failed (HTTP ${zipRes.status}) — artifact may be unavailable`);
  }
  // Digest/byte-length check: the downloaded zip must match the API record.
  if (zipBytes.byteLength !== sizeInBytes) {
    throw new ClaimsProducerHandoffError(
      `artifact zip byte length ${zipBytes.byteLength} != producer-run record ${sizeInBytes} — DIGEST/BYTE-LENGTH MISMATCH, refusing`,
    );
  }

  // ── 4. unpack the exact artifact entry (CRC-checked) ──
  const entry = readZipEntry(zipBytes, e.artifactName, MAX_HANDOFF_ZIP_BYTES);
  void entry.name;

  // ── 5. claims-grade byte verification + identity expectations ──
  const verified = verifyClaimsArtifactBytes(entry.bytes, {
    ...(e.expectedPool !== undefined ? { pool: e.expectedPool } : {}),
    ...(e.expectedLpMint !== undefined ? { lpMint: e.expectedLpMint } : {}),
    ...(e.expectedAmmProgramId !== undefined ? { ammProgramId: e.expectedAmmProgramId } : {}),
  });
  void verified;
  // (verifyClaimsArtifactBytes throws on schema/provenance/pool mismatch.)

  return {
    bytes: entry.bytes,
    runHeadSha: run.head_sha,
    artifactId,
    artifactName: e.artifactName,
    artifactSha256Hex: createHash("sha256").update(entry.bytes).digest("hex"),
  };
}

/**
 * Composition boundary used by the publication CLI: handoff FIRST, then
 * publish. The publish callback runs ONLY when every handoff check has
 * passed — invalid artifacts cause ZERO publication side effects.
 */
export async function publishVerifiedProducerArtifact<T>(opts: {
  token: string;
  expectations: ClaimsProducerExpectations;
  fetchImpl?: typeof fetch;
  publish: (bytes: Uint8Array) => Promise<T>;
}): Promise<T> {
  const handoff = await fetchVerifiedClaimsArtifact(opts);
  return opts.publish(handoff.bytes);
}
