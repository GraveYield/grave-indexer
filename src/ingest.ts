// SPDX-License-Identifier: Apache-2.0
//
// Ingest ledger — cross-cycle duplicate ingestion, change detection,
// conflict detection and staleness policy over discovered pool records.
//
// The monorepo queue deduplicates candidates in-memory per cycle; this
// module is the durable, cross-cycle counterpart:
//
//   * duplicate-unchanged — same fingerprint as the stored record: the
//     ingest is idempotent (ingestCount++, lastSeenAtMs bumped, NO
//     re-enrichment work is scheduled).
//   * changed             — different fingerprint: the record is updated
//     and the prior fingerprint is kept in a bounded history so drift is
//     auditable.
//   * conflict            — same provenance slot, different bytes: two
//     RPC observations disagree about the same slot. Fail-closed: the
//     entry is flagged `conflicted: true` and excluded from evidence
//     issuance until a FRESH unambiguous observation supersedes it.
//   * stale               — the record's provenance slot is further back
//     from the current slot than the staleness policy allows.

import type { DiscoveredPoolRecord } from "./discovery.js";
import { provenanceAgeSlots, type Provenance } from "./provenance.js";

export type IngestStatus = "new" | "duplicate-unchanged" | "changed" | "conflict";

/** Serialized ledger entry (JSONL-safe — everything is strings/numbers). */
export interface LedgerEntry {
  poolAddress: string;
  ammProgramId: string;
  fingerprint: string;
  /** Bounded history of previous fingerprints (most recent first). */
  fingerprintHistory: string[];
  /** Highest observed provenance slot for this entry. */
  slotLowerBound: number;
  slotUpperBound: number;
  fetchedAtUnixMs: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  ingestCount: number;
  /** True while a same-slot byte divergence is unresolved. */
  conflicted: boolean;
  /** True when the pool pair fails the 7019 WSOL-side guard. */
  unsupported: boolean;
}

export interface IngestOutcome {
  status: IngestStatus;
  entry: LedgerEntry;
  /** Previous fingerprint when status is "changed" or "conflict". */
  previousFingerprint?: string;
}

export interface IngestResult {
  outcomes: IngestOutcome[];
  counts: Record<IngestStatus, number>;
  conflicts: IngestOutcome[];
}

/** Durable, address-keyed ingest ledger. */
export class IngestLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(private readonly maxFingerprintHistory = 8) {}

  /** Number of live entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Direct read (for staleness checks / tests). */
  get(poolAddress: string): LedgerEntry | undefined {
    return this.entries.get(poolAddress);
  }

  /** All entries, ascending pool address (deterministic serialization). */
  list(): LedgerEntry[] {
    return [...this.entries.values()].sort((a, b) => a.poolAddress.localeCompare(b.poolAddress));
  }

  /**
   * Ingest one batch of discovery records. Records whose provenance slot
   * regresses behind the stored entry still ingest (history happens),
   * but the conflict rule fires when two observations CLaim the same
   * slot and disagree on bytes.
   */
  ingestBatch(records: DiscoveredPoolRecord[], nowMs: number): IngestResult {
    const outcomes: IngestOutcome[] = [];
    const counts: Record<IngestStatus, number> = {
      new: 0,
      "duplicate-unchanged": 0,
      changed: 0,
      conflict: 0,
    };

    for (const record of records) {
      const outcome = this.ingestOne(record, nowMs);
      outcomes.push(outcome);
      counts[outcome.status]++;
    }

    return { outcomes, counts, conflicts: outcomes.filter((o) => o.status === "conflict") };
  }

  /** Ingest a single record. */
  ingestOne(record: DiscoveredPoolRecord, nowMs: number): IngestOutcome {
    const key = record.poolAddress.toBase58();
    const existing = this.entries.get(key);

    if (!existing) {
      const entry: LedgerEntry = {
        poolAddress: key,
        ammProgramId: record.ammProgramId.toBase58(),
        fingerprint: record.raw.fingerprint,
        fingerprintHistory: [],
        slotLowerBound: record.provenance.slotLowerBound,
        slotUpperBound: record.provenance.slotUpperBound,
        fetchedAtUnixMs: record.provenance.fetchedAtUnixMs,
        firstSeenAtMs: nowMs,
        lastSeenAtMs: nowMs,
        ingestCount: 1,
        conflicted: false,
        unsupported: record.wsolSide === null,
      };
      this.entries.set(key, entry);
      return { status: "new", entry };
    }

    // Same slot, different bytes → RPC divergence about one slot. Fail closed.
    if (
      record.provenance.slotLowerBound === existing.slotLowerBound &&
      record.raw.fingerprint !== existing.fingerprint
    ) {
      existing.conflicted = true;
      existing.lastSeenAtMs = nowMs;
      existing.ingestCount++;
      return {
        status: "conflict",
        entry: existing,
        previousFingerprint: existing.fingerprint,
      };
    }

    if (record.raw.fingerprint === existing.fingerprint) {
      existing.lastSeenAtMs = nowMs;
      existing.ingestCount++;
      // A fresh unambiguous observation clears a past conflict.
      if (existing.conflicted && record.provenance.slotLowerBound > existing.slotLowerBound) {
        existing.conflicted = false;
      }
      existing.slotLowerBound = Math.max(existing.slotLowerBound, record.provenance.slotLowerBound);
      existing.slotUpperBound = Math.max(existing.slotUpperBound, record.provenance.slotUpperBound);
      existing.fetchedAtUnixMs = record.provenance.fetchedAtUnixMs;
      return { status: "duplicate-unchanged", entry: existing };
    }

    // Different bytes at a later slot → legitimate chain progression.
    existing.fingerprintHistory.unshift(existing.fingerprint);
    if (existing.fingerprintHistory.length > this.maxFingerprintHistory) {
      existing.fingerprintHistory.length = this.maxFingerprintHistory;
    }
    existing.fingerprint = record.raw.fingerprint;
    existing.slotLowerBound = Math.max(existing.slotLowerBound, record.provenance.slotLowerBound);
    existing.slotUpperBound = Math.max(existing.slotUpperBound, record.provenance.slotUpperBound);
    existing.fetchedAtUnixMs = record.provenance.fetchedAtUnixMs;
    existing.lastSeenAtMs = nowMs;
    existing.ingestCount++;
    existing.conflicted = false;
    existing.unsupported = record.wsolSide === null;
    const previousFingerprint = existing.fingerprintHistory[0];
    return previousFingerprint === undefined
      ? { status: "changed", entry: existing }
      : { status: "changed", entry: existing, previousFingerprint };
  }

  /** Staleness policy: which entries must be re-fetched before use. */
  staleEntries(currentSlot: number, maxAgeSlots: number): Array<{ entry: LedgerEntry; ageSlots: number }> {
    const stale: Array<{ entry: LedgerEntry; ageSlots: number }> = [];
    for (const entry of this.entries.values()) {
      const ageSlots = Math.max(0, currentSlot - entry.slotUpperBound);
      if (ageSlots > maxAgeSlots) stale.push({ entry, ageSlots });
    }
    return stale;
  }

  /** Entries excluded from evidence issuance right now. */
  blockedEntries(currentSlot: number, maxAgeSlots: number): LedgerEntry[] {
    return this.list().filter(
      (e) => e.conflicted || this.staleEntries(currentSlot, maxAgeSlots).some((s) => s.entry === e),
    );
  }

  /** Provenance-shaped view of an entry. */
  provenanceOf(entry: LedgerEntry): Provenance {
    return {
      source: "raydium-v4-gpa",
      cluster: "mainnet-beta",
      endpointKind: "public-rpc",
      slot: entry.slotUpperBound,
      fetchedAtUnixMs: entry.fetchedAtUnixMs,
      accountSha256: entry.fingerprint,
      owner: entry.ammProgramId,
    };
  }

  /** JSONL serialization (deterministic order). */
  toJSONL(): string {
    return this.list().map((e) => JSON.stringify(e)).join("\n");
  }

  /** Adopt a parsed entry directly (cross-cycle persistence reload). */
  adopt(entry: LedgerEntry): void {
    this.entries.set(entry.poolAddress, entry);
  }

  /** Rebuild a ledger from JSONL (torn trailing line tolerated). */
  static fromJSONL(jsonl: string): IngestLedger {
    const ledger = new IngestLedger();
    for (const line of jsonl.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        ledger.adopt(JSON.parse(trimmed) as LedgerEntry);
      } catch {
        // Torn trailing line (crash mid-append): tolerated by design.
      }
    }
    return ledger;
  }
}
