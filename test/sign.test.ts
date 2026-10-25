// SPDX-License-Identifier: Apache-2.0
//
// Signing tests — seed handling, Ed25519 sign/verify, tamper detection,
// unauthorized-key rejection, and key-file parsing (no secret material
// is ever logged by these paths; the seeds below are public test bytes).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { buildEvidenceMessage } from "../src/evidence.js";
import {
  generateDisposableOracleSigner,
  oracleSignerFromSeed,
  publicKeyFingerprint,
  resolveOracleSigner,
  signAttestationMessage,
  verifyAttestationSignature,
} from "../src/sign.js";
import { parseOracleSeedFromFilePayload, parseOracleSeedFromEnv } from "../src/config.js";
import { synth, testOracle } from "./fixtures.js";

const AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

describe("oracle signing", () => {
  test("32-byte seed derives a stable signer; signatures verify", async () => {
    const seed = new Uint8Array(32).fill(0x2a);
    const a = await oracleSignerFromSeed(seed);
    const b = await oracleSignerFromSeed(seed);
    assert.equal(a.publicKey.toBase58(), b.publicKey.toBase58(), "deterministic derivation");

    const msg = buildEvidenceMessage({
      ammProgramId: AMM,
      poolAddress: synth(0xa1),
      lastSwapUnixTs: 1_700_000_000,
      issuedSlot: 5_000_000,
      slotHash: new Uint8Array(32).fill(7),
    });
    const sig = signAttestationMessage(a, msg);
    assert.equal(sig.length, 64);
    assert.ok(verifyAttestationSignature(sig, msg, a.publicKey.toBytes()));
  });

  test("tampered message or signature fails verification", async () => {
    const oracle = await testOracle();
    const msg = buildEvidenceMessage({
      ammProgramId: AMM,
      poolAddress: synth(0xa1),
      lastSwapUnixTs: 1_700_000_000,
      issuedSlot: 5_000_000,
      slotHash: new Uint8Array(32).fill(7),
    });
    const sig = signAttestationMessage(oracle, msg);

    const tamperedMsg = Uint8Array.from(msg);
    tamperedMsg[64] = (tamperedMsg[64]! + 1) & 0xff; // flip timestamp byte
    assert.ok(!verifyAttestationSignature(sig, tamperedMsg, oracle.publicKey.toBytes()));

    const tamperedSig = Uint8Array.from(sig);
    tamperedSig[0] = (tamperedSig[0]! + 1) & 0xff;
    assert.ok(!verifyAttestationSignature(tamperedSig, msg, oracle.publicKey.toBytes()));

    // A different (unauthorized) key's signature over the same message is
    // valid Ed25519 — but bound to the WRONG public key, which is what the
    // on-chain oracle check (6026) rejects.
    const intruder = await generateDisposableOracleSigner();
    const intruderSig = signAttestationMessage(intruder, msg);
    assert.ok(verifyAttestationSignature(intruderSig, msg, intruder.publicKey.toBytes()));
    assert.ok(!verifyAttestationSignature(intruderSig, msg, oracle.publicKey.toBytes()));
  });

  test("refuses to sign anything but the canonical 112-byte message", async () => {
    const oracle = await testOracle();
    assert.throws(() => signAttestationMessage(oracle, new Uint8Array(111)), /112/);
    assert.throws(() => signAttestationMessage(oracle, new Uint8Array(113)), /112/);
  });

  test("seed parsers: key files (32/64-byte JSON) and base58 env", async () => {
    const seed = new Uint8Array(32).fill(0x5e);
    const seedB58 = bs58.encode(seed);
    assert.deepEqual(parseOracleSeedFromFilePayload(JSON.stringify([...seed])), seed, "32-byte array");
    const padded64 = [...seed, ...new Uint8Array(32).fill(9)];
    assert.deepEqual(parseOracleSeedFromFilePayload(JSON.stringify(padded64)), seed, "64-byte array → seed half");
    assert.deepEqual(
      parseOracleSeedFromFilePayload(JSON.stringify({ seed_base58: seedB58 })),
      seed,
      "seed_base58 object",
    );
    assert.deepEqual(parseOracleSeedFromEnv(seedB58), seed, "env base58 seed");
    assert.throws(() => parseOracleSeedFromFilePayload("[1,2,3]"), /32|64/);
    assert.throws(() => parseOracleSeedFromFilePayload("{}"), /not recognized/);
    assert.throws(() => parseOracleSeedFromEnv("abc"), /32/);
  });

  test("resolveOracleSigner throws (fails closed) without key material and never echoes it", async () => {
    const savedFile = process.env.ORACLE_KEY_FILE;
    const savedEnv = process.env.ACTIVITY_ORACLE_KEY;
    delete process.env.ORACLE_KEY_FILE;
    delete process.env.ACTIVITY_ORACLE_KEY;
    try {
      await assert.rejects(() => resolveOracleSigner(), /no oracle key material/);
    } finally {
      if (savedFile !== undefined) process.env.ORACLE_KEY_FILE = savedFile;
      if (savedEnv !== undefined) process.env.ACTIVITY_ORACLE_KEY = savedEnv;
    }
  });

  test("public fingerprints leak no key material", async () => {
    const oracle = await testOracle();
    const fp = publicKeyFingerprint(oracle.publicKey);
    assert.ok(fp.length < 32, "short fingerprint");
    assert.ok(fp.includes("…"), "truncation marker present");
  });
});
