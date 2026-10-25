// SPDX-License-Identifier: Apache-2.0
//
// Evidence verifier — the off-chain mirror of the on-chain ORACLE-002
// verification path, in the SAME order and with the SAME failure
// semantics, so a bundle that passes here is exactly the bundle the
// deployed GraveScanner would accept (modulo the oracle key equality,
// which is configuration, not correctness — see ATTESTATION_ORACLE).
//
// On-chain order (programs/grave-scanner/src/attestation.rs):
//   1. precompile present immediately before the scanner ix   → 6024
//   2. precompile offset structure (pinned, fail-closed)      → 6025
//   3. covered pubkey == ProtocolConfig.activity_oracle        → 6026
//   4. msg binding (amm ‖ pool) echoes instruction params      → 6027
//   5. 0 < last_swap_unix_ts <= now                            → 6028
//   6. 0 < issued_slot <= now_slot                             → 6031
//   7. issued_slot resolves in SlotHashes                      → 6029
//   8. SlotHashes hash byte-equals msg[80..112]                → 6030
// The runtime additionally guarantees Ed25519 signature validity before
// any program code runs.
//
// Off-chain, the precompile/offset steps collapse into: canonical span
// well-formedness (the bundle carries exactly one 112-byte message, one
// 32-byte key, one 64-byte signature at canonical placements) and direct
// Ed25519 verification. Steps 3–8 run against LIVE chain data
// (ProtocolConfig via RPC, SlotHashes membership via getBlock).

import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchScannerProtocolConfig,
  scannerProtocolConfigPda,
} from "@graveyield/sdk";
import {
  parseEvidenceBundle,
  recomputeBundleMessage,
  type EvidenceBundle,
} from "./evidence.js";
import { verifyAttestationSignature } from "./sign.js";
import { ReplayJournal } from "./journal.js";
import { sha256Hex, type Cluster } from "./provenance.js";

/** Verifier check identifiers — named after their on-chain analogues. */
export type VerificationCheckId =
  | "BUNDLE_WELLFORMED"
  | "ATTESTATION_MISSING"
  | "ATTESTATION_OFFSETS"
  | "ATTESTATION_SIGNATURE"
  | "ATTESTATION_ORACLE"
  | "ATTESTATION_BINDING"
  | "ATTESTATION_TIMESTAMP"
  | "ATTESTATION_SLOT"
  | "ATTESTATION_STALE"
  | "ATTESTATION_SLOT_HASH"
  | "ATTESTATION_REPLAY";

/** One executed check. */
export interface VerificationCheck {
  id: VerificationCheckId;
  ok: boolean;
  /** On-chain error this check mirrors (code + name) when applicable. */
  onChainAnalogue?: { code: number; name: string };
  detail?: string;
  /** "indeterminate" — e.g. RPC indexing lag for a within-window slot. */
  outcome?: "pass" | "fail" | "indeterminate";
}

/** Full verification result. */
export interface VerifyResult {
  ok: boolean;
  /** "verified" — everything passed; "oracle-gated" — all checks passed
   *  except ATTESTATION_ORACLE (signer ≠ configured oracle), i.e. the
   *  evidence is well-formed and fresh but the signing key is not (yet)
   *  the configured oracle (owner-gated: open item 9.5); "rejected" — a
   *  substantive check failed. */
  outcome: "verified" | "oracle-gated" | "rejected" | "indeterminate";
  checks: VerificationCheck[];
  firstFailure?: VerificationCheck;
  bundle: EvidenceBundle;
  verifiedAtUnixMs: number;
  cluster: Cluster;
  /** The configured oracle observed on chain during this verification. */
  configuredOracle: string | null;
}

export interface VerifyOptions {
  journal?: ReplayJournal;
  /** Override "now" (unix seconds) for deterministic tests. */
  nowUnixSeconds?: number;
  /** Override the current slot for deterministic tests. */
  nowSlot?: number;
  /** Expected configured oracle (skips the live ProtocolConfig fetch). */
  expectedOracle?: PublicKey;
  /** Max step-backs when resolving a recent slot's block (default 8). */
  blockLookupRetries?: number;
  /** Trust window: issued_slot older than (now - window) is stale. */
  freshnessWindowSlots?: number;
  /** Injectable slot-hash resolver (lets callers memoize across many
   *  verifications against rate-limited RPC). */
  slotHashResolver?: (slot: number) => Promise<{ hash: Uint8Array | null; indeterminate: boolean }>;
}

const ON_CHAIN = {
  ATTESTATION_MISSING: { code: 6024, name: "AttestationMissing" },
  ATTESTATION_OFFSETS: { code: 6025, name: "InvalidAttestationOffsets" },
  ATTESTATION_ORACLE: { code: 6026, name: "AttestationOracleMismatch" },
  ATTESTATION_BINDING: { code: 6027, name: "AttestationBindingMismatch" },
  ATTESTATION_TIMESTAMP: { code: 6028, name: "AttestationTimestampInvalid" },
  ATTESTATION_STALE: { code: 6029, name: "AttestationStale" },
  ATTESTATION_SLOT_HASH: { code: 6030, name: "AttestationSlotHashMismatch" },
  ATTESTATION_SLOT: { code: 6031, name: "AttestationSlotInvalid" },
} as const;

function check(
  id: VerificationCheckId,
  ok: boolean,
  onChainAnalogue?: { code: number; name: string },
  detail?: string,
): VerificationCheck {
  return {
    id,
    ok,
    ...(onChainAnalogue !== undefined ? { onChainAnalogue } : {}),
    ...(detail !== undefined ? { detail } : {}),
    outcome: ok ? ("pass" as const) : ("fail" as const),
  };
}

/**
 * Resolve a slot's blockhash with bounded retries for RPC indexing lag.
 * Returns null when the slot has no resolvable block (stale/skipped) and
 * "indeterminate" cannot be excluded.
 */
async function resolveSlotHash(
  connection: Connection,
  slot: number,
  retries: number,
): Promise<{ hash: Uint8Array | null; indeterminate: boolean }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const probe = slot - attempt;
    if (probe <= 0) return { hash: null, indeterminate: false };
    try {
      const block = await connection.getBlock(probe, { maxSupportedTransactionVersion: 0 });
      if (block && block.blockhash) {
        // Only the EXACT slot answers the on-chain hash check; stepping
        // back is only useful to distinguish "RPC lag" from "gap". If the
        // requested slot itself yielded nothing while an older one
        // resolved, the exact slot is treated as missing (stale).
        if (probe === slot) {
          return { hash: new PublicKey(block.blockhash).toBytes(), indeterminate: false };
        }
        break;
      }
    } catch {
      // RPC hiccup: retry, then report indeterminate below.
    }
  }
  return { hash: null, indeterminate: retries > 0 };
}

/**
 * Verify an evidence bundle against live chain state, mirroring the
 * on-chain check order. Malformed bundles fail at BUNDLE_WELLFORMED
 * before any RPC call.
 */
export async function verifyEvidenceBundle(
  connection: Connection,
  cluster: Cluster,
  rawBundle: unknown,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const checks: VerificationCheck[] = [];
  const verifiedAtUnixMs = Date.now();

  // ---- 1. Well-formedness (parse-time rejection, mirrors 6025/6027 checks)
  let bundle: EvidenceBundle;
  try {
    bundle = parseEvidenceBundle(rawBundle);
    checks.push(check("BUNDLE_WELLFORMED", true, undefined, "schema, lengths, pubkeys and field/msg agreement all valid"));
  } catch (err) {
    checks.push(
      check("BUNDLE_WELLFORMED", false, ON_CHAIN.ATTESTATION_OFFSETS, String((err as Error).message ?? err)),
    );
    return {
      ok: false,
      outcome: "rejected",
      checks,
      ...(checks[0] !== undefined ? { firstFailure: checks[0] } : {}),
      bundle: rawBundle as EvidenceBundle,
      verifiedAtUnixMs,
      cluster,
      configuredOracle: null,
    };
  }

  const msg = recomputeBundleMessage(bundle);
  const signature = Uint8Array.from(Buffer.from(bundle.attestation.signatureHex, "hex"));
  const oraclePk = new PublicKey(bundle.attestation.oraclePublicKey);
  const poolAddress = new PublicKey(bundle.poolIdentity.poolAddress);
  const ammProgramId = new PublicKey(bundle.poolIdentity.ammProgramId);

  // ---- 2. Canonical span / presence (6024/6025 analogues)
  const msgView = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const embeddedIssuedSlot = Number(msgView.getBigUint64(72, true));
  if (embeddedIssuedSlot !== bundle.issuance.issuedSlot) {
    checks.push(
      check("ATTESTATION_OFFSETS", false, ON_CHAIN.ATTESTATION_OFFSETS, "issued_slot disagrees between issuance block and message bytes"),
    );
    return finish(
      checks,
      bundle,
      "rejected",
      verifiedAtUnixMs,
      cluster,
      null,
      checks.find((c) => !c.ok),
    );
  }
  checks.push(check("ATTESTATION_OFFSETS", true, ON_CHAIN.ATTESTATION_OFFSETS, "canonical 112-byte span, canonical field placement"));

  // ---- 3. Ed25519 signature validity (runtime precompile guarantee)
  const signatureValid = verifyAttestationSignature(signature, msg, oraclePk.toBytes());
  checks.push(
    check(
      "ATTESTATION_SIGNATURE",
      signatureValid,
      undefined,
      signatureValid ? "Ed25519 signature valid over the canonical message" : "Ed25519 signature INVALID over the canonical message (tampered or wrong key)",
    ),
  );
  if (!signatureValid) {
    return finish(
      checks,
      bundle,
      "rejected",
      verifiedAtUnixMs,
      cluster,
      null,
      checks.find((c) => !c.ok),
    );
  }

  // ---- 4. Signer authorization (6026) — live ProtocolConfig fetch
  let configuredOracle: string | null = null;
  if (opts.expectedOracle) {
    configuredOracle = opts.expectedOracle.toBase58();
  } else {
    try {
      const pda = scannerProtocolConfigPda(new PublicKey(bundle.destination.scannerProgramId));
      const cfg = await fetchScannerProtocolConfig(connection, pda);
      configuredOracle = cfg?.activityOracle.toBase58() ?? null;
    } catch (err) {
      checks.push(
        check("ATTESTATION_ORACLE", false, ON_CHAIN.ATTESTATION_ORACLE, `ProtocolConfig fetch failed: ${String((err as Error).message ?? err)}`),
      );
      return finish(checks, bundle, "indeterminate", verifiedAtUnixMs, cluster, null);
    }
  }
  const oracleAuthorized = configuredOracle !== null && configuredOracle === oraclePk.toBase58();
  checks.push(
    check(
      "ATTESTATION_ORACLE",
      oracleAuthorized,
      ON_CHAIN.ATTESTATION_ORACLE,
      oracleAuthorized
        ? `signer ${oraclePk.toBase58()} is the configured activity_oracle`
        : `signer ${oraclePk.toBase58()} ≠ configured activity_oracle ${configuredOracle ?? "(unavailable)"}`,
    ),
  );

  // ---- 5. Binding echo (6027) — parse already recomputed the message;
  //         the explicit check pins the two identity prefixes.
  const msgBytes = new Uint8Array(msg);
  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const bindingOk =
    bytesEqual(msgBytes.slice(0, 32), ammProgramId.toBytes()) &&
    bytesEqual(msgBytes.slice(32, 64), poolAddress.toBytes());
  // (recomputeBundleMessage guarantees this; keep the explicit check for the report)
  checks.push(
    check("ATTESTATION_BINDING", bindingOk, ON_CHAIN.ATTESTATION_BINDING, `amm=${ammProgramId.toBase58()} pool=${poolAddress.toBase58()}`),
  );

  // ---- 6. Timestamp sanity (6028)
  const nowUnixSeconds = opts.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const ts = bundle.activity.lastSwapUnixTs;
  const timestampOk = ts > 0 && ts <= nowUnixSeconds;
  checks.push(
    check("ATTESTATION_TIMESTAMP", timestampOk, ON_CHAIN.ATTESTATION_TIMESTAMP, `last_swap_unix_ts=${ts} now=${nowUnixSeconds}`),
  );

  // ---- 7. Slot sanity (6031)
  const nowSlot = opts.nowSlot ?? Number(await connection.getSlot());
  const issuedSlot = bundle.issuance.issuedSlot;
  const slotOk = issuedSlot > 0 && issuedSlot <= nowSlot;
  checks.push(check("ATTESTATION_SLOT", slotOk, ON_CHAIN.ATTESTATION_SLOT, `issued_slot=${issuedSlot} now_slot=${nowSlot}`));

  // ---- 8. Freshness window + SlotHashes resolution (6029/6030)
  const window = opts.freshnessWindowSlots ?? 450;
  if (nowSlot - issuedSlot > window) {
    checks.push(
      check("ATTESTATION_STALE", false, ON_CHAIN.ATTESTATION_STALE, `issued_slot ${issuedSlot} is ${nowSlot - issuedSlot} slots old (window ${window}) — would age out of SlotHashes`),
    );
  } else {
    checks.push(check("ATTESTATION_STALE", true, ON_CHAIN.ATTESTATION_STALE, `issued_slot within window (${nowSlot - issuedSlot} <= ${window})`));
    const { hash, indeterminate } = opts.slotHashResolver
      ? await opts.slotHashResolver(issuedSlot)
      : await resolveSlotHash(connection, issuedSlot, opts.blockLookupRetries ?? 8);
    if (indeterminate) {
      const slotHashCheck = check(
        "ATTESTATION_SLOT_HASH",
        false,
        ON_CHAIN.ATTESTATION_SLOT_HASH,
        "slot within window but block not (yet) resolvable via RPC — indeterminate, not stale",
      );
      slotHashCheck.outcome = "indeterminate";
      checks.push(slotHashCheck);
    } else if (hash === null) {
      checks.push(check("ATTESTATION_SLOT_HASH", false, ON_CHAIN.ATTESTATION_STALE, "no block resolvable for issued_slot — on chain this slot is absent from SlotHashes"));
    } else {
      const hashHex = Buffer.from(hash).toString("hex");
      const expectedHex = Buffer.from(msgBytes.slice(80, 112)).toString("hex");
      checks.push(
        check(
          "ATTESTATION_SLOT_HASH",
          hashHex === expectedHex,
          ON_CHAIN.ATTESTATION_SLOT_HASH,
          `chain blockhash ${hashHex.slice(0, 16)}… vs attested ${expectedHex.slice(0, 16)}…`,
        ),
      );
    }
  }

  // ---- 9. Replay journal (operator-side complement to SlotHashes)
  if (opts.journal) {
    const msgHash = ReplayJournal.msgHash(msgBytes);
    const replay = opts.journal.check(msgHash, poolAddress.toBase58(), issuedSlot);
    checks.push(
      check(
        "ATTESTATION_REPLAY",
        !replay.isReplay,
        undefined,
        replay.isReplay ? `identical (msg, pool, issuedSlot) already journaled at ${replay.matchedEntry?.seenAtUnixMs}` : "no journal match",
      ),
    );
  } else {
    checks.push(check("ATTESTATION_REPLAY", true, undefined, "journal disabled"));
  }

  // ---- Outcome synthesis (mirrors on-chain short-circuit order)
  const firstFailure = checks.find((c) => !c.ok);
  const indeterminate = checks.find((c) => c.outcome === "indeterminate");
  let outcome: VerifyResult["outcome"];
  if (firstFailure?.id === "ATTESTATION_ORACLE") {
    const othersOk = checks.every((c) => c.id === "ATTESTATION_ORACLE" || c.ok);
    outcome = othersOk ? "oracle-gated" : "rejected";
  } else if (firstFailure) {
    outcome = "rejected";
  } else if (indeterminate) {
    outcome = "indeterminate";
  } else {
    outcome = "verified";
  }

  // ---- Journal the observation so a re-verification of the SAME
  //      (msg, pool, issuedSlot) is caught as a replay. Only bundles that
  //      cleared every structural check are recorded — structurally valid
  //      evidence is exactly what an operator might act on, so its reuse
  //      is what the operator-side guard must catch.
  if (opts.journal && (outcome === "verified" || outcome === "oracle-gated")) {
    opts.journal.append({
      msgSha256: ReplayJournal.msgHash(msgBytes),
      poolAddress: poolAddress.toBase58(),
      issuedSlot,
      oraclePublicKey: oraclePk.toBase58(),
      action: "verify",
    }, verifiedAtUnixMs);
  }

  return finish(checks, bundle, outcome, verifiedAtUnixMs, cluster, configuredOracle, firstFailure);
}

function finish(
  checks: VerificationCheck[],
  bundle: EvidenceBundle,
  outcome: VerifyResult["outcome"],
  verifiedAtUnixMs: number,
  cluster: Cluster,
  configuredOracle: string | null,
  firstFailure?: VerificationCheck,
): VerifyResult {
  return {
    ok: outcome === "verified",
    outcome,
    checks,
    ...(firstFailure !== undefined ? { firstFailure } : {}),
    bundle,
    verifiedAtUnixMs,
    cluster,
    configuredOracle,
  };
}

/** Compact, log-safe verification summary (no secrets exist here). */
export function summarizeVerifyResult(result: VerifyResult): string {
  const failed = result.checks.filter((c) => !c.ok).map((c) => c.id);
  return [
    `outcome=${result.outcome}`,
    `checks=${result.checks.length}`,
    failed.length > 0 ? `failed=${failed.join(",")}` : "failed=none",
    `oracle=${result.configuredOracle ?? "unknown"}`,
    `msg_sha256=${sha256Hex(recomputeBundleMessage(result.bundle)).slice(0, 16)}…`,
  ].join(" ");
}
