// SPDX-License-Identifier: Apache-2.0
//
// D3→D4 claims-artifact handoff (review finding I-06).
//
// A GitHub Actions dispatch starts a FRESH runner: a bare artifact_path
// input cannot transfer the Rust producer's artifact to the publication
// runner, and an arbitrary local path is never proof of producer origin.
// This module implements the concrete, verifiable handoff:
//
//   1. resolve the TRUSTED PRODUCER WORKFLOW by its PATH in the trusted
//      repository's workflow registry (GitHub-authoritative), requiring
//      the registry record to be active and to match the pinned identity,
//   2. resolve the PRODUCER RUN by explicit, validated run ID and bind it
//      to that exact workflow (immutable numeric workflow ID + workflow
//      path), the trusted branch, and the trusted repository context —
//      every value taken from GitHub's API response, never from
//      caller-controlled arguments (review finding P125-01),
//   3. require the run to be completed+successful and its head_sha to
//      equal the publication's source commit (provenance binding),
//   4. retrieve the NAMED artifact from THAT EXACT run via the
//      authenticated Actions artifacts API, rejecting missing, expired,
//      oversized, ambiguous, or run-mismatched artifacts,
//   5. download the artifact zip, verify its byte length against the API
//      record, unpack the exact `claims-artifact.json` entry, and verify
//      its CRC32,
//   6. run the full claims-grade byte verification (strict schema,
//      provenance digests, Merkle integrity, pool identity) BEFORE any
//      publication side effect.
//
// This module performs READ-ONLY GitHub API calls (GET only) and never
// logs or returns the token. Publication side effects (draft release,
// assets, tag objects, stable ref) happen ONLY after every check passes.
//
// Honest scope note (see docs/CLAIMS_PUBLICATION.md § D3→D4 handoff): the
// producer side of this handoff — a graveyield-protocol workflow that
// runs `grave-snapshotter-cli` and uploads `claims-artifact.json` as a
// named run artifact — is being added by protocol PR #125. Until it is
// merged, every dispatch fails closed. No simulated fixture substitutes
// for that missing dependency.

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { verifyClaimsArtifactBytes } from "./claimsArtifact.js";

/** The single artifact file the Rust producer seals (claimed name). */
export const CLAIMS_PRODUCER_ARTIFACT_NAME = "claims-artifact.json";

/**
 * The TRUSTED PRODUCER REPOSITORY (P125-01). Enforced by the consumer:
 * a caller-supplied repo argument that disagrees is rejected before any
 * network call — the verifier never asks the caller which repo to trust.
 */
export const TRUSTED_CLAIMS_PRODUCER_REPO = "GraveYield/graveyield-protocol";

/** Kept for backwards compatibility of the CLI default; identical value. */
export const DEFAULT_CLAIMS_PRODUCER_REPO = TRUSTED_CLAIMS_PRODUCER_REPO;

/**
 * The TRUSTED PRODUCER BRANCH (P125-01). The producer run must have been
 * executed against this branch — taken from the run's GitHub-authoritative
 * `head_branch`, never from caller input.
 */
export const TRUSTED_CLAIMS_PRODUCER_BRANCH = "main";

/**
 * The TRUSTED PRODUCER WORKFLOW PATH (P125-01). Identity anchor: resolved
 * in the trusted repository's workflow REGISTRY by this path; a run is
 * accepted only when its immutable numeric `workflow_id` binds to that
 * registry record and its `path` matches. A workflow display name is NOT
 * identity — two workflows can share one.
 */
export const TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH = ".github/workflows/claims-snapshot.yml";

/**
 * The display name the trusted workflow pins (`name:` in
 * claims-snapshot.yml). Kept in lock-step with the producer workflow by
 * tests on both sides; checked against the REGISTRY record's
 * GitHub-authoritative `name`, never against the run's caller-pinned
 * expectation alone.
 */
export const TRUSTED_CLAIMS_PRODUCER_WORKFLOW_NAME = "grave-snapshotter-cli";

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

/** The operator-pinned expectations a producer run must satisfy. */
export interface ClaimsProducerExpectations {
  /**
   * Repository owning the producer run. NOT trusted as-is: the consumer
   * enforces that this equals TRUSTED_CLAIMS_PRODUCER_REPO and rejects
   * any other value before any network call (P125-01).
   */
  producerRepo: string;
  /** The exact producer run ID (validated decimal, safe-integer subset). */
  producerRunId: number;
  /**
   * The expected producer workflow identity (workflow `name`). This is a
   * DECLARATION only — it must equal the consumer's pinned
   * TRUSTED_CLAIMS_PRODUCER_WORKFLOW_NAME, and the ACTUAL identity check
   * is performed against GitHub-authoritative registry data (workflow
   * path + immutable workflow ID), never against this string. A caller
   * cannot point the check at a different workflow by changing it.
   */
  producerWorkflowName: string;
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
  /**
   * The verified producer identity evidence (P125-01) — GitHub-
   * authoritative values the run was bound to before acceptance.
   */
  trustedProducer: {
    repo: string;
    branch: string;
    workflowPath: string;
    /** Immutable numeric workflow id the run's workflow_id was bound to. */
    workflowId: number;
  };
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
  /** GitHub-authoritative branch the run was executed against. */
  head_branch?: unknown;
  /** Immutable numeric workflow identifier (binds the run to a definition). */
  workflow_id?: unknown;
  /** Workflow path GitHub recorded for the run (e.g. .github/workflows/x.yml). */
  path?: unknown;
  head_repository?: { full_name?: unknown } | null;
  repository?: { full_name?: unknown } | null;
}

/**
 * The workflow-registry record for the trusted producer workflow
 * (GET /repos/{repo}/actions/workflows/{workflow_filename}).
 */
interface WorkflowRecord {
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
  /**
   * GitHub-authoritative run binding for the artifact. A real artifact
   * record always carries it; its absence is treated as insufficient
   * identity evidence and rejected (fail closed).
   */
  workflow_run?: { id?: unknown; head_sha?: unknown } | null;
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
  // P125-01: the trusted producer repository is enforced by the consumer.
  // A caller-supplied repo that disagrees is rejected here — the verifier
  // never asks the caller which repository to trust.
  if (e.producerRepo !== TRUSTED_CLAIMS_PRODUCER_REPO) {
    throw new ClaimsProducerHandoffError(
      `producer repo ${JSON.stringify(e.producerRepo)} is not the trusted producer repository ${JSON.stringify(TRUSTED_CLAIMS_PRODUCER_REPO)} — refusing to verify a run outside the trusted producer`,
    );
  }
  if (typeof e.producerWorkflowName !== "string" || e.producerWorkflowName.length === 0) {
    throw new ClaimsProducerHandoffError("the expected producer workflow identity must be pinned (non-empty)");
  }
  // P125-01: the caller-declared workflow name is only a lock-step
  // declaration; it may not point the check at a different workflow.
  if (e.producerWorkflowName !== TRUSTED_CLAIMS_PRODUCER_WORKFLOW_NAME) {
    throw new ClaimsProducerHandoffError(
      `declared producer workflow name ${JSON.stringify(e.producerWorkflowName)} does not match the consumer's pinned producer workflow ${JSON.stringify(TRUSTED_CLAIMS_PRODUCER_WORKFLOW_NAME)}`,
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

  const base = `https://api.github.com/repos/${TRUSTED_CLAIMS_PRODUCER_REPO}`;

  // ── 1. resolve the TRUSTED WORKFLOW in the registry (P125-01) ──
  // GitHub-authoritative: this record is fetched by the workflow PATH
  // from the trusted repository's own workflow registry — a caller
  // cannot influence it. Its immutable numeric `id` is what the run will
  // be bound to; a workflow display name would not be identity (two
  // workflows can share one).
  const workflow = await fetchJson<WorkflowRecord>(
    fetchImpl,
    `${base}/actions/workflows/${TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH}`,
    token,
    "trusted producer workflow",
  );
  if (typeof workflow.id !== "number" || !Number.isSafeInteger(workflow.id)) {
    // Fail closed: without the registry record's numeric id the run
    // cannot be bound to a workflow definition.
    throw new ClaimsProducerHandoffError(
      "trusted producer workflow registry record has no usable numeric workflow id — missing workflow identity metadata, refusing",
    );
  }
  if (workflow.state !== "active") {
    throw new ClaimsProducerHandoffError(
      `trusted producer workflow ${TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH} is not active in the trusted repository (state ${JSON.stringify(String(workflow.state))}) — refusing`,
    );
  }
  if (typeof workflow.path !== "string" || workflow.path.length === 0) {
    throw new ClaimsProducerHandoffError(
      "trusted producer workflow registry record is missing its path — missing workflow identity metadata, refusing",
    );
  }
  if (workflow.path !== TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH) {
    throw new ClaimsProducerHandoffError(
      `trusted producer workflow registry path ${JSON.stringify(workflow.path)} does not match the pinned workflow path ${JSON.stringify(TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH)}`,
    );
  }
  // The caller-declared name must agree with the GitHub-authoritative
  // registry name ("caller supplies expected workflow name but GitHub
  // reports another workflow" → reject).
  if (typeof workflow.name !== "string" || workflow.name.length === 0) {
    throw new ClaimsProducerHandoffError(
      "trusted producer workflow registry record is missing its name — missing workflow identity metadata, refusing",
    );
  }
  if (workflow.name !== e.producerWorkflowName) {
    throw new ClaimsProducerHandoffError(
      `trusted producer workflow registry name ${JSON.stringify(workflow.name)} does not match the expected producer workflow ${JSON.stringify(e.producerWorkflowName)} — WRONG WORKFLOW IDENTITY`,
    );
  }

  // ── 2. resolve + validate the producer run ──
  const run = await fetchJson<ActionsRun>(fetchImpl, `${base}/actions/runs/${e.producerRunId}`, token, "producer run");
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
  // P125-01: bind the run to the trusted workflow definition — immutable
  // numeric workflow ID first, then the workflow path GitHub recorded
  // for the run. A run that shares the display name but was produced by
  // a different workflow file is rejected here.
  if (typeof run.workflow_id !== "number" || !Number.isSafeInteger(run.workflow_id)) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} is missing its workflow_id — missing workflow identity metadata, refusing (fail closed)`,
    );
  }
  if (run.workflow_id !== workflow.id) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} was executed by workflow id ${run.workflow_id}, not the trusted producer workflow id ${workflow.id} (${TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH}) — DIFFERENT WORKFLOW ID`,
    );
  }
  if (typeof run.path !== "string" || run.path.length === 0) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} is missing its workflow path — missing workflow identity metadata, refusing (fail closed)`,
    );
  }
  if (run.path !== TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} was executed from workflow path ${JSON.stringify(run.path)}, not the trusted ${JSON.stringify(TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH)} — WRONG WORKFLOW IDENTITY`,
    );
  }
  // P125-01: the run must belong to the TRUSTED BRANCH — GitHub's
  // authoritative head_branch, never a caller-supplied branch name.
  if (typeof run.head_branch !== "string" || run.head_branch.length === 0) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} is missing its head_branch — missing branch/ref metadata, refusing (fail closed)`,
    );
  }
  if (run.head_branch !== TRUSTED_CLAIMS_PRODUCER_BRANCH) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} was executed against branch ${JSON.stringify(run.head_branch)}, not the trusted producer branch ${JSON.stringify(TRUSTED_CLAIMS_PRODUCER_BRANCH)}`,
    );
  }
  // P125-01: fork / untrusted-repository context. The run's own
  // repository AND the commit's source repository must both be the
  // trusted producer repository; a fork-run (head_repository = fork)
  // or a run whose commit came from another repo is rejected.
  if (typeof run.repository?.full_name !== "string" || run.repository.full_name.length === 0) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} is missing its repository identity — missing repository metadata, refusing (fail closed)`,
    );
  }
  if (run.repository.full_name !== TRUSTED_CLAIMS_PRODUCER_REPO) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} belongs to repository ${JSON.stringify(String(run.repository.full_name))}, not the trusted producer repository ${JSON.stringify(TRUSTED_CLAIMS_PRODUCER_REPO)}`,
    );
  }
  if (typeof run.head_repository?.full_name !== "string" || run.head_repository.full_name.length === 0) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} is missing its head repository identity — missing branch/ref metadata, refusing (fail closed)`,
    );
  }
  if (run.head_repository.full_name !== TRUSTED_CLAIMS_PRODUCER_REPO) {
    throw new ClaimsProducerHandoffError(
      `producer run ${e.producerRunId} was built from repository ${JSON.stringify(String(run.head_repository.full_name))}, not the trusted producer repository ${JSON.stringify(TRUSTED_CLAIMS_PRODUCER_REPO)} — FORK/UNTRUSTED CONTEXT`,
    );
  }

  // ── 3. retrieve the NAMED artifact from THAT EXACT run ──
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
  // Configured size limit: refuse BEFORE any download work.
  if (sizeInBytes > MAX_HANDOFF_ZIP_BYTES) {
    throw new ClaimsProducerHandoffError(
      `producer artifact ${artifactId} size ${sizeInBytes} exceeds the configured ${MAX_HANDOFF_ZIP_BYTES}-byte artifact size limit — refusing`,
    );
  }
  // P125-01: the artifact must BELONG to the exact producer run. GitHub's
  // artifact record carries the run binding (workflow_run) authoritatively;
  // its absence is insufficient identity evidence and fails closed.
  if (typeof artifact.workflow_run?.id !== "number" || !Number.isSafeInteger(artifact.workflow_run.id)) {
    throw new ClaimsProducerHandoffError(
      `producer artifact ${artifactId} record is missing its workflow_run run binding — missing artifact-to-run identity metadata, refusing (fail closed)`,
    );
  }
  if (artifact.workflow_run.id !== e.producerRunId) {
    throw new ClaimsProducerHandoffError(
      `producer artifact ${artifactId} belongs to run ${artifact.workflow_run.id}, not the requested producer run ${e.producerRunId} — ARTIFACT/FROM-ANOTHER-RUN`,
    );
  }
  if (typeof artifact.workflow_run.head_sha !== "string" || artifact.workflow_run.head_sha.length === 0) {
    throw new ClaimsProducerHandoffError(
      `producer artifact ${artifactId} record is missing its workflow_run head commit — missing artifact-to-run identity metadata, refusing (fail closed)`,
    );
  }
  if (artifact.workflow_run.head_sha !== run.head_sha) {
    throw new ClaimsProducerHandoffError(
      `producer artifact ${artifactId} run binding head commit ${JSON.stringify(artifact.workflow_run.head_sha)} differs from the producer run head commit ${JSON.stringify(run.head_sha)} — ARTIFACT/FROM-ANOTHER-RUN`,
    );
  }

  // ── 4. download the artifact zip (bounded; follows at most one redirect) ──
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

  // ── 5. unpack the exact artifact entry (CRC-checked) ──
  const entry = readZipEntry(zipBytes, e.artifactName, MAX_HANDOFF_ZIP_BYTES);
  void entry.name;

  // ── 6. claims-grade byte verification + identity expectations ──
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
    trustedProducer: {
      repo: TRUSTED_CLAIMS_PRODUCER_REPO,
      branch: run.head_branch as string,
      workflowPath: run.path as string,
      workflowId: workflow.id,
    },
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
