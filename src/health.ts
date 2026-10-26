// SPDX-License-Identifier: Apache-2.0
//
// Operational health — every pipeline stage reports successes and failures
// with latency; the registry renders a single snapshot that the CLI prints
// and CI/scheduled jobs publish as job summaries. A stage is:
//
//   ok        — last outcome was a success and it happened within
//               maxSilenceMs
//   degraded  — the last outcome was a failure, or the last success is
//               older than maxSilenceMs (silence is suspicion)
//   failing   — `failureThreshold` consecutive failures
//
// Snapshot serialization never includes key material or URLs (endpoint
// kinds only) — snapshots are safe to publish verbatim in CI summaries.

export type HealthStatus = "ok" | "degraded" | "failing";

export type HealthComponentId =
  | "rpc-discovery"
  | "rpc-verification"
  | "discovery"
  | "ingest"
  | "activity"
  | "evidence"
  | "verifier"
  | "journal"
  | "enrich";

export interface HealthComponentReport {
  component: HealthComponentId;
  status: HealthStatus;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastSuccessAtUnixMs: number | null;
  lastFailureAtUnixMs: number | null;
  lastErrorName: string | null;
  lastLatencyMs: number | null;
  /** Bounded recent error names (most recent first, max 10). */
  recentErrors: string[];
}

export interface HealthSnapshot {
  status: HealthStatus;
  generatedAtUnixMs: number;
  components: HealthComponentReport[];
}

export interface HealthRegistryOptions {
  /** Silence longer than this degrades a component (default 30 min). */
  maxSilenceMs?: number;
  /** Consecutive failures that escalate degraded → failing (default 3). */
  failureThreshold?: number;
}

const RECENT_ERROR_LIMIT = 10;

/** Stage-level health registry (mirrors ops/src/health.ts conventions). */
export class HealthRegistry {
  private readonly reports = new Map<HealthComponentId, HealthComponentReport>();
  private readonly maxSilenceMs: number;
  private readonly failureThreshold: number;

  constructor(opts: HealthRegistryOptions = {}) {
    this.maxSilenceMs = opts.maxSilenceMs ?? 30 * 60 * 1000;
    this.failureThreshold = opts.failureThreshold ?? 3;
    const all: HealthComponentId[] = [
      "rpc-discovery",
      "rpc-verification",
      "discovery",
      "ingest",
      "activity",
      "evidence",
      "verifier",
      "journal",
    ];
    for (const id of all) {
      this.reports.set(id, {
        component: id,
        status: "degraded", // a component that has never reported is not "ok"
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        lastSuccessAtUnixMs: null,
        lastFailureAtUnixMs: null,
        lastErrorName: null,
        lastLatencyMs: null,
        recentErrors: [],
      });
    }
  }

  /** Record a successful stage run. */
  recordSuccess(component: HealthComponentId, latencyMs: number, atUnixMs = Date.now()): void {
    const r = this.reports.get(component);
    if (!r) return;
    r.successes++;
    r.consecutiveFailures = 0;
    r.lastSuccessAtUnixMs = atUnixMs;
    r.lastLatencyMs = latencyMs;
    r.status = "ok";
  }

  /** Record a failed stage run. */
  recordFailure(component: HealthComponentId, error: unknown, atUnixMs = Date.now()): void {
    const r = this.reports.get(component);
    if (!r) return;
    r.failures++;
    r.consecutiveFailures++;
    r.lastFailureAtUnixMs = atUnixMs;
    r.lastErrorName = errorName(error);
    r.recentErrors.unshift(r.lastErrorName);
    if (r.recentErrors.length > RECENT_ERROR_LIMIT) r.recentErrors.length = RECENT_ERROR_LIMIT;
    r.status = r.consecutiveFailures >= this.failureThreshold ? "failing" : "degraded";
  }

  /** Render the snapshot, re-evaluating silence-based degradation. */
  snapshot(nowUnixMs = Date.now()): HealthSnapshot {
    const components = [...this.reports.values()].map((r) => {
      const report = { ...r, recentErrors: [...r.recentErrors] };
      if (
        report.status === "ok" &&
        report.lastSuccessAtUnixMs !== null &&
        nowUnixMs - report.lastSuccessAtUnixMs > this.maxSilenceMs
      ) {
        report.status = "degraded";
      }
      return report;
    });
    const overall: HealthStatus = components.some((c) => c.status === "failing")
      ? "failing"
      : components.some((c) => c.status === "degraded")
        ? "degraded"
        : "ok";
    return { status: overall, generatedAtUnixMs: nowUnixMs, components };
  }
}

function errorName(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message.length > 0
        ? `${error.name}: ${error.message}`
        : error.name
      : String(error);
  return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
}
