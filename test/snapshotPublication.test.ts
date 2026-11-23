// SPDX-License-Identifier: Apache-2.0
//
// Snapshot publication — offline battery for the provenance sidecar,
// SHA-256 integrity gate, versioned-tag naming/immutability, and the
// stable-reference sequencing rules (GY-M1-INT-001 §8, §10, §11).
//
// Pinned behaviors:
//   * the sidecar is derived from the EXACT artifact bytes + parsed
//     snapshot; unavailable workflow context stays null (never fabricated);
//   * the sidecar is secret-free by construction (exhaustive key pin +
//     secret-pattern scan);
//   * any byte tampering / length drift / sidecar drift is refused;
//   * versioned tags are unique per (timestamp, commit) and NEVER clobber
//     an existing tag (fail-safe duplicate handling);
//   * the stable reference may advance ONLY after versioned publication
//     AND post-publication verification — every unmet condition aborts
//     with the last-known-good stable artifact untouched;
//   * the stable update is a DEDICATED stable-reference activation
//     (create a NEW annotated pointer tag object + ONE atomic ref update;
//     the previous release and its assets are never touched; the retired
//     repo-wide latest promotion survives only as a legacy utility).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PublicKey } from "@solana/web3.js";
import { RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";

import {
  buildConsoleSnapshot,
  SNAPSHOT_THRESHOLD_FALLBACK,
  type ConsoleSnapshotV2,
  type PoolEnrichment,
} from "../src/consoleSnapshot.js";
import type { DiscoveredPoolRecord } from "../src/discovery.js";
import {
  buildPublicationProvenance,
  verifySnapshotIntegrity,
  versionedTagName,
  assertVersionedTagAvailable,
  assertVersionedTagFormat,
  assertStableAdvanceAllowed,
  assertStableReferenceServesVerifiedArtifact,
  describeStableReferenceUpdate,
  snapshotSha256,
  stableSnapshotUrl,
  stableProvenanceUrl,
  stableChecksumUrl,
  stableRefApiUrl,
  stableTagObjectApiUrl,
  buildStablePointer,
  parseStablePointer,
  verifyStablePointerMatchesArtifacts,
  STABLE_POINTER_SCHEMA,
  versionedAssetUrl,
  VERSIONED_TAG_PATTERN,
  SnapshotPublicationError,
  PUBLICATION_PROVENANCE_KEYS,
  PUBLICATION_STEPS,
  STABLE_TAG,
  STABLE_POINTER_KEYS,
  SNAPSHOT_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  CHECKSUM_ASSET_NAME,
  type PublicationProvenance,
  type PublicationContext,
  type StablePointerV1,
} from "../src/snapshotPublication.js";
import { parseConsoleSnapshot } from "../src/consoleSnapshotParse.js";
import { buildAmmInfo, synth } from "./fixtures.js";

// ─── A real schema-valid snapshot built through the real builder ────────────

const NOW_MS = 1_800_000_000_000;
const SOURCE = "b".repeat(40);

function discoveredRecord(seed: number): DiscoveredPoolRecord {
  const poolAddress = synth(seed);
  const data = buildAmmInfo();
  return {
    poolAddress,
    ammProgramId: RAYDIUM_V4_PROGRAM_ID,
    pool: {
      coinVault: synth(0x11),
      pcVault: synth(0x12),
      baseMint: synth(0x13),
      quoteMint: WSOL_MINT_CANON,
      lpMint: synth(0x14),
    },
    wsolSide: { memecoinMint: synth(0x13), coinIsWsol: false },
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

import { WSOL_MINT } from "@graveyield/sdk";
const WSOL_MINT_CANON = WSOL_MINT;

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

function realSnapshot(): { snapshot: ConsoleSnapshotV2; bytes: Uint8Array } {
  return realSnapshotAt(NOW_MS);
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

const BASE_CTX: PublicationContext = {
  sourceCommitSha: "b".repeat(40),
  workflowRunId: "987654",
  workflowAttempt: "1",
  repository: "GraveYield/grave-indexer",
  versionedTag: null,
};

// ─── Provenance sidecar ──────────────────────────────────────────────────────

describe("publication provenance sidecar", () => {
  test("is derived from the EXACT parsed snapshot + EXACT bytes", () => {
    const { snapshot, bytes } = realSnapshot();
    const prov = buildPublicationProvenance(snapshot, bytes, BASE_CTX);
    assert.equal(prov.schemaVersion, 2);
    assert.equal(prov.snapshotGeneratedAtUnixMs, snapshot.generatedAtUnixMs);
    assert.equal(prov.cluster, snapshot.cluster);
    assert.equal(prov.freshness.maxAgeMs, snapshot.freshness.maxAgeMs);
    assert.equal(prov.counts.rawAccounts, snapshot.counts.rawAccounts);
    assert.equal(prov.counts.parsedPools, snapshot.counts.parsedPools);
    assert.equal(prov.counts.supportedWsolPairs, snapshot.counts.supportedWsolPairs);
    assert.equal(prov.counts.m1SourcingRejected, snapshot.counts.m1SourcingRejected);
    assert.equal(prov.counts.enriched, snapshot.counts.enriched);
    assert.equal(prov.snapshotSha256, snapshotSha256(bytes));
    assert.equal(prov.snapshotByteLength, bytes.byteLength);
  });

  test("workflow context is carried verbatim; unavailable values are null, never fabricated", () => {
    const { snapshot, bytes } = realSnapshot();
    const full = buildPublicationProvenance(snapshot, bytes, BASE_CTX);
    assert.equal(full.workflowRunId, "987654");
    assert.equal(full.workflowAttempt, "1");
    assert.equal(full.repository, "GraveYield/grave-indexer");
    assert.equal(full.indexerSourceCommitSha, "b".repeat(40));

    // Off-CI / off-repo generation: everything unknown stays null.
    const bare = buildPublicationProvenance(snapshot, bytes, {
      sourceCommitSha: null,
      workflowRunId: null,
      workflowAttempt: null,
      repository: null,
      versionedTag: null,
    });
    assert.equal(bare.workflowRunId, null);
    assert.equal(bare.workflowAttempt, null);
    assert.equal(bare.repository, null);
    assert.equal(bare.indexerSourceCommitSha, null);
    assert.equal(bare.versionedTag, null);
  });

  test("the sidecar is secret-free: exhaustive key pin + secret-pattern scan", () => {
    const { snapshot, bytes } = realSnapshot();
    const prov = buildPublicationProvenance(snapshot, bytes, BASE_CTX);
    assert.deepEqual(Object.keys(prov).sort(), [...PUBLICATION_PROVENANCE_KEYS].sort());
    // No nested key drift either.
    assert.deepEqual(Object.keys(prov.counts).sort(), ["enriched", "m1SourcingRejected", "parsedPools", "rawAccounts", "supportedWsolPairs"]);
    const serialized = JSON.stringify(prov);
    for (const banned of ["http", "rpc", "url", "key", "token", "seed", "secret", "credential", "Authorization"]) {
      assert.ok(!serialized.toLowerCase().includes(banned), `sidecar must not contain "${banned}"`);
    }
  });

  test("the sidecar round-trips through JSON without change", () => {
    const { snapshot, bytes } = realSnapshot();
    const prov: PublicationProvenance = JSON.parse(JSON.stringify(buildPublicationProvenance(snapshot, bytes, BASE_CTX)));
    verifySnapshotIntegrity(bytes, prov); // must still verify after serialization
  });
});

// ─── Integrity gate ──────────────────────────────────────────────────────────

describe("snapshot SHA-256 / byte-length integrity", () => {
  test("exact bytes verify", () => {
    const { snapshot, bytes } = realSnapshot();
    verifySnapshotIntegrity(bytes, buildPublicationProvenance(snapshot, bytes, BASE_CTX));
  });

  test("a single flipped byte is refused", () => {
    const { snapshot, bytes } = realSnapshot();
    const tampered = bytes.slice();
    const idx = tampered.length - 4;
    tampered[idx] = (tampered[idx] ?? 0) ^ 0x01;
    assert.throws(
      () => verifySnapshotIntegrity(tampered, buildPublicationProvenance(snapshot, bytes, BASE_CTX)),
      /SHA-256 mismatch/,
    );
  });

  test("truncation is refused (digest gate fires on the changed bytes)", () => {
    const { snapshot, bytes } = realSnapshot();
    const prov = buildPublicationProvenance(snapshot, bytes, BASE_CTX);
    assert.throws(
      () => verifySnapshotIntegrity(bytes.slice(0, bytes.length - 1), prov),
      /SHA-256 mismatch/,
    );
  });

  test("a declared byte length that disagrees with the actual bytes is refused", () => {
    const { snapshot, bytes } = realSnapshot();
    const drifted = buildPublicationProvenance(snapshot, bytes, BASE_CTX);
    drifted.snapshotByteLength = bytes.byteLength + 1; // correct sha, wrong length
    assert.throws(
      () => verifySnapshotIntegrity(bytes, drifted),
      /byte length mismatch/,
    );
  });

  test("a drifted sidecar digest is refused (wrong artifact for this sidecar)", () => {
    const { bytes } = realSnapshot();
    // Build a genuinely different artifact (different generation time).
    const { snapshot: otherSnapshot, bytes: otherBytes } = realSnapshotAt(NOW_MS + 5_000);
    const otherProv = buildPublicationProvenance(otherSnapshot, otherBytes, BASE_CTX);
    assert.notEqual(otherProv.snapshotSha256, snapshotSha256(bytes), "the two artifacts must really differ");
    assert.throws(() => verifySnapshotIntegrity(bytes, otherProv), /SHA-256 mismatch/);
  });

  test("the snapshot bytes the sidecar was built from always pass the strict schema-v2 parser", () => {
    const { bytes } = realSnapshot();
    assert.doesNotThrow(() => parseConsoleSnapshot(JSON.parse(Buffer.from(bytes).toString("utf8"))));
  });
});

// ─── Versioned tag naming + duplicate handling ──────────────────────────────

describe("versioned release tags", () => {
  test("encode generation timestamp + source commit, and are deterministic", () => {
    const t1 = versionedTagName(NOW_MS, "c".repeat(40));
    const t2 = versionedTagName(NOW_MS, "c".repeat(40));
    assert.equal(t1, t2);
    assert.ok(t1.startsWith(`${STABLE_TAG}-`));
    assert.ok(t1.includes("c".repeat(12)), "the short source commit is embedded");
    assert.match(t1, /console-snapshot-prod-\d{8}T\d{6}Z-[0-9a-f]{12}$/);
  });

  test("different commits or generation seconds never collide (UTC-second granularity)", () => {
    // Tag granularity is one UTC second: two generations in the SAME
    // second at the SAME commit map to the same tag by design (they are
    // the same publication); a different second or commit always yields
    // a different tag.
    const a = versionedTagName(NOW_MS, "c".repeat(40));
    const b = versionedTagName(NOW_MS + 1_000, "c".repeat(40));
    const c = versionedTagName(NOW_MS, "d".repeat(40));
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  test("an unavailable source commit degrades to a unique timestamp-only tag (notrack), never a guess", () => {
    const t = versionedTagName(NOW_MS, null);
    assert.ok(t.endsWith("-notrack"));
    assert.match(t, /console-snapshot-prod-\d{8}T\d{6}Z-notrack/);
  });

  test("duplicate versioned tag → fail safely (no clobber of immutable history)", () => {
    const tag = versionedTagName(NOW_MS, "c".repeat(40));
    assert.throws(
      () => assertVersionedTagAvailable(tag, ["some-old-tag", tag]),
      /already exists.*stable reference untouched/,
    );
  });

  test("publishing under the stable tag, or an off-policy tag, is refused", () => {
    assert.throws(() => assertVersionedTagAvailable(STABLE_TAG, []), /never be issued under the stable tag/);
    assert.throws(() => assertVersionedTagAvailable("random-tag", []), /off-policy/);
  });

  test("a fresh versioned tag passes the duplicate gate", () => {
    const tag = versionedTagName(NOW_MS, "c".repeat(40));
    assert.doesNotThrow(() => assertVersionedTagAvailable(tag, ["console-snapshot-prod-20200101T000000Z-notrack"]));
  });
});

// ─── Stable-reference sequencing (last-known-good preservation) ─────────────

describe("stable reference update ordering", () => {
  const complete = {
    artifactComplete: true,
    schemaValidated: true,
    versionedReleasePublished: true,
    versionedAssetsVerified: true,
  };

  test("the stable ref name is distinct from every versioned tag (no suffix vs suffix)", () => {
    assert.equal(STABLE_TAG, "console-snapshot-prod");
    assert.ok(!VERSIONED_TAG_PATTERN.test(STABLE_TAG), "the stable ref name is not a versioned tag");
    assert.ok(versionedTagName(NOW_MS, SOURCE).startsWith(`${STABLE_TAG}-`), "versioned tags derive from the stable name");
  });

  test("the superseded latest-release URLs are retained as utilities only", () => {
    const repo = "GraveYield/grave-indexer";
    assert.equal(stableSnapshotUrl(repo), `https://github.com/${repo}/releases/latest/download/console-snapshot.json`);
    assert.equal(stableProvenanceUrl(repo), `https://github.com/${repo}/releases/latest/download/console-snapshot-provenance.json`);
    assert.equal(stableChecksumUrl(repo), `https://github.com/${repo}/releases/latest/download/console-snapshot.sha256`);
  });

  test("the PRODUCTION stable-reference resolution entry points are the dedicated git-ref APIs", () => {
    const repo = "GraveYield/grave-indexer";
    assert.equal(stableRefApiUrl(repo), `https://api.github.com/repos/${repo}/git/ref/tags/console-snapshot-prod`);
    const sha = "a".repeat(40);
    assert.equal(stableTagObjectApiUrl(repo, sha), `https://api.github.com/repos/${repo}/git/tags/${sha}`);
    // And they never overlap the superseded latest URL family.
    assert.ok(!stableRefApiUrl(repo).includes("releases/latest"));
  });

  test("versioned asset URLs are immutable tag-scoped paths", () => {
    const repo = "GraveYield/grave-indexer";
    const tag = versionedTagName(NOW_MS, "c".repeat(40));
    assert.equal(versionedAssetUrl(repo, tag, SNAPSHOT_ASSET_NAME), `https://github.com/${repo}/releases/download/${tag}/console-snapshot.json`);
  });

  test("the step order is fail-closed: activation is followed by a stable-reference identity re-verification", () => {
    assert.deepEqual(PUBLICATION_STEPS, [
      "generate",
      "validate-schema",
      "verify-integrity",
      "publish-versioned-release",
      "verify-versioned-assets",
      "activate-stable-reference",
      "verify-stable-reference",
    ]);
    assert.ok(PUBLICATION_STEPS.indexOf("activate-stable-reference") > PUBLICATION_STEPS.indexOf("verify-versioned-assets"));
    assert.ok(PUBLICATION_STEPS.indexOf("verify-versioned-assets") > PUBLICATION_STEPS.indexOf("publish-versioned-release"));
    assert.ok(PUBLICATION_STEPS.indexOf("verify-stable-reference") > PUBLICATION_STEPS.indexOf("activate-stable-reference"));
  });

  test("a fully verified sequence may advance the stable reference", () => {
    assert.doesNotThrow(() => assertStableAdvanceAllowed(complete));
  });

  test("an incomplete artifact can NEVER advance the stable reference", () => {
    assert.throws(
      () => assertStableAdvanceAllowed({ ...complete, artifactComplete: false }),
      /INCOMPLETE/,
    );
  });

  test("a schema-invalid artifact can NEVER advance the stable reference", () => {
    assert.throws(
      () => assertStableAdvanceAllowed({ ...complete, schemaValidated: false }),
      /schema-v2/,
    );
  });

  test("an un-published versioned release blocks the stable advance (order violation)", () => {
    assert.throws(
      () => assertStableAdvanceAllowed({ ...complete, versionedReleasePublished: false }),
      /versioned release has not been published/,
    );
  });

  test("unverified versioned assets block the stable advance (order violation)", () => {
    assert.throws(
      () => assertStableAdvanceAllowed({ ...complete, versionedAssetsVerified: false }),
      /assets have not been verified/,
    );
  });

  test("failure at ANY earlier step leaves the last-known-good stable reference untouched", () => {
    // The design contract: each unmet condition aborts the run — the
    // stable reference is only ever mutated on the LAST step, and only
    // when every earlier gate passed. Enumerate every failure position
    // and confirm the gate refuses the advance in all of them.
    for (const missing of ["artifactComplete", "schemaValidated", "versionedReleasePublished", "versionedAssetsVerified"] as const) {
      const state = { ...complete, [missing]: false };
      assert.throws(
        () => assertStableAdvanceAllowed(state),
        SnapshotPublicationError,
        `stable advance must abort when ${missing} is unmet`,
      );
    }
  });

  test("the stable update is documented as a dedicated-ref activation (never asset clobbering, never repo-wide latest)", () => {
    const doc = describeStableReferenceUpdate();
    assert.ok(doc.includes("annotated tag object"), "the mechanism is named");
    assert.ok(doc.includes("refs/tags/console-snapshot-prod"), "the dedicated ref is named");
    assert.ok(doc.includes("atomic ref update"), "the single atomic operation is identified");
    assert.ok(doc.includes("never copied onto the stable reference"), "the payload never becomes a second mutable copy");
    assert.ok(doc.includes("recorded for rollback"), "rollback is stated");
    assert.ok(doc.includes("immutable versioned release"), "the pointer names an immutable versioned release");
  });

  test("the pointer digest gate rejects tampered sidecar bytes", () => {
    const prov = buildPublicationProvenance(realSnapshot().snapshot, realSnapshot().bytes, { ...BASE_CTX, versionedTag: versionedTagName(NOW_MS, SOURCE) });
    const built = buildStablePointer({
      versionedTag: prov.versionedTag as string,
      sourceCommit: SOURCE,
      publishedAtUnixMs: NOW_MS,
      snapshotBytes: realSnapshot().bytes,
      provenanceBytes: new TextEncoder().encode(JSON.stringify(prov)),
      checksumBytes: new TextEncoder().encode(`${snapshotSha256(realSnapshot().bytes)}  ${SNAPSHOT_ASSET_NAME}\n`),
      previous: null,
    });
    const tampered = realSnapshot().bytes.slice();
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 0x01;
    assert.throws(
      () =>
        verifyStablePointerMatchesArtifacts({
          pointer: built.pointer,
          snapshotBytes: tampered,
          provenanceBytes: new TextEncoder().encode(JSON.stringify(prov)),
          checksumBytes: new TextEncoder().encode(`${snapshotSha256(tampered)}  ${SNAPSHOT_ASSET_NAME}\n`),
          provenance: prov,
        }),
      /digest\/length mismatch/,
    );
  });

  test("the stable reference must serve the ACTIVATED versioned artifact (post-activation gate)", () => {
    const { snapshot, bytes } = realSnapshot();
    const tag = versionedTagName(NOW_MS, SOURCE);
    const prov = buildPublicationProvenance(snapshot, bytes, { ...BASE_CTX, versionedTag: tag });
    // Positive: the activated bytes + naming sidecar pass.
    assert.doesNotThrow(() =>
      assertStableReferenceServesVerifiedArtifact({ fetchedSnapshotBytes: bytes, fetchedProvenance: prov, activatedTag: tag }),
    );
    // A stale stable URL (previous publication's sidecar) is refused.
    const staleTag = versionedTagName(NOW_MS - 1_000, "9".repeat(40));
    assert.throws(
      () => assertStableReferenceServesVerifiedArtifact({ fetchedSnapshotBytes: bytes, fetchedProvenance: prov, activatedTag: staleTag }),
      /NOT serving the activated artifact/,
    );
    // Tampered stable bytes are refused (digest gate).
    const tampered = bytes.slice();
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 0x01;
    assert.throws(
      () => assertStableReferenceServesVerifiedArtifact({ fetchedSnapshotBytes: tampered, fetchedProvenance: prov, activatedTag: tag }),
      /SHA-256 mismatch/,
    );
  });

  test("the strict versioned-tag shape gates what may be interpolated into workflow commands", () => {
    assert.match(versionedTagName(NOW_MS, SOURCE), VERSIONED_TAG_PATTERN);
    assert.match(versionedTagName(NOW_MS, null), VERSIONED_TAG_PATTERN);
    assert.doesNotThrow(() => assertVersionedTagFormat(versionedTagName(NOW_MS, SOURCE)));
    for (const hostile of ["", "; rm -rf /", "console-snapshot-prod", "console-snapshot-prod-20260101T000000Z", "console-snapshot-prod-20260101T000000Z-DEADBEEFDEAD", "console-snapshot-prod-20260101T000000Z-0123456789abc"]) {
      assert.throws(() => assertVersionedTagFormat(hostile), SnapshotPublicationError, `hostile tag ${JSON.stringify(hostile)} refused`);
    }
  });
});

// ─── Stable-pointer JSON — build/parse round trip + strict rejection matrix ──

describe("stable pointer JSON (graveyield.console-snapshot-stable-pointer.v1)", () => {
  function builtPointer(at = NOW_MS) {
    const { snapshot, bytes } = realSnapshotAt(at);
    const tag = versionedTagName(at, SOURCE);
    const prov = buildPublicationProvenance(snapshot, bytes, { ...BASE_CTX, versionedTag: tag });
    const provenanceBytes = new TextEncoder().encode(JSON.stringify(prov));
    const checksumBytes = new TextEncoder().encode(`${snapshotSha256(bytes)}  ${SNAPSHOT_ASSET_NAME}\n`);
    return {
      tag,
      snapshotBytes: bytes,
      provenance: prov,
      provenanceBytes,
      checksumBytes,
      ...buildStablePointer({
        versionedTag: tag,
        sourceCommit: SOURCE,
        publishedAtUnixMs: at,
        snapshotBytes: bytes,
        provenanceBytes,
        checksumBytes,
        previous: null,
      }),
    };
  }

  test("build → parse round trip preserves every field; the JSON is a single canonical line", async () => {
    const built = builtPointer();
    assert.ok(!built.pointerJson.includes("\n"), "the pointer JSON is single-line (annotated tag message)");
    const parsed = parseStablePointer(built.pointerJson);
    assert.equal(parsed.pointerSchema, STABLE_POINTER_SCHEMA);
    assert.equal(parsed.stableRef, "console-snapshot-prod");
    assert.equal(parsed.versionedTag, built.tag);
    assert.equal(parsed.sourceCommit, SOURCE);
    assert.equal(parsed.snapshot.sha256, snapshotSha256(built.snapshotBytes));
    assert.equal(parsed.snapshot.byteLength, built.snapshotBytes.byteLength);
    assert.equal(parsed.previousVersionedTag, null);
    assert.equal(parsed.previousTagObjectSha, null);
    assert.deepEqual(Object.keys(parsed).sort(), [...STABLE_POINTER_KEYS].sort(), "the key set is pinned");
    void built.pointer;
  });

  test("the pointer digests verify against the exact artifact triple and its provenance", async () => {
    const built = builtPointer();
    assert.doesNotThrow(() =>
      verifyStablePointerMatchesArtifacts({
        pointer: built.pointer,
        snapshotBytes: built.snapshotBytes,
        provenanceBytes: built.provenanceBytes,
        checksumBytes: built.checksumBytes,
        provenance: built.provenance,
      }),
    );
    // A provenance naming a DIFFERENT release is refused (cross-release identification).
    const otherTag = versionedTagName(NOW_MS - 1_000, "9".repeat(40));
    assert.throws(
      () =>
        verifyStablePointerMatchesArtifacts({
          pointer: built.pointer,
          snapshotBytes: built.snapshotBytes,
          provenanceBytes: built.provenanceBytes,
          checksumBytes: built.checksumBytes,
          provenance: { ...built.provenance, versionedTag: otherTag },
        }),
      /refusing a cross-release identification/,
    );
  });

  test("the previous-pointer record is carried and validated (rollback chain)", () => {
    const built = builtPointer();
    const withPrevious = buildStablePointer({
      versionedTag: built.tag,
      sourceCommit: SOURCE,
      publishedAtUnixMs: NOW_MS,
      snapshotBytes: built.snapshotBytes,
      provenanceBytes: built.provenanceBytes,
      checksumBytes: built.checksumBytes,
      previous: { versionedTag: versionedTagName(NOW_MS - 3_600_000, "9".repeat(40)), tagObjectSha: "a".repeat(40) },
    });
    assert.ok(withPrevious.pointerJson.includes('"previousVersionedTag":"console-snapshot-prod-'));
    assert.ok(withPrevious.pointerJson.includes('"previousTagObjectSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'));
    const parsed = parseStablePointer(withPrevious.pointerJson);
    assert.equal(parsed.previousVersionedTag, versionedTagName(NOW_MS - 3_600_000, "9".repeat(40)));
    // Previous fields must be jointly null or jointly set.
    assert.throws(
      () =>
        parseStablePointer(
          JSON.stringify({ ...parsed, previousVersionedTag: null }),
        ),
      SnapshotPublicationError,
    );
  });

  test("the strict parser rejects malformed pointers (every field fail-closed)", () => {
    const built = builtPointer();
    const valid = JSON.parse(built.pointerJson) as Record<string, unknown>;
    // Not JSON / not an object.
    assert.throws(() => parseStablePointer("not-json"), /not JSON/);
    assert.throws(() => parseStablePointer("42"), /not a JSON object/);
    // Wrong schema discriminator / stableRef.
    assert.throws(() => parseStablePointer(JSON.stringify({ ...valid, pointerSchema: "graveyield.other.v1" })), /pointerSchema/);
    assert.throws(() => parseStablePointer(JSON.stringify({ ...valid, stableRef: "console-snapshot-staging" })), /stableRef/);
    // Unexpected key set (extra or missing keys).
    const extra = { ...valid, sneaky: 1 };
    assert.throws(() => parseStablePointer(JSON.stringify(extra)), /unexpected key set/);
    const missing = { ...valid } as Record<string, unknown>;
    delete missing.snapshot;
    assert.throws(() => parseStablePointer(JSON.stringify(missing)), /unexpected key set/);
    // Malformed tag / commit / timestamp.
    assert.throws(() => parseStablePointer(JSON.stringify({ ...valid, versionedTag: "console-snapshot-prod" })), /does not match the expected shape|versioned tag/);
    assert.throws(() => parseStablePointer(JSON.stringify({ ...valid, sourceCommit: "zz" })), /sourceCommit/);
    assert.throws(() => parseStablePointer(JSON.stringify({ ...valid, publishedAtUnixMs: -1 })), /publishedAtUnixMs/);
    const validRecord = valid as unknown as Record<string, Record<string, unknown>>;
    // Malformed digests (not hex, wrong length) and bad lengths.
    const badSnapshot = { ...valid } as Record<string, unknown>;
    badSnapshot.snapshot = { ...validRecord.snapshot, sha256: "0".repeat(63) };
    assert.throws(() => parseStablePointer(JSON.stringify(badSnapshot)), /sha256/);
    const badLength = { ...valid } as Record<string, unknown>;
    badLength.snapshot = { ...validRecord.snapshot, byteLength: 0 };
    assert.throws(() => parseStablePointer(JSON.stringify(badLength)), /byteLength/);
    const badName = { ...valid } as Record<string, unknown>;
    badName.snapshot = { ...validRecord.snapshot, name: "snapshot.json" };
    assert.throws(() => parseStablePointer(JSON.stringify(badName)), /name/);
    // A versioned-tag-shaped-but-hostile previous record is refused.
    assert.throws(
      () => parseStablePointer(JSON.stringify({ ...valid, previousVersionedTag: "console-snapshot-prod", previousTagObjectSha: null })),
      SnapshotPublicationError,
    );
    // Building with a hostile sourceCommit is refused.
    assert.throws(
      () =>
        buildStablePointer({
          versionedTag: versionedTagName(NOW_MS, SOURCE),
          sourceCommit: "; rm -rf /",
          publishedAtUnixMs: NOW_MS,
          snapshotBytes: new Uint8Array(1),
          provenanceBytes: new Uint8Array(1),
          checksumBytes: new Uint8Array(1),
        }),
      SnapshotPublicationError,
    );
  });
});
