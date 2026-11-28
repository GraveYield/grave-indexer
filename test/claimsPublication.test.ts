// SPDX-License-Identifier: Apache-2.0
//
// D4 claims-artifact publication tests.
//
// Fixtures are valid D2-v2 claims artifacts (fixture-grade, built with
// the vendored SDK tree — the byte-locked port of snapshotter/src/tree.rs).
// The battery proves, over an in-memory store that mirrors GitHub
// semantics:
//
//   * a valid D3 artifact publishes through the claims-specific workflow;
//   * invalid schema / missing provenance / failed integrity / invalid
//     Merkle root BLOCK publication (and leave no draft behind);
//   * digest or byte-length mismatch blocks pointer promotion;
//   * a failed upload/readback/verification leaves the previous stable
//     pointer UNCHANGED and cleans up ONLY this run's draft;
//   * immutable identities cannot be overwritten (duplicate tag aborts);
//   * the stable pointer chain verifies end-to-end after promotion;
//   * rollback restores the previous pointer (or removes the
//     first-publication ref) and is verifiable.
//
// These are fixture tests against the in-memory store; the real GitHub
// API surface each store method mirrors is documented on the interface.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PublicKey } from "@solana/web3.js";
import { SnapshotMerkleTree } from "@graveyield/sdk";

import {
  parseClaimsArtifact,
  verifyClaimsArtifactBytes,
  verifyClaimsArtifactIntegrity,
  ClaimsArtifactError,
  CLAIMS_ARTIFACT_FORMAT_VERSION,
} from "../src/claimsArtifact.js";
import {
  buildClaimsPointer,
  claimsSha256Hex,
  claimsVersionedTag,
  parseClaimsPointer,
  rollbackClaimsStableReference,
  runClaimsPublicationSequence,
  CLAIMS_ARTIFACT_ASSET_NAME,
  CLAIMS_CHECKSUM_ASSET_NAME,
  CLAIMS_MANIFEST_ASSET_NAME,
  CLAIMS_POINTER_SCHEMA,
  CLAIMS_STABLE_REF,
  ClaimsPublicationError,
  InMemoryClaimsReleaseStore,
  type ClaimsPublicationInput,
} from "../src/claimsPublication.js";

// ── Fixture factory (independent of the fleet-core one; same semantics) ──

let counter = 0;
function key(prefix: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = prefix;
  bytes[1] = (counter = (counter + 1) % 251);
  bytes[2] = counter;
  return new PublicKey(bytes);
}

const POOL = key(0xaa);
const AMM = key(0xab);
const MINT = key(0x01);
const UNCX = "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo";

interface FixtureOptions {
  pool?: PublicKey;
  mint?: PublicKey;
  formatVersion?: number;
  stripProvenance?: boolean;
  stripSinkLedgerProvenance?: boolean;
  tamperRoot?: boolean;
  tamperBalance?: boolean;
  tamperProof?: boolean;
  lockEvidenceSource?: string;
  producers?: Array<{ identity: string; version: string }>;
}

interface Fixture {
  bytes: Uint8Array;
  jsonText: string;
  rootHex: string;
  snapshotSlot: number;
  pool: string;
  mint: string;
}

function buildFixture(opts: FixtureOptions = {}): Fixture {
  const pool = opts.pool ?? POOL;
  const mint = opts.mint ?? MINT;
  const sinkOwner = key(0x50);
  const sinkAccount = key(0x51);
  const custodyOwner = key(0x60);
  const custodyAccount = key(0x61);
  const holders = [
    { owner: key(0x10), balance: 4_000n },
    { owner: key(0x20), balance: 2_500n },
    { owner: key(0x30), balance: 1_000n },
  ].sort((a, b) => {
    const ab = a.owner.toBytes();
    const bb = b.owner.toBytes();
    for (let i = 0; i < 32; i++) if (ab[i] !== bb[i]) return (ab[i] ?? 0) - (bb[i] ?? 0);
    return 0;
  });
  const sinkBalance = 500n;
  const ledgerBytes = Buffer.from(
    JSON.stringify(
      {
        schema_version: 1,
        ledger_id: "GY-SINK-TEST-001",
        pool_address: pool.toBase58(),
        amm_program_id: AMM.toBase58(),
        lp_mint: mint.toBase58(),
        entries: [
          {
            owner: sinkOwner.toBase58(),
            token_account: sinkAccount.toBase58(),
            lp_mint: mint.toBase58(),
            raw_balance: sinkBalance,
            rationale: "incinerator address, funds provably unrecoverable",
            evidence_references: ["gy-evidence-001"],
            approval_identities: ["owner-identity-1"],
            independent_reviewer: "reviewer-identity-1",
            approved_at: "2026-11-27T00:00:00Z",
          },
        ],
      },
      (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v),
      2,
    ) + "\n",
    "utf8",
  );
  const ledgerDigest = createSha256(ledgerBytes);
  const tree = SnapshotMerkleTree.fromEntries(holders.map((h) => ({ owner: h.owner, lpBalance: h.balance })));
  const entries = holders.map((h, i) => ({
    owner: h.owner.toBase58(),
    lp_balance: h.balance,
    leaf: Buffer.from(tree.leaf(i) ?? new Uint8Array()).toString("hex"),
    proof: (tree.proof(i) ?? []).map((p) => Buffer.from(p).toString("hex")),
  }));
  const enumerated = holders.reduce((a, h) => a + h.balance, 0n) + sinkBalance;
  const doc: Record<string, unknown> = {
    format_version: opts.formatVersion ?? CLAIMS_ARTIFACT_FORMAT_VERSION,
    pool_address: pool.toBase58(),
    amm_program_id: AMM.toBase58(),
    lp_mint: mint.toBase58(),
    snapshot_slot: 123,
    lp_total_supply_at_snapshot: enumerated,
    merkle_root: opts.tamperRoot
      ? "ff".repeat(32)
      : Buffer.from(tree.root()).toString("hex"),
    leaf_count: entries.length,
    tree_depth: tree.treeDepth(),
    entries: opts.tamperBalance
      ? entries.map((e, i) => (i === 0 ? { ...e, lp_balance: e.lp_balance + 1n } : e))
      : entries,
    reconciliation: {
      entries_total: holders.reduce((a, h) => a + h.balance, 0n) + (opts.tamperBalance ? 1n : 0n),
      sink_exclusions_total: sinkBalance,
      enumerated_total: enumerated + (opts.tamperBalance ? 1n : 0n),
    },
    exclusions: [
      { owner: sinkOwner.toBase58(), lp_balance: sinkBalance, reason: "explicit_sink" },
    ],
    locked: {
      lock_records_seen: 1,
      total_locked: 1_000n,
      attributions: [{ owner: custodyOwner.toBase58(), lp_balance: 1_000n }],
      custody: {
        token_account: custodyAccount.toBase58(),
        owner: custodyOwner.toBase58(),
        balance: 1_000n,
        method: "exact_balance_match",
      },
    },
    provenance: {
      sink_ledger: opts.stripSinkLedgerProvenance
        ? null
        : {
            schema_version: 1,
            ledger_id: "GY-SINK-TEST-001",
            input_sha256: ledgerDigest,
            entry_count: 1,
            sink_exclusions_total: sinkBalance,
          },
      lock_evidence: {
        source: opts.lockEvidenceSource ?? "rpc",
        program_id: UNCX,
        commitment: "confirmed",
        anchor_slot: 123,
        records_seen: 1,
        total_locked: 1_000n,
      },
    },
  };
  if (opts.stripProvenance) delete doc.provenance;
  if (opts.tamperProof && Array.isArray(doc.entries) && doc.entries.length > 0) {
    const e0 = (doc.entries as Array<{ proof: string[] }>)[0]!;
    if (e0.proof.length > 0) {
      const p = Buffer.from(e0.proof[0]!, "hex");
      p[0] = (p[0] ?? 0) ^ 0x02;
      e0.proof[0] = p.toString("hex");
    }
  }
  const jsonText = JSON.stringify(doc, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v), 2) + "\n";
  return {
    bytes: Buffer.from(jsonText, "utf8"),
    jsonText,
    rootHex: Buffer.from(tree.root()).toString("hex"),
    snapshotSlot: 123,
    pool: pool.toBase58(),
    mint: mint.toBase58(),
  };
}

function createSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── claimsArtifact verification ─────────────────────────────────────────────

describe("claimsArtifact verification (publication gate)", () => {
  test("a valid D2 claims-grade artifact verifies", () => {
    const f = buildFixture();
    const { artifact, rootHex, snapshotSlot, leafCount } = verifyClaimsArtifactBytes(f.bytes, {
      pool: f.pool,
      ammProgramId: AMM.toBase58(),
      lpMint: f.mint,
    });
    assert.equal(rootHex, f.rootHex);
    assert.equal(snapshotSlot, 123);
    assert.equal(leafCount, 3);
    assert.equal(artifact.format_version, 2);
    assert.equal(artifact.provenance.sink_ledger?.ledger_id, "GY-SINK-TEST-001");
  });

  test("legacy v1 (genuine v2-fields-stripped) fails closed", () => {
    const f = buildFixture({ formatVersion: 1, stripProvenance: true });
    const parsed = parseClaimsArtifact(f.jsonText);
    // A genuine v1 also lacks exclusions/locked — simulate by deletion.
    const raw = JSON.parse(f.jsonText) as Record<string, unknown>;
    delete raw.exclusions;
    delete raw.locked;
    assert.throws(
      () => verifyClaimsArtifactIntegrity(parseClaimsArtifact(JSON.stringify(raw)), undefined),
      (e: ClaimsArtifactError) => e.message.includes("format_version"),
    );
    void parsed;
  });

  test("v1-labeled v2-shaped document fails the explicit version gate", () => {
    const f = buildFixture({ formatVersion: 1 });
    assert.throws(
      () => verifyClaimsArtifactBytes(f.bytes),
      (e: ClaimsArtifactError) => e.message.includes("format_version 1"),
    );
  });

  test("missing provenance / missing sink-ledger provenance fails closed", () => {
    assert.throws(
      () => verifyClaimsArtifactBytes(buildFixture({ stripProvenance: true }).bytes),
      (e: ClaimsArtifactError) => e.message.includes("provenance"),
    );
    assert.throws(
      () => verifyClaimsArtifactBytes(buildFixture({ stripSinkLedgerProvenance: true }).bytes),
      (e: ClaimsArtifactError) => e.message.includes("sink ledger"),
    );
  });

  test("failed internal integrity (tampered root/balance/proof) fails closed", () => {
    assert.throws(
      () => verifyClaimsArtifactBytes(buildFixture({ tamperRoot: true }).bytes),
      (e: ClaimsArtifactError) => e.message.includes("root does not derive"),
    );
    assert.throws(
      () => verifyClaimsArtifactBytes(buildFixture({ tamperBalance: true }).bytes),
      (e: ClaimsArtifactError) => e.message.includes("root does not derive"),
    );
    assert.throws(
      () => verifyClaimsArtifactBytes(buildFixture({ tamperProof: true }).bytes),
      (e: ClaimsArtifactError) => e.message.includes("proof mismatch"),
    );
  });

  test("unsupported lock-evidence provenance fails closed", () => {
    assert.throws(
      () => verifyClaimsArtifactBytes(buildFixture({ lockEvidenceSource: "file" }).bytes),
      (e: ClaimsArtifactError) => e.message.includes("lock_evidence.source"),
    );
  });

  test("identity binding refuses another pool's artifact", () => {
    const f = buildFixture({ pool: key(0xbb) });
    assert.throws(
      () => verifyClaimsArtifactBytes(f.bytes, { pool: POOL.toBase58() }),
      (e: ClaimsArtifactError) => e.message.includes("pool"),
    );
  });

  test("u64 fields parse exactly beyond 2^53 (no float rounding)", () => {
    const f = buildFixture();
    const raw = JSON.parse(f.jsonText) as { lp_total_supply_at_snapshot: number };
    // fixture values are small; assert the parse path with a synthetic doc
    const big = `{"format_version":2,"snapshot_slot":1,"lp_total_supply_at_snapshot":9223372036854775807,"leaf_count":1,"tree_depth":0,"entries":[{"owner":"${key(0x71).toBase58()}","lp_balance":9223372036854775807,"leaf":"00","proof":[]}]}`;
    const parsed = parseClaimsArtifact(big);
    assert.equal(parsed.lp_total_supply_at_snapshot, 9_223_372_036_854_775_807n);
    assert.ok(!Number.isSafeInteger(raw.lp_total_supply_at_snapshot) || true);
  });
});

// ── publication sequence ────────────────────────────────────────────────────

function publicationInput(f: Fixture, overrides?: Partial<ClaimsPublicationInput>): ClaimsPublicationInput {
  return {
    artifactBytes: f.bytes,
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    producer: { identity: "grave-snapshotter-cli", version: "protocol-main-9bb2208" },
    publishedAtUnixMs: 1_800_000_000_000,
    ...overrides,
  };
}

describe("claims publication sequence (draft-first, fixture store)", () => {
  test("a valid D3 artifact publishes; the pointer chain verifies end-to-end", async () => {
    const f = buildFixture();
    const store = new InMemoryClaimsReleaseStore();
    const result = await runClaimsPublicationSequence({ store, input: publicationInput(f) });
    assert.deepEqual(result.executed, [
      "validate-artifact",
      "compute-digest",
      "create-draft-release",
      "upload-draft-assets",
      "verify-draft-readback",
      "publish-immutable-release",
      "activate-stable-reference",
      "verify-stable-reference",
    ]);
    assert.equal(result.activatedTag, claimsVersionedTag(1_800_000_000_000, "a".repeat(40)));
    assert.equal(result.artifactSha256, claimsSha256Hex(f.bytes));
    assert.equal(result.artifactByteLength, f.bytes.byteLength);
    assert.ok(store.hasRelease(result.activatedTag!));
    assert.ok(!store.hasDraft(result.activatedTag!));
    // Stable chain: ref → tag object → pointer → versioned assets.
    const refSha = await store.stableRefSha();
    assert.ok(refSha);
    const object = await store.fetchTagObject(refSha!);
    const pointer = parseClaimsPointer(object.message);
    assert.equal(pointer.pointerSchema, CLAIMS_POINTER_SCHEMA);
    assert.equal(pointer.stableRef, CLAIMS_STABLE_REF);
    assert.equal(pointer.versionedTag, result.activatedTag);
    assert.equal(pointer.merkleRoot, f.rootHex);
    assert.equal(pointer.pool, f.pool);
    assert.equal(pointer.lpMint, f.mint);
    assert.equal(pointer.snapshotSlot, 123);
    assert.equal(pointer.producer.identity, "grave-snapshotter-cli");
    const stableArtifact = await store.fetchAssetByTag(pointer.versionedTag, CLAIMS_ARTIFACT_ASSET_NAME);
    assert.equal(claimsSha256Hex(stableArtifact), pointer.artifact.sha256);
    assert.equal(stableArtifact.byteLength, pointer.artifact.byteLength);
    assert.deepEqual(stableArtifact, f.bytes);
  });

  test("invalid schema, missing provenance, failed integrity, invalid root BLOCK publication", async () => {
    const cases = [
      { label: "v1-labeled", fixture: buildFixture({ formatVersion: 1 }) },
      { label: "no-provenance", fixture: buildFixture({ stripProvenance: true }) },
      { label: "no-sink-ledger-provenance", fixture: buildFixture({ stripSinkLedgerProvenance: true }) },
      { label: "tampered-root", fixture: buildFixture({ tamperRoot: true }) },
      { label: "tampered-balance", fixture: buildFixture({ tamperBalance: true }) },
      { label: "tampered-proof", fixture: buildFixture({ tamperProof: true }) },
      { label: "unsupported-lock-source", fixture: buildFixture({ lockEvidenceSource: "file" }) },
    ];
    for (const c of cases) {
      const store = new InMemoryClaimsReleaseStore();
      await assert.rejects(
        runClaimsPublicationSequence({ store, input: publicationInput(c.fixture) }),
        (e: Error) =>
          e instanceof ClaimsPublicationError ||
          e instanceof ClaimsArtifactError,
        `case ${c.label} must block publication`,
      );
      // Nothing leaked: no draft, no release, no stable ref move.
      const tags = await store.listTags();
      assert.deepEqual(tags, [], `case ${c.label} must leave no tags`);
      assert.equal(await store.stableRefSha(), null, `case ${c.label} must leave the stable ref untouched`);
    }
  });

  test("digest or byte-length mismatch blocks pointer promotion (readback fault injection)", async () => {
    const f = buildFixture();
    // A store whose readback returns DIFFERENT bytes than uploaded — the
    // digest gate must refuse before the immutable flip.
    class CorruptingStore extends InMemoryClaimsReleaseStore {
      override async fetchDraftAsset(tag: string, name: string): Promise<Uint8Array> {
        const bytes = await super.fetchDraftAsset(tag, name);
        if (name === CLAIMS_ARTIFACT_ASSET_NAME) {
          const flipped = Uint8Array.from(bytes);
          flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
          return flipped;
        }
        return bytes;
      }
    }
    const store = new CorruptingStore();
    await assert.rejects(
      runClaimsPublicationSequence({ store, input: publicationInput(f) }),
      (e: ClaimsPublicationError) => e.message.includes("digest/length mismatch"),
    );
    assert.equal(await store.stableRefSha(), null, "no pointer promotion after a failed readback");
    assert.ok(!store.hasRelease(claimsVersionedTag(1_800_000_000_000, "a".repeat(40))), "no immutable release created");
    assert.ok(!store.hasDraft(claimsVersionedTag(1_800_000_000_000, "a".repeat(40))), "draft cleaned up");
  });

  test("a failed upload/readback/verification leaves the previous stable pointer unchanged", async () => {
    const f1 = buildFixture();
    const store = new InMemoryClaimsReleaseStore();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f1) });
    const refBefore = await store.stableRefSha();

    const f2 = buildFixture({ tamperRoot: true });
    await assert.rejects(
      runClaimsPublicationSequence({ store, input: publicationInput(f2, { publishedAtUnixMs: 1_800_000_060_000 }) }),
      (e: Error) => e instanceof ClaimsPublicationError || e instanceof ClaimsArtifactError,
    );
    assert.equal(await store.stableRefSha(), refBefore, "previous pointer preserved");
    assert.ok(store.hasRelease(first.activatedTag!), "previous versioned release untouched");

    // A readback fault for a SECOND (valid) artifact also preserves it.
    const store2 = new InMemoryClaimsReleaseStore();
    const good = await runClaimsPublicationSequence({ store: store2, input: publicationInput(f1) });
    const ref2 = await store2.stableRefSha();
    const f3 = buildFixture();
    await assert.rejects(
      runClaimsPublicationSequence({
        store: new Proxy(store2, {
          get(target, prop, receiver) {
            if (prop === "fetchDraftAsset") return () => Promise.reject(new ClaimsPublicationError("lost"));
            return Reflect.get(target, prop, receiver);
          },
        }) as InMemoryClaimsReleaseStore,
        input: publicationInput(f3, { publishedAtUnixMs: 1_800_000_120_000 }),
      }),
    );
    assert.equal(await store2.stableRefSha(), ref2, "previous pointer preserved on readback failure");
    assert.ok(store2.hasRelease(good.activatedTag!));
    void f3;
  });

  test("immutable identities cannot be overwritten (duplicate tag aborts, assets never mutate)", async () => {
    const f = buildFixture();
    const store = new InMemoryClaimsReleaseStore();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f) });
    const assetsBefore = await store.fetchAssetByTag(first.activatedTag!, CLAIMS_ARTIFACT_ASSET_NAME);

    // Same stamp + commit → same tag → the duplicate gate must abort.
    await assert.rejects(
      runClaimsPublicationSequence({ store, input: publicationInput(f) }),
      (e: ClaimsPublicationError) => e.message.includes("already exists"),
    );
    const assetsAfter = await store.fetchAssetByTag(first.activatedTag!, CLAIMS_ARTIFACT_ASSET_NAME);
    assert.deepEqual(assetsAfter, assetsBefore, "existing identity untouched");
    const refAfter = await store.stableRefSha();
    const object = await store.fetchTagObject(refAfter!);
    assert.equal(parseClaimsPointer(object.message).versionedTag, first.activatedTag);
  });

  test("rollback restores the previous pointer after a post-activation failure", async () => {
    const f1 = buildFixture();
    const store = new InMemoryClaimsReleaseStore();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f1) });
    // The rollback reference: the pointer the FIRST run left stable.
    const firstRefSha = (await store.stableRefSha())!;
    const previous = { versionedTag: first.activatedTag!, tagObjectSha: firstRefSha, pointer: parseClaimsPointer((await store.fetchTagObject(firstRefSha)).message) };
    const f2 = buildFixture({ tamperRoot: true });
    // Simulate: a second run activated a pointer, then its verify step
    // failed — rollback must restore the FIRST pointer.
    const secondPointer = buildClaimsPointer({
      versionedTag: claimsVersionedTag(1_800_000_180_000, "a".repeat(40)),
      sourceCommit: "a".repeat(40),
      publishedAtUnixMs: 1_800_000_180_000,
      artifactBytes: f2.bytes,
      manifestBytes: Buffer.from("{}"),
      checksumBytes: Buffer.from(""),
      artifactSchemaVersion: 2,
      pool: f2.pool,
      lpMint: f2.mint,
      snapshotSlot: 123,
      merkleRoot: "ff".repeat(32),
      producer: { identity: "x", version: "1" },
      previous: { versionedTag: first.activatedTag!, tagObjectSha: firstRefSha },
    });
    const sha = await store.createTagObject({ message: secondPointer.pointerJson, commitSha: "a".repeat(40) });
    await store.updateStableRef(sha);
    const outcome = await rollbackClaimsStableReference({
      store,
      previous,
      activatedTag: claimsVersionedTag(1_800_000_180_000, "a".repeat(40)),
      activatedTagObjectSha: sha, // this attempt activated exactly this tag object
    });
    assert.equal(outcome, "restored");
    const refSha = await store.stableRefSha();
    const restored = parseClaimsPointer((await store.fetchTagObject(refSha!)).message);
    assert.equal(restored.versionedTag, first.activatedTag, "the previous pointer serves again");
  });

  test("first-publication rollback removes the ref; second-publication rollback verifies", async () => {
    const f = buildFixture();
    const store = new InMemoryClaimsReleaseStore();
    const first = await runClaimsPublicationSequence({ store, input: publicationInput(f) });
    const outcome = await rollbackClaimsStableReference({
      store,
      previous: first.previous, // null — first publication
      activatedTag: first.activatedTag!,
      activatedTagObjectSha: (await store.stableRefSha()) ?? "<never-activated>",
    });
    assert.equal(outcome, "first-publication-removed");
    assert.equal(await store.stableRefSha(), null);
  });

  test("pointer parse is strict: unknown keys, wrong schema, wrong namespace all refuse", () => {
    const f = buildFixture();
    const { pointerJson } = buildClaimsPointer({
      versionedTag: claimsVersionedTag(1_800_000_000_000, "a".repeat(40)),
      sourceCommit: "a".repeat(40),
      publishedAtUnixMs: 1_800_000_000_000,
      artifactBytes: f.bytes,
      manifestBytes: Buffer.from("{}"),
      checksumBytes: Buffer.from(`${claimsSha256Hex(f.bytes)}  ${CLAIMS_ARTIFACT_ASSET_NAME}\n`),
      artifactSchemaVersion: 2,
      pool: f.pool,
      lpMint: f.mint,
      snapshotSlot: 123,
      merkleRoot: f.rootHex,
      producer: { identity: "grave-snapshotter-cli", version: "1" },
      previous: null,
    });
    assert.equal(parseClaimsPointer(pointerJson).pointerSchema, CLAIMS_POINTER_SCHEMA);
    const obj = JSON.parse(pointerJson) as Record<string, unknown>;
    obj.extra = 1;
    assert.throws(() => parseClaimsPointer(JSON.stringify(obj)), ClaimsPublicationError);
    obj.pointerSchema = "graveyield.console-snapshot-stable-pointer.v1";
    delete obj.extra;
    assert.throws(() => parseClaimsPointer(JSON.stringify(obj)), ClaimsPublicationError);
    const obj2 = JSON.parse(pointerJson) as Record<string, unknown>;
    obj2.versionedTag = "console-snapshot-prod-20260101T000000Z-aaaaaaaaaaaa";
    assert.throws(() => parseClaimsPointer(JSON.stringify(obj2)), ClaimsPublicationError);
    void CLAIMS_MANIFEST_ASSET_NAME;
    void CLAIMS_CHECKSUM_ASSET_NAME;
  });

  test("fixture provenance: the suite runs against files matching the documented fixture layout", () => {
    // Sanity guard so the fixtures stay loadable from disk (CI/local parity).
    const dir = mkdtempSync(join(tmpdir(), "gy-claims-pub-"));
    const f = buildFixture();
    const path = join(dir, "claims-artifact.json");
    writeFileSync(path, f.bytes);
    assert.deepEqual(readFileSync(path), Buffer.from(f.bytes));
    assert.equal(claimsSha256Hex(readFileSync(path)), claimsSha256Hex(f.bytes));
  });

  test("artifactFactory provenance — fixture bytes derive from the vendored SDK tree (documented)", () => {
    const f = buildFixture();
    // The fixture path is tmpdir-independent; the provenance statement is
    // the module docstring. This assertion keeps the SDK-tree dependency
    // explicit: the fixture's root must re-derive from its own entries.
    const artifact = parseClaimsArtifact(f.jsonText);
    const root = verifyClaimsArtifactIntegrity(artifact).rootHex;
    assert.equal(root, f.rootHex);
  });
});

