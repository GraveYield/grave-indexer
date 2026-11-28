// SPDX-License-Identifier: Apache-2.0
//
// Claims-artifact verification — the D4 publication gate.
//
// The claims-artifact publication lifecycle accepts ONLY a D3-produced,
// claims-grade Rust snapshotter artifact (format v2, complete governed
// provenance). This module is the publication-side verifier: an
// independent transcription of `graveyield-protocol` snapshotter/src/
// artifact.rs `verify_integrity` (the claims-grade contract), used to
// refuse ANY artifact that the Rust producer's own contract would refuse:
//
//   * format_version must be exactly 2 (v2 = v1 + exclusions + locked
//     report + governed provenance; a genuine v1 document fails at parse
//     because the v2 fields are required);
//   * full Merkle re-derivation through the vendored SDK tree (the
//     byte-locked port of snapshotter/src/tree.rs): root, leaf_count,
//     tree_depth, every leaf, every proof;
//   * the closing reconciliation identity
//     `entries + sink_exclusions == enumerated == lp_total_supply`;
//   * the exclusion ledger (canonical order, reasons, sink total);
//   * the locked-LP report (attributions sum, custody rules);
//   * CLAIMS-GRADE provenance REQUIRED: lock evidence (source `rpc`,
//     UNCX Raydium AMM V4 locker program, supported commitment,
//     anchor_slot == snapshot_slot, records/totals agreement) and — when
//     explicit sink exclusions are present — the governed sink-ledger
//     provenance (schema version, ledger identity, input digest).
//
// TRUST BOUNDARY (unchanged): this verifies artifact STRUCTURE, supported
// values, and internal consistency. It does NOT establish that the RPC
// evidence was authentic or that a sink ledger was owner-approved
// (D-04-D process control). The on-chain PoolRegistry root remains the
// authoritative claims root.
//
// u64 SAFETY: every u64 field is read EXACTLY through a reviver that
// uses the JSON.parse source text (Node ≥ 21). A number past 2^53 that
// survived a plain JSON.parse would be REFUSED, not silently rounded —
// the same fail-closed behavior the producer and the console enforce.

import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { SnapshotMerkleTree } from "@graveyield/sdk";

/** The only artifact format this publication lifecycle accepts. */
export const CLAIMS_ARTIFACT_FORMAT_VERSION = 2;

/** The only locker program the claims-grade provenance may name. */
export const UNCX_RAYDIUM_AMM_V4_LOCKER_PROGRAM_ID =
  "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo";

/** The sink-ledger schema version provenance must carry (`gy.sink-ledger.v1`). */
export const CLAIMS_SINK_LEDGER_SCHEMA_VERSION = 1;

/** Commitment levels supported for claims-grade construction (D2). */
export const CLAIMS_COMMITMENTS = ["confirmed", "finalized"] as const;
export type ClaimsCommitment = (typeof CLAIMS_COMMITMENTS)[number];

export class ClaimsArtifactError extends Error {
  constructor(message: string) {
    super(`claims-artifact: ${message}`);
    this.name = "ClaimsArtifactError";
  }
}

/** Exact-shape claims artifact (u64 fields are bigints after exact parsing). */
export interface ClaimsArtifact {
  format_version: number;
  pool_address: string;
  amm_program_id: string;
  lp_mint: string;
  snapshot_slot: bigint;
  lp_total_supply_at_snapshot: bigint;
  merkle_root: string;
  leaf_count: bigint;
  tree_depth: bigint;
  entries: Array<{ owner: string; lp_balance: bigint; leaf: string; proof: string[] }>;
  reconciliation: {
    entries_total: bigint;
    sink_exclusions_total: bigint;
    enumerated_total: bigint;
  };
  exclusions: Array<{ owner: string; lp_balance: bigint; reason: string }>;
  locked: {
    lock_records_seen: bigint;
    total_locked: bigint;
    attributions: Array<{ owner: string; lp_balance: bigint }>;
    custody: { token_account: string; owner: string; balance: bigint; method: string } | null;
  };
  provenance: {
    sink_ledger: {
      schema_version: bigint;
      ledger_id: string;
      input_sha256: string;
      entry_count: bigint;
      sink_exclusions_total: bigint;
    } | null;
    lock_evidence: {
      source: string;
      program_id: string;
      commitment: string;
      anchor_slot: bigint;
      records_seen: bigint;
      total_locked: bigint;
    };
  };
}

const U64_MAX = (1n << 64n) - 1n;

const U64_KEYS = new Set([
  "snapshot_slot",
  "lp_total_supply_at_snapshot",
  "leaf_count",
  "tree_depth",
  "lp_balance",
  "entries_total",
  "sink_exclusions_total",
  "enumerated_total",
  "lock_records_seen",
  "total_locked",
  "balance",
  "entry_count",
  "anchor_slot",
  "records_seen",
  "schema_version",
]);

/** Exact-integer parse of a claims artifact (see module doc). */
export function parseClaimsArtifact(text: string): ClaimsArtifact {
  // D4 review: full u64 domain enforcement on EVERY serialized u64 field —
  // negatives refused, values above 2^64-1 refused, imprecise magnitudes
  // refused. Arithmetic consistency downstream is never relied on for
  // range safety.
  const reviver = (
    key: string,
    value: unknown,
    context?: { source?: string },
  ): unknown => {
    if (U64_KEYS.has(key) && typeof value === "number") {
      const source = context?.source;
      if (typeof source === "string" && /^\d+$/.test(source)) {
        const exact = BigInt(source);
        if (exact > U64_MAX) {
          throw new ClaimsArtifactError(
            `field "${key}" value ${source} is outside the u64 range (0 … 2^64-1)`,
          );
        }
        return exact;
      }
      if (value < 0 || !Number.isSafeInteger(value)) {
        throw new ClaimsArtifactError(
          `field "${key}" is not a non-negative in-range integer (negative, rounded, or beyond exact-integer parse capability)`,
        );
      }
      return BigInt(value);
    }
    return value;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
  } catch (err) {
    if (err instanceof ClaimsArtifactError) throw err;
    throw new ClaimsArtifactError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parsed as ClaimsArtifact;
}

function decode58(s: string, what: string): Uint8Array {
  try {
    return bs58.decode(s);
  } catch {
    throw new ClaimsArtifactError(`${what} is not a valid base58 pubkey`);
  }
}

function compareOwners(a: string, b: string): number {
  const ab = decode58(a, "owner");
  const bb = decode58(b, "owner");
  for (let i = 0; i < 32; i++) {
    if ((ab[i] ?? 0) !== (bb[i] ?? 0)) return (ab[i] ?? 0) - (bb[i] ?? 0);
  }
  return 0;
}

function hex32(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^[0-9a-fA-F]{64}$/.test(v)) {
    throw new ClaimsArtifactError(`${what} must be 64 hex characters`);
  }
  return v.toLowerCase();
}

const LOWER64 = /^[0-9a-f]{64}$/;

/**
 * Full claims-grade verification of a parsed artifact. Throws
 * `ClaimsArtifactError` on any violation. `expected` binds the artifact
 * to the publication input (identity) when provided.
 */
export function verifyClaimsArtifactIntegrity(
  a: ClaimsArtifact,
  expected?: { pool?: string; ammProgramId?: string; lpMint?: string },
): { rootHex: string; snapshotSlot: number; leafCount: number } {
  // A `function` declaration with an explicit `never` return type — TS
  // narrows control flow across calls to it.
  function fail(m: string): never {
    throw new ClaimsArtifactError(m);
  }
  if (a.format_version !== CLAIMS_ARTIFACT_FORMAT_VERSION) {
    fail(`unsupported format_version ${String(a.format_version)} (expected ${CLAIMS_ARTIFACT_FORMAT_VERSION})`);
  }
  if (typeof a.snapshot_slot !== "bigint" || a.snapshot_slot <= 0n) {
    fail("snapshot_slot must be a positive integer");
  }
  if (typeof a.lp_total_supply_at_snapshot !== "bigint" || a.lp_total_supply_at_snapshot <= 0n) {
    fail("lp_total_supply_at_snapshot must be a positive integer");
  }
  if (expected?.pool !== undefined && a.pool_address !== expected.pool) {
    fail(`artifact pool ${a.pool_address} != expected ${expected.pool}`);
  }
  if (expected?.ammProgramId !== undefined && a.amm_program_id !== expected.ammProgramId) {
    fail(`artifact amm ${a.amm_program_id} != expected ${expected.ammProgramId}`);
  }
  if (expected?.lpMint !== undefined && a.lp_mint !== expected.lpMint) {
    fail(`artifact lp_mint ${a.lp_mint} != expected ${expected.lpMint}`);
  }
  for (const [k, v] of [
    ["pool_address", a.pool_address],
    ["amm_program_id", a.amm_program_id],
    ["lp_mint", a.lp_mint],
  ] as const) {
    const bytes = decode58(v, k);
    if (bytes.length !== 32) fail(`${k} does not decode to 32 bytes`);
  }

  // Entries: non-empty, positive, canonical ascending-owner byte order.
  const entries = a.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail("empty entry set — no legitimate empty root");
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (typeof e.owner !== "string" || typeof e.lp_balance !== "bigint") {
      fail(`entry ${i} is structurally invalid`);
    }
    if (e.lp_balance <= 0n) fail(`entry ${i} (${e.owner}) carries a non-positive balance`);
    if (i > 0) {
      const cmp = compareOwners(entries[i - 1]!.owner, e.owner);
      if (cmp === 0) fail(`duplicate owner at entry ${i}`);
      if (cmp > 0) fail(`entries not in canonical ascending-owner order at ${i}`);
    }
  }

  // Full Merkle re-derivation through the vendored SDK tree.
  let tree: SnapshotMerkleTree;
  try {
    tree = SnapshotMerkleTree.fromEntries(
      entries.map((e) => ({ owner: new PublicKey(e.owner), lpBalance: e.lp_balance })),
    );
  } catch (err) {
    throw new ClaimsArtifactError(
      `entry set failed canonical tree construction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const rootHex = hex32(a.merkle_root, "merkle_root");
  if (Buffer.from(tree.root()).toString("hex") !== rootHex) {
    fail("root does not derive from the persisted entries");
  }
  if (a.leaf_count !== BigInt(entries.length) || a.leaf_count !== BigInt(tree.leafCount())) {
    fail("leaf_count disagrees with the persisted entries");
  }
  if (a.tree_depth !== BigInt(tree.treeDepth())) {
    fail("tree_depth disagrees with the persisted entries");
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (Buffer.from(tree.leaf(i) ?? new Uint8Array()).toString("hex") !== e.leaf) {
      fail(`leaf mismatch at entry ${i} (owner ${e.owner})`);
    }
    const proof = (tree.proof(i) ?? []).map((p) => Buffer.from(p).toString("hex"));
    if (proof.length !== e.proof.length || proof.some((p, j) => p !== e.proof[j])) {
      fail(`proof mismatch at entry ${i} (owner ${e.owner})`);
    }
  }

  // Closing reconciliation identity.
  const rec = a.reconciliation;
  if (!rec || typeof rec.entries_total !== "bigint") fail("reconciliation block is missing or malformed");
  const entriesSum = entries.reduce((acc, e) => acc + e.lp_balance, 0n);
  if (entriesSum !== rec.entries_total) {
    fail(`Σ persisted balances (${entriesSum}) != reconciliation.entries_total (${rec.entries_total})`);
  }
  if (rec.entries_total + rec.sink_exclusions_total !== rec.enumerated_total) {
    fail("reconciliation identity entries + sinks != enumerated broken");
  }
  if (rec.enumerated_total !== a.lp_total_supply_at_snapshot) {
    fail("reconciliation.enumerated_total != lp_total_supply_at_snapshot");
  }

  // Exclusion ledger.
  if (!Array.isArray(a.exclusions)) fail("exclusions block is missing");
  let sinkTotal = 0n;
  let prevOwner: string | null = null;
  for (const x of a.exclusions) {
    if (typeof x.owner !== "string" || typeof x.lp_balance !== "bigint" || typeof x.reason !== "string") {
      fail("exclusion row is structurally invalid");
    }
    if (prevOwner !== null && compareOwners(prevOwner, x.owner) >= 0) {
      fail("exclusions are not in canonical ascending-owner order");
    }
    prevOwner = x.owner;
    if (x.reason === "zero_balance") {
      if (x.lp_balance !== 0n) fail(`zero_balance exclusion for ${x.owner} carries a nonzero balance`);
    } else if (x.reason === "explicit_sink") {
      sinkTotal += x.lp_balance;
    } else {
      fail(`unknown exclusion reason "${x.reason}"`);
    }
  }
  if (sinkTotal !== rec.sink_exclusions_total) {
    fail("Σ explicit sink exclusions != reconciliation.sink_exclusions_total");
  }

  // Locked-LP report.
  const locked = a.locked;
  if (!locked || typeof locked.total_locked !== "bigint") fail("locked report is missing or malformed");
  let attributed = 0n;
  let prevAttr: string | null = null;
  for (const at of locked.attributions) {
    if (typeof at.owner !== "string" || typeof at.lp_balance !== "bigint") {
      fail("locked attribution row is structurally invalid");
    }
    if (prevAttr !== null && compareOwners(prevAttr, at.owner) >= 0) {
      fail("locked attributions are not in canonical ascending-owner order");
    }
    prevAttr = at.owner;
    attributed += at.lp_balance;
  }
  if (attributed !== locked.total_locked) fail("Σ locked attributions != locked.total_locked");
  if (locked.custody !== null) {
    if (locked.total_locked === 0n) fail("custody resolution present with zero locked total");
    if (locked.custody.balance !== locked.total_locked) fail("custody balance != locked.total_locked");
    if (entries.some((e) => e.owner === locked.custody!.owner)) {
      fail("custody owner also holds a claimable leaf; attributing to a PDA would strand the claim");
    }
  } else if (locked.total_locked !== 0n) {
    fail("locked total > 0 but no custody resolution");
  }

  // CLAIMS-GRADE PROVENANCE — required; a provenance-less artifact is
  // never claims-grade (D2), and a compatibility artifact must never
  // reach publication.
  const provenance = a.provenance;
  if (!provenance || !provenance.lock_evidence) {
    fail(
      "claims-grade verification requires complete governed-input provenance: the artifact carries none",
    );
  }
  const lock = provenance.lock_evidence;
  if (lock.source !== "rpc") {
    fail(`unsupported lock_evidence.source "${lock.source}" (supported: "rpc")`);
  }
  if (lock.program_id !== UNCX_RAYDIUM_AMM_V4_LOCKER_PROGRAM_ID) {
    fail(`unsupported lock_evidence.program_id ${lock.program_id} (supports exactly the UNCX locker)`);
  }
  if (!CLAIMS_COMMITMENTS.includes(lock.commitment as ClaimsCommitment)) {
    fail(`unsupported lock_evidence.commitment "${lock.commitment}"`);
  }
  if (typeof lock.anchor_slot !== "bigint" || lock.anchor_slot <= 0n) {
    fail("lock_evidence.anchor_slot must be a positive integer");
  }
  if (lock.anchor_slot !== a.snapshot_slot) fail("provenance lock_evidence.anchor_slot != snapshot_slot");
  if (lock.records_seen !== locked.lock_records_seen) {
    fail("provenance lock_evidence.records_seen != locked.lock_records_seen");
  }
  if (lock.total_locked !== locked.total_locked) {
    fail("provenance lock_evidence.total_locked != locked.total_locked");
  }

  // Governed sink-ledger provenance: REQUIRED when explicit sinks exist.
  const explicitSinks = a.exclusions.filter((x) => x.reason === "explicit_sink").length;
  if (explicitSinks > 0) {
    const ledgerProv = provenance.sink_ledger;
    if (!ledgerProv) {
      fail("artifact contains explicit sink exclusions but the provenance carries no governed sink ledger");
    }
    if (ledgerProv.schema_version !== BigInt(CLAIMS_SINK_LEDGER_SCHEMA_VERSION)) {
      fail("unsupported sink_ledger provenance schema_version");
    }
    if (typeof ledgerProv.ledger_id !== "string" || ledgerProv.ledger_id.trim().length === 0) {
      fail("sink_ledger.ledger_id is empty — the governed ledger identity is required");
    }
    if (!LOWER64.test(ledgerProv.input_sha256)) {
      fail("sink_ledger.input_sha256 is not a lowercase 64-character SHA-256 hex digest");
    }
    if (ledgerProv.entry_count !== BigInt(explicitSinks)) {
      fail("provenance sink_ledger.entry_count != explicit sink exclusions");
    }
    if (ledgerProv.sink_exclusions_total !== rec.sink_exclusions_total) {
      fail("provenance sink_ledger.sink_exclusions_total != reconciliation.sink_exclusions_total");
    }
  }

  return { rootHex, snapshotSlot: Number(a.snapshot_slot), leafCount: entries.length };
}

/** Convenience: parse + verify over exact bytes, returning the summary. */
export function verifyClaimsArtifactBytes(
  bytes: Uint8Array,
  expected?: { pool?: string; ammProgramId?: string; lpMint?: string },
): { artifact: ClaimsArtifact; rootHex: string; snapshotSlot: number; leafCount: number } {
  const artifact = parseClaimsArtifact(Buffer.from(bytes).toString("utf8"));
  const summary = verifyClaimsArtifactIntegrity(artifact, expected);
  return { artifact, ...summary };
}
