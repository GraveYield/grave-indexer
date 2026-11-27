// SPDX-License-Identifier: Apache-2.0
//
// governedConnection — the SDK activity derivation's signature/transaction
// retrieval runs under the SAME process-global rate governor as discovery
// and enrichment (Option 2, Part 2 item 3).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { governedConnection } from "../src/governedConnection.js";
import { governorInFlight, resetGovernors } from "../src/rpcTransport.js";

interface FakeConn {
  getSignaturesForAddress(a: string, o?: { limit?: number }): Promise<string[]>;
  getTransaction(s: string): Promise<{ sig: string } | null>;
  rpcEndpoint: string;
  notGoverned(): string;
}

function fakeConn(): FakeConn {
  return {
    async getSignaturesForAddress(a: string, o?: { limit?: number }) {
      return [`sig-for-${a}-limit-${o?.limit ?? "none"}`];
    },
    async getTransaction(s: string) {
      if (s === "boom") throw new Error("tx fetch failed");
      return { sig: s };
    },
    rpcEndpoint: "https://mainnet.helius-rpc.com",
    notGoverned() {
      return "passthrough";
    },
  };
}

const asConn = (f: FakeConn): never => f as never;

describe("governedConnection", () => {
  test("governed methods forward calls and results verbatim", async () => {
    resetGovernors();
    const fake = fakeConn();
    const conn = governedConnection(asConn(fake), "private-rpc");
    assert.deepEqual(await conn.getSignaturesForAddress("abc" as never, { limit: 5 } as never), [
      "sig-for-abc-limit-5",
    ]);
    assert.deepEqual(await conn.getTransaction("xyz" as never), { sig: "xyz" });
    assert.equal((conn as unknown as FakeConn).rpcEndpoint, "https://mainnet.helius-rpc.com");
    assert.equal((conn as unknown as FakeConn).notGoverned(), "passthrough", "non-RPC surface is untouched");
  });

  test("rejections propagate and the governor slot is ALWAYS released", async () => {
    resetGovernors();
    const fake = fakeConn();
    const conn = governedConnection(asConn(fake), "private-rpc");
    await assert.rejects(conn.getTransaction("boom" as never), /tx fetch failed/);
    assert.equal(governorInFlight("private-rpc"), 0, "no slot leak on failure");
  });

  test("spacing between issuances is enforced through the governor (deterministic clock)", async () => {
    resetGovernors();
    let clock = 1_000_000;
    const slept: number[] = [];
    const fake = fakeConn();
    const conn = governedConnection(asConn(fake), "private-rpc", {
      minIntervalMs: 100,
      maxInFlight: 4,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await conn.getSignaturesForAddress("a" as never);
    await conn.getTransaction("b" as never);
    await conn.getSignaturesForAddress("c" as never);
    assert.deepEqual(slept, [100, 100], "each subsequent issuance waits the min spacing");
    assert.equal(governorInFlight("private-rpc"), 0);
  });

  test("non-intercepted methods are NOT governed (documented explicit coverage)", async () => {
    resetGovernors();
    const fake = fakeConn();
    const conn = governedConnection(asConn(fake), "private-rpc", { minIntervalMs: 100 });
    // `notGoverned` is outside the intercepted set — callable without any
    // governor accounting.
    assert.equal((conn as unknown as FakeConn).notGoverned(), "passthrough");
    assert.equal(governorInFlight("private-rpc"), 0);
  });
});
