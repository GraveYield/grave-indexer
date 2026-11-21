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
//   * the stable update is a latest-release promotion (single metadata
//     operation; the previous release and its assets are never touched).

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
  versionedAssetUrl,
  VERSIONED_TAG_PATTERN,
  SnapshotPublicationError,
  PUBLICATION_PROVENANCE_KEYS,
  PUBLICATION_STEPS,
  STABLE_TAG,
  SNAPSHOT_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  CHECKSUM_ASSET_NAME,
  type PublicationProvenance,
  type PublicationContext,
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

  test("the stable tag string survives only as the versioned-tag PREFIX (no mutable stable release)", () => {
    assert.equal(STABLE_TAG, "console-snapshot-prod");
  });

  test("the stable URLs are the CONSTANT latest-release paths (plain fetch, no auth)", () => {
    const repo = "GraveYield/grave-indexer";
    assert.equal(stableSnapshotUrl(repo), `https://github.com/${repo}/releases/latest/download/console-snapshot.json`);
    assert.equal(stableProvenanceUrl(repo), `https://github.com/${repo}/releases/latest/download/console-snapshot-provenance.json`);
    assert.equal(stableChecksumUrl(repo), `https://github.com/${repo}/releases/latest/download/console-snapshot.sha256`);
  });

  test("versioned asset URLs are immutable tag-scoped paths", () => {
    const repo = "GraveYield/grave-indexer";
    const tag = versionedTagName(NOW_MS, "c".repeat(40));
    assert.equal(versionedAssetUrl(repo, tag, SNAPSHOT_ASSET_NAME), `https://github.com/${repo}/releases/download/${tag}/console-snapshot.json`);
  });

  test("the step order is fail-closed: activation is followed by a stable-URL re-verification", () => {
    assert.deepEqual(PUBLICATION_STEPS, [
      "generate",
      "validate-schema",
      "verify-integrity",
      "publish-versioned-release",
      "verify-versioned-assets",
      "activate-stable-latest",
      "verify-stable-reference",
    ]);
    assert.ok(PUBLICATION_STEPS.indexOf("activate-stable-latest") > PUBLICATION_STEPS.indexOf("verify-versioned-assets"));
    assert.ok(PUBLICATION_STEPS.indexOf("verify-versioned-assets") > PUBLICATION_STEPS.indexOf("publish-versioned-release"));
    assert.ok(PUBLICATION_STEPS.indexOf("verify-stable-reference") > PUBLICATION_STEPS.indexOf("activate-stable-latest"));
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

  test("the stable update is documented as a latest-release promotion (never asset clobbering)", () => {
    const doc = describeStableReferenceUpdate();
    assert.ok(doc.includes("latest-release promotion"), "the mechanism is named");
    assert.ok(doc.includes("make_latest=true"), "the single metadata operation is identified");
    assert.ok(doc.includes("releases/latest/download/console-snapshot.json"), "the stable URL is named");
    assert.ok(doc.includes("never modified or deleted"), "last-known-good preservation is stated");
    assert.ok(doc.includes("re-promoting"), "rollback is stated");
    assert.ok(!doc.toLowerCase().includes("clobber") || doc.toLowerCase().includes("rejected"), "clobbering is not the mechanism");
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
