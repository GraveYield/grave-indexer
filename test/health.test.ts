// SPDX-License-Identifier: Apache-2.0
//
// Health registry tests — stage transitions (ok/degraded/failing),
// silence-based degradation, bounded error history, snapshot safety.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry } from "../src/health.js";

describe("health registry", () => {
  test("a component that never reported is degraded, not ok", () => {
    const h = new HealthRegistry();
    const snap = h.snapshot();
    assert.equal(snap.status, "degraded");
    assert.ok(snap.components.every((c) => c.status === "degraded"));
  });

  test("success marks ok; a failure degrades; three consecutive failures escalate", () => {
    const h = new HealthRegistry({ failureThreshold: 3 });
    h.recordSuccess("discovery", 10, 1000);
    assert.equal(h.snapshot(1000).components.find((c) => c.component === "discovery")?.status, "ok");

    h.recordFailure("discovery", new Error("rpc 429"), 2000);
    assert.equal(h.snapshot(2000).components.find((c) => c.component === "discovery")?.status, "degraded");

    h.recordFailure("discovery", new Error("rpc 429"), 3000);
    h.recordFailure("discovery", new Error("rpc 429"), 4000);
    const after = h.snapshot(4000);
    assert.equal(after.status, "failing");
    const discovery = after.components.find((c) => c.component === "discovery");
    assert.equal(discovery?.status, "failing");
    assert.equal(discovery?.consecutiveFailures, 3);
  });

  test("success resets the consecutive-failure counter", () => {
    const h = new HealthRegistry({ failureThreshold: 3 });
    h.recordFailure("activity", new Error("x"), 1000);
    h.recordFailure("activity", new Error("x"), 1100);
    h.recordSuccess("activity", 5, 1200);
    h.recordFailure("activity", new Error("x"), 1300);
    const activity = h.snapshot(1300).components.find((c) => c.component === "activity");
    assert.equal(activity?.status, "degraded", "counter reset by the success");
    assert.equal(activity?.consecutiveFailures, 1);
  });

  test("silence degrades an otherwise-ok component", () => {
    const h = new HealthRegistry({ maxSilenceMs: 1000 });
    h.recordSuccess("verifier", 3, 1000);
    assert.equal(h.snapshot(1500).components.find((c) => c.component === "verifier")?.status, "ok");
    assert.equal(h.snapshot(3000).components.find((c) => c.component === "verifier")?.status, "degraded");
  });

  test("recent error history is bounded at 10, most recent first", () => {
    const h = new HealthRegistry();
    for (let i = 0; i < 15; i++) h.recordFailure("journal", new Error(`e${i}`), 1000 + i);
    const journal = h.snapshot(2000).components.find((c) => c.component === "journal");
    assert.equal(journal?.recentErrors.length, 10);
    assert.equal(journal?.recentErrors[0], "Error: e14");
  });

  test("snapshot serialization is secret-safe by construction", () => {
    const h = new HealthRegistry();
    h.recordFailure("evidence", new Error("boom"), 1000);
    const json = JSON.stringify(h.snapshot(1000));
    assert.ok(!/secret|seed|private|key/i.test(json), "no key material in health output");
  });
});
