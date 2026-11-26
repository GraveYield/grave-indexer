// SPDX-License-Identifier: Apache-2.0
//
// rpcTransport — bounded retries, exponential backoff with jitter,
// Retry-After support, deadlines, typed exhaustion, secret-free errors,
// the provider-aware rate governor and bounded-concurrency mapping.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  RpcDeadlineExceededError,
  RpcRetryExhaustedError,
  backoffDelayMs,
  governed,
  governorInFlight,
  mapWithConcurrency,
  parseRetryAfter,
  resetGovernors,
  rpcJsonRequest,
} from "../src/rpcTransport.js";

/** Deterministic RNG (jitter = 0) and instant sleep. */
const rng = (): number => 0;
const sleep = (): Promise<void> => Promise.resolve();
const now = (): number => Date.now();

const T = { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 50, deadlineMs: 5_000, rng, sleep, now };

/** A Response with the given status/headers/body. */
function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

describe("rpcTransport — retry-aware request", () => {
  test("first-try success returns the parsed body with no retries", async () => {
    let calls = 0;
    const out = await rpcJsonRequest("https://api.mainnet-beta.solana.com", { x: 1 }, {
      ...T,
      fetchImpl: (async () => {
        calls++;
        return res(200, { jsonrpc: "2.0", id: 1, result: { ok: true } });
      }) as typeof fetch,
    });
    assert.equal(calls, 1);
    assert.deepEqual(out, { jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  test("HTTP 429 retries within the budget and then succeeds", async () => {
    const statuses: number[] = [];
    let calls = 0;
    const out = await rpcJsonRequest("https://api.mainnet-beta.solana.com", {}, {
      ...T,
      fetchImpl: (async () => {
        calls++;
        statuses.push(calls);
        return calls < 3 ? res(429, "rate limited") : res(200, { result: 42 });
      }) as typeof fetch,
    });
    assert.equal(calls, 3);
    assert.deepEqual(out, { result: 42 });
  });

  test("Retry-After is honored when shorter than the deadline", async () => {
    const delays: number[] = [];
    let calls = 0;
    await rpcJsonRequest("https://api.mainnet-beta.solana.com", {}, {
      ...T,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetchImpl: (async () => {
        calls++;
        return calls < 2 ? res(429, "", { "retry-after": "2" }) : res(200, {});
      }) as typeof fetch,
    });
    assert.deepEqual(delays, [2_000]);
  });

  test("budget exhaustion raises the TYPED RpcRetryExhaustedError (never a fake success)", async () => {
    let calls = 0;
    await assert.rejects(
      rpcJsonRequest("https://api.mainnet-beta.solana.com", {}, {
        ...T,
        fetchImpl: (async () => {
          calls++;
          return res(429, "");
        }) as typeof fetch,
      }),
      (err: unknown) => {
        assert.ok(err instanceof RpcRetryExhaustedError);
        assert.equal(err.attempts, 4);
        assert.equal(err.lastHttpStatus, 429);
        return true;
      },
    );
    assert.equal(calls, 4);
  });

  test("exhaustion on transport failure carries lastHttpStatus 0", async () => {
    await assert.rejects(
      rpcJsonRequest("https://api.mainnet-beta.solana.com", {}, {
        ...T,
        fetchImpl: (async () => {
          throw new Error("ECONNRESET");
        }) as typeof fetch,
      }),
      (err: unknown) => err instanceof RpcRetryExhaustedError && err.lastHttpStatus === 0,
    );
  });

  test("non-retryable HTTP status fails immediately (no retry burn)", async () => {
    let calls = 0;
    await assert.rejects(
      rpcJsonRequest("https://api.mainnet-beta.solana.com", {}, {
        ...T,
        fetchImpl: (async () => {
          calls++;
          return res(401, "unauthorized");
        }) as typeof fetch,
      }),
      /HTTP 401.*non-retryable/,
    );
    assert.equal(calls, 1);
  });

  test("an exhausted deadline raises the TYPED RpcDeadlineExceededError", async () => {
    let clock = 0;
    await assert.rejects(
      rpcJsonRequest("https://api.mainnet-beta.solana.com", {}, {
        ...T,
        deadlineMs: 100,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        fetchImpl: (async () => {
          clock += 150; // every attempt consumes the whole remaining budget
          return res(429, "");
        }) as typeof fetch,
      }),
      (err: unknown) => err instanceof RpcDeadlineExceededError && err.deadlineMs === 100,
    );
  });

  test("error messages never embed the URL (endpoint KIND only)", async () => {
    const secretUrl = "https://mainnet.helius-rpc.com/?api-key=SUPERSECRET";
    try {
      await rpcJsonRequest(secretUrl, {}, {
        ...T,
        fetchImpl: (async () => res(401, "")) as typeof fetch,
      });
      assert.fail("must throw");
    } catch (err) {
      const msg = String((err as Error).message);
      assert.ok(!msg.includes("SUPERSECRET"), "URL/credential leaked into the error");
      assert.ok(msg.includes("private-rpc"));
    }
  });

  test("backoff is exponential with full jitter and capped", () => {
    const rngHigh = (): number => 0.999999;
    assert.equal(backoffDelayMs(1, 100, 10_000, rng), 0);
    assert.ok(backoffDelayMs(1, 100, 10_000, rngHigh) <= 100);
    assert.ok(backoffDelayMs(2, 100, 10_000, rngHigh) <= 200);
    assert.ok(backoffDelayMs(5, 100, 10_000, rngHigh) <= 1_600);
    assert.ok(backoffDelayMs(9, 100, 10_000, rngHigh) <= 10_000); // cap holds
    assert.ok(backoffDelayMs(20, 100, 10_000, rngHigh) <= 10_000); // exponent clamped
  });

  test("parseRetryAfter handles delta-seconds and HTTP-date forms", () => {
    const t0 = 1_000_000;
    assert.equal(parseRetryAfter("3", t0), 3_000);
    assert.equal(parseRetryAfter(" 5 ", t0), 5_000);
    const future = new Date(t0 + 7_000).toUTCString();
    assert.equal(parseRetryAfter(future, t0), 7_000);
    assert.equal(parseRetryAfter("garbage", t0), null);
    assert.equal(parseRetryAfter(null, t0), null);
  });
});

describe("rpcTransport — rate governor + bounded concurrency", () => {
  test("governed enforces the min spacing between issuances", async () => {
    resetGovernors();
    let clock = 0;
    const ticks: number[] = [];
    for (let i = 0; i < 3; i++) {
      await governed("public-rpc", async () => {
        ticks.push(clock);
      }, { minIntervalMs: 100, maxInFlight: 8 }, () => clock, async (ms) => {
        clock += ms;
      });
    }
    assert.deepEqual(ticks, [0, 100, 200]);
    resetGovernors();
  });

  test("governed bounds simultaneous in-flight executions", async () => {
    resetGovernors();
    let inFlight = 0;
    let peak = 0;
    const jobs = Array.from({ length: 12 }, (_, i) =>
      governed("private-rpc", async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return i;
      }, { minIntervalMs: 0, maxInFlight: 3 }),
    );
    const out = await Promise.all(jobs);
    assert.equal(peak, 3);
    assert.equal(out.length, 12);
    assert.equal(governorInFlight("private-rpc"), 0, "slot leak after completion");
    resetGovernors();
  });

  test("a governed rejection releases its slot (no deadlock on failure)", async () => {
    resetGovernors();
    await assert.rejects(
      governed("private-rpc", async () => {
        throw new Error("boom");
      }, { minIntervalMs: 0, maxInFlight: 1 }),
      /boom/,
    );
    const out = await governed("private-rpc", async () => "recovered", { minIntervalMs: 0, maxInFlight: 1 });
    assert.equal(out, "recovered");
    assert.equal(governorInFlight("private-rpc"), 0);
    resetGovernors();
  });

  test("mapWithConcurrency preserves INPUT order regardless of completion order", async () => {
    const items = [30, 10, 50, 20, 40];
    const out = await mapWithConcurrency(items, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    assert.deepEqual(out, ["0:30", "1:10", "2:50", "3:20", "4:40"]);
  });

  test("mapWithConcurrency rejects a non-positive concurrency", async () => {
    await assert.rejects(mapWithConcurrency([1], 0, async (x) => x), /concurrency/);
  });
});
