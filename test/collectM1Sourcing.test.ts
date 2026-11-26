// SPDX-License-Identifier: Apache-2.0
//
// cmdCollect() integration — the D-01 M1 sourcing gate on the ACTUAL
// alternate ingestion path (GY-M1-ODR-001 §3).
//
// The predicate-level pins (test/m1Sourcing.test.ts, "collect-path
// ingestion gate") mirror the gate call but do not exercise the command;
// review finding: integration coverage for cmdCollect() itself. This
// suite runs the real cmdCollect through its injected connection seams
// (the same test/diagnostic-seam convention the Correction 002 suite
// uses) with deterministic fixtures — NO public RPC, no public-cluster
// operations, no key material beyond the ephemeral in-memory oracle.
//
// Pinned behaviors:
//   * an explicit --pool candidate whose freshly fetched identity has
//     WSOL on coin_mint is REJECTED by the gate — before activity
//     derivation, before any evidence work, with no bundle/attestation
//     and no destination-cluster contact;
//   * the ledger-candidate route is rejected identically (both alternate
//     routes are gated);
//   * the process continues safely to the other candidates;
//   * a correctly oriented identity (coin_mint non-WSOL, pc_mint WSOL)
//     PASSES the boundary and proceeds to the subsequent evidence checks;
//   * m1-sourcing health accounting records every attempted validation —
//     success on acceptance, failure on rejection — and a run with zero
//     candidates leaves the component degraded (never-reported is not ok;
//     completing the command is never mistaken for a healthy check).
//
// The reject fixture is the exact shape the review finding describes:
// WSOL on coin_mint/baseMint, a non-WSOL mint on pc_mint/quoteMint, in
// an otherwise canonical 752-byte Raydium V4 AmmInfo payload owned by
// Raydium V4 — so ONLY the sourcing orientation can reject it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";

import { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID, type PipelineConfig } from "../src/config.js";
import { cmdCollect } from "../src/cli.js";
import { buildAmmInfo, synth, WSOL_MINT } from "./fixtures.js";

const MEMECOIN = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** The M1-REJECTED orientation: WSOL on coin_mint (base side). */
function coinWsolPoolBytes(): Uint8Array {
  return buildAmmInfo({ baseMint: WSOL_MINT, quoteMint: MEMECOIN });
}

/** The M1-ELIGIBLE orientation: WSOL on pc_mint (quote side). */
function eligiblePoolBytes(): Uint8Array {
  return buildAmmInfo(); // baseMint = synthetic non-WSOL, quoteMint = WSOL
}

interface RecordedCall {
  method: string;
  args: string[];
}

/** Fake discovery/verification connection: serves pool accounts per
 *  address, records every method invocation. Never touches the network. */
class FakeConn {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly poolBytes: Map<string, Uint8Array>) {}

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args: args.map((a) => String(a)) });
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    this.record("getAccountInfo", [address.toBase58()]);
    const bytes = this.poolBytes.get(address.toBase58());
    if (bytes === undefined) return null;
    return {
      lamports: 1_000_000,
      data: Buffer.from(bytes),
      owner: RAYDIUM_V4_PROGRAM_ID,
      executable: false,
      rentEpoch: 0n,
    } as unknown as AccountInfo<Uint8Array>;
  }

  async getSignaturesForAddress(address: PublicKey, _opts?: { limit?: number }): Promise<never[]> {
    this.record("getSignaturesForAddress", [address.toBase58()]);
    return []; // deterministic no-swap-in-scan scan
  }

  async getTransaction(signature: string): Promise<null> {
    this.record("getTransaction", [signature]);
    return null;
  }

  async getSlot(_commitment?: unknown): Promise<bigint> {
    this.record("getSlot", []);
    return 1_000_000n;
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

function collectConfig(dataDir: string): PipelineConfig {
  return {
    discoveryRpcUrl: "http://discovery.invalid",
    discoveryCluster: "mainnet-beta",
    verificationRpcUrl: "http://verification.invalid",
    scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
    vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
    maxPoolsPerScan: 10,
    signatureScanLimit: 50,
    enrichConcurrency: 4,
    discoveryStalenessSlots: 400,
    evidenceFreshnessSlots: 450,
    dataDir,
    oracleKeyFile: null,
    oracleKeyEnv: null,
    oracleIsRegistered: false,
  };
}

function withTempDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "grave-indexer-m1-collect-"));
  return fn(dataDir).finally(() => rmSync(dataDir, { recursive: true, force: true }));
}

/** Write a minimal durable ledger with the given pool addresses (all
 *  entries non-conflicted, non-unsupported, fresh — the ledger route's
 *  candidate selection must accept them). */
function writeLedger(dataDir: string, pools: Array<{ address: string; seed: number }>): void {
  const now = 1_800_000_000_000;
  const lines = pools.map((p) =>
    JSON.stringify({
      poolAddress: p.address,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID.toBase58(),
      fingerprint: `ledger-${p.seed}`,
      fingerprintHistory: [],
      slotLowerBound: 999_000,
      slotUpperBound: 1_000_000,
      fetchedAtUnixMs: now,
      firstSeenAtMs: now,
      lastSeenAtMs: now,
      ingestCount: 1,
      conflicted: false,
      unsupported: false,
    }),
  );
  writeFileSync(join(dataDir, "ingest-ledger.jsonl"), lines.join("\n") + "\n", { encoding: "utf8" });
}

interface HealthFile {
  status: string;
  components: Array<{
    component: string;
    status: string;
    successes: number;
    failures: number;
    lastErrorName: string | null;
  }>;
}

function readHealth(dataDir: string): HealthFile {
  return JSON.parse(readFileSync(join(dataDir, "health-snapshot.json"), "utf8")) as HealthFile;
}

function m1Component(health: HealthFile): HealthFile["components"][number] {
  const c = health.components.find((x) => x.component === "m1-sourcing");
  assert.ok(c, "health snapshot carries the m1-sourcing component");
  return c!;
}

function evidenceFiles(dataDir: string): string[] {
  const dir = join(dataDir, "evidence");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("cmdCollect — D-01 M1 sourcing gate integration (review finding 1)", () => {
  test("explicit --pool route rejects a coin-WSOL identity: gate fires before activity derivation, nothing is issued", async () => {
    await withTempDataDir(async (dataDir) => {
      const pool = synth(0x41);
      // Valid Raydium V4 ownership + layout; ONLY the mint orientation is
      // M1-ineligible (WSOL on coin_mint, non-WSOL on pc_mint).
      const discovery = new FakeConn(new Map([[pool.toBase58(), coinWsolPoolBytes()]]));
      const devnet = new FakeConn(new Map());
      const code = await cmdCollect(collectConfig(dataDir), {
        pool: pool.toBase58(),
        useEphemeralOracle: true,
        discoveryConnection: discovery.asConnection(),
        verificationConnection: devnet.asConnection(),
      });

      assert.equal(code, 1, "collect reports no issuance for the rejected pool");
      assert.deepEqual(evidenceFiles(dataDir), [], "no evidence bundle was produced");
      assert.equal(devnet.calls.length, 0, "no destination-cluster contact: no attestation, no submission");

      // Rejection is IMMEDIATE: the fresh identity fetch happened (the
      // gate ran on fetched-and-decoded bytes), but no activity
      // derivation or any later evidence stage ever started.
      assert.equal(discovery.callsTo("getAccountInfo").length, 1, "exactly one fresh on-chain identity fetch");
      assert.equal(discovery.callsTo("getSignaturesForAddress").length, 0, "no activity derivation after the sourcing rejection");
      assert.equal(discovery.callsTo("getTransaction").length, 0, "no transaction inspection after the sourcing rejection");

      // The refusal is machine-checkable in the persisted health output.
      const m1 = m1Component(readHealth(dataDir));
      assert.equal(m1.failures, 1);
      assert.equal(m1.successes, 0);
      assert.ok(m1.lastErrorName?.includes("M1SourcingError"), `lastErrorName names the sourcing guard: ${m1.lastErrorName}`);
      assert.ok(m1.lastErrorName?.includes("wsol-on-coin-side"), `the exact rejection reason is recorded: ${m1.lastErrorName}`);
    });
  });

  test("ledger-candidate route rejects the same pool identically", async () => {
    await withTempDataDir(async (dataDir) => {
      const pool = synth(0x42);
      writeLedger(dataDir, [{ address: pool.toBase58(), seed: 0x42 }]);
      const discovery = new FakeConn(new Map([[pool.toBase58(), coinWsolPoolBytes()]]));
      const devnet = new FakeConn(new Map());
      const code = await cmdCollect(collectConfig(dataDir), {
        useEphemeralOracle: true,
        discoveryConnection: discovery.asConnection(),
        verificationConnection: devnet.asConnection(),
      });

      assert.equal(code, 1);
      assert.deepEqual(evidenceFiles(dataDir), [], "no evidence bundle from the ledger route either");
      assert.equal(devnet.calls.length, 0);
      assert.equal(discovery.callsTo("getAccountInfo").length, 1);
      assert.equal(discovery.callsTo("getSignaturesForAddress").length, 0, "the ledger route is gated at the same point");
      const m1 = m1Component(readHealth(dataDir));
      assert.equal(m1.failures, 1);
      assert.equal(m1.successes, 0);
      assert.ok(m1.lastErrorName?.includes("wsol-on-coin-side"));
    });
  });

  test("the process continues safely: a rejected candidate does not stop a following one", async () => {
    await withTempDataDir(async (dataDir) => {
      const rejected = synth(0x43); // coin-WSOL → gate refuses
      const eligible = synth(0x44); // pc-WSOL → gate accepts, proceeds
      writeLedger(dataDir, [
        { address: rejected.toBase58(), seed: 0x43 },
        { address: eligible.toBase58(), seed: 0x44 },
      ]);
      const discovery = new FakeConn(
        new Map([
          [rejected.toBase58(), coinWsolPoolBytes()],
          [eligible.toBase58(), eligiblePoolBytes()],
        ]),
      );
      const devnet = new FakeConn(new Map());
      const code = await cmdCollect(collectConfig(dataDir), {
        useEphemeralOracle: true,
        discoveryConnection: discovery.asConnection(),
        verificationConnection: devnet.asConnection(),
      });

      // Both identities were fetched; the second candidate was evaluated
      // after the first was rejected. (The eligible pool is fetched again
      // by the derivation's vault corroboration — per-address counts.)
      const fetched = discovery.callsTo("getAccountInfo").map((c) => c.args[0]);
      assert.ok(fetched.includes(rejected.toBase58()), "the rejected candidate's identity was fetched");
      assert.ok(fetched.includes(eligible.toBase58()), "the second candidate's identity was fetched after the rejection");

      // Activity derivation (the first post-gate evidence stage) ran ONLY
      // for the eligible pool — the rejected one never got that far.
      const scans = discovery.callsTo("getSignaturesForAddress");
      assert.deepEqual(scans.map((c) => c.args[0]), [eligible.toBase58()], "only the M1-eligible pool proceeds past the gate");

      // The eligible pool's deterministic no-swap scan is rejected by the
      // attestation evidence gate, so still nothing is issued anywhere.
      assert.equal(code, 1, "no bundle issued (no-swap evidence does not pass the attestation gate)");
      assert.deepEqual(evidenceFiles(dataDir), []);
      assert.equal(devnet.calls.length, 0);

      // Health counts represent the ATTEMPTED sourcing validations:
      // exactly one failure and one success across the two candidates.
      const m1 = m1Component(readHealth(dataDir));
      assert.equal(m1.failures, 1);
      assert.equal(m1.successes, 1);
    });
  });
});

describe("cmdCollect — M1 sourcing boundary passes a correctly oriented pool", () => {
  test("pc-WSOL identity passes the gate and proceeds to the subsequent evidence checks", async () => {
    await withTempDataDir(async (dataDir) => {
      const pool = synth(0x45);
      const discovery = new FakeConn(new Map([[pool.toBase58(), eligiblePoolBytes()]]));
      const devnet = new FakeConn(new Map());
      const code = await cmdCollect(collectConfig(dataDir), {
        pool: pool.toBase58(),
        useEphemeralOracle: true,
        discoveryConnection: discovery.asConnection(),
        verificationConnection: devnet.asConnection(),
      });

      // The gate PASSED (fresh identity: coin_mint non-WSOL, pc_mint WSOL)
      // and the pool reached the evidence checks: the last-swap derivation
      // ran against the discovery connection.
      assert.equal(discovery.callsTo("getAccountInfo").length >= 1, true, "identity fetched");
      assert.equal(discovery.callsTo("getSignaturesForAddress").length, 1, "activity derivation ran after the sourcing gate accepted");
      const scans = discovery.callsTo("getSignaturesForAddress");
      assert.equal(scans[0]!.args[0], pool.toBase58());

      // Sourcing health: the successful validation is recorded — failures
      // stay zero, so the output does not remain degraded (review finding 2).
      const m1 = m1Component(readHealth(dataDir));
      assert.equal(m1.successes, 1);
      assert.equal(m1.failures, 0);
      assert.equal(m1.status, "ok");

      // The deterministic no-swap scan cannot support an attestation, so
      // no bundle is issued and the destination cluster is never touched.
      assert.equal(code, 1);
      assert.deepEqual(evidenceFiles(dataDir), []);
      assert.equal(devnet.calls.length, 0);
    });
  });
});

describe("cmdCollect — m1-sourcing health with zero validation attempts (review finding 2)", () => {
  test("no candidates: nothing is recorded, the component stays degraded (not ok)", async () => {
    await withTempDataDir(async (dataDir) => {
      // No --pool, no ledger file: zero candidates, zero attempts.
      const discovery = new FakeConn(new Map());
      const devnet = new FakeConn(new Map());
      const code = await cmdCollect(collectConfig(dataDir), {
        useEphemeralOracle: true,
        discoveryConnection: discovery.asConnection(),
        verificationConnection: devnet.asConnection(),
      });

      assert.equal(code, 1, "nothing issued");
      assert.equal(discovery.calls.length, 0, "no discovery-cluster contact without candidates");
      assert.equal(devnet.calls.length, 0);

      // Health reflects ACTUAL validation outcomes: zero attempts means
      // zero successes and zero failures — and the component is NOT ok.
      // Completing the command must never mark sourcing healthy.
      const health = readHealth(dataDir);
      const m1 = m1Component(health);
      assert.equal(m1.successes, 0);
      assert.equal(m1.failures, 0);
      assert.equal(m1.status, "degraded", "a never-attempted component is degraded, not ok");
      assert.equal(health.status, "degraded", "the run does not present as fully healthy");
    });
  });
});
