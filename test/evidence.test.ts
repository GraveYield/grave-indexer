// SPDX-License-Identifier: Apache-2.0
//
// Evidence bundle tests — build/parse round-trip and the malformed-input
// rejection matrix (fail-closed, mirroring the on-chain field checks).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  buildEvidenceBundle,
  buildEvidenceMessage,
  parseEvidenceBundle,
  parseEvidenceBundleJson,
  recomputeBundleMessage,
  MalformedEvidenceError,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceBundle,
} from "../src/evidence.js";
import { signAttestationMessage } from "../src/sign.js";
import { synth, testOracle } from "./fixtures.js";

const AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const SCANNER = new PublicKey("CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54");

async function canonicalBundle() {
  const oracle = await testOracle();
  const slotHash = new Uint8Array(32).fill(0x33);
  const msg = buildEvidenceMessage({
    ammProgramId: AMM,
    poolAddress: synth(0xa1),
    lastSwapUnixTs: 1_700_000_000,
    issuedSlot: 5_000_000,
    slotHash,
  });
  return {
    oracle,
    bundle: buildEvidenceBundle({
      destination: { cluster: "devnet", scannerProgramId: SCANNER, protocolConfigPda: synth(0x01) },
      poolIdentity: {
        ammProgramId: AMM.toBase58(),
        poolAddress: synth(0xa1).toBase58(),
        baseMint: synth(0xb1).toBase58(),
        quoteMint: new PublicKey("So11111111111111111111111111111111111111112").toBase58(),
        lpMint: synth(0xc1).toBase58(),
        coinVault: synth(0xd1).toBase58(),
        pcVault: synth(0xe1).toBase58(),
      },
      activity: {
        lastSwapUnixTs: 1_700_000_000,
        lastSwapSlot: 4_999_000,
        lastSwapSignature: "5TESTSIGNATURE",
        derivationCluster: "mainnet-beta",
      },
      issuance: { issuedSlot: 5_000_000, slotHash, issuedAtUnixMs: 1_760_000_000_000 },
      signature: signAttestationMessage(oracle, msg),
      oraclePublicKey: oracle.publicKey,
    }),
  };
}

describe("evidence bundles", () => {
  test("round-trips: parse(serialize(build)) is stable and msg recomputation agrees", async () => {
    const { bundle } = await canonicalBundle();
    const json = JSON.stringify(bundle);
    const parsed = parseEvidenceBundleJson(json);
    assert.equal(parsed.schemaVersion, EVIDENCE_SCHEMA_VERSION);
    assert.deepEqual(parsed.poolIdentity, bundle.poolIdentity);
    assert.equal(parsed.attestation.msgHex, bundle.attestation.msgHex);
    assert.deepEqual(recomputeBundleMessage(parsed), recomputeBundleMessage(bundle));
    assert.equal(parsed.attestation.msgHex.length, 112 * 2, "112-byte message hex");
    assert.equal(parsed.attestation.signatureHex.length, 64 * 2, "64-byte signature hex");
    assert.equal(parsed.issuance.slotHashHex.length, 32 * 2, "32-byte slot hash hex");
  });

  test("bundle contains NO secret material (only public key + signature)", async () => {
    const { bundle } = await canonicalBundle();
    const serialized = JSON.stringify(bundle).toLowerCase();
    assert.ok(!serialized.includes("secret"), "no 'secret' field");
    assert.ok(!serialized.includes("seed"), "no 'seed' field");
    assert.ok(!serialized.includes("private"), "no 'private' field");
    assert.equal(Object.keys(bundle.attestation).sort().join(","), "msgHex,oraclePublicKey,signatureHex");
  });

  test("rejects a message one byte short (on-chain 6025 analogue)", async () => {
    const { bundle } = await canonicalBundle();
    const bad = structuredClone(bundle);
    bad.attestation.msgHex = bundle.attestation.msgHex.slice(0, 111 * 2);
    assert.throws(() => parseEvidenceBundle(bad), MalformedEvidenceError);
  });

  test("rejects a message one byte long", async () => {
    const { bundle } = await canonicalBundle();
    const bad = structuredClone(bundle);
    bad.attestation.msgHex = bundle.attestation.msgHex + "00";
    assert.throws(() => parseEvidenceBundle(bad), MalformedEvidenceError);
  });

  test("rejects non-hex message bytes", async () => {
    const { bundle } = await canonicalBundle();
    const bad = structuredClone(bundle);
    bad.attestation.msgHex = `z${bundle.attestation.msgHex.slice(1)}`;
    assert.throws(() => parseEvidenceBundle(bad), MalformedEvidenceError);
  });

  test("rejects a wrong-length slot hash and wrong-length signature", async () => {
    const { bundle } = await canonicalBundle();
    const badHash = structuredClone(bundle);
    badHash.issuance.slotHashHex = bundle.issuance.slotHashHex.slice(0, 62);
    assert.throws(() => parseEvidenceBundle(badHash), MalformedEvidenceError);
    const badSig = structuredClone(bundle);
    badSig.attestation.signatureHex = `${bundle.attestation.signatureHex}aa`;
    assert.throws(() => parseEvidenceBundle(badSig), MalformedEvidenceError);
  });

  test("rejects zero timestamp and zero issued slot (6028/6031 analogues)", async () => {
    const { bundle } = await canonicalBundle();
    const zeroTs = structuredClone(bundle);
    zeroTs.activity.lastSwapUnixTs = 0;
    assert.throws(() => parseEvidenceBundle(zeroTs), /6028/);
    const zeroSlot = structuredClone(bundle);
    zeroSlot.issuance.issuedSlot = 0;
    assert.throws(() => parseEvidenceBundle(zeroSlot), /6031/);
  });

  test("rejects binding echo divergence — msgHex disagrees with bundle fields (6027 analogue)", async () => {
    const { bundle } = await canonicalBundle();
    const bad = structuredClone(bundle);
    // Repoint the bundle at a different pool WITHOUT re-signing/rebuilding
    // the embedded message: the parse-time echo rule must catch it.
    bad.poolIdentity = { ...bad.poolIdentity, poolAddress: synth(0xa2).toBase58() };
    assert.throws(() => parseEvidenceBundle(bad), /6027/);
  });

  test("rejects invalid pubkeys and unknown schema versions", async () => {
    const { bundle } = await canonicalBundle();
    const badPk = structuredClone(bundle);
    badPk.poolIdentity = { ...badPk.poolIdentity, poolAddress: "!!!not-base58!!!" };
    assert.throws(() => parseEvidenceBundle(badPk), MalformedEvidenceError);
    const badVersion = structuredClone(bundle);
    badVersion.schemaVersion = 99;
    assert.throws(() => parseEvidenceBundle(badVersion), /schemaVersion/);
    assert.throws(() => parseEvidenceBundle(null), MalformedEvidenceError);
    assert.throws(() => parseEvidenceBundleJson("not json"), MalformedEvidenceError);
  });

  test("msg layout is normative: identity ‖ ts ‖ slot ‖ hash at pinned offsets", async () => {
    const { bundle } = await canonicalBundle();
    const msg = recomputeBundleMessage(bundle);
    const view = new DataView(msg.buffer);
    assert.deepEqual(msg.slice(0, 32), AMM.toBytes());
    assert.deepEqual(msg.slice(32, 64), synth(0xa1).toBytes());
    assert.equal(Number(view.getBigInt64(64, true)), 1_700_000_000);
    assert.equal(Number(view.getBigUint64(72, true)), 5_000_000);
    assert.deepEqual(msg.slice(80, 112), new Uint8Array(32).fill(0x33));
  });
});
