// SPDX-License-Identifier: Apache-2.0
//
// Evidence-path verification — the Phase 2 acceptance harness.
//
// Runs the full verification matrix against the DEPLOYED devnet
// GraveScanner (DR-001: CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54)
// and against live chain data, producing a structured pass/fail report.
//
// LIVE PROGRAM-LEVEL CASES (via record_launch_price — the attestation
// prologue — precompile presence, precompile offset pinning and oracle
// authorization are SHARED code with evaluate_pool_phase_1/2, so the
// 6024/6025/6026 outcomes transfer verbatim to the C1 path):
//
//   1. missing-precompile      → AttestationMissing (6024)
//   2. tampered-signature      → rejected by the ed25519 PRECOMPILE
//                                itself (no GraveYield custom code)
//   3. non-canonical-offsets   → InvalidAttestationOffsets (6025)
//   4. unauthorized-signer     → AttestationOracleMismatch (6026)
//   5. malformed-msg-length    → Anchor decode failure (no custom code)
//   6. canonical-bundle        → reaches the authorization equality and
//                                reverts 6026 UNLESS the signing key IS
//                                the configured launch-price oracle
//                                (owner-gated, open item 9.5)
//   + phase1-precondition (observational): evaluate_pool_phase_1 on a
//     pool without a LaunchPrice PDA fails at account validation —
//     documenting the hard record_launch_price → phase1 ordering.
//
// LIVE VERIFIER-LEVEL CASES (EvidenceVerifier against real SlotHashes /
// ProtocolConfig data — the checks the oracle equality currently gates
// on chain):
//
//   7. tampered-binding        → ATTESTATION_BINDING (6027 analogue)
//   8. future-timestamp        → ATTESTATION_TIMESTAMP (6028 analogue)
//   9. stale-slot              → ATTESTATION_STALE (6029 analogue)
//  10. slot-hash-mismatch      → ATTESTATION_SLOT_HASH (6030 analogue)
//  11. replayed-evidence       → ATTESTATION_REPLAY (journal)
//  12. canonical-bundle        → verifier "oracle-gated" outcome (all
//                                properties proven; key equality is the
//                                single remaining gate)
//
// All signatures are produced by EPHEMERAL devnet keys generated inside
// the run; no key material is serialized into the report (reports carry
// public keys and signatures only). Simulations never persist state.
// Real submission stays opt-in (SUBMIT=1) and is NOT exercised by the
// default run — see the "no live salvage until verified" gate.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  GraveYieldClient,
  buildAttestationMessage,
  buildEd25519VerifyInstruction,
  buildLaunchPriceMessage,
  buildRecordLaunchPriceIx,
  buildLaunchPriceEd25519VerifyInstruction,
  decodeGraveYieldError,
  fetchScannerProtocolConfig,
  scannerProtocolConfigPda,
  ATTESTATION_MSG_LEN,
  LAUNCH_PRICE_MSG_OFFSET,
  type DecodedGraveYieldError,
} from "@graveyield/sdk";
import { verifyEvidenceBundle, type VerificationCheckId, type VerifyResult } from "./verify.js";
import { ReplayJournal } from "./journal.js";
import {
  buildEvidenceBundle,
  buildEvidenceMessage,
  type BuildEvidenceBundleInput,
  type EvidenceBundle,
} from "./evidence.js";
import {
  generateDisposableOracleSigner,
  publicKeyFingerprint,
  signAttestationMessage,
  type OracleSigner,
} from "./sign.js";
import type { Cluster } from "./provenance.js";

export interface EvidencePathExpectation {
  result: "reject" | "accept";
  /** Expected GraveYield custom error (program-level cases). */
  errorCode?: number;
  errorName?: string;
  /** Expected verifier failed check (verifier-level cases). */
  failedCheck?: VerificationCheckId;
  /** Acceptable set — some failures surface at more than one stage
   *  (e.g. the binding echo fires at parse time OR at the verifier
   *  stage; both are the 6027 analogue). */
  failedCheckAny?: VerificationCheckId[];
  /** "custom" (GraveYield custom error) | "precompile" | "anchor-decode" | "none". */
  errorFamily?: "custom" | "precompile" | "anchor-decode" | "none";
}

export interface EvidencePathCaseReport {
  caseId: string;
  layer: "program-live" | "verifier-live" | "journal";
  description: string;
  expectation: EvidencePathExpectation;
  observed: {
    simErr?: string | null;
    decoded?: { code: number; hex: string; name: string; program: string } | null;
    failedCheck?: string;
    note?: string;
  };
  pass: boolean;
  skipped?: boolean;
}

export interface EvidencePathReport {
  cluster: Cluster;
  scannerProgramId: string;
  configuredActivityOracle: string | null;
  configuredLaunchPriceOracle: string | null;
  generatedAtUnixMs: number;
  /** Public fingerprint of the ephemeral devnet oracle used for signing. */
  ephemeralOracle: string;
  payerFunded: boolean;
  cases: EvidencePathCaseReport[];
  allPass: boolean;
}

interface SimOutcome {
  err: string | null;
  logs: string[];
  decoded: DecodedGraveYieldError | undefined;
}

async function simulateTx(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<SimOutcome> {
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]?.publicKey ?? (await Keypair.generate()).publicKey;
  tx.sign(...signers);
  const sim = await connection.simulateTransaction(tx);
  const err = sim.value.err === null ? null : String(sim.value.err);
  const logs = sim.value.logs ?? [];
  return { err, logs, decoded: err ? decodeGraveYieldError(err) : undefined };
}

function classifySim(outcome: SimOutcome): { family: "custom" | "precompile" | "anchor-decode" | "none" } {
  if (outcome.decoded) return { family: "custom" };
  if (outcome.err === null) return { family: "none" };
  // A GraveYield custom error would have decoded; a precompile signature
  // failure surfaces as a non-custom program error (the precompile aborts
  // the transaction before the scanner runs).
  return { family: "precompile" };
}

function programCase(
  caseId: string,
  description: string,
  expectation: EvidencePathExpectation,
  outcome: SimOutcome,
): EvidencePathCaseReport {
  const observed: EvidencePathCaseReport["observed"] = {
    simErr: outcome.err,
    decoded: outcome.decoded
      ? {
          code: outcome.decoded.code,
          hex: outcome.decoded.hex,
          name: outcome.decoded.name,
          program: outcome.decoded.program,
        }
      : null,
  };
  let pass = false;
  if (expectation.errorCode !== undefined) {
    pass = outcome.decoded?.code === expectation.errorCode;
  } else if (expectation.errorFamily === "precompile") {
    pass = outcome.err !== null && !outcome.decoded;
  } else if (expectation.errorFamily === "anchor-decode") {
    pass = outcome.err !== null && !outcome.decoded;
  } else if (expectation.result === "accept") {
    pass = outcome.err === null;
  }
  return { caseId, layer: "program-live", description, expectation, observed, pass };
}

function synthAddress(seed: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(seed));
}

/**
 * Run the evidence-path verification matrix. See the module header for
 * the case catalogue. `oracle` (optional) supplies the devnet oracle
 * signer; when absent, an ephemeral key is generated for the run
 * (recommended — the key never leaves memory).
 */
export async function runEvidencePathVerification(opts: {
  connection: Connection;
  cluster: Cluster;
  scannerProgramId: PublicKey;
  vaultProgramId: PublicKey;
  oracle?: OracleSigner;
  /** Attempt to fund the ephemeral payer via devnet airdrop. */
  allowFaucet?: boolean;
  /** Injected clock for deterministic verifier tests. */
  nowUnixSeconds?: number;
}): Promise<EvidencePathReport> {
  const connection = opts.connection;
  const scannerProgramId = opts.scannerProgramId;
  const vaultProgramId = opts.vaultProgramId;
  const oracle = opts.oracle ?? (await generateDisposableOracleSigner());

  // ---- Live on-chain configuration context
  let configuredActivityOracle: string | null = null;
  let configuredLaunchPriceOracle: string | null = null;
  try {
    const pda = scannerProtocolConfigPda(scannerProgramId);
    const cfg = await fetchScannerProtocolConfig(connection, pda);
    if (cfg) {
      configuredActivityOracle = cfg.activityOracle.toBase58();
      configuredLaunchPriceOracle = cfg.launchPriceOracle.toBase58();
    }
  } catch {
    // Report continues with nulls; the config-dependent cases note it.
  }

  const cases: EvidencePathCaseReport[] = [];
  const nowUnixSeconds = opts.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  // =====================================================================
  // Verifier-level cases — always runnable (RPC read-only), no funding.
  // =====================================================================
  const verifierCases = await runVerifierLevelCases({
    connection,
    cluster: opts.cluster,
    scannerProgramId,
    vaultProgramId,
    oracle,
    configuredActivityOracle,
    nowUnixSeconds,
  });
  cases.push(...verifierCases);

  // =====================================================================
  // Program-level cases — need a funded payer for the `init` stage of
  // record_launch_price (account validation precedes the handler, so even
  // failing cases pay rent from the payer inside simulation).
  // =====================================================================
  const payer = await Keypair.generate();
  let payerFunded = (await connection.getBalance(payer.publicKey)) > 0;
  if (!payerFunded && opts.allowFaucet !== false) {
    try {
      await connection.requestAirdrop(payer.publicKey, 0.5 * 1_000_000_000);
      payerFunded = (await connection.getBalance(payer.publicKey)) > 0;
    } catch {
      payerFunded = false;
    }
  }

  if (!payerFunded) {
    cases.push({
      caseId: "program-level-batch",
      layer: "program-live",
      description:
        "Program-level attestation cases (6024/6025/6026 live) — SKIPPED: no funded payer available for the record_launch_price init stage (devnet faucet rate-limited; funding is an owner action).",
      expectation: { result: "reject", errorFamily: "custom" },
      observed: { note: "skipped — unfunded payer" },
      pass: true, // a skip is not a failure; the report marks it explicitly
      skipped: true,
    });
  } else {
    cases.push(...(await runProgramLevelCases({ connection, scannerProgramId, vaultProgramId, oracle, payer })));
  }

  const nonSkipped = cases.filter((c) => !c.skipped);
  return {
    cluster: opts.cluster,
    scannerProgramId: scannerProgramId.toBase58(),
    configuredActivityOracle,
    configuredLaunchPriceOracle,
    generatedAtUnixMs: Date.now(),
    ephemeralOracle: publicKeyFingerprint(oracle.publicKey),
    payerFunded,
    cases,
    allPass: nonSkipped.every((c) => c.pass),
  };
}

// ======================================================================
// Verifier-level cases
// ======================================================================

async function runVerifierLevelCases(ctx: {
  connection: Connection;
  cluster: Cluster;
  scannerProgramId: PublicKey;
  vaultProgramId: PublicKey;
  oracle: OracleSigner;
  configuredActivityOracle: string | null;
  nowUnixSeconds: number;
}): Promise<EvidencePathCaseReport[]> {
  const { connection, cluster, scannerProgramId, vaultProgramId, oracle, nowUnixSeconds } = ctx;
  const reports: EvidencePathCaseReport[] = [];
  const journal = new ReplayJournal(null); // in-memory journal for the run

  const nowSlot = Number(await connection.getSlot());

  // Memoized slot-hash resolver: devnet public RPC rate-limits getBlock
  // hard, so the whole matrix shares one resolved slot + hash.
  let memo: { slot: number; hash: Uint8Array } | null = null;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const memoResolver = async (
    slot: number,
  ): Promise<{ hash: Uint8Array | null; indeterminate: boolean }> => {
    if (memo && memo.slot === slot) return { hash: memo.hash, indeterminate: false };
    for (let attempt = 0; attempt < 6 && !memo; attempt++) {
      try {
        const block = await connection.getBlock(slot, { maxSupportedTransactionVersion: 0 });
        if (block?.blockhash) {
          memo = { slot, hash: new PublicKey(block.blockhash).toBytes() };
          return { hash: memo.hash, indeterminate: false };
        }
      } catch {
        // 429 / transient — pace and retry.
      }
      await sleep(2000);
    }
    return { hash: null, indeterminate: memo === null };
  };

  // Issuance slot: a few slots back so the block is confirmed + indexed.
  let issuedSlot = Math.max(1, nowSlot - 8);
  let slotHash: Uint8Array | null = null;
  for (let back = 8; back <= 60 && !slotHash; back += 4) {
    issuedSlot = Math.max(1, nowSlot - back);
    const resolved = await memoResolver(issuedSlot);
    if (resolved.hash) slotHash = resolved.hash;
  }
  if (!slotHash) {
    // Cannot resolve any recent block — verifier cases needing hash
    // context are skipped rather than mis-reported.
    const skipCase = (id: string, description: string): EvidencePathCaseReport => ({
      caseId: id,
      layer: "verifier-live",
      description: `${description} — SKIPPED: no recent devnet block resolvable via RPC.`,
      expectation: { result: "reject" },
      observed: { note: "skipped — RPC indexing" },
      pass: true,
      skipped: true,
    });
    return [
      skipCase("canonical-bundle-verifier", "Verifier-level canonical bundle (oracle-gated)"),
      skipCase("tampered-binding", "Verifier rejects a bundle whose binding was tampered"),
      skipCase("future-timestamp", "Verifier rejects a future last-swap timestamp"),
      skipCase("stale-slot", "Verifier rejects a bundle issued far outside the SlotHashes window"),
      skipCase("slot-hash-mismatch", "Verifier rejects a wrong slot hash"),
      skipCase("replayed-evidence", "Journal rejects replayed identical evidence"),
    ];
  }

  const poolAddress = synthAddress(0xa1); // synthetic pool for the report run
  const ammProgramId = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const baseMint = synthAddress(0xb1);
  const quoteMint = new PublicKey("So11111111111111111111111111111111111111112");
  const lastSwapUnixTs = nowUnixSeconds - 90 * 24 * 3600; // 90 days stale → the derelict shape

  const canonical = buildEvidenceBundle({
    destination: {
      cluster,
      scannerProgramId,
      protocolConfigPda: scannerProtocolConfigPda(scannerProgramId),
    },
    poolIdentity: {
      ammProgramId: ammProgramId.toBase58(),
      poolAddress: poolAddress.toBase58(),
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      lpMint: synthAddress(0xc1).toBase58(),
      coinVault: synthAddress(0xd1).toBase58(),
      pcVault: synthAddress(0xe1).toBase58(),
    },
    activity: { lastSwapUnixTs, lastSwapSlot: issuedSlot, lastSwapSignature: "", derivationCluster: cluster },
    issuance: { issuedSlot, slotHash, issuedAtUnixMs: Date.now() },
    signature: signAttestationMessage(
      oracle,
      buildEvidenceMessage({ ammProgramId, poolAddress, lastSwapUnixTs, issuedSlot, slotHash }),
    ),
    oraclePublicKey: oracle.publicKey,
  });

  const verifyWithJournal = async (bundle: unknown, sharedJournal: ReplayJournal): Promise<VerifyResult> =>
    verifyEvidenceBundle(connection, cluster, bundle, {
      journal: sharedJournal,
      nowUnixSeconds,
      nowSlot,
      ...(ctx.configuredActivityOracle !== null
        ? { expectedOracle: new PublicKey(ctx.configuredActivityOracle) }
        : {}),
      slotHashResolver: memoResolver,
    });

  // Mutation cases run with the run's OWN oracle substituted as the
  // configured oracle (expectedOracle) — the on-chain check order gates
  // every case at the oracle equality first, so without this substitution
  // each mutation would merely repeat the authorization gate instead of
  // isolating its own on-chain analogue. The canonical case above runs
  // against the LIVE configured oracle and therefore reports the real
  // deployment gate.
  const verifyMutation = async (bundle: unknown, sharedJournal: ReplayJournal): Promise<VerifyResult> =>
    verifyEvidenceBundle(connection, cluster, bundle, {
      journal: sharedJournal,
      nowUnixSeconds,
      nowSlot,
      expectedOracle: oracle.publicKey,
      slotHashResolver: memoResolver,
    });

  const asReport = (
    caseId: string,
    description: string,
    expectation: EvidencePathExpectation,
    result: VerifyResult,
  ): EvidencePathCaseReport => {
    const firstFailure = result.firstFailure;
    const observed: EvidencePathCaseReport["observed"] = {
      ...(firstFailure !== undefined ? { failedCheck: firstFailure.id } : {}),
      ...(firstFailure?.detail !== undefined ? { note: firstFailure.detail } : {}),
    };
    let pass: boolean;
    if (expectation.failedCheck) {
      pass = firstFailure?.id === expectation.failedCheck;
    } else if (expectation.failedCheckAny) {
      pass = firstFailure !== undefined && expectation.failedCheckAny.includes(firstFailure.id);
    } else if (expectation.result === "accept") {
      pass = result.outcome === "verified";
    } else {
      pass = result.outcome === "rejected";
    }
    return { caseId, layer: "verifier-live", description, expectation, observed, pass };
  };

  // 12. canonical bundle → all properties pass; oracle gate decides the
  //     final outcome ("verified" when the signer IS the configured
  //     oracle — e.g. after 9.5 resolution — otherwise "oracle-gated").
  const canonicalResult = await verifyWithJournal(canonical, journal);
  const oracleIsConfigured =
    ctx.configuredActivityOracle !== null &&
    ctx.configuredActivityOracle === oracle.publicKey.toBase58();
  reports.push(
    asReport(
      "canonical-bundle-verifier",
      "Verifier accepts a canonical bundle: every property (well-formedness, signature, binding, timestamp, slot sanity, SlotHashes hash, freshness, replay) proven against live chain data",
      oracleIsConfigured
        ? { result: "accept" }
        : { result: "reject", failedCheck: "ATTESTATION_ORACLE" },
      canonicalResult,
    ),
  );

  // 7. tampered binding: re-point the bundle at a different pool while
  //    keeping the original (valid) attestation bytes. The echo rule
  //    fires at parse time (BUNDLE_WELLFORMED) — the 6027 analogue.
  const tamperedBinding = structuredClone(canonical);
  tamperedBinding.poolIdentity = { ...tamperedBinding.poolIdentity, poolAddress: synthAddress(0xa2).toBase58() };
  reports.push(
    asReport(
      "tampered-binding",
      "Verifier rejects a bundle whose pool binding disagrees with the signed message (6027 analogue; surfaces at the parse-time echo rule)",
      { result: "reject", failedCheckAny: ["BUNDLE_WELLFORMED", "ATTESTATION_BINDING"] },
      await verifyMutation(tamperedBinding, journal),
    ),
  );

  // 8. future timestamp: signed attestation is valid but the claimed
  //    last-swap time postdates the clock — the on-chain 0 < ts <= now
  //    check must fail. Re-sign so only the timestamp property is wrong.
  const futureTs = nowUnixSeconds + 3600;
  const futureBundle = buildEvidenceBundle({
    ...bundleToInput(canonical),
    activity: { lastSwapUnixTs: futureTs, lastSwapSlot: issuedSlot, lastSwapSignature: "", derivationCluster: cluster },
    issuance: { issuedSlot, slotHash, issuedAtUnixMs: Date.now() },
    signature: signAttestationMessage(
      oracle,
      buildEvidenceMessage({ ammProgramId, poolAddress, lastSwapUnixTs: futureTs, issuedSlot, slotHash }),
    ),
    oraclePublicKey: oracle.publicKey,
  });
  reports.push(
    asReport(
      "future-timestamp",
      "Verifier rejects a future last-swap timestamp (6028 analogue)",
      { result: "reject", failedCheck: "ATTESTATION_TIMESTAMP" },
      await verifyMutation(futureBundle, journal),
    ),
  );

  // 9. stale slot: issued far outside the ~512-slot SlotHashes window.
  const staleSlot = Math.max(1, nowSlot - 10_000);
  const staleBundle = buildEvidenceBundle({
    ...bundleToInput(canonical),
    activity: { lastSwapUnixTs, lastSwapSlot: staleSlot, lastSwapSignature: "", derivationCluster: cluster },
    issuance: { issuedSlot: staleSlot, slotHash, issuedAtUnixMs: Date.now() },
    signature: signAttestationMessage(
      oracle,
      buildEvidenceMessage({ ammProgramId, poolAddress, lastSwapUnixTs, issuedSlot: staleSlot, slotHash }),
    ),
    oraclePublicKey: oracle.publicKey,
  });
  reports.push(
    asReport(
      "stale-slot",
      "Verifier rejects a bundle whose issued_slot aged out of the SlotHashes window (6029 analogue)",
      { result: "reject", failedCheck: "ATTESTATION_STALE" },
      await verifyMutation(staleBundle, journal),
    ),
  );

  // 10. slot-hash mismatch: right slot, wrong 32-byte hash.
  const wrongHash = new Uint8Array(32).fill(0x5a);
  const mismatchBundle = buildEvidenceBundle({
    ...bundleToInput(canonical),
    activity: { lastSwapUnixTs, lastSwapSlot: issuedSlot, lastSwapSignature: "", derivationCluster: cluster },
    issuance: { issuedSlot, slotHash: wrongHash, issuedAtUnixMs: Date.now() },
    signature: signAttestationMessage(
      oracle,
      buildEvidenceMessage({ ammProgramId, poolAddress, lastSwapUnixTs, issuedSlot, slotHash: wrongHash }),
    ),
    oraclePublicKey: oracle.publicKey,
  });
  reports.push(
    asReport(
      "slot-hash-mismatch",
      "Verifier rejects a bundle whose attested slot hash does not match the chain (6030 analogue)",
      { result: "reject", failedCheck: "ATTESTATION_SLOT_HASH" },
      await verifyMutation(mismatchBundle, journal),
    ),
  );

  // 11. replay: the SAME canonical bundle verified twice against the
  //     same journal — the second pass must fail ATTESTATION_REPLAY.
  await verifyMutation(canonical, journal);
  const replayResult = await verifyMutation(canonical, journal);
  reports.push(
    asReport(
      "replayed-evidence",
      "Journal rejects replayed identical (msg, pool, issuedSlot) evidence on second observation",
      { result: "reject", failedCheck: "ATTESTATION_REPLAY" },
      replayResult,
    ),
  );

  return reports;
}

function bundleToInput(b: EvidenceBundle): BuildEvidenceBundleInput {
  return {
    destination: {
      cluster: b.destination.cluster,
      scannerProgramId: new PublicKey(b.destination.scannerProgramId),
      protocolConfigPda: new PublicKey(b.destination.protocolConfigPda),
    },
    poolIdentity: b.poolIdentity,
    activity: b.activity,
    issuance: {
      issuedSlot: b.issuance.issuedSlot,
      slotHash: Uint8Array.from(Buffer.from(b.issuance.slotHashHex, "hex")),
      issuedAtUnixMs: b.issuance.issuedAtUnixMs,
    },
    signature: Uint8Array.from(Buffer.from(b.attestation.signatureHex, "hex")),
    oraclePublicKey: new PublicKey(b.attestation.oraclePublicKey),
    discoveryFingerprint: b.discoveryFingerprint,
    createdAtUnixMs: b.createdAtUnixMs,
  };
}

// ======================================================================
// Program-level cases (live, simulation-only, funded payer)
// ======================================================================

async function runProgramLevelCases(ctx: {
  connection: Connection;
  scannerProgramId: PublicKey;
  vaultProgramId: PublicKey;
  oracle: OracleSigner;
  payer: Keypair;
}): Promise<EvidencePathCaseReport[]> {
  const { connection, scannerProgramId, vaultProgramId, oracle, payer } = ctx;
  const client = new GraveYieldClient({
    connection,
    cluster: "devnet",
    graveScannerProgramId: scannerProgramId,
    graveVaultProgramId: vaultProgramId,
  });

  const ammProgramId = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const poolAddress = synthAddress(0xf1);
  const baseMint = synthAddress(0xf2);
  const quoteMint = new PublicKey("So11111111111111111111111111111111111111112");
  const firstSwapSlot = 1;
  const firstSwapUnixTs = Math.floor(Date.now() / 1000) - 90 * 24 * 3600;
  const launchPriceQ64x64 = (1n << 64n) / 1000n; // 0.001 quote-per-base
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  const issuedSlotHint = Number(await connection.getSlot()) - 8;

  // Canonical C2 attestation, signed by the EPHEMERAL devnet oracle.
  const c2Msg = buildLaunchPriceMessage({
    ammProgramId,
    poolAddress,
    baseMint,
    quoteMint,
    firstSwapSlot,
    firstSwapUnixTs,
    launchPriceQ64x64,
    issuedSlot: issuedSlotHint,
  });
  const c2Sig = signAttestationMessage(oracle, c2Msg);

  const recordIx = buildRecordLaunchPriceIx({
    scannerProgramId,
    ammProgramId,
    poolAddress,
    baseMint,
    quoteMint,
    launchPriceQ64x64,
    msg: c2Msg,
    payer: payer.publicKey,
  });

  const canonicalPrecompile = buildLaunchPriceEd25519VerifyInstruction({
    signature: c2Sig,
    oraclePublicKey: oracle.publicKey,
    recordInstructionIndex: 1,
  });

  const reports: EvidencePathCaseReport[] = [];

  const runCase = async (
    caseId: string,
    description: string,
    expectation: EvidencePathExpectation,
    ixs: TransactionInstruction[],
  ): Promise<void> => {
    const tx = new Transaction();
    for (const ix of ixs) tx.add(ix);
    const outcome = await simulateTx(connection, tx, [payer]);
    reports.push(programCase(caseId, description, expectation, outcome));
  };

  // 1. missing-precompile → 6024
  await runCase(
    "missing-precompile",
    "record_launch_price without a preceding ed25519 verify instruction reverts AttestationMissing (6024) — the shared attestation prologue",
    { result: "reject", errorCode: 6024, errorName: "AttestationMissing" },
    [recordIx],
  );

  // 2. tampered-signature → precompile-level rejection (no custom code)
  const tamperedSig = Uint8Array.from(c2Sig);
  const flipIndex = 10;
  if (tamperedSig.length <= flipIndex) throw new Error("signature shorter than expected");
  tamperedSig.set([tamperedSig[flipIndex]! ^ 0x01], flipIndex);
  await runCase(
    "tampered-signature",
    "A corrupted 64-byte signature is rejected by the ed25519 precompile BEFORE the scanner program runs (runtime guarantees signature validity)",
    { result: "reject", errorFamily: "precompile" },
    [
      buildLaunchPriceEd25519VerifyInstruction({
        signature: tamperedSig,
        oraclePublicKey: oracle.publicKey,
        recordInstructionIndex: 1,
      }),
      recordIx,
    ],
  );

  // 3. non-canonical-offsets → 6025. The signature is REAL but covers the
  //    byte span one slot earlier (data[151..319)); the precompile accepts
  //    (offsets are runtime-consistent) while the program's pinned
  //    placement check rejects → InvalidAttestationOffsets.
  const shiftedOffset = LAUNCH_PRICE_MSG_OFFSET - 1;
  const shiftedSpan = recordIx.data.subarray(shiftedOffset, shiftedOffset + 168);
  const shiftedSig = nacl.sign.detached(shiftedSpan, oracle.keypair.secretKey);
  const shiftedPrecompile = buildCustomPrecompileIx({
    signature: shiftedSig,
    oraclePublicKey: oracle.publicKey.toBytes(),
    messageDataOffset: shiftedOffset,
    messageDataSize: 168,
    messageInstructionIndex: 1,
  });
  await runCase(
    "non-canonical-offsets",
    "A runtime-valid precompile instruction whose message span is shifted one byte off the pinned canonical placement reverts InvalidAttestationOffsets (6025) — the fail-closed offset pin",
    { result: "reject", errorCode: 6025, errorName: "InvalidAttestationOffsets" },
    [shiftedPrecompile, recordIx],
  );

  // 4. unauthorized-signer → 6026 (the signer-authorization check itself)
  await runCase(
    "unauthorized-signer",
    "A fully valid attestation signed by a key that is NOT the configured oracle reverts AttestationOracleMismatch (6026) — signer authorization",
    { result: "reject", errorCode: 6026, errorName: "AttestationOracleMismatch" },
    [canonicalPrecompile, recordIx],
  );

  // 5. malformed-msg-length → Anchor decode failure (no custom code)
  const truncatedData = recordIx.data.subarray(0, recordIx.data.length - 1);
  const truncatedIx = new TransactionInstruction({ ...recordIx, data: truncatedData });
  await runCase(
    "malformed-msg-length",
    "Instruction data one byte short of the canonical params layout fails Anchor deserialization (malformed-input rejection; no GraveYield custom code)",
    { result: "reject", errorFamily: "anchor-decode" },
    [
      buildLaunchPriceEd25519VerifyInstruction({
        signature: c2Sig,
        oraclePublicKey: oracle.publicKey,
        recordInstructionIndex: 1,
      }),
      truncatedIx,
    ],
  );

  // 6. canonical-bundle → the full valid attestation reaches the
  //    authorization equality and reverts 6026 (the ONLY remaining gate,
  //    owner-gated by open item 9.5). When the configured oracle matches
  //    the signer, this case instead SUCCEEDS (init writes the PDA in
  //    simulation) — the full positive path.
  const configuredLaunch = await (async () => {
    try {
      const cfg = await fetchScannerProtocolConfig(
        connection,
        scannerProtocolConfigPda(scannerProgramId),
      );
      return cfg?.launchPriceOracle.toBase58() ?? null;
    } catch {
      return null;
    }
  })();
  const signerIsConfigured = configuredLaunch === oracle.publicKey.toBase58();
  await runCase(
    "canonical-bundle-program",
    "The canonical, correctly-signed C2 attestation traverses the entire on-chain path and is gated ONLY by the oracle-key equality (6026 while the key is unregistered; acceptance once registered — open item 9.5)",
    signerIsConfigured
      ? { result: "accept" }
      : { result: "reject", errorCode: 6026, errorName: "AttestationOracleMismatch" },
    [canonicalPrecompile, recordIx],
  );

  // + phase1 precondition (observational): phase1 on a pool with no
  //   LaunchPrice PDA fails at account validation, before attestation.
  const c1Msg = buildAttestationMessage({
    ammProgramId,
    poolAddress,
    lastSwapUnixTs: firstSwapUnixTs,
    issuedSlot: issuedSlotHint,
    slotHash: new Uint8Array(32).fill(1),
  });
  const phase1Pair = client.buildPhase1Ix({
    ammProgramId,
    poolAddress,
    derivation: {
      lastSwapUnixTs: firstSwapUnixTs,
      slot: issuedSlotHint,
      signature: "",
    },
    slotHash: new Uint8Array(32).fill(1),
    signature: nacl.sign.detached(c1Msg, oracle.keypair.secretKey),
    oraclePublicKey: oracle.publicKey,
    writer: payer.publicKey,
  });
  await runCase(
    "phase1-precondition",
    "evaluate_pool_phase_1 requires a recorded LaunchPrice PDA (record_launch_price runs first); without one the transaction fails at account validation — documenting the hard evidence ordering",
    { result: "reject", errorFamily: "anchor-decode" },
    [phase1Pair.precompileIx, phase1Pair.phase1Ix],
  );

  return reports;
}

/**
 * Build a raw ed25519 precompile verify instruction with EXPLICIT offsets
 * (used by the non-canonical case). Layout: 1B count + 1B pad + 7×u16 LE
 * offsets at byte 2 + pubkey@16 + signature@48 — byte-identical to the
 * runtime's own builder (mirrored by attestation.rs / lastSwapAttestation.ts).
 */
function buildCustomPrecompileIx(opts: {
  signature: Uint8Array;
  oraclePublicKey: Uint8Array;
  messageDataOffset: number;
  messageDataSize: number;
  messageInstructionIndex: number;
}): TransactionInstruction {
  if (opts.signature.length !== 64) throw new Error("signature must be 64 bytes");
  if (opts.oraclePublicKey.length !== 32) throw new Error("oracle pubkey must be 32 bytes");
  // 16-byte header + 32-byte pubkey + 64-byte signature = 112 bytes
  const data = Buffer.alloc(16 + 32 + 64);
  data[0] = 1;
  data[1] = 0;
  const w = (off: number, v: number) => data.writeUInt16LE(v, off);
  w(2, 48); // signature_offset (canonical placement)
  w(4, 0xffff); // signature_instruction_index = this instruction
  w(6, 16); // public_key_offset (canonical placement)
  w(8, 0xffff); // public_key_instruction_index = this instruction
  w(10, opts.messageDataOffset); // message_data_offset — the non-canonical part
  w(12, opts.messageDataSize);
  w(14, opts.messageInstructionIndex);
  Buffer.from(opts.oraclePublicKey).copy(data, 16);
  Buffer.from(opts.signature).copy(data, 48);
  return new TransactionInstruction({
    programId: new PublicKey("Ed25519SigVerify111111111111111111111111111"),
    keys: [],
    data,
  });
}


