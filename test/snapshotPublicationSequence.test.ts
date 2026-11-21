// SPDX-License-Identifier: Apache-2.0
//
// GY-M1-INT-001 correction §4.5 — failure-injection battery for the
// stable publication sequence.
//
// These tests drive `runPublicationSequence` (src/snapshotPublicationSequence.ts)
// — a faithful executable abstraction of the publish job in
// .github/workflows/publish-console-snapshot.yml: the workflow's exact
// step order and public-URL fetch semantics, with the REAL production
// verification gates (strict schema-v2 parser, SHA-256/byte-length
// integrity, checksum-file verification, ordering gates). Faults are
// injected at every operation (a wrapped InMemoryReleaseStore), and the
// stable-reference invariant is asserted after every fault:
//
//   BEFORE activation  → the latest designation is UNCHANGED and still
//                         serves the complete previous artifact.
//   AFTER activation   → the latest designation serves a COMPLETE
//                         artifact whose sidecar names the activated
//                         versioned tag.
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

type StoreOp = "create" | "upload" | "fetchByTag" | "fetchByLatest" | "markLatest";

/**
 * A store that throws at a chosen operation — the fault-injection seams
 * for the workflow's GitHub-side operations. Faults are armed ONLY
 * after seeding (a publication may fail mid-run, but setting up the
 * previous good release must not). `skipAsset` simulates an asset that
 * silently fails to upload (missing asset on the release).
 */
class FaultyReleaseStore extends InMemoryReleaseStore {
  armed = false;
  constructor(
    private readonly faultOn: StoreOp | null = null,
    private readonly skipAsset: string | null = null,
  ) {
    super();
  }
  /** Arm the fault AFTER seeding the previous good release. */
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
  override async markLatest(tag: string): Promise<void> {
    if (this.hit("markLatest")) throw new Error("injected fault: latest-release promotion failed");
    return super.markLatest(tag);
  }
  override async fetchAssetByLatest(name: string): Promise<Uint8Array> {
    if (this.hit("fetchByLatest")) throw new Error("injected fault: stable-URL fetch failed");
    return super.fetchAssetByLatest(name);
  }
}

const PREVIOUS_TAG = versionedTagName(NOW_MS - 3_600_000, SOURCE_COMMIT);

/** Seed a store whose latest designation already serves a previous good publication. */
async function storeWithPreviousRelease<S extends InMemoryReleaseStore = InMemoryReleaseStore>(store?: S): Promise<S> {
  const s: S = store ?? (new InMemoryReleaseStore() as unknown as S);
  const { bundle, tag } = freshBundle(NOW_MS - 3_600_000);
  await s.createRelease(tag, { makeLatest: false });
  await s.uploadAsset(tag, SNAPSHOT_ASSET_NAME, bundle.snapshotBytes);
  await s.uploadAsset(tag, PROVENANCE_ASSET_NAME, bundle.provenanceBytes);
  await s.uploadAsset(tag, CHECKSUM_ASSET_NAME, bundle.checksumBytes);
  await s.markLatest(tag);
  return s;
}

/** The invariant: the current latest designation serves a COMPLETE, verified artifact. */
async function assertLatestServesCompleteArtifact(store: InMemoryReleaseStore, expectedTag: string | null): Promise<void> {
  assert.equal(await store.latestTag(), expectedTag, "latest designation");
  if (expectedTag === null) {
    await assert.rejects(() => store.fetchAssetByLatest(SNAPSHOT_ASSET_NAME), /404/);
    return;
  }
  const snapshot = await store.fetchAssetByLatest(SNAPSHOT_ASSET_NAME);
  const provBytes = await store.fetchAssetByLatest(PROVENANCE_ASSET_NAME);
  const checksum = await store.fetchAssetByLatest(CHECKSUM_ASSET_NAME);
  verifyChecksumFile(snapshot, checksum, SNAPSHOT_ASSET_NAME); // throws on any inconsistency
  const prov = JSON.parse(Buffer.from(provBytes).toString("utf8")) as { versionedTag: string | null };
  assert.equal(prov.versionedTag, expectedTag, "served provenance names the latest release");
  // The served bytes must pass the strict schema-v2 parser.
  assert.doesNotThrow(() => parseConsoleSnapshot(JSON.parse(Buffer.from(snapshot).toString("utf8"))));
}

// ─── Happy path ─────────────────────────────────────────────────────────────

describe("publication sequence — happy path", () => {
  test("a complete publication executes every step in order and activates the stable reference", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle, tag } = freshBundle();

    const result = await runPublicationSequence({ store, bundle, artifactComplete: true });

    assert.deepEqual(
      result.executed,
      PUBLICATION_STEPS.filter((s) => s !== "generate") as PublicationStep[],
      "the sequence executes exactly the workflow's post-generation steps, in order",
    );
    assert.equal(result.activatedTag, tag);
    assert.equal(result.previousLatestTag, PREVIOUS_TAG, "the rollback pointer is the previously latest release");
    // Stable URL now serves the NEW artifact.
    await assertLatestServesCompleteArtifact(store, tag);
    // The OLD release is untouched and fully fetchable (rollback intact).
    const oldSnapshot = await store.fetchAssetByTag(PREVIOUS_TAG, SNAPSHOT_ASSET_NAME);
    assert.ok(oldSnapshot.byteLength > 0);
    assert.equal(await store.latestTag(), tag);
  });

  test("the first publication bootstraps: previous latest is null, activation promotes from none", async () => {
    const store = new InMemoryReleaseStore();
    const { bundle, tag } = freshBundle();
    const result = await runPublicationSequence({ store, bundle, artifactComplete: true });
    assert.equal(result.previousLatestTag, null);
    assert.equal(result.activatedTag, tag);
    await assertLatestServesCompleteArtifact(store, tag);
  });
});

// ─── Failure injection (GY-M1-INT-001 §4.5) ─────────────────────────────────

describe("failure injection — last-known-good preservation", () => {
  test("1+7. duplicate versioned release: aborts BEFORE creation, stable untouched", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle } = freshBundle();
    // Simulate a concurrent run having already created this exact tag.
    await store.createRelease(bundle.provenance.versionedTag as string, { makeLatest: false });

    await assert.rejects(
      () => runPublicationSequence({ store, bundle, artifactComplete: true }),
      /already exists/,
    );
    // Invariant: stable still serves the previous artifact.
    await assertLatestServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("2. failure during versioned asset upload: stable untouched", async () => {
    const store = (await storeWithPreviousRelease(new FaultyReleaseStore("upload"))).arm();
    const { bundle, tag } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /asset upload failed/);
    await assertLatestServesCompleteArtifact(store, PREVIOUS_TAG);
    assert.notEqual(await store.latestTag(), tag, "the new tag was never promoted");
  });

  test("3. failure during versioned asset verification (checksum drift): stable untouched", async () => {
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
    await assertLatestServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("8. invalid provenance/schema-invalid artifact: aborts at validate-schema, nothing created", async () => {
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
    await assertLatestServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("4. failure before stable activation (artifact INCOMPLETE): promotion refused, stable untouched", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle, tag } = freshBundle();
    await assert.rejects(
      () => runPublicationSequence({ store, bundle, artifactComplete: false }),
      /INCOMPLETE/,
    );
    assert.equal(await store.latestTag(), PREVIOUS_TAG);
    await assertLatestServesCompleteArtifact(store, PREVIOUS_TAG);
    assert.notEqual(await store.latestTag(), tag);
  });

  test("5. failure during stable activation (promotion throws): stable unchanged, versioned release intact for retry", async () => {
    const store = (await storeWithPreviousRelease(new FaultyReleaseStore("markLatest"))).arm();
    const { bundle, tag } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /promotion failed/);
    await assertLatestServesCompleteArtifact(store, PREVIOUS_TAG);
    // The versioned release itself is complete — a manual promotion can retry.
    const snapshot = await store.fetchAssetByTag(tag, SNAPSHOT_ASSET_NAME);
    verifyChecksumFile(snapshot, await store.fetchAssetByTag(tag, CHECKSUM_ASSET_NAME), SNAPSHOT_ASSET_NAME);
  });

  test("6. failure immediately after stable activation (stable-URL fetch fails): stable still serves a COMPLETE validated artifact", async () => {
    const store = (await storeWithPreviousRelease(new FaultyReleaseStore("fetchByLatest"))).arm();
    const { bundle, tag } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /stable-URL fetch failed/);
    // The run FAILED (post-activation verification could not confirm),
    // but the designation moved to the fully-verified versioned release:
    // the stable reference serves a complete, validated artifact.
    assert.equal(await store.latestTag(), tag);
    const snapshot = await store.fetchAssetByTag(tag, SNAPSHOT_ASSET_NAME);
    verifyChecksumFile(snapshot, await store.fetchAssetByTag(tag, CHECKSUM_ASSET_NAME), SNAPSHOT_ASSET_NAME);
    assert.doesNotThrow(() => parseConsoleSnapshot(JSON.parse(Buffer.from(snapshot).toString("utf8"))));
  });

  test("10. missing snapshot asset on the versioned release: roundtrip 404 aborts BEFORE activation", async () => {
    const store = (await storeWithPreviousRelease(new FaultyReleaseStore(null, SNAPSHOT_ASSET_NAME))).arm();
    const { bundle } = freshBundle();
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /404/);
    await assertLatestServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("11. partial publication (upload stops after 2 of 3 assets): stable untouched", async () => {
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
    await assertLatestServesCompleteArtifact(store, PREVIOUS_TAG);
  });

  test("12. interrupted workflow: a fault at ANY operation leaves the invariant intact (exhaustive sweep)", async () => {
    for (const op of ["create", "upload", "fetchByTag", "markLatest", "fetchByLatest"] as const) {
      const store = (await storeWithPreviousRelease(new FaultyReleaseStore(op))).arm();
      const { bundle, tag } = freshBundle();
      await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /injected fault/, `fault at ${op} must fail the run`);
      store.disarm(); // the invariant check itself must be able to read the store
      if (op === "fetchByLatest") {
        // Post-activation: the designation moved, but to a COMPLETE verified release.
        await assertLatestServesCompleteArtifact(store, tag);
      } else {
        await assertLatestServesCompleteArtifact(store, PREVIOUS_TAG);
      }
    }
  });

  test("13. concurrent publication attempts (same bundle, sequential executions): the second attempt aborts on the duplicate gate", async () => {
    const store = await storeWithPreviousRelease();
    const { bundle, tag } = freshBundle();
    // First run succeeds and activates.
    await runPublicationSequence({ store, bundle, artifactComplete: true });
    await assertLatestServesCompleteArtifact(store, tag);
    // A second concurrent/queued run with the SAME bundle must abort on
    // the duplicate-tag gate (the concurrency group queues it; the gate
    // makes the re-run a no-op, never a clobber).
    await assert.rejects(() => runPublicationSequence({ store, bundle, artifactComplete: true }), /already exists/);
    await assertLatestServesCompleteArtifact(store, tag);
    assert.equal(await store.latestTag(), tag);
  });

  test("13b. two DIFFERENT publications run back-to-back: the second activates, the first remains fetchable (rollback intact)", async () => {
    const store = new InMemoryReleaseStore();
    const first = freshBundle(NOW_MS - 1_000);
    await runPublicationSequence({ store, bundle: first.bundle, artifactComplete: true });
    const second = freshBundle(NOW_MS);
    const result = await runPublicationSequence({ store, bundle: second.bundle, artifactComplete: true });
    assert.equal(result.previousLatestTag, first.tag, "the second run records the first as its rollback pointer");
    await assertLatestServesCompleteArtifact(store, second.tag);
    const firstSnapshot = await store.fetchAssetByTag(first.tag, SNAPSHOT_ASSET_NAME);
    assert.ok(firstSnapshot.byteLength > 0, "the superseded release remains fully fetchable");
  });
});

// ─── Release-store semantics mirrors ────────────────────────────────────────

describe("InMemoryReleaseStore — GitHub semantics mirrors", () => {
  test("createRelease with makeLatest:false never moves the designation", async () => {
    const store = new InMemoryReleaseStore();
    const { bundle, tag } = freshBundle(NOW_MS - 3_600_000);
    await store.createRelease(tag, { makeLatest: false });
    await store.uploadAsset(tag, SNAPSHOT_ASSET_NAME, bundle.snapshotBytes);
    await store.uploadAsset(tag, PROVENANCE_ASSET_NAME, bundle.provenanceBytes);
    await store.uploadAsset(tag, CHECKSUM_ASSET_NAME, bundle.checksumBytes);
    await store.markLatest(tag);
    await assertLatestServesCompleteArtifact(store, tag);

    const otherTag = versionedTagName(NOW_MS, SOURCE_COMMIT);
    await store.createRelease(otherTag, { makeLatest: false });
    await store.uploadAsset(otherTag, SNAPSHOT_ASSET_NAME, new Uint8Array(8));
    assert.equal(await store.latestTag(), tag, "creating (even with assets) does not promote");
  });

  test("fetchAssetByLatest resolves the CURRENT designation's asset — one release's bytes, never a mixture", async () => {
    const store = new InMemoryReleaseStore();
    const a = freshBundle(NOW_MS - 3_600_000);
    const b = freshBundle(NOW_MS);
    await store.createRelease(a.tag, { makeLatest: false });
    await store.uploadAsset(a.tag, SNAPSHOT_ASSET_NAME, a.bundle.snapshotBytes);
    await store.uploadAsset(a.tag, PROVENANCE_ASSET_NAME, a.bundle.provenanceBytes);
    await store.uploadAsset(a.tag, CHECKSUM_ASSET_NAME, a.bundle.checksumBytes);
    await store.markLatest(a.tag);
    await store.createRelease(b.tag, { makeLatest: false });
    await store.uploadAsset(b.tag, SNAPSHOT_ASSET_NAME, b.bundle.snapshotBytes);
    await store.uploadAsset(b.tag, PROVENANCE_ASSET_NAME, b.bundle.provenanceBytes);
    await store.uploadAsset(b.tag, CHECKSUM_ASSET_NAME, b.bundle.checksumBytes);
    // Before promotion: latest serves A's bytes.
    const servedA = await store.fetchAssetByLatest(SNAPSHOT_ASSET_NAME);
    assert.equal(snapshotSha256(servedA), snapshotSha256(a.bundle.snapshotBytes));
    await store.markLatest(b.tag);
    const servedB = await store.fetchAssetByLatest(SNAPSHOT_ASSET_NAME);
    assert.equal(snapshotSha256(servedB), snapshotSha256(b.bundle.snapshotBytes));
    // A's bytes are still reachable through its immutable versioned URL.
    const directA = await store.fetchAssetByTag(a.tag, SNAPSHOT_ASSET_NAME);
    assert.equal(snapshotSha256(directA), snapshotSha256(a.bundle.snapshotBytes));
  });

  test("markLatest on a missing release is refused (no phantom designation)", async () => {
    const store = new InMemoryReleaseStore();
    await assert.rejects(() => store.markLatest("console-snapshot-prod-20260101T000000Z-notrack"), /does not exist/);
    assert.equal(await store.latestTag(), null);
  });
});
