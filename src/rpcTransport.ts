// SPDX-License-Identifier: Apache-2.0
//
// Retry-aware JSON-RPC transport with a provider-aware rate governor and
// bounded concurrency (Option 2 — Part 1 item B/C).
//
// Properties:
//
//   * BOUNDED RETRIES — a small, finite retry budget per request over the
//     retryable class (HTTP 429, 5xx, network/transport failures). Never
//     unbounded: when the budget is exhausted the request FAILS with an
//     explicit `RpcRetryExhaustedError` — exhaustion is a typed outcome
//     the caller must surface, never a silent success and never negative
//     evidence.
//   * EXPONENTIAL BACKOFF + JITTER — full jitter over an exponentially
//     growing window; deterministic per attempt via an injectable RNG so
//     tests are reproducible.
//   * RETRY-AFTER — an HTTP 429 (or 503) carrying `Retry-After` (seconds
//     or HTTP-date) is honored once, capped by the deadline budget.
//   * DEADLINES — an absolute wall-clock deadline bounds the WHOLE
//     request (including all retries); expiry raises
//     `RpcDeadlineExceededError` (typed, fail-closed).
//   * SECRET-FREE ERRORS — error messages never embed the RPC URL (it
//     may carry an api-key query parameter); only the endpoint KIND is
//     recorded (provenance.ts convention).
//   * RATE GOVERNOR — a process-global governor throttles RPC issuance
//     per endpoint kind (provider-aware defaults; env-overridable), so
//     concurrent enrichment across pools cannot stampede a public
//     endpoint. Bounded concurrency (a semaphore) bounds simultaneous
//     in-flight requests.
//
// This module NEVER converts a transport failure into a successful
// response or into negative evidence: it either returns a validated
// response or throws a typed error.

import { endpointKindFor, type EndpointKind } from "./provenance.js";

/** Typed error: the bounded retry budget was exhausted. */
export class RpcRetryExhaustedError extends Error {
  override readonly name = "RpcRetryExhaustedError";
  /** Endpoint kind (never the URL). */
  readonly endpointKind: EndpointKind;
  /** Attempts actually made (including the first). */
  readonly attempts: number;
  /** Last observed HTTP status, when any (0 for transport failures). */
  readonly lastHttpStatus: number;
  /** Whether the final failure carried a Retry-After we could not honor. */
  readonly retryAfterUnhonored: boolean;
  /** The last underlying failure text (truncated; secret-free). */
  readonly lastError: string;

  constructor(
    endpointKind: EndpointKind,
    attempts: number,
    lastHttpStatus: number,
    retryAfterUnhonored: boolean,
    lastError = "",
  ) {
    super(
      `RPC request failed after ${attempts} attempt(s) (endpoint kind ${endpointKind}, ` +
        `last HTTP status ${lastHttpStatus || "none"}) — retry budget exhausted` +
        (retryAfterUnhonored ? "; a Retry-After hint could not be honored within the deadline" : "") +
        (lastError ? ` — last failure: ${lastError}` : ""),
    );
    this.endpointKind = endpointKind;
    this.attempts = attempts;
    this.lastHttpStatus = lastHttpStatus;
    this.retryAfterUnhonored = retryAfterUnhonored;
    this.lastError = lastError;
  }
}

/** Typed error: the absolute request deadline expired before success. */
export class RpcDeadlineExceededError extends Error {
  override readonly name = "RpcDeadlineExceededError";
  readonly endpointKind: EndpointKind;
  readonly deadlineMs: number;

  constructor(endpointKind: EndpointKind, deadlineMs: number) {
    super(`RPC request exceeded its ${deadlineMs} ms deadline (endpoint kind ${endpointKind})`);
    this.endpointKind = endpointKind;
    this.deadlineMs = deadlineMs;
  }
}

/**
 * Typed error: the provider returned a PERMANENT JSON-RPC error inside an
 * HTTP-success response (protocol/usage error — retrying cannot fix it).
 * Fail fast, explicit; never converted into a fake success or negative
 * evidence.
 */
export class JsonRpcPermanentError extends Error {
  override readonly name = "JsonRpcPermanentError";
  readonly endpointKind: EndpointKind;
  /** JSON-RPC error code from the response envelope. */
  readonly code: number;

  constructor(endpointKind: EndpointKind, code: number, detail: string) {
    super(
      `RPC returned a permanent JSON-RPC error (endpoint kind ${endpointKind}, code ${code}) — ` +
        `retrying cannot fix a protocol/usage error — ${detail}`,
    );
    this.endpointKind = endpointKind;
    this.code = code;
  }
}

/**
 * Classification of an IN-BAND JSON-RPC error object (HTTP success, body
 * carries `{ error: { code, message } }`):
 *
 *   RETRYABLE — provider-side transient conditions: the JSON-RPC server
 *   error range (-32000..-32099, which includes rate-limit/limit-exceeded
 *   codes such as -32005 and generic "server error" -32000) and internal
 *   error -32603, plus a message-based guard for providers that report
 *   rate limiting with non-standard codes ("rate limit", "too many
 *   requests", "please try again", "temporarily unavailable").
 *
 *   PERMANENT — protocol/usage errors retrying cannot fix: -32700
 *   (parse), -32600 (invalid request), -32601 (method not found),
 *   -32602 (invalid params). ANY UNKNOWN code is classified PERMANENT:
 *   an error of unknown semantics cannot be safely retried (it may be an
 *   invalid request that would fail identically), and the retry budget is
 *   reserved for KNOWN transient conditions. Fail-closed either way — the
 *   caller sees a typed error, never a fabricated result.
 */
export type JsonRpcErrorClass = "retryable" | "permanent";

const RETRYABLE_MESSAGE_RE = /rate limit|too many requests|please try again|temporarily unavailable/;

export function classifyJsonRpcError(error: unknown): JsonRpcErrorClass {
  if (error === null || typeof error !== "object") return "permanent";
  const e = error as { code?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (RETRYABLE_MESSAGE_RE.test(message)) return "retryable";
  if (typeof e.code !== "number" || !Number.isFinite(e.code)) return "permanent";
  if (e.code === -32603) return "retryable"; // internal error (server hiccup)
  if (e.code >= -32099 && e.code <= -32000) return "retryable"; // server error range (incl. -32005)
  if (e.code === -32700 || e.code === -32600 || e.code === -32601 || e.code === -32602) return "permanent";
  return "permanent"; // unknown code: never guess retryability
}

/** Transport configuration (all bounds REQUIRED to be finite). */
export interface RpcTransportOptions {
  /** Total retry attempts INCLUDING the first (must be >= 1). Default 4. */
  maxAttempts?: number;
  /** Base delay for exponential backoff (ms). Default 250. */
  baseDelayMs?: number;
  /** Backoff cap (ms). Default 8,000. */
  maxDelayMs?: number;
  /** Absolute deadline for the whole request incl. retries (ms). Default 30,000. */
  deadlineMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable RNG for jitter (tests). Defaults to Math.random. */
  rng?: () => number;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Handle IN-BAND JSON-RPC errors (HTTP success + `{ error }` body):
   *  classify and retry RETRYABLE ones within the SAME bounded budget and
   *  deadline as HTTP-level failures; PERMANENT ones fail immediately as
   *  `JsonRpcPermanentError`. Default false — callers that inspect the
   *  envelope themselves (e.g. batch arrays, capability probes with typed
   *  verdicts) keep the raw envelope. Exhaustion raises the TYPED
   *  `RpcRetryExhaustedError`; a failed call NEVER becomes a fake success,
   *  a zero balance or negative evidence. */
  retryJsonRpcErrors?: boolean;
}

export interface ResolvedTransportOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  deadlineMs: number;
  fetchImpl: typeof fetch;
  rng: () => number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  retryJsonRpcErrors: boolean;
}

export function resolveTransportOptions(opts?: RpcTransportOptions): ResolvedTransportOptions {
  const maxAttempts = opts?.maxAttempts ?? 4;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  return {
    maxAttempts,
    baseDelayMs: opts?.baseDelayMs ?? 250,
    maxDelayMs: opts?.maxDelayMs ?? 8_000,
    deadlineMs: opts?.deadlineMs ?? 30_000,
    fetchImpl: opts?.fetchImpl ?? fetch,
    rng: opts?.rng ?? Math.random,
    now: opts?.now ?? Date.now,
    sleep: opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    retryJsonRpcErrors: opts?.retryJsonRpcErrors ?? false,
  };
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) → delay ms, or null. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? seconds * 1_000 : null;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

/** Full-jitter backoff delay for a retry attempt (1-based retry index). */
export function backoffDelayMs(retryIndex: number, baseMs: number, maxMs: number, rng: () => number): number {
  const exp = baseMs * 2 ** Math.min(retryIndex - 1, 16);
  const cap = Math.min(exp, maxMs);
  // full jitter: uniform in [0, cap]
  return Math.floor(rng() * cap);
}

const RETRYABLE_STATUS = new Set([425, 429, 500, 502, 503, 504]);

/** One validated JSON-RPC HTTP request under the retry-aware transport. */
export async function rpcJsonRequest(
  rpcUrl: string,
  body: unknown,
  opts?: RpcTransportOptions,
): Promise<unknown> {
  const o = resolveTransportOptions(opts);
  const endpointKind = endpointKindFor(rpcUrl);
  const deadline = o.now() + o.deadlineMs;
  let attempts = 0;
  let lastHttpStatus = 0;
  let retryAfterUnhonored = false;

  while (attempts < o.maxAttempts) {
    const remaining = deadline - o.now();
    if (remaining <= 0) {
      throw new RpcDeadlineExceededError(endpointKind, o.deadlineMs);
    }
    attempts++;
    let res: Response;
    try {
      res = await o.fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // AbortSignal.timeout bounds THIS attempt; the overall deadline
        // bounds the whole loop. (Node >= 17.3)
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      // Transport failure (network, timeout). Retryable within budget.
      lastHttpStatus = 0;
      if (attempts >= o.maxAttempts || deadline - o.now() <= 0) {
        if (deadline - o.now() <= 0 && attempts < o.maxAttempts) {
          throw new RpcDeadlineExceededError(endpointKind, o.deadlineMs);
        }
        if (attempts >= o.maxAttempts) {
          throw new RpcRetryExhaustedError(endpointKind, attempts, lastHttpStatus, false, String(err).slice(0, 200));
        }
      }
      const delay = backoffDelayMs(attempts, o.baseDelayMs, o.maxDelayMs, o.rng);
      if (o.now() + delay >= deadline) {
        throw new RpcDeadlineExceededError(endpointKind, o.deadlineMs);
      }
      await o.sleep(delay);
      continue;
    }

    if (!res.ok) {
      lastHttpStatus = res.status;
      const retryAfterRaw = res.headers.get("retry-after");
      const retryAfterMs = parseRetryAfter(retryAfterRaw, o.now());
      // Drain the body so the socket is released even on failure paths.
      try {
        await res.arrayBuffer();
      } catch {
        /* body already consumed / connection torn down */
      }
      if (!RETRYABLE_STATUS.has(res.status)) {
        // Non-retryable HTTP status: fail immediately, typed and explicit.
        throw new Error(
          `RPC HTTP ${res.status} from ${endpointKind} endpoint — non-retryable status`,
        );
      }
      if (attempts >= o.maxAttempts) {
        throw new RpcRetryExhaustedError(endpointKind, attempts, lastHttpStatus, false);
      }
      const backoff =
        retryAfterMs !== null && retryAfterMs > 0
          ? Math.min(retryAfterMs, Math.max(0, deadline - o.now()))
          : backoffDelayMs(attempts, o.baseDelayMs, o.maxDelayMs, o.rng);
      if (retryAfterMs !== null && retryAfterMs > o.deadlineMs) {
        retryAfterUnhonored = true;
      }
      if (o.now() + backoff >= deadline) {
        retryAfterUnhonored = retryAfterUnhonored || retryAfterMs !== null;
        throw new RpcDeadlineExceededError(endpointKind, o.deadlineMs);
      }
      await o.sleep(backoff);
      continue;
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      // Malformed body: retryable within budget (provider hiccup).
      lastHttpStatus = res.status;
      if (attempts >= o.maxAttempts) {
        throw new RpcRetryExhaustedError(endpointKind, attempts, lastHttpStatus, false);
      }
      const delay = backoffDelayMs(attempts, o.baseDelayMs, o.maxDelayMs, o.rng);
      if (o.now() + delay >= deadline) {
        throw new RpcDeadlineExceededError(endpointKind, o.deadlineMs);
      }
      await o.sleep(delay);
      continue;
    }

    // IN-BAND JSON-RPC error handling (opt-in): the HTTP exchange
    // succeeded but the body carries `{ error }`. Classification decides
    // between a bounded retry (same budget + deadline as HTTP failures;
    // Retry-After honored when the provider supplies the header even on a
    // 200) and an immediate typed permanent failure. The attempt counter
    // is SHARED with the HTTP-level retries, so the total budget stays
    // bounded exactly as documented.
    if (o.retryJsonRpcErrors && json !== null && typeof json === "object") {
      const envelope = json as { error?: unknown };
      if (envelope.error !== undefined && envelope.error !== null) {
        const errObj = envelope.error as { code?: unknown; message?: unknown };
        const code = typeof errObj.code === "number" ? errObj.code : 0;
        const detail = JSON.stringify(envelope.error).slice(0, 200);
        if (classifyJsonRpcError(envelope.error) === "permanent") {
          throw new JsonRpcPermanentError(endpointKind, code, detail);
        }
        lastHttpStatus = res.status;
        if (attempts >= o.maxAttempts) {
          throw new RpcRetryExhaustedError(
            endpointKind,
            attempts,
            lastHttpStatus,
            false,
            `retryable JSON-RPC error (code ${code}): ${detail}`,
          );
        }
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), o.now());
        const backoff =
          retryAfterMs !== null && retryAfterMs > 0
            ? Math.min(retryAfterMs, Math.max(0, deadline - o.now()))
            : backoffDelayMs(attempts, o.baseDelayMs, o.maxDelayMs, o.rng);
        if (retryAfterMs !== null && retryAfterMs > o.deadlineMs) {
          retryAfterUnhonored = true;
        }
        if (o.now() + backoff >= deadline) {
          retryAfterUnhonored = retryAfterUnhonored || retryAfterMs !== null;
          throw new RpcDeadlineExceededError(endpointKind, o.deadlineMs);
        }
        await o.sleep(backoff);
        continue;
      }
    }
    return json;
  }
  throw new RpcRetryExhaustedError(endpointKind, attempts, lastHttpStatus, retryAfterUnhonored);
}

// ---------------------------------------------------------------------
// Provider-aware rate governor (process-global)
// ---------------------------------------------------------------------

/**
 * Provider presets: minimum spacing between consecutive RPC issuances
 * per endpoint kind. The public cluster RPC is aggressively rate-limited
 * (the previous validation observed 85 HTTP 429s); private providers
 * tolerate tighter spacing. These are POLICY DEFAULTS — operators
 * override via env (RPC_RATE_MIN_INTERVAL_MS) and callers may pass
 * explicit values. Production caps must be chosen from measured
 * behavior, never from these defaults alone.
 */
const PROVIDER_MIN_INTERVAL_MS: Record<EndpointKind, number> = {
  "public-rpc": 250,
  "private-rpc": 25,
};

interface GovernorState {
  /** RESERVATION bookkeeping: the latest RESERVED (possibly still future)
   *  issuance instant. Used only to stagger callers' initial wake-ups;
   *  spacing is NEVER enforced against this value (see claimIssuance). */
  lastReservedAtMs: number;
  hasReserved: boolean;
  /** ACTUAL issuance: the real start time of the most recent operation
   *  handed to `fn`. Spacing is enforced against THIS value, never
   *  against reservations — a delayed wake-up must re-queue, not issue. */
  lastActualIssuedAtMs: number;
  hasIssued: boolean;
  /** Semaphore: currently in-flight requests. */
  inFlight: number;
  waiters: Array<{ resolve: () => void; cancel: () => void }>;
  /** Serialized chain for the two SHORT synchronous critical sections:
   *  (a) computing + recording a reservation, and (b) claiming an actual
   *  issuance instant. Without (a), two concurrent callers could both
   *  read the same state, compute the SAME remaining wait, sleep
   *  together and wake together (thundering herd). Without (b), callers
   *  whose timers all became overdue during an event-loop stall would
   *  wake together and issue together (see the delayed-wake regression
   *  test). The lock is never held across a sleep or `fn`, so a slow or
   *  failing caller never blocks other callers' scheduling. */
  scheduleLock: Promise<void>;
}

const GOVERNORS = new Map<string, GovernorState>();

export interface RateGovernorOptions {
  /** Minimum spacing between consecutive issuances (ms). */
  minIntervalMs?: number;
  /** Max simultaneous in-flight requests (bounded concurrency). */
  maxInFlight?: number;
}

export interface ResolvedGovernorOptions {
  minIntervalMs: number;
  maxInFlight: number;
}

/** Resolve governor options: explicit > env > provider preset. */
export function resolveGovernorOptions(
  endpointKind: EndpointKind,
  opts?: RateGovernorOptions,
): ResolvedGovernorOptions {
  const envInterval = Number.parseInt(process.env.RPC_RATE_MIN_INTERVAL_MS ?? "", 10);
  const envConcurrency = Number.parseInt(process.env.RPC_MAX_CONCURRENCY ?? "", 10);
  const preset = PROVIDER_MIN_INTERVAL_MS[endpointKind] ?? 250;
  const minIntervalMs =
    opts?.minIntervalMs ??
    (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : preset);
  const maxInFlight =
    opts?.maxInFlight ??
    (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : 8);
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error(`minIntervalMs must be >= 0, got ${minIntervalMs}`);
  }
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error(`maxInFlight must be a positive integer, got ${maxInFlight}`);
  }
  return { minIntervalMs, maxInFlight };
}

function governorState(kind: string): GovernorState {
  let s = GOVERNORS.get(kind);
  if (!s) {
    s = {
      lastReservedAtMs: 0,
      hasReserved: false,
      lastActualIssuedAtMs: 0,
      hasIssued: false,
      inFlight: 0,
      waiters: [],
      scheduleLock: Promise.resolve(),
    };
    GOVERNORS.set(kind, s);
  }
  return s;
}

/** Run `critical` as the exclusive holder of the governor's scheduleLock.
 *  The chain is joined BEFORE any await (so ordering matches arrival) and
 *  released in a `finally` even if the injected clock throws. `critical`
 *  must stay synchronous-ish: it may read the clock, but it must NOT
 *  sleep or run `fn` while holding the chain. */
async function withScheduleLock<T>(state: GovernorState, critical: () => T): Promise<T> {
  let releaseSchedule: () => void = () => {};
  const prevSchedule = state.scheduleLock;
  state.scheduleLock = new Promise<void>((resolve) => {
    releaseSchedule = resolve;
  });
  try {
    await prevSchedule;
    return critical();
  } finally {
    releaseSchedule();
  }
}

/** Phase 1 — RESERVE (serialized): compute this caller's initial wait
 *  from the reservation chain and atomically reserve the next staggered
 *  instant. Two concurrent callers can never reserve the same instant.
 *  Returns the ms to sleep before the claim phase (0 = issue attempt
 *  now). Reservations only STAGGER wake-ups; they never authorize an
 *  issuance by themselves. */
function reserveIssuance(state: GovernorState, minIntervalMs: number, now: () => number): Promise<number> {
  return withScheduleLock(state, () => {
    const t = now();
    let waitMs = 0;
    if (state.hasReserved) {
      const earliest = state.lastReservedAtMs + minIntervalMs;
      if (t < earliest) waitMs = earliest - t;
    }
    state.hasReserved = true;
    state.lastReservedAtMs = t + waitMs;
    return waitMs;
  });
}

/** Phase 3 — CLAIM (serialized): re-check spacing against ACTUAL issuance
 *  times at wake-up. Returns 0 when the caller may issue NOW (its actual
 *  start is then recorded as `lastActualIssuedAtMs`); otherwise returns
 *  the remaining ms to sleep, after which the caller must claim AGAIN.
 *  This is what guarantees spacing when reality diverges from the
 *  schedule: an event-loop stall can make several reserved timers
 *  overdue simultaneously, and only one of them may pass this gate per
 *  `minIntervalMs` window — the others re-queue with the remaining wait. */
function claimIssuance(state: GovernorState, minIntervalMs: number, now: () => number): Promise<number> {
  return withScheduleLock(state, () => {
    const t = now();
    if (state.hasIssued) {
      const earliest = state.lastActualIssuedAtMs + minIntervalMs;
      if (t < earliest) return earliest - t;
    }
    state.hasIssued = true;
    state.lastActualIssuedAtMs = t;
    return 0;
  });
}

function acquireSlot(state: GovernorState, maxInFlight: number): Promise<void> {
  if (state.inFlight < maxInFlight) {
    state.inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, cancel) => {
    // The slot is TRANSFERRED on release (releaseSlot does not decrement
    // when handing off), so the waiter resolves WITHOUT incrementing.
    state.waiters.push({ resolve, cancel });
  });
}

function releaseSlot(state: GovernorState): void {
  const next = state.waiters.shift();
  if (next) {
    next.resolve(); // hand the slot directly to the next waiter (inFlight unchanged)
  } else {
    state.inFlight = Math.max(0, state.inFlight - 1);
  }
}

/** Reset governor state (tests only). */
export function resetGovernors(): void {
  for (const w of [...GOVERNORS.values()].flatMap((s) => s.waiters)) w.cancel();
  GOVERNORS.clear();
}

/** Test introspection: current in-flight count for an endpoint kind. */
export function governorInFlight(endpointKind: EndpointKind): number {
  return GOVERNORS.get(endpointKind)?.inFlight ?? 0;
}

/**
 * Issue `fn` under the rate governor for `endpointKind`: bounded
 * concurrency (max in-flight) + minimum spacing between ACTUAL request
 * starts. Rejections propagate; the slot is always released.
 *
 * CONCURRENCY-SAFE ISSUANCE SCHEDULING is a three-phase protocol:
 *
 *   Phase 1 — RESERVE (serialized by `state.scheduleLock`, purely
 *   synchronous): the caller reads the reservation chain, computes its
 *   earliest permitted issuance instant, and atomically RESERVES that
 *   instant. Because the reservation is serialized, two concurrent
 *   callers can never reserve the same instant — each receives a
 *   distinct, staggered wake-up target.
 *
 *   Phase 2 — WAIT (outside the lock): the caller sleeps until its
 *   reserved instant. This staggers callers so they do not all contend
 *   for the claim gate at once.
 *
 *   Phase 3 — CLAIM (serialized again): after waking, the caller
 *   re-checks spacing against ACTUAL issuance times (`lastActualIssued-
 *   AtMs`) before issuing. If reality diverged from the schedule — e.g.
 *   an event-loop stall made several reserved timers overdue
 *   simultaneously — exactly ONE overdue caller passes the gate per
 *   `minIntervalMs` window; the others receive the remaining wait and
 *   re-claim after sleeping. Reservations never authorize an issuance:
 *   only a successful claim does, and a claim records the ACTUAL start
 *   time. Spacing therefore holds between real request starts, not just
 *   between scheduled ones.
 *
 * The lock is never held across a sleep or `fn` — a slow or failing
 * caller cannot block other callers' scheduling or claims. A rejection
 * from `fn` propagates after its slot is released and leaves the spacing
 * state untouched, so an early failure cannot permanently block later
 * callers. `minIntervalMs = 0` makes both reservation and claim instantaneous,
 * preserving the pure-semaphore behavior (bounded only by
 * `maxInFlight`). Endpoint-kind isolation and process-global sharing
 * are unchanged (state is keyed by kind).
 */
export async function governed<T>(
  endpointKind: EndpointKind,
  fn: () => Promise<T>,
  opts?: RateGovernorOptions,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<T> {
  const { minIntervalMs, maxInFlight } = resolveGovernorOptions(endpointKind, opts);
  const state = governorState(endpointKind);
  const slot = await acquireSlot(state, maxInFlight);
  try {
    // Phase 1 — RESERVE a staggered wake-up target (serialized).
    let waitMs = await reserveIssuance(state, minIntervalMs, now);
    // Phases 2+3 — WAIT, then CLAIM against actual issuance times.
    // A claim that finds itself too early returns the remaining wait;
    // the caller sleeps and re-claims until it passes the gate.
    for (;;) {
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      waitMs = await claimIssuance(state, minIntervalMs, now);
      if (waitMs === 0) break;
    }
    return await fn();
  } finally {
    releaseSlot(state);
  }
}

/**
 * Map over `items` with bounded concurrency, preserving RESULT ORDER
 * (deterministic regardless of completion order). Worker count is
 * bounded by `concurrency` (positive integer).
 */
export async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  worker: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  }
  const out = new Array<TOut>(items.length);
  let nextIndex = 0;
  const workers: Promise<void>[] = [];
  const n = Math.min(concurrency, items.length);
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = nextIndex++;
          if (i >= items.length) return;
          out[i] = await worker(items[i]!, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}
