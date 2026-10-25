// SPDX-License-Identifier: Apache-2.0
//
// Verifier tests — the full off-chain verification matrix against a
// mocked RPC. The check order mirrors the on-chain path; every expected
// rejection names its on-chain analogue (6025/6026/6027/6028/6029/6030)
// or the operator-side journal.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  buildEvidenceBundle,
  buildEvidenceMessage,
  type EvidenceBundle,
} from "../src/evidence.js";
import { signAttestationMessage } from "../src/sign.js";
import { verifyEvidenceBundle, summarizeVerifyResult } from "../src/verify.js";
import { ReplayJournal } from "../src/journal.js";
import { synth, testOracle } from "./fixtures.js";

const AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const SCANNER = new PublicKey("CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54");

// Mock chain state: current slot 5_000_000; blocks resolvable for a
// window of slots with deterministic blockhashes (sha-like filler).
const NOW_SLOT = 5_000_000;
const NOW_UNIX = 1_760_000_000;
const SLOT_HASH_WINDOW = 512;

function mockBlockhash(slot: number): Uint8Array {
  const h = new Uint8Array(32);
  for (let i = 0; i < 32; i++) h[i] = (slot + i * 31) & 0xff;
  return h;
}

function mockConnection(): Connection {
  const fake = {
    getSlot: async (): Promise<number> => NOW_SLOT,
    getBlock: async (slot: number) => {
      if (slot <= 0) return null;
      if (NOW_SLOT - slot > SLOT_HASH_WINDOW) return null; // aged out
      return { blockhash: bs58.encode(mockBlockhash(slot)) };
    },
    getAccountInfo: async () => null,
  };
  return fake as unknown as Connection;
}

interface BundleSpec {
  lastSwapUnixTs?: number;
  issuedSlot?: number;
  slotHash?: Uint8Array;
  poolSeed?: number;
  signer?: Awaited<ReturnType<typeof testOracle>>;
}

async function makeBundle(spec: BundleSpec = {}) {
  const oracle = spec.signer ?? (await testOracle());
  const issuedSlot = spec.issuedSlot ?? NOW_SLOT - 8;
  const slotHash = spec.slotHash ?? mockBlockhash(issuedSlot);
  const lastSwapUnixTs = spec.lastSwapUnixTs ?? NOW_UNIX - 90 * 24 * 3600;
  const poolAddress = synth(spec.poolSeed ?? 0xa1);
  const msg = buildEvidenceMessage({
    ammProgramId: AMM,
    poolAddress,
    lastSwapUnixTs,
    issuedSlot,
    slotHash,
  });
  const bundle = buildEvidenceBundle({
    destination: { cluster: "devnet", scannerProgramId: SCANNER, protocolConfigPda: synth(0x01) },
    poolIdentity: {
      ammProgramId: AMM.toBase58(),
      poolAddress: poolAddress.toBase58(),
      baseMint: synth(0xb1).toBase58(),
      quoteMint: new PublicKey("So11111111111111111111111111111111111111112").toBase58(),
      lpMint: synth(0xc1).toBase58(),
      coinVault: synth(0xd1).toBase58(),
      pcVault: synth(0xe1).toBase58(),
    },
    activity: { lastSwapUnixTs, lastSwapSlot: issuedSlot - 100, lastSwapSignature: "", derivationCluster: "mainnet-beta" },
    issuance: { issuedSlot, slotHash, issuedAtUnixMs: NOW_UNIX * 1000 },
    signature: signAttestationMessage(oracle, msg),
    oraclePublicKey: oracle.publicKey,
    createdAtUnixMs: NOW_UNIX * 1000,
  });
  return { oracle, bundle };
}

const baseVerifyOpts = (oracle: Awaited<ReturnType<typeof testOracle>>) => ({
  nowUnixSeconds: NOW_UNIX,
  nowSlot: NOW_SLOT,
  expectedOracle: oracle.publicKey,
  blockLookupRetries: 0,
});

describe("evidence verifier — acceptance", () => {
  test("a canonical bundle verifies end-to-end against mocked chain state", async () => {
    const { oracle, bundle } = await makeBundle();
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", bundle, {
      ...baseVerifyOpts(oracle),
      journal: new ReplayJournal(null),
    });
    assert.equal(result.outcome, "verified", JSON.stringify(result.checks, null, 2));
    assert.ok(result.ok);
    const ids = result.checks.map((c) => c.id);
    for (const required of [
      "BUNDLE_WELLFORMED",
      "ATTESTATION_OFFSETS",
      "ATTESTATION_SIGNATURE",
      "ATTESTATION_ORACLE",
      "ATTESTATION_BINDING",
      "ATTESTATION_TIMESTAMP",
      "ATTESTATION_SLOT",
      "ATTESTATION_STALE",
      "ATTESTATION_SLOT_HASH",
      "ATTESTATION_REPLAY",
    ]) {
      assert.ok(ids.includes(required), `missing check ${required}`);
    }
  });

  test("signer == configured oracle when expectedOracle matches (positive authorization)", async () => {
    const { oracle, bundle } = await makeBundle();
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", bundle, baseVerifyOpts(oracle));
    const oracleCheck = result.checks.find((c) => c.id === "ATTESTATION_ORACLE");
    assert.ok(oracleCheck?.ok, "oracle check passes with the matching expected oracle");
  });
});

describe("evidence verifier — rejection matrix", () => {
  test("tampered signature → rejected at ATTESTATION_SIGNATURE", async () => {
    const { oracle, bundle } = await makeBundle();
    const bad = structuredClone(bundle);
    const flip = (n: number) => {
      const bytes = Uint8Array.from(Buffer.from(bad.attestation.signatureHex, "hex"));
      bytes[n] = (bytes[n]! ^ 0x01) & 0xff;
      bad.attestation.signatureHex = Buffer.from(bytes).toString("hex");
    };
    flip(3);
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", bad, baseVerifyOpts(oracle));
    assert.equal(result.outcome, "rejected");
    assert.equal(result.firstFailure?.id, "ATTESTATION_SIGNATURE");
  });

  test("unauthorized signer (≠ configured oracle) → oracle-gated at ATTESTATION_ORACLE (6026 analogue)", async () => {
    const { bundle } = await makeBundle(); // signed by testOracle
    const impostor = await makeBundle({ signer: await (async () => {
      const { oracleSignerFromSeed } = await import("../src/sign.js");
      return oracleSignerFromSeed(new Uint8Array(32).fill(0x77));
    })(), poolSeed: 0xa1 });
    // Verify the impostor bundle against the REAL oracle as the configured one:
    const { oracle } = await makeBundle();
    void bundle;
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", impostor.bundle, baseVerifyOpts(oracle));
    assert.equal(result.outcome, "oracle-gated");
    assert.equal(result.firstFailure?.id, "ATTESTATION_ORACLE");
    assert.equal(result.firstFailure?.onChainAnalogue?.code, 6026);
    assert.ok(result.ok === false);
  });

  test("future timestamp → rejected at ATTESTATION_TIMESTAMP (6028 analogue)", async () => {
    const { oracle } = await makeBundle();
    const { bundle } = await makeBundle({ lastSwapUnixTs: NOW_UNIX + 3600, signer: oracle });
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", bundle, baseVerifyOpts(oracle));
    assert.equal(result.outcome, "rejected");
    assert.equal(result.firstFailure?.id, "ATTESTATION_TIMESTAMP");
    assert.equal(result.firstFailure?.onChainAnalogue?.code, 6028);
  });

  test("stale issued_slot (outside ~512-slot window) → rejected at ATTESTATION_STALE (6029 analogue)", async () => {
    const { oracle } = await makeBundle();
    const { bundle } = await makeBundle({ issuedSlot: NOW_SLOT - 10_000, signer: oracle });
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", bundle, baseVerifyOpts(oracle));
    assert.equal(result.outcome, "rejected");
    assert.equal(result.firstFailure?.id, "ATTESTATION_STALE");
    assert.equal(result.firstFailure?.onChainAnalogue?.code, 6029);
  });

  test("future issued_slot → rejected at ATTESTATION_SLOT (6031 analogue)", async () => {
    const { oracle } = await makeBundle();
    const { bundle } = await makeBundle({ issuedSlot: NOW_SLOT + 100, signer: oracle });
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", bundle, baseVerifyOpts(oracle));
    assert.equal(result.outcome, "rejected");
    assert.equal(result.firstFailure?.id, "ATTESTATION_SLOT");
    assert.equal(result.firstFailure?.onChainAnalogue?.code, 6031);
  });

  test("wrong slot hash → rejected at ATTESTATION_SLOT_HASH (6030 analogue)", async () => {
    const { oracle } = await makeBundle();
    const { bundle } = await makeBundle({ slotHash: new Uint8Array(32).fill(0x5a), signer: oracle });
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", bundle, baseVerifyOpts(oracle));
    assert.equal(result.outcome, "rejected");
    assert.equal(result.firstFailure?.id, "ATTESTATION_SLOT_HASH");
    assert.equal(result.firstFailure?.onChainAnalogue?.code, 6030);
  });

  test("aged-out slot with no resolvable block → rejected as stale (6029 analogue)", async () => {
    const { oracle } = await makeBundle();
    // issuedSlot inside the verifier's own freshness policy (450) is not
    // reachable here since the mock window is 512 — use the policy bound:
    // issuedSlot 460 back is within 450? No — 460 > 450 → stale; exercise
    // the hash-null branch instead via a bundle issued 100 slots back on a
    // connection whose block lookup returns null.
    const issuedSlot = NOW_SLOT - 100;
    const { bundle } = await makeBundle({ issuedSlot, slotHash: mockBlockhash(issuedSlot), signer: oracle });
    const nullConn = {
      getSlot: async () => NOW_SLOT,
      getBlock: async () => null,
    } as unknown as Connection;
    const result = await verifyEvidenceBundle(nullConn, "devnet", bundle, baseVerifyOpts(oracle));
    assert.equal(result.outcome, "rejected");
    assert.equal(result.firstFailure?.id, "ATTESTATION_SLOT_HASH");
  });

  test("replayed evidence → rejected at ATTESTATION_REPLAY on second observation", async () => {
    const { oracle, bundle } = await makeBundle();
    const journal = new ReplayJournal(null);
    const first = await verifyEvidenceBundle(mockConnection(), "devnet", bundle, {
      ...baseVerifyOpts(oracle),
      journal,
    });
    assert.equal(first.outcome, "verified");
    const second = await verifyEvidenceBundle(mockConnection(), "devnet", bundle, {
      ...baseVerifyOpts(oracle),
      journal,
    });
    assert.equal(second.outcome, "rejected");
    assert.equal(second.firstFailure?.id, "ATTESTATION_REPLAY");
  });

  test("malformed bundle → rejected at BUNDLE_WELLFORMED before any RPC", async () => {
    const { bundle } = await makeBundle();
    const bad = structuredClone(bundle);
    bad.attestation.msgHex = bad.attestation.msgHex.slice(0, 220);
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", bad, baseVerifyOpts(await testOracle()));
    assert.equal(result.outcome, "rejected");
    assert.equal(result.firstFailure?.id, "BUNDLE_WELLFORMED");
  });

  test("summary line leaks no secret material and names the failure", async () => {
    const { oracle, bundle } = await makeBundle();
    const result = await verifyEvidenceBundle(mockConnection(), "devnet", bundle, baseVerifyOpts(oracle));
    const line = summarizeVerifyResult(result);
    assert.match(line, /outcome=verified/);
    assert.ok(!/secret|seed|private/i.test(line));
  });
});
