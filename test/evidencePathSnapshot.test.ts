// SPDX-License-Identifier: Apache-2.0
//
// Evidence-path verifier regression battery — Workstream C PR #7 review
// findings, mock-only, no real cluster access, no transactions, no faucet:
//
//   1. SAME-SNAPSHOT guarantee (Finding 1, Medium): the verifier-level
//      harness must fetch + validate the canonical SlotHashes sysvar
//      EXACTLY ONCE per run; the recent (slot, hash) issuance pair AND
//      every resolver lookup must derive from that single in-memory
//      snapshot. The mock serves a divergent snapshot B on any second
//      fetch — so a two-fetch implementation (issuance from snapshot A,
//      verification against snapshot B) fails both the fetch-count and
//      the canonical-verification assertions.
//   2. Initial RPC-failure classification (Finding 2, Low): a genuine RPC
//      failure on the initial snapshot fetch is reported as an explicit
//      INDETERMINATE infrastructure failure — never as stale evidence,
//      never as a skip-as-pass, never swallowed. Missing and structurally
//      invalid sysvar data stay explicit fail-closed skips.
//
// The mock is the same RPC-boundary pattern as deploymentState.test.ts:
// getAccountInfo / getBalance / requestAirdrop / getSlot only. The
// ProtocolConfig bytes are the byte-exact SDK borsh layout.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import {
  AccountDisc,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
  SYSVAR_PROGRAM_ID,
} from "@graveyield/sdk";

import {
  DEVNET_SCANNER_PROGRAM_ID,
  DEVNET_VAULT_PROGRAM_ID,
  NS3_GOVERNANCE_AUTHORITY,
} from "../src/config.js";
import { BPF_UPGRADEABLE_LOADER_PROGRAM_ID } from "../src/deploymentState.js";
import { runEvidencePathVerification } from "../src/evidencePath.js";
import { publicKeyFingerprint, type OracleSigner } from "../src/sign.js";

const SCANNER = DEVNET_SCANNER_PROGRAM_ID;
const VAULT = DEVNET_VAULT_PROGRAM_ID;
const LOADER = new PublicKey(BPF_UPGRADEABLE_LOADER_PROGRAM_ID);
const GOVERNANCE = new PublicKey(NS3_GOVERNANCE_AUTHORITY);

// ---------------------------------------------------------------- mocks

interface MockAccount {
  owner: PublicKey;
  executable: boolean;
  data: Uint8Array;
}

interface MockState {
  accounts: Map<string, MockAccount>;
  /** Number of getAccountInfo calls against the SlotHashes sysvar. */
  slotHashFetches: number;
  /** The sysvar account as the cluster serves it (null → absent). */
  slotHashesAccount: MockAccount | null;
  /** When set, the sysvar fetch throws (genuine RPC failure). */
  slotHashesError: Error | null;
  /** When set, served INSTEAD of `slotHashesAccount` from the second
   *  sysvar fetch on — the divergent-snapshot discriminator. */
  divergentSecondSnapshot: MockAccount | null;
  getBlockCalls: number;
}

/**
 * A SlotHashes sysvar body: u64 LE count + count × (u64 slot, 32-byte
 * hash) entries newest-first. The hash bytes are deterministic per
 * (tag, slot) so snapshots A and B are trivially distinguishable.
 */
function slotHashesData(opts: { count: number; newestSlot: number; tag: number }): MockAccount {
  const buf = Buffer.alloc(8 + opts.count * 40);
  buf.writeBigUInt64LE(BigInt(opts.count), 0);
  for (let i = 0; i < opts.count; i++) {
    const base = 8 + i * 40;
    const slot = opts.newestSlot - i;
    buf.writeBigUInt64LE(BigInt(slot), base);
    for (let j = 0; j < 32; j++) buf[base + 8 + j] = (opts.tag + slot * 7 + j * 31) & 0xff;
  }
  return { owner: SYSVAR_PROGRAM_ID, executable: false, data: new Uint8Array(buf) };
}

/** Snapshot A — the ONLY snapshot the harness is allowed to consult. */
function snapshotA(): MockAccount {
  return slotHashesData({ count: 8, newestSlot: 1_000_000, tag: 0x10 });
}

/**
 * Snapshot B — a DIVERGENT snapshot (different window: newest slot
 * 900_000, so the issued slot 1_000_000 is absent entirely, and every
 * hash byte differs). Served from the second sysvar fetch on; any
 * implementation that fetches twice resolves the evidence pair from a
 * DIFFERENT snapshot than verification and fails the battery.
 */
function snapshotB(): MockAccount {
  return slotHashesData({ count: 4, newestSlot: 900_000, tag: 0xc0 });
}

function mockRpc(state: MockState): Connection {
  return {
    async getAccountInfo(addr: PublicKey) {
      if (addr.equals(SYSVAR_SLOT_HASHES_PUBKEY)) {
        state.slotHashFetches++;
        if (state.slotHashesError) throw state.slotHashesError;
        if (state.slotHashFetches >= 2 && state.divergentSecondSnapshot) {
          return state.divergentSecondSnapshot;
        }
        return state.slotHashesAccount;
      }
      return state.accounts.get(addr.toBase58()) ?? null;
    },
    async getBalance(addr: PublicKey) {
      void addr;
      return 0; // unfunded → program-level batch skips (read-only run)
    },
    async requestAirdrop() {
      throw new Error("airdrop refused: tests must not mutate external state");
    },
    async getSlot() {
      return 1_000_000;
    },
    async getBlock() {
      state.getBlockCalls++;
      return { blockhash: "11111111111111111111111111111111" };
    },
  } as unknown as Connection;
}

function freshState(opts: { slotHashes?: MockAccount | null } = {}): MockState {
  return {
    accounts: new Map(),
    slotHashFetches: 0,
    slotHashesAccount: opts.slotHashes !== undefined ? opts.slotHashes : snapshotA(),
    slotHashesError: null,
    divergentSecondSnapshot: null,
    getBlockCalls: 0,
  };
}

// ------------------------------------------------- synthetic accounts

/** A minimal stand-in for a deployed BPF program account. */
function programAccount(): MockAccount {
  return { owner: LOADER, executable: true, data: new Uint8Array(64).fill(0x7f) };
}

/**
 * Byte-exact GraveScanner ProtocolConfig (188 bytes) per the SDK borsh
 * layout (same builder as deploymentState.test.ts), with the ORACLE
 * fields pointed at the caller's fixed oracle so the canonical
 * verifier-level case resolves its final gate.
 */
function scannerConfigAccount(opts: {
  authority: PublicKey;
  activityOracle: PublicKey;
  launchPriceOracle: PublicKey;
}): MockAccount {
  const buf = Buffer.alloc(188);
  Buffer.from(AccountDisc.ProtocolConfig).copy(buf, 0);
  Buffer.from(opts.authority.toBytes()).copy(buf, 8);
  Buffer.from(opts.authority.toBytes()).copy(buf, 40); // pendingAuthority
  buf.writeBigInt64LE(0n, 72);
  buf.writeBigUInt64LE(7_776_000n, 80);
  buf.writeUInt16LE(9_900, 88);
  buf.writeBigUInt64LE(500_000_000n, 90);
  buf.writeBigUInt64LE(1_209_600n, 98);
  buf.writeBigUInt64LE(1_000n, 106);
  buf.writeBigInt64LE(3_600n, 114);
  buf.writeUInt8(0, 122); // paused = false
  Buffer.from(opts.activityOracle.toBytes()).copy(buf, 123);
  Buffer.from(opts.launchPriceOracle.toBytes()).copy(buf, 155);
  buf.writeUInt8(255, 187);
  return { owner: SCANNER, executable: false, data: new Uint8Array(buf) };
}

/** Byte-exact GraveVault ProtocolConfig (114 bytes), governance authority. */
function vaultConfigAccount(opts: { authority: PublicKey }): MockAccount {
  const buf = Buffer.alloc(114);
  Buffer.from(AccountDisc.ProtocolConfig).copy(buf, 0);
  Buffer.from(opts.authority.toBytes()).copy(buf, 8);
  Buffer.from(opts.authority.toBytes()).copy(buf, 40);
  buf.writeBigInt64LE(0n, 72);
  buf.writeUInt16LE(4_000, 80);
  buf.writeUInt16LE(4_000, 82);
  buf.writeUInt16LE(2_000, 84);
  buf.writeBigUInt64LE(1_000_000_000n, 86);
  buf.writeUInt16LE(300, 94);
  buf.writeBigUInt64LE(666_666n, 96);
  buf.writeBigInt64LE(259_200n, 104);
  buf.writeUInt8(0, 112);
  buf.writeUInt8(255, 113);
  return { owner: VAULT, executable: false, data: new Uint8Array(buf) };
}

/** Install a fully deployed + initialized two-program NS-3 world whose
 *  configured activity oracle IS the run's fixed oracle. */
function installReadyWorld(state: MockState, oraclePk: PublicKey): void {
  state.accounts.set(SCANNER.toBase58(), programAccount());
  state.accounts.set(VAULT.toBase58(), programAccount());
  state.accounts.set(
    scannerProtocolConfigPda(SCANNER).toBase58(),
    scannerConfigAccount({
      authority: GOVERNANCE,
      activityOracle: oraclePk,
      launchPriceOracle: oraclePk,
    }),
  );
  state.accounts.set(
    vaultProtocolConfigPda(VAULT).toBase58(),
    vaultConfigAccount({ authority: GOVERNANCE }),
  );
}

async function fixedOracleSigner(): Promise<OracleSigner> {
  const keypair = await Keypair.generate();
  return {
    keypair,
    publicKey: keypair.publicKey,
    fingerprint: publicKeyFingerprint(keypair.publicKey),
  };
}

const RUN_OPTS_BASE = {
  cluster: "devnet" as const,
  scannerProgramId: SCANNER,
  vaultProgramId: VAULT,
  nowUnixSeconds: 1_760_000_000,
};

// ---------------------------------------------------------------- tests

describe("same-snapshot guarantee (PR #7 Finding 1)", () => {
  test("the verifier-level run fetches the SlotHashes sysvar EXACTLY ONCE and verifies entirely against that snapshot", async () => {
    const state = freshState();
    state.divergentSecondSnapshot = snapshotB(); // served from fetch #2 on
    // Pin ONE fixed oracle for the run; the deployed world's configured
    // activity oracle IS that oracle, so the canonical case's final gate
    // is satisfied and verification runs to the SlotHashes check.
    const oracle = await fixedOracleSigner();
    installReadyWorld(state, oracle.publicKey);

    const rpc = mockRpc(state);
    const report = await runEvidencePathVerification({
      ...RUN_OPTS_BASE,
      connection: rpc,
      oracle,
    });

    // Core assertion: exactly ONE SlotHashes sysvar fetch for the whole
    // verifier-level run — snapshot B was never served, so a second
    // fetch is impossible to hide.
    assert.equal(
      state.slotHashFetches,
      1,
      "the verifier-level run must fetch the canonical SlotHashes sysvar exactly once",
    );

    // Behavioral discriminator: the canonical bundle was issued from
    // snapshot A's newest entry; the canonical case can only VERIFY (all
    // checks pass, outcome "verified") if every resolver lookup returned
    // exactly snapshot A's hashes. Against snapshot B (window without
    // the issued slot) the ATTESTATION_SLOT_HASH check would fail.
    const verifierCases = report.cases.filter((c) => c.layer === "verifier-live");
    assert.equal(verifierCases.length, 6);
    assert.ok(verifierCases.every((c) => !c.skipped), "verifier cases must run, not skip");
    const canonical = verifierCases.find((c) => c.caseId === "canonical-bundle-verifier")!;
    assert.ok(
      canonical.pass,
      `canonical bundle must verify against the single snapshot A (outcome ${canonical.observed.note ?? ""})`,
    );

    // The full matrix behaves normally on that single snapshot: every
    // mutation case still fails at its own isolated check.
    assert.ok(
      verifierCases.every((c) => c.pass),
      `all verifier cases must pass: ${JSON.stringify(verifierCases.filter((c) => !c.pass), null, 1)}`,
    );

    // The harness never regressed to a getBlock-based mirror.
    assert.equal(state.getBlockCalls, 0, "getBlock must never be called by the harness");

    // Nothing else failed in the report (program-level batch skips on
    // the unfunded payer — read-only run).
    assert.equal(report.allPass, true);
  });

  test("mock sanity: a second sysvar fetch WOULD be discriminated (the discriminator is live)", async () => {
    const state = freshState();
    state.divergentSecondSnapshot = snapshotB();
    const rpc = mockRpc(state);
    const first = await rpc.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY);
    const second = await rpc.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY);
    assert.ok(first && second, "mock serves the sysvar account");
    assert.notDeepEqual(
      Buffer.from(first!.data).subarray(0, 48).toString("hex"),
      Buffer.from(second!.data).subarray(0, 48).toString("hex"),
      "the divergent second snapshot must genuinely differ (count + newest entry)",
    );
    assert.equal(state.slotHashFetches, 2);
  });
});

describe("initial snapshot-failure classification (PR #7 Finding 2)", () => {
  test("missing sysvar account → explicit fail-closed SKIPPED cases (never an RPC-failure claim)", async () => {
    const state = freshState({ slotHashes: null }); // sysvar absent
    const rpc = mockRpc(state);
    const report = await runEvidencePathVerification({ ...RUN_OPTS_BASE, connection: rpc });

    const verifierCases = report.cases.filter((c) => c.layer === "verifier-live");
    assert.equal(verifierCases.length, 6);
    assert.ok(
      verifierCases.every((c) => c.skipped === true && c.pass === true),
      "every verifier case needing a valid pair must be an explicit skip",
    );
    for (const c of verifierCases) {
      assert.match(c.description, /SKIPPED/);
      assert.match(c.description, /SlotHashes sysvar account not found/);
      assert.match(c.observed.note ?? "", /not found/);
      assert.doesNotMatch(c.description, /RPC failure/);
    }
    assert.equal(state.slotHashFetches, 1, "a single fetch decides the whole run");
    assert.equal(report.allPass, true, "a fail-closed skip is not a failure");
  });

  test("structurally invalid sysvar account → explicit fail-closed SKIPPED cases carrying the parser detail", async () => {
    const bad = snapshotA();
    // Corrupt: header claims 8 entries but only 3 are serialized — the
    // SDK parser rejects the length mismatch with structured detail.
    const truncated = new Uint8Array(8 + 3 * 40);
    truncated.set(bad.data.subarray(0, truncated.length));
    const state = freshState({ slotHashes: { owner: SYSVAR_PROGRAM_ID, executable: false, data: truncated } });
    const rpc = mockRpc(state);
    const report = await runEvidencePathVerification({ ...RUN_OPTS_BASE, connection: rpc });

    const verifierCases = report.cases.filter((c) => c.layer === "verifier-live");
    assert.equal(verifierCases.length, 6);
    assert.ok(
      verifierCases.every((c) => c.skipped === true && c.pass === true),
      "every verifier case needing a valid pair must be an explicit skip",
    );
    for (const c of verifierCases) {
      assert.match(c.description, /SKIPPED/);
      assert.match(c.description, /structurally invalid/);
      assert.match(c.observed.note ?? "", /serialized length/, "the SDK parser's structured detail is surfaced");
      assert.doesNotMatch(c.description, /RPC failure/);
    }
    assert.equal(state.slotHashFetches, 1);
    assert.equal(report.allPass, true);
  });

  test("genuine RPC failure on the initial fetch → explicit INDETERMINATE infrastructure failure (resolves, never stale evidence, never skip-as-pass, never swallowed)", async () => {
    const state = freshState();
    state.slotHashesError = new Error("mock: connection reset by peer");
    const rpc = mockRpc(state);

    // The run must RESOLVE into a structured report — the RPC error is
    // classified, not thrown out of the case runner.
    const report = await runEvidencePathVerification({ ...RUN_OPTS_BASE, connection: rpc });

    const verifierCases = report.cases.filter((c) => c.layer === "verifier-live");
    assert.equal(verifierCases.length, 6);
    for (const c of verifierCases) {
      assert.notEqual(c.skipped, true, "an RPC outage is NOT a skip-as-pass");
      assert.equal(c.pass, false, "an RPC outage is an explicit failure, not a PASS");
      assert.match(c.description, /INDETERMINATE/);
      assert.match(c.description, /RPC failure/);
      assert.match(c.description, /not a stale-evidence rejection/);
      assert.match(c.observed.note ?? "", /connection reset by peer/, "the genuine error message is carried");
    }
    assert.equal(report.allPass, false, "the smoke run fails loudly on an RPC outage");
    assert.equal(state.getBlockCalls, 0, "an RPC outage never falls back to getBlock");
  });
});
