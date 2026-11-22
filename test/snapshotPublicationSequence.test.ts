// SPDX-License-Identifier: Apache-2.0
//
// GY-M1-INT-001 correction §4.5 — failure-injection battery for the
// stable publication sequence (sixth round: the OWNER-SELECTED dedicated
// `console-snapshot-prod` stable reference).
//
// These tests drive `runPublicationSequence` (src/snapshotPublicationSequence.ts)
// — a faithful executable abstraction of the publication jobs in
// .github/workflows/publish-console-snapshot.yml: the workflow's exact
// step order and GitHub semantics (immutable versioned releases, annotated
// tag objects, ONE atomic ref update), with the REAL production
// verification gates (strict schema-v2 parser, SHA-256/byte-length
// integrity, checksum-file verification, pointer digest cross-checks,
// ordering gates). Faults are injected at every operation (a wrapped
// InMemoryReleaseStore), and the stable-reference invariant is asserted
// after every fault:
//
//   BEFORE activation  → the stable ref is UNCHANGED and still
//                         identifies the complete previous artifact.
//   AFTER activation   → the stable ref identifies a COMPLETE versioned
//                         publication whose bytes verify against the
//                         pointer digests and a sidecar naming the
//                         activated versioned tag.
//
// Helper-level pins alone are insufficient by design: these tests
// exercise the whole sequence, not isolated functions.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PublicKey } from "@solana/web3.js";
import { RAYDIUM_V4_PROGRAM_ID, WSOL_MINT } from "@graveyield/sdk";

import { buildConsoleSnapshot, SNAPSHOT_THRESHOLD_FALLBACK, type ConsoleSnapshotV2, type PoolEnrichment } from "../src/consoleSnapshot.js";
import type { DiscoveredPoolRecord } from "../src/discovery.js";
import {
  buildPublicationProvenance,
  CHECKSUM_ASSET_NAME,
  PUBLICATION_STEPS,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  snapshotSha256,
  versionedTagName,
  type PublicationStep,
  type StablePointerV1,
} from "../src/snapshotPublication.js";
import {
  InMemoryReleaseStore,
  runPublicationSequence,
  verifyChecksumFile,
  type PublicationBundle,
} from "../src/snapshotPublicationSequence.js";
import { parseConsoleSnapshot } from "../src/consoleSnapshotParse.js";

// ─── Real schema-v2 snapshot fixtures (same machinery as the CLI tests) ─────

const NOW_MS = 1_800_000_000_000;
const SOURCE_COMMIT = "c".repeat(40);

function discoveredRecord(seed: number): DiscoveredPoolRecord {
  return {
    poolAddress: synthPool(seed),
    ammProgramId: RAYDIUM_V4_PROGRAM_ID,
    pool: {
      coinVault: synthPool(0x11 + seed),
      pcVault: synthPool(0x12 + seed),
      baseMint: synthPool(0x13 + seed),
      quoteMint: WSOL_MINT,
      lpMint: synthPool(0x14 + seed),
    },
    wsolSide: { memecoinMint: synthPool(0x13 + seed), coinIsWsol: false },
    raw: {
      mode: "identity-slice",
      dataLen: 160,
      fingerprint: `fp-${seed}`,
      owner: RAYDIUM_V4_PROGRAM_ID.toBase58(),
    },
    provenance: {
      source: "raydium-v4-gpa",
      cluster: "mainnet-beta",
      endpointKind: "public-rpc",
      slotLowerBound: 5_000_000,
      slotUpperBound: 5_000_002,
      fetchedAtUnixMs: NOW_MS,
    },
  };
}

function synthPool(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, seed);
  return new PublicKey(bytes);
}

function enrichment(seed: number): PoolEnrichment {
  return {
    wsolReserveLamports: "600000000",
    memecoinReserveRaw: "1000000",
    memecoinDecimals: 6,
    lpSupplyRaw: "1000000",
    lastSwap: { unixTs: 1_700_000_100, slot: 900_000, signature: `sig-${seed}`.padEnd(88, "x").slice(0, 87) },
    fetchedAtUnixMs: NOW_MS,
  };
}

function realSnapshotAt(generatedAtUnixMs: number): { snapshot: ConsoleSnapshotV2; bytes: Uint8Array } {
  const records = [discoveredRecord(0x51), discoveredRecord(0x52)];
  const enrichments = new Map(records.map((r) => [r.poolAddress.toBase58(), enrichment(0)]));
  const snapshot = buildConsoleSnapshot(records, enrichments, {
    generatedAtUnixMs,
    cluster: "mainnet-beta",
    endpointKind: "public-rpc",
    indexerGitHead: "a".repeat(40),
    maxAgeMs: 24 * 3_600_000,
    thresholds: SNAPSHOT_THRESHOLD_FALLBACK,
    counts: {
      rawAccounts: 4200,
      parsedPools: 4200,
      supportedWsolPairs: 2,
      m1SourcingRejected: 0,
    },
    failures: [],
    slotLowerBound: 5_000_000,
    slotUpperBound: 5_000_002,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  return { snapshot, bytes };
}

function checksumLineFor(bytes: Uint8Array): Uint8Array {
  return new TextEncoder().encode(`${snapshotSha256(bytes)}  ${SNAPSHOT_ASSET_NAME}\n`);
}

/** A publication bundle exactly as the generate job would stage it. */
function freshBundle(at = NOW_MS): { bundle: PublicationBundle; tag: string } {
  const { snapshot, bytes } = realSnapshotAt(at);
  const tag = versionedTagName(at, SOURCE_COMMIT);
  const provenance = buildPublicationProvenance(snapshot, bytes, {
    sourceCommitSha: SOURCE_COMMIT,
    workflowRunId: "12345",
    workflowAttempt: "1",
    repository: "GraveYield/grave-indexer",
    versionedTag: tag,
  });
  return {
    tag,
    bundle: {
      snapshotBytes: bytes,
      provenanceBytes: new TextEncoder().encode(JSON.stringify(provenance)),
      checksumBytes: checksumLineFor(bytes),
      provenance,
    },
  };
}

// ─── Fault-injection store ──────────────────────────────────────────────────

type StoreOp =
  | "create"
  | "upload"
  | "fetchByTag"
  | "createTagObject"
  | "updateStableRef"
  | "fetchTagObject";

/**
 * A store that throws at a chosen operation — the fault-injection seams
 * for the workflow's GitHub-side operations. Faults are armed ONLY
 * after seeding (a publication may fail mid-run, but setting up the
 * previous good publication must not). `skipAsset` simulates an asset
 * that silently fails to upload (missing asset on the release).
 */
class FaultyReleaseStore extends InMemoryReleaseStore {
  armed = false;
  constructor(
    private readonly faultOn: StoreOp | null = null,
    private readonly skipAsset: string | null = null,
  ) {
    super();
  }
  /** Arm the fault AFTER seeding the previous good publication. */
  arm(): this {
    this.armed = true;
    return this;
  }
  /** Disarm faults so post-run invariant assertions can read the store. */
  disarm(): this {
    this.armed = false;
    return this;
  }
  private hit(op: StoreOp): boolean {
    return this.armed && this.faultOn === op;
  }
  override async createRelease(tag: string, opts: { makeLatest: boolean }): Promise<void> {
    if (this.hit("create")) throw new Error("injected fault: release creation failed");
    return super.createRelease(tag, opts);
  }
  override async uploadAsset(tag: string, name: string, bytes: Uint8Array): Promise<void> {
    if (this.armed && this.skipAsset === name) return; // silently missing asset (partial publication)
    if (this.hit("upload")) throw new Error("injected fault: asset upload failed");
    return super.uploadAsset(tag, name, bytes);
  }
  override async fetchAssetByTag(tag: string, name: string): Promise<Uint8Array> {
    if (this.hit("fetchByTag")) throw new Error("injected fault: roundtrip fetch failed");
    return super.fetchAssetByTag(tag, name);
  }
  override async createTagObject(args: { message: string; commitSha: string }): Promise<string> {
    if (this.hit("createTagObject")) throw new Error("injected fault: tag object creation failed");
    return super.createTagObject(args);
  }
  override async updateStableRef(tagObjectSha: string): Promise<void> {
    if (this.hit("updateStableRef")) throw new Error("injected fault: stable ref update failed");
    return super.updateStableRef(tagObjectSha);
  }
  override async fetchTagObject(tagObjectSha: string): Promise<{ message: string; commitSha: string }> {
    // Armed calls, in run order: (1) the PRE-activation previous-pointer
    // read (rollback discovery — must pass), (2) the POST-activation
    // verification read (the fault fires here).
    if (this.hit("fetchTagObject")) {
      this.tagObjectCalls += 1;
      if (this.tagObjectCalls >= 2) throw new Error("injected fault: stable pointer fetch failed");
    }
    return super.fetchTagObject(tagObjectSha);
  }
  private tagObjectCalls = 0;
}

const PREVIOUS_TAG = versionedTagName(NOW_MS - 3_600_000, SOURCE_COMMIT);

/** Seed a store whose stable ref already identifies a previous good publication. */
async function storeWithPreviousRelease<S extends InMemoryReleaseStore = InMemoryReleaseStore>(store?: S): Promise<S> {
  const s: S = store ?? (new InMemoryReleaseStore() as unknown as S);
  const first = freshBundle(NOW_MS - 3_600_000);
  const firstResult = await runPublicationSequence({ store: s, bundle: first.bundle, artifactComplete: true });
  assert.equal(firstResult.activatedTag, first.tag, "seeding: the first publication activates");
  return s;
}

/** The invariant: the stable ref identifies a COMPLETE, verified versioned publication. */
async function assertStableServesCompleteArtifact(store: InMemoryReleaseStore, expectedTag: string | null): Promise<void> {
  const refSha = await store.stableRefSha();
  if (expectedTag === null) {
    assert.equal(refSha, null, "the stable ref must not exist");
    return;
  }
  assert.ok(refSha !== null, "the stable ref must exist");
  const object = await store.fetchTagObject(refSha as string);
  const pointer = JSON.parse(object.message) as StablePointerV1;
  assert.equal(pointer.versionedTag, expectedTag, "the stable pointer names the expected release");
  // The identified versioned release serves a complete, verified artifact set.
  const snapshot = await store.fetchAssetByTag(pointer.versionedTag, SNAPSHOT_ASSET_NAME);
  const provBytes = await store.fetchAssetByTag(pointer.versionedTag, PROVENANCE_ASSET_NAME);
  const checksum = await store.fetchAssetByTag(pointer.versionedTag, CHECKSUM_ASSET_NAME);
  verifyChecksumFile(snapshot, checksum, SNAPSHOT_ASSET_NAME); // throws on any inconsistency
  assert.equal(snapshotSha256(snapshot), pointer.snapshot.sha256, "the served bytes match the pointer digest");
  assert.equal(snapshot.byteLength, pointer.snapshot.byteLength, "the served bytes match the pointer length");
  const prov = JSON.parse(Buffer.from(provBytes).toString("utf8")) as { versionedTag: string | null };
  assert.equal(prov.versionedTag, expectedTag, "the served provenance names the identified release");
  // The served bytes must pass the strict schema-v2 parser.
  assert.doesNotThrow(() => parseConsoleSnapshot(JSON.parse(Buffer.from(snapshot).toString("utf8"))));
}

// ─── Happy path ─────────────────────────────────────────────────────────────

describe("publication sequence — happy path (dedicated stable reference)", () => {
  test("a complete publication executes every step in order and moves the stable ref to the new pointer", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle, tag } = freshBundle();

    const result = await runPublicationSequence({ store, bundle, artifactComplete: true });

    assert.deepEqual(
      result.executed,
      PUBLICATION_STEPS.filter((s) => s !== "generate") as PublicationStep[],
      "the sequence executes exactly the workflow's post-generation steps, in order",
    );
    assert.equal(result.activatedTag, tag);
    assert.equal(result.previousStable?.versionedTag, PREVIOUS_TAG, "the rollback reference is the previously identified release");
    // The stable ref now identifies the NEW publication.
    await assertStableServesCompleteArtifact(store, tag);
    // The OLD release is untouched and fully fetchable (rollback intact).
    const oldSnapshot = await store.fetchAssetByTag(PREVIOUS_TAG, SNAPSHOT_ASSET_NAME);
    assert.ok(oldSnapshot.byteLength > 0);
    // The new pointer records the previous pointer (rollback chain).
    const refSha = (await store.stableRefSha()) as string;
    const pointer = JSON.parse((await store.fetchTagObject(refSha)).message) as StablePointerV1;
    assert.equal(pointer.previousVersionedTag, PREVIOUS_TAG, "the pointer carries the rollback record");
  });

  test("the first publication bootstraps: previous pointer is null, the ref is CREATED", async () => {
    const store = new InMemoryReleaseStore();
    const { bundle, tag } = freshBundle();
    const result = await runPublicationSequence({ store, bundle, artifactComplete: true });
    assert.equal(result.previousStable, null);
    assert.equal(result.activatedTag, tag);
    await assertStableServesCompleteArtifact(store, tag);
  });

  test("the stable ref is independent of the (retired) latest designation: an unrelated release taking latest does NOT move it", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle, tag } = freshBundle();
    // An UNRELATED release (not a console-snapshot versioned publication)
    // is created and takes the repo-wide latest designation.
    await store.createRelease("unrelated-lib-release", { makeLatest: true });
    // The stable ref must be untouched by that.
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
    // And the publication itself proceeds unaffected.
    const result = await runPublicationSequence({ store, bundle, artifactComplete: true });
    assert.equal(result.activatedTag, tag);
    await assertStableServesCompleteArtifact(store, tag);
    assert.equal(await store.latestTag(), "unrelated-lib-release", "the unrelated release took latest — proving the pointer independence");
  });
});

// ─── Failure injection (GY-M1-INT-001 §4.5) ─────────────────────────────────

describe("failure injection — last-known-good preservation (dedicated stable reference)", () => {
  test("duplicate versioned release: aborts BEFORE creation, stable untouched", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle } = freshBundle();
    // Simulate a concurrent run having already created this exact tag.
    await store.createRelease(bundle.provenance.versionedTag as string, { makeLatest: false });

    await assert.rejects(
      () => runPublicationSequence({ store, bundle, artifactComplete: true }),
      /already exists/,
    );
    // Invariant: stable still identifies the previous publication.
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("failure during versioned asset upload: stable untouched", async () => {
    const store = (await storeWithPreviousRelease(new FaultyReleaseStore("upload"))).arm();
    const { bundle, tag } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /asset upload failed/);
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
    const refSha = (await store.stableRefSha()) as string;
    const pointer = JSON.parse((await store.fetchTagObject(refSha)).message) as StablePointerV1;
    assert.notEqual(pointer.versionedTag, tag, "the new tag was never activated");
  });

  test("failure during versioned asset verification (checksum drift): stable untouched", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle } = freshBundle();
    // The staged checksum file disagrees with the snapshot bytes.
    const badChecksum = new TextEncoder().encode(`${"0".repeat(64)}  ${SNAPSHOT_ASSET_NAME}\n`);
    await assert.rejects(
      () =>
        runPublicationSequence({
          store,
          bundle: { ...bundle, checksumBytes: badChecksum },
          artifactComplete: true,
        }),
      /checksum MISMATCH/,
    );
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("invalid provenance/schema-invalid artifact: aborts at validate-schema, nothing created", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle } = freshBundle();
    const invalid = JSON.parse(Buffer.from(bundle.snapshotBytes).toString("utf8")) as Record<string, unknown>;
    invalid.schemaVersion = 999; // violates the strict schema-v2 contract
    const invalidBytes = new TextEncoder().encode(JSON.stringify(invalid));
    const invalidProv = { ...bundle.provenance, snapshotSha256: snapshotSha256(invalidBytes), snapshotByteLength: invalidBytes.byteLength };
    await assert.rejects(
      () =>
        runPublicationSequence({
          store,
          bundle: {
            snapshotBytes: invalidBytes,
            provenanceBytes: new TextEncoder().encode(JSON.stringify(invalidProv)),
            checksumBytes: checksumLineFor(invalidBytes),
            provenance: invalidProv,
          },
          artifactComplete: true,
        }),
      Error,
    );
    // No release was created for the invalid artifact.
    const tags = await store.listTags();
    assert.ok(!tags.some((t) => t !== PREVIOUS_TAG), "no new release created");
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("failure before stable activation (artifact INCOMPLETE): activation refused, stable untouched", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle, tag } = freshBundle();
    await assert.rejects(
      () => runPublicationSequence({ store, bundle, artifactComplete: false }),
      /INCOMPLETE/,
    );
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
    const refSha = (await store.stableRefSha()) as string;
    const pointer = JSON.parse((await store.fetchTagObject(refSha)).message) as StablePointerV1;
    assert.notEqual(pointer.versionedTag, tag);
  });

  test("failure during activation (tag-object creation throws): stable unchanged, versioned release intact for retry", async () => {
    const store = (await storeWithPreviousRelease(new FaultyReleaseStore("createTagObject"))).arm();
    const { bundle, tag } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /tag object creation failed/);
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
    // The versioned release itself is complete — a manual activation can retry.
    const snapshot = await store.fetchAssetByTag(tag, SNAPSHOT_ASSET_NAME);
    verifyChecksumFile(snapshot, await store.fetchAssetByTag(tag, CHECKSUM_ASSET_NAME), SNAPSHOT_ASSET_NAME);
  });

  test("failure during activation (ref update throws): stable unchanged", async () => {
    const store = (await storeWithPreviousRelease(new FaultyReleaseStore("updateStableRef"))).arm();
    const { bundle } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /stable ref update failed/);
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("failure immediately after activation (stable pointer fetch fails): the ref already serves the COMPLETE verified publication", async () => {
    const store = (await storeWithPreviousRelease(new FaultyReleaseStore("fetchTagObject"))).arm();
    const { bundle, tag } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /stable pointer fetch failed/);
    store.disarm(); // the invariant check itself must be able to read the store
    // The run FAILED (post-activation verification could not confirm),
    // but the ref moved to the fully-verified versioned publication:
    await assertStableServesCompleteArtifact(store, tag);
  });

  test("missing snapshot asset on the versioned release: roundtrip 404 aborts BEFORE activation", async () => {
    const store = (await storeWithPreviousRelease(new FaultyReleaseStore(null, SNAPSHOT_ASSET_NAME))).arm();
    const { bundle } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /404/);
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("partial publication (upload stops after 2 of 3 assets): stable untouched", async () => {
    class TwoOfThreeStore extends FaultyReleaseStore {
      private uploads = 0;
      constructor() {
        super(null);
      }
      override async uploadAsset(tag: string, name: string, bytes: Uint8Array): Promise<void> {
        this.uploads++;
        if (this.armed && this.uploads === 4) throw new Error("injected fault: workflow dies after two assets");
        return super.uploadAsset(tag, name, bytes);
      }
    }
    const store = (await storeWithPreviousRelease(new TwoOfThreeStore())).arm();
    const { bundle } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /dies after two assets/);
    await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("interrupted workflow: a fault at ANY operation leaves the invariant intact (exhaustive sweep)", async () => {
    for (const op of ["create", "upload", "fetchByTag", "createTagObject", "updateStableRef", "fetchTagObject"] as const) {
      const store = (await storeWithPreviousRelease(new FaultyReleaseStore(op))).arm();
      const { bundle, tag } = freshBundle();
      await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /injected fault/, `fault at ${op} must fail the run`);
      store.disarm(); // the invariant check itself must be able to read the store
      if (op === "fetchTagObject") {
        // Post-activation: the ref moved, but to a COMPLETE verified publication.
        await assertStableServesCompleteArtifact(store, tag);
      } else {
        await assertStableServesCompleteArtifact(store, PREVIOUS_TAG);
      }
    }
  });

  test("concurrent publication attempts (same bundle, sequential executions): the second attempt aborts on the duplicate gate", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle, tag } = freshBundle();
    // First run succeeds and activates.
    await runPublicationSequence({ store, bundle, artifactComplete: true });
    await assertStableServesCompleteArtifact(store, tag);
    // A second concurrent/queued run with the SAME bundle must abort on
    // the duplicate-tag gate (the concurrency group queues it; the gate
    // makes the re-run a no-op, never a clobber).
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /already exists/);
    await assertStableServesCompleteArtifact(store, tag);
  });

  test("two DIFFERENT publications run back-to-back: the second activates, the first remains fetchable (rollback intact)", async () => {
    const store = new InMemoryReleaseStore();
    const first = freshBundle(NOW_MS - 1_000);
    await runPublicationSequence({ store, bundle: first.bundle, artifactComplete: true });
    const second = freshBundle(NOW_MS);
    const result = await runPublicationSequence({ store, bundle: second.bundle, artifactComplete: true });
    assert.equal(result.previousStable?.versionedTag, first.tag, "the second run records the first as its rollback reference");
    await assertStableServesCompleteArtifact(store, second.tag);
    const firstSnapshot = await store.fetchAssetByTag(first.tag, SNAPSHOT_ASSET_NAME);
    assert.ok(firstSnapshot.byteLength > 0, "the superseded release remains fully fetchable");
  });

  test("a provenance WITHOUT a source commit cannot activate (the pointer would be unidentifiable)", async () => {
    const store = new InMemoryReleaseStore();
    const { bundle } = freshBundle();
    const noCommit = {
      ...bundle,
      provenance: { ...bundle.provenance, indexerSourceCommitSha: null },
      provenanceBytes: new TextEncoder().encode(JSON.stringify({ ...bundle.provenance, indexerSourceCommitSha: null })),
    };
    await assert.rejects(() => runPublicationSequence({ store, bundle: noCommit, artifactComplete: true }), /source commit|40-hex/);
    assert.equal(await store.stableRefSha(), null, "nothing was activated");
  });
});

// ─── Pointer-identity races (sixth round — dedicated stable reference) ──────

describe("stable-reference races — the identity chain must reject cross-release states", () => {
  test("a pointer naming ANOTHER release fails the post-activation identity chain", async () => {
    const store = await storeWithPreviousRelease();
    const next = freshBundle(NOW_MS);
    // A rogue/mismatched pointer object naming a release that is not the activated one.
    const rogueSha = await store.createTagObject({
      message: JSON.stringify({
        pointerSchema: "graveyield.console-snapshot-stable-pointer.v1",
        stableRef: "console-snapshot-prod",
        versionedTag: PREVIOUS_TAG,
        sourceCommit: SOURCE_COMMIT,
        publishedAtUnixMs: NOW_MS - 3_600_000,
        snapshot: { name: SNAPSHOT_ASSET_NAME, sha256: "a".repeat(64), byteLength: 1 },
        provenance: { name: PROVENANCE_ASSET_NAME, sha256: "b".repeat(64), byteLength: 1 },
        checksum: { name: CHECKSUM_ASSET_NAME, sha256: "c".repeat(64), byteLength: 1 },
        previousVersionedTag: null,
        previousTagObjectSha: null,
      }),
      commitSha: SOURCE_COMMIT,
    });
    await store.updateStableRef(rogueSha);
    // The gate (same cross-checks as the workflow's verify-stable job) must reject:
    // the pointer names PREVIOUS_TAG while the run expects the NEW tag — and the
    // pointer digests do not match the actual release bytes either.
    const { buildStablePointer, parseStablePointer, verifyStablePointerMatchesArtifacts } = await import("../src/snapshotPublication.js");
    const object = await store.fetchTagObject(rogueSha);
    const pointer = parseStablePointer(object.message);
    assert.equal(pointer.versionedTag, PREVIOUS_TAG);
    const nextProvenance = next.bundle.provenance;
    assert.throws(
      () =>
        verifyStablePointerMatchesArtifacts({
          pointer,
          snapshotBytes: next.bundle.snapshotBytes,
          provenanceBytes: next.bundle.provenanceBytes,
          checksumBytes: next.bundle.checksumBytes,
          provenance: nextProvenance,
        }),
      /names|digest|mismatch|refusing/,
      "a pointer naming another release (or foreign digests) must never verify",
    );
    void buildStablePointer;
  });

  test("the ref moving BETWEEN activation and verification is detected (ref no longer names the created object)", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle } = freshBundle();
    // Sabotage: after activation, another actor moves the ref.
    class RefRacer extends FaultyReleaseStore {
      constructor() {
        super(null);
      }
      override async updateStableRef(tagObjectSha: string): Promise<void> {
        await super.updateStableRef(tagObjectSha);
        // A concurrent actor immediately re-points the ref elsewhere.
        const rogue = await super.createTagObject({ message: (await super.fetchTagObject(tagObjectSha)).message, commitSha: SOURCE_COMMIT });
        await super.updateStableRef(rogue);
      }
    }
    const racer = new RefRacer();
    await assert.rejects(
      () => runPublicationSequence({ store: racer, bundle: bundle, artifactComplete: true }),
      /no longer names the object created by this run/,
      "a raced ref update must fail the run (never mistaken for a successful publication)",
    );
  });
});

// ─── Store semantics mirrors ─────────────────────────────────────────────────

describe("InMemoryReleaseStore — GitHub semantics mirrors (dedicated ref)", () => {
  test("the ref update is atomic over immutable tag objects: readers see old or new, never missing", async () => {
    const store = new InMemoryReleaseStore();
    const first = freshBundle(NOW_MS - 3_600_000);
    await runPublicationSequence({ store, bundle: first.bundle, artifactComplete: true });
    const before = await store.stableRefSha();
    const second = freshBundle(NOW_MS);
    await runPublicationSequence({ store, bundle: second.bundle, artifactComplete: true });
    const after = await store.stableRefSha();
    assert.notEqual(before, after, "the ref moved");
    // The old tag object is still fetchable by sha (immutable objects).
    const oldObject = await store.fetchTagObject(before as string);
    assert.equal((JSON.parse(oldObject.message) as StablePointerV1).versionedTag, first.tag);
    const newObject = await store.fetchTagObject(after as string);
    assert.equal((JSON.parse(newObject.message) as StablePointerV1).versionedTag, second.tag);
  });

  test("updateStableRef on a nonexistent tag object is refused (no phantom pointer)", async () => {
    const store = new InMemoryReleaseStore();
    await assert.rejects(() => store.updateStableRef("0".repeat(40)), /does not exist/);
    assert.equal(await store.stableRefSha(), null);
  });

  test("fetchTagObject on an unknown sha is a 404-equivalent failure", async () => {
    const store = new InMemoryReleaseStore();
    await assert.rejects(() => store.fetchTagObject("1".repeat(40)), /404/);
  });
});
