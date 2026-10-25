// SPDX-License-Identifier: Apache-2.0
//
// Provenance tests — fingerprints, endpoint redaction, freshness policy.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  accountFingerprint,
  endpointKindFor,
  isProvenanceFresh,
  provenanceAgeSlots,
  sha256Hex,
  type Provenance,
} from "../src/provenance.js";
import { synth } from "./fixtures.js";

const baseProvenance: Provenance = {
  source: "raydium-v4-gpa",
  cluster: "mainnet-beta",
  endpointKind: "public-rpc",
  slot: 5_000_000,
  fetchedAtUnixMs: 1_760_000_000_000,
  accountSha256: "aa".repeat(32),
};

describe("provenance", () => {
  test("sha256Hex is deterministic and length-correct", () => {
    assert.equal(sha256Hex(new Uint8Array([1, 2, 3])), sha256Hex(new Uint8Array([1, 2, 3])));
    assert.equal(sha256Hex(new Uint8Array([1, 2, 3])).length, 64);
    assert.notEqual(sha256Hex(new Uint8Array([1, 2, 3])), sha256Hex(new Uint8Array([1, 2, 4])));
  });

  test("accountFingerprint binds address AND payload (collision of identical payloads across pools is impossible)", () => {
    const addrA = synth(0x01);
    const addrB = synth(0x02);
    const payload = new Uint8Array(752);
    assert.notEqual(accountFingerprint(addrA, payload), accountFingerprint(addrB, payload));
    assert.equal(accountFingerprint(addrA, payload), accountFingerprint(addrA, payload));
    assert.notEqual(
      accountFingerprint(addrA, payload),
      accountFingerprint(addrA, Uint8Array.from(payload).fill(1)),
    );
  });

  test("endpoint classification REDACTS URLs to kinds (no API keys in evidence)", () => {
    assert.equal(endpointKindFor("https://api.mainnet-beta.solana.com"), "public-rpc");
    assert.equal(endpointKindFor("https://api.devnet.solana.com"), "public-rpc");
    assert.equal(endpointKindFor("https://solana-mainnet.g.alchemy.com/v2/APIKEY123"), "private-rpc");
    assert.equal(endpointKindFor("https://my-helius-endpoint.helius-rpc.com/?api-key=xyz"), "private-rpc");
  });

  test("freshness policy: age in slots, rewind treated as infinitely stale", () => {
    assert.equal(provenanceAgeSlots(baseProvenance, 5_000_100), 100);
    assert.equal(provenanceAgeSlots(baseProvenance, 5_000_000), 0);
    assert.equal(provenanceAgeSlots(baseProvenance, 4_999_000), Number.MAX_SAFE_INTEGER);
    assert.ok(isProvenanceFresh(baseProvenance, 5_000_400, 400));
    assert.ok(!isProvenanceFresh(baseProvenance, 5_000_401, 400));
  });
});
