// SPDX-License-Identifier: Apache-2.0
//
// D-01 M1 WSOL quote-side sourcing predicate — grave-indexer's
// independently-enforced boundary expression (GY-M1-ODR-001 §3,
// GY-M1-SPEC-001 §2.1 "C3 M1 sourcing restriction" and §7 item 2).
//
// A candidate pool is M1-eligible only when ALL three conditions hold:
//
//   1. Exactly one of the two pool mints is WSOL;
//   2. WSOL is the Raydium AMM V4 `pc_mint` (the quote-side mint);
//   3. The other mint (`coin_mint`, the base side) is non-WSOL.
//
// SINGLE WSOL DEFINITION: the mint address comes from the canonical
// `WSOL_MINT` constant exported by @graveyield/sdk (the vendored
// protocol submodule) — this module deliberately does not introduce a
// second WSOL definition. The predicate EXPRESSION is deliberately
// re-declared here per the D-01 requirement that discovery, SDK and
// operator boundaries enforce it independently: each boundary refuses
// on its own judgment, never by trusting an upstream filter.
//
// SYNCHRONIZATION NOTE: the vendored protocol submodule is currently
// pinned below graveyield-protocol PR #117, which adds the SDK-side
// `m1Sourcing` module. Once the submodule is bumped past that PR this
// module should delegate to (or be replaced by) the SDK's canonical
// helper, keeping the reason-code taxonomy identical. Until then the
// taxonomy below mirrors the SDK's documented reason codes exactly.
//
// Field mapping (SDK parser `parseV4AmmInfo`):
//
//   coin_mint  — AmmInfo offset 400 — exposed as `V4PoolAccount.baseMint`
//   pc_mint    — AmmInfo offset 432 — exposed as `V4PoolAccount.quoteMint`
//
// POLICY BOUNDARY: this restriction is M1 sourcing-only. It is NOT a
// settlement-orientation restriction and must not be tightened into the
// settlement-adjacent orientation logic (the SDK 7019 guard or the
// salvage path) — non-M1 discovery keeps recording and ledgering both
// single-WSOL orientations; only the M1 candidate boundaries enforce
// the quote-side predicate.
//
// FAIL-CLOSED: missing, malformed, ambiguous or unverifiable orientation
// data is always rejected. Uncertain orientation is never M1-eligible.

import { PublicKey } from "@solana/web3.js";
import { WSOL_MINT } from "@graveyield/sdk";

/** Machine-checkable rejection reasons (mirrors the SDK's taxonomy). */
export type M1SourcingRejectionReason =
  /** `coin_mint` is missing (null/undefined) — orientation cannot be established. */
  | "missing-coin-mint"
  /** `pc_mint` is missing (null/undefined) — orientation cannot be established. */
  | "missing-pc-mint"
  /** A mint field is present but not a usable PublicKey — unverifiable data. */
  | "unverifiable-orientation"
  /** Neither mint is WSOL. */
  | "no-wsol-side"
  /** Both mints are WSOL. */
  | "both-sides-wsol"
  /** WSOL sits on `coin_mint` (base side) instead of `pc_mint` (quote side). */
  | "wsol-on-coin-side";

/** A pool that passed the M1 sourcing predicate. */
export interface M1SourcingAccepted {
  accepted: true;
  /** The WSOL mint — always the canonical `WSOL_MINT` constant. */
  wsolMint: PublicKey;
  /** The non-WSOL (`coin_mint` / base-side) mint. */
  memecoinMint: PublicKey;
}

/** A pool that failed the M1 sourcing predicate, with the exact reason. */
export interface M1SourcingRejected {
  accepted: false;
  reason: M1SourcingRejectionReason;
  /** Human-readable detail for logs and operator artifacts. */
  detail: string;
  /** The observed `coin_mint` (base58), or null when it could not be established. */
  coinMint: string | null;
  /** The observed `pc_mint` (base58), or null when it could not be established. */
  pcMint: string | null;
}

export type M1SourcingVerdict = M1SourcingAccepted | M1SourcingRejected;

/**
 * Explicit Raydium V4 orientation fields. Callers holding a parsed pool
 * identity pass `baseMint`/`quoteMint` from the SDK's `V4PoolAccount`
 * (or the discovery record's parsed identity slice) — the mapping is the
 * parser's own: `baseMint` IS `coin_mint` and `quoteMint` IS `pc_mint`.
 */
export interface M1SourcingOrientation {
  /** Raydium V4 `coin_mint` (AmmInfo @400; the SDK's `baseMint`). */
  coinMint: PublicKey | null | undefined;
  /** Raydium V4 `pc_mint` (AmmInfo @432; the SDK's `quoteMint`). */
  pcMint: PublicKey | null | undefined;
}

function base58OrNull(mint: PublicKey | null | undefined): string | null {
  if (mint === null || mint === undefined) return null;
  if (!(mint instanceof PublicKey)) return null;
  return mint.toBase58();
}

/**
 * Evaluate the D-01 M1 WSOL quote-side sourcing predicate. Pure, total
 * and fail-closed: every uncertain input resolves to a rejection, never
 * to an acceptance.
 */
export function evaluateM1Sourcing(pool: M1SourcingOrientation): M1SourcingVerdict {
  const { coinMint, pcMint } = pool;

  if (coinMint === null || coinMint === undefined) {
    return {
      accepted: false,
      reason: "missing-coin-mint",
      detail: "coin_mint is missing — pool orientation cannot be established",
      coinMint: null,
      pcMint: base58OrNull(pcMint),
    };
  }
  if (pcMint === null || pcMint === undefined) {
    return {
      accepted: false,
      reason: "missing-pc-mint",
      detail: "pc_mint is missing — pool orientation cannot be established",
      coinMint: base58OrNull(coinMint),
      pcMint: null,
    };
  }
  if (!(coinMint instanceof PublicKey) || !(pcMint instanceof PublicKey)) {
    return {
      accepted: false,
      reason: "unverifiable-orientation",
      detail: "mint fields are not usable PublicKeys — orientation is unverifiable",
      coinMint: base58OrNull(coinMint),
      pcMint: base58OrNull(pcMint),
    };
  }

  const coinIsWsol = coinMint.equals(WSOL_MINT);
  const pcIsWsol = pcMint.equals(WSOL_MINT);

  if (coinIsWsol && pcIsWsol) {
    return {
      accepted: false,
      reason: "both-sides-wsol",
      detail: `both mints are WSOL — coin=${coinMint.toBase58()}, pc=${pcMint.toBase58()}`,
      coinMint: coinMint.toBase58(),
      pcMint: pcMint.toBase58(),
    };
  }
  if (!coinIsWsol && !pcIsWsol) {
    return {
      accepted: false,
      reason: "no-wsol-side",
      detail: `neither mint is WSOL — coin=${coinMint.toBase58()}, pc=${pcMint.toBase58()}`,
      coinMint: coinMint.toBase58(),
      pcMint: pcMint.toBase58(),
    };
  }
  if (coinIsWsol && !pcIsWsol) {
    return {
      accepted: false,
      reason: "wsol-on-coin-side",
      detail: `WSOL is coin_mint (base side) — M1 requires WSOL on pc_mint (quote side): coin=${coinMint.toBase58()}, pc=${pcMint.toBase58()}`,
      coinMint: coinMint.toBase58(),
      pcMint: pcMint.toBase58(),
    };
  }

  return {
    accepted: true,
    wsolMint: pcMint,
    memecoinMint: coinMint,
  };
}

/** Error thrown by the M1 sourcing guard when a pool is not M1-eligible. */
export class M1SourcingError extends Error {
  readonly reason: M1SourcingRejectionReason;
  readonly verdict: M1SourcingRejected;

  constructor(verdict: M1SourcingRejected) {
    super(`M1 sourcing rejected (D-01): ${verdict.reason} — ${verdict.detail}`);
    this.name = "M1SourcingError";
    this.reason = verdict.reason;
    this.verdict = verdict;
  }
}

/**
 * Assert the D-01 M1 sourcing predicate. Returns the acceptance (with
 * the WSOL / memecoin mints) or throws `M1SourcingError`.
 */
export function assertM1Sourcing(pool: M1SourcingOrientation): M1SourcingAccepted {
  const verdict = evaluateM1Sourcing(pool);
  if (!verdict.accepted) throw new M1SourcingError(verdict);
  return verdict;
}
