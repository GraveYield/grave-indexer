// SPDX-License-Identifier: Apache-2.0
//
// Replay journal — operator-side replay resistance.
//
// The ON-CHAIN replay defense is structural: the attestation binds
// issued_slot, and the program requires issued_slot to still resolve in
// SlotHashes with a byte-exact hash (~512-slot window). A replayed
// attestation therefore dies on chain once its slot ages out.
//
// The journal is the OPERATOR-side complement: it records every
// (pool, issued_slot, msg) the pipeline has ever signed or verified, so
// re-running collection/verification cannot silently re-issue or
// re-accept an identical bundle, and so double-signing the same
// attestation slot+message is caught before submission. Entries are
// JSONL, append-only, and carry no secrets (message hash + public fields
// only).

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface JournalEntry {
  /** sha256 of the 112-byte attestation message. */
  msgSha256: string;
  poolAddress: string;
  issuedSlot: number;
  /** Oracle public key (base58) — public data. */
  oraclePublicKey: string;
  seenAtUnixMs: number;
  /** "sign" (issued by us) or "verify" (accepted/observed). */
  action: "sign" | "verify";
}

export interface ReplayCheckResult {
  isReplay: boolean;
  matchedEntry?: JournalEntry;
}

/** Append-only replay journal backed by a JSONL file. */
export class ReplayJournal {
  private readonly entries = new Map<string, JournalEntry>();

  constructor(private readonly filePath: string | null = null) {
    if (filePath && existsSync(filePath)) {
      this.loadFrom(filePath);
    }
  }

  private static keyOf(msgSha256: string, poolAddress: string, issuedSlot: number): string {
    return `${msgSha256}:${poolAddress}:${issuedSlot}`;
  }

  private loadFrom(filePath: string): void {
    const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JournalEntry;
        this.entries.set(ReplayJournal.keyOf(entry.msgSha256, entry.poolAddress, entry.issuedSlot), entry);
      } catch {
        // A torn trailing line (crash mid-append) is tolerated: the file
        // is append-only, so a torn line can only be the LAST line.
      }
    }
  }

  /** sha256 of a message, hex — the journal's message key. */
  static msgHash(message: Uint8Array): string {
    return createHash("sha256").update(message).digest("hex");
  }

  /** Has this exact (msg, pool, issuedSlot) been seen before? */
  check(msgSha256: string, poolAddress: string, issuedSlot: number): ReplayCheckResult {
    const key = ReplayJournal.keyOf(msgSha256, poolAddress, issuedSlot);
    const matchedEntry = this.entries.get(key);
    return matchedEntry === undefined
      ? { isReplay: false }
      : { isReplay: true, matchedEntry };
  }

  /**
   * Append an entry (idempotent — re-appending the same key is a no-op
   * that does NOT rewrite history). Returns false when the entry already
   * existed.
   */
  append(entry: Omit<JournalEntry, "seenAtUnixMs">, nowUnixMs = Date.now()): boolean {
    const key = ReplayJournal.keyOf(entry.msgSha256, entry.poolAddress, entry.issuedSlot);
    if (this.entries.has(key)) return false;
    const full: JournalEntry = { ...entry, seenAtUnixMs: nowUnixMs };
    this.entries.set(key, full);
    if (this.filePath) {
      appendFileSync(this.filePath, `${JSON.stringify(full)}\n`, { encoding: "utf8" });
    }
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  /** All entries (for reporting; deterministic insertion order). */
  list(): JournalEntry[] {
    return [...this.entries.values()];
  }
}
