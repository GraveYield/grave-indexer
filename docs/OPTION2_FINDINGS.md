# Option 2 — Paginated discovery + staged enrichment: findings, semantics and owner decisions

Status: implemented on `feat/option2-pipeline-hardening` (this branch). All changes verified
against the full offline battery (`test:offline` 612/612) and `tsconfig.typecheck.json`.
No release, tag, stable pointer, deployment or blockchain state was touched.

The companion SDK change (early exit in `deriveLastSwapEvidenceV4`) lives in
`GraveYield/graveyield-protocol` — see §7 for its delivery form and the owner decision it needs.

---

## 1. Provider contract evidence — Helius `getProgramAccountsV2`

Verified against the provider documentation
(https://www.helius.dev/docs/api-reference/rpc/http/getprogramaccountsv2, retrieved 2026-11-26):

Documented and relied upon:
* `limit` 1–10,000 accounts per page; `paginationKey` is a base58 cursor passed back verbatim.
* `withContext: true` nests `accounts`/`paginationKey` under `result.value` and adds
  `result.context.{slot, apiVersion}` (a per-page context slot — used for the bounded
  observation window, §3).
* `filters` (incl. `dataSize`), `dataSlice`, `commitment` (`confirmed|finalized|processed`)
  and `minContextSlot` behave as in classic gPA.
* End of pagination: "End of pagination is only indicated when **no accounts are returned**…
  always continue pagination until `paginationKey` is `null`."

Documented **ambiguity** the implementation refuses to guess at:
* The two end-of-pagination sentences conflict for a NONEMPTY page that returns a null
  cursor. `discoverRaydiumV4PoolsPaginated` treats that case as
  `ambiguous-pagination-end` → run incomplete (fail closed). An empty page with a NON-null
  cursor is `empty-page-with-cursor` → contract violation, incomplete.

NOT documented by the provider — **the production blocker**:
* No no-gap guarantee across pages.
* No no-duplicate guarantee across pages.
* No consistent-snapshot semantics: behavior for an account CREATED before the current
  cursor position mid-iteration is unspecified.
* No cursor-stability guarantee under concurrent account mutation between page requests.
* No documented maximum page count / per-run budget.

Consequence (by design): a page ledger proves which pages the CLIENT received; it does NOT
prove the provider returned every matching account. Even a "clean end" paginated run is
reported `provider-guarantees-unverified` (incomplete) until a live probe on the configured
provider establishes the missing guarantees. The probe procedure: run the classic
`getProgramAccounts` (bounded by `--max-pools`) and the paginated enumeration against the
same endpoint in the same epoch, compare account sets (pubkey + fingerprint) for
missing/extra entries, repeat across several runs and mutations, and record the provider's
written no-gap/no-duplicate commitment. That procedure requires a real provider endpoint
and credentials — it was NOT executed in this task (no Mainnet-scale runs authorized, no
provider credentials provided); see §8, owner decision D-2.

## 2. Mode gate (never a silent fallback)

`DISCOVERY_PAGINATION_MODE` (env; default `classic` = byte-identical previous behavior):

| mode | behavior when the capability probe FAILS |
| --- | --- |
| `classic` | unchanged classic gPA path (probe not even executed) |
| `paginated-strict` | command exits 1 with a `pagination-capability` failure record — refuses to run rather than fall back |
| `paginated-bounded-fallback` | classic gPA runs, but the artifact is forced `discovery-INCOMPLETE` with an explicit reason; classic gPA is a BOUNDED fallback only and can never present corpus completeness |

In every paginated mode the artifact additionally carries the run's completeness verdict
(`page-budget-exhausted`, `ambiguous-pagination-end`, `empty-page-with-cursor`,
`enumeration-failed`, `provider-guarantees-unverified`) as a `discovery-completeness`
failure record, and the exit code stays non-zero. A partial or unprovable enumeration can
never be endorsed as a complete production snapshot.

## 3. Slot consistency — bounded observation window (correction)

The classic path's `slotLowerBound`/`slotUpperBound` (getSlot before/after the single gPA
call) were never an atomic snapshot; with per-page enumeration the span is wider by
construction. The paginated adapter therefore records, per page, the provider's
`result.context.slot` (with `withContext: true`), plus:

* `observationWindow.kind: "bounded-observation-window"` — explicit, not an atomic snapshot;
* `slotMin`/`slotMax` across pages, `pagesWithSlot`/`pagesWithoutSlot` (missing slots are
  counted, never fabricated);
* commitment `finalized` on every page request.

The console-snapshot schema (v2) is intentionally UNCHANGED — provenance still carries the
classic bracket fields; the richer window lives in the discovery run stats/ledger and in
this document. Any schema extension (e.g. embedding the observation window in the artifact)
is a v3 schema bump requiring owner approval (§8, D-3).

## 4. History coverage (correction)

Unchanged and re-pinned by tests: an empty backward signature page does NOT prove full
history (a pruned/unindexed RPC is indistinguishable from an inactive pool);
`deriveLastSwapEvidenceV4` keeps the three-state model —
* empty signature response → `incomplete`, never `no_swap_in_scan`;
* a bounded scan that did not reach history end → `incomplete` unless a verified swap was found;
* unresolved candidates NEWER than the newest verified swap → `incomplete`.

The early exit (§7) never fires without a verified swap, so no-swap semantics are untouched.

## 5. Pipeline hardening delivered (Phase 1)

1. **Vault passthrough** — `ActivityIndexerLive.indexActivity` accepts
   `coinVault`/`pcVault` and forwards them to the SDK, removing the redundant per-pool
   AmmInfo fetch. Identity validation is NOT weakened: the vaults come from the same
   authoritative source (the pool's own parsed account data), the SDK still requires
   both-or-neither (partial knowledge still fetches), and wrong vaults fail corroboration
   closed (pinned by tests: identical anchor with known vaults; `incomplete` with wrong
   vaults; fetch preserved with a single vault).
2. **Retry-aware transport** (`src/rpcTransport.ts`) — bounded attempts (default 4),
   exponential backoff with full jitter, Retry-After honored (delta-seconds and HTTP-date),
   absolute deadline, typed `RpcRetryExhaustedError` / `RpcDeadlineExceededError`
   (exhaustion is an explicit state, never a fake success and never negative evidence),
   secret-free errors (endpoint KIND only — URLs may carry api-keys). Wired into the
   production `fetchProgramAccountsRaw`; the injected `fetchImpl` test seam is unchanged.
3. **Rate governor + bounded concurrency** (`governed`, `mapWithConcurrency`) —
   provider-aware spacing (public-rpc 250 ms / private-rpc 25 ms presets,
   `RPC_RATE_MIN_INTERVAL_MS` / `RPC_MAX_CONCURRENCY` overrides) and a semaphore
   (slot-transfer semantics pinned by tests, incl. no leak on failure). Enrichment runs
   `ENRICH_CONCURRENCY` workers (default 4) with per-pool accounting preserved and
   DETERMINISTIC output order (per-pool failures are collected and appended in input
   order).
4. **Validated batching** (`src/rpcBatching.ts`) — the four per-pool enrichment reads
   (2 × `getTokenAccountBalance`, 2 × `getTokenSupply`) go out as ONE JSON-RPC array with
   exhaustive response validation: 1:1 id mapping, per-item errors, missing items
   (`response_missing`), duplicates (`response_id_duplicate`), malformed envelopes.
   A missing/malformed response is UNRESOLVED — it can never become a zero balance or
   negative evidence; unresolved items are enrichment stage failures (fail-closed).
   Batch bound is conservative (`DEFAULT_BATCH_MAX_ITEMS = 20`,
   `maxBatchItems` overridable) — provider batch limits must be probed before raising
   (§8, D-2). The `discoveryConnection` test seam keeps the legacy per-pool path so the
   faked-RPC suites exercise identical enrichment semantics.

M1 invariants untouched: C1 threshold, C2 pending-state, C3/C4 pending-state, D-01
quote-side predicate (RPC filter + local gate re-assert), UNCX verification path, evidence
gate freshness, three-state evidence, completeness markers — all pinned by the pre-existing
suite (568 tests) plus the new suites.

## 6. C3/C4 funnel investigation — NOT activated (owner decision required)

Question: can C3 (WSOL-quote-vault ≥ 500,000,000 raw units) and C4 (LP supply > 1,000 raw)
be pushed into the RPC as response-shaping filters the way D-01 was (memcmp on
`pc_mint@432`)?

Findings:
* **C3 cannot be a server-side AmmInfo filter.** The WSOL vault BALANCE lives in the SPL
  token ACCOUNT (the vault pubkey at AmmInfo@336/@368), not in the 752-byte AmmInfo
  payload. A `memcmp` filter over `getProgramAccounts` on the Raydium V4 program cannot
  express it. Filtering the SPL-token program instead would require joining per-vault
  token accounts to pools client-side (another ~560k-account enumeration) — no funnel
  reduction without a second large query.
* **C4 (as an eligibility bound) also cannot be a server-side filter.** `memcmp` matches
  exact byte patterns / prefixes, not numeric ranges (`lp_amount`/LP supply ≥ 1000). Exact
  value matching is useless for a threshold. LP supply additionally lives on the LP MINT
  (SPL token program), not AmmInfo.
* **A practical, bounded client-side funnel** (activated only by owner decision): during
  enrichment, evaluate C3/C4 immediately after the batched reads and skip the expensive
  last-swap derivation for pools failing C3/C4. This does NOT shrink discovery (still
  identity-slice gPA) but cuts the dominant per-pool cost (N transaction fetches) for
  pools that would never qualify. Estimated saving scales with the fraction of
  low-reserve pools in the memcmp-filtered corpus — MEASUREMENT REQUIRED before any
  production claim (§8, D-4).
* **Compatibility if activated**: schema-v2 `criteria.c3MinTvl` already renders pass/fail
  from `minTvlLamports`; C4 ("lpBurned") is currently `pending` and semantically DIFFERENT
  from the raw >1,000 eligibility bound (C4 needs an attested original-supply baseline).
  The console, producer, verifier and publication pipeline all pin schema v2; any new
  criterion surface is a v3 bump + consumer migration. Conclusion: activation is a
  product decision (which pools enter the funnel) and a schema decision — both owner
  calls. NOTHING in this branch changes C3/C4 behavior.

## 7. Companion SDK change — early exit (requires owner action, cross-repo)

`deriveLastSwapEvidenceV4` (vendored SDK, `graveyield-protocol/sdk/src/lastSwapAttestation.ts`)
now stops after the newest verified economic swap is established and every newer candidate
is resolved. Decision fields are unchanged; `scan` gains additive `earlyExit` /
`signaturesExamined`; the exit never fires while a newer candidate is unresolved and never
fires without a verified swap (no-swap semantics untouched). Parity evidence: the full
pre-existing SDK suite passes (249/249) except one explicit candidate-truncation pin
(updated with rationale), plus nine new scenario-matrix tests.

**Delivery form:** the change is committed locally as protocol `e448f60` on branch
`feat/sdk-early-exit-newest-verified-swap` and included in THIS branch as an
apply-ready patch: `docs/option2/sdk-early-exit-companion.patch` (`git am`).
The remote branch was created (at `main` = `0fd4abb`) but the commit could not be pushed
from this sandbox (no git credentials; the GitHub API path available here cannot carry the
two ~42 KB modified files reliably). This is the "modify another repository" case the task
authorizations gate behind owner approval — merging the companion PR is owner decision
D-1. Until it lands, the indexer's submodule pin is UNCHANGED and the indexer PR is fully
green WITHOUT the early exit (the early exit is purely additive upstream).

UPDATE (2026-11-26): the SDK branch HAS now been pushed via the GitHub API —
`GraveYield/graveyield-protocol:feat/sdk-early-exit-newest-verified-swap` carries the
complete change (commits on top of `main` = `0fd4abb`); the patch below remains as the
apply-ready equivalent.

## 8. Owner decisions requested

| # | decision | why it is not taken unilaterally |
| --- | --- | --- |
| D-1 | Merge the companion SDK PR (patch: `docs/option2/sdk-early-exit-companion.patch`) | cross-repo change; changes vendor pin timing |
| D-2 | Provide a Helius (or equivalent) endpoint + credentials for the §1 probe; approve a bounded Mainnet measurement run | completeness guarantees must be verified LIVE; large Mainnet loads are out of scope |
| D-3 | Approve a schema-v3 that embeds the bounded observation window + page ledger in console snapshots | schema bump touches producer/verifier/console |
| D-4 | Decide whether to activate the client-side C3/C4 funnel (§6) | product + schema decision; requires measurement first |

## 9. Operational configuration (defaults; tune from measured behavior only)

| env | default | meaning |
| --- | --- | --- |
| `DISCOVERY_PAGINATION_MODE` | `classic` | `classic` / `paginated-strict` / `paginated-bounded-fallback` |
| `ENRICH_CONCURRENCY` | `4` | enrichment workers per snapshot run |
| `RPC_RATE_MIN_INTERVAL_MS` | provider preset (250 public / 25 private) | min spacing between RPC issuances |
| `RPC_MAX_CONCURRENCY` | `8` | max in-flight governed requests |

Rollback: every behavior change is env-gated or additive. Setting
`DISCOVERY_PAGINATION_MODE=classic` and `ENRICH_CONCURRENCY=4` restores the previous
sequential semantics except (a) production gPA now uses the retry transport and (b) the
four enrichment reads are batched — both are pure transport changes; revert the branch to
restore byte-identical v0 behavior. No schema, threshold or evidence-semantics rollback
surface exists.

## 10. Local measurements (test harness only — NOT production claims)

* Enrichment batching: 4 HTTP round trips per pool → 1 (75% fewer round trips for the
  balance/supply stage), verified by fetch-call counting in tests.
* SDK early exit: for a window [deposit, verified swap, deposit, deposit] the scan
  performs 2 transaction fetches instead of 4; for [verified swap at newest, older
  candidates…] exactly 1 instead of N. Savings scale with the position of the newest
  verified swap inside the window; NO saving for pools with no verified swap in the
  window (measured in `sdk` tests via `LastSwapFakeRpc.txFetches`).
* Rate governor: enforced 100 ms spacing at `minIntervalMs=100` and a hard peak of 3
  concurrent executions at `maxInFlight=3` (measured, deterministic clock tests).
* Mainnet end-to-end figures (561,483-account corpus, 429 behavior, wall-clock) are
  EXPLICITLY NOT measured here — see D-2.
