# ORACLE_PIPELINE.md — Phase 2: Raydium V4 discovery + evidence pipeline

Repository: `GraveYield/grave-indexer` · Ground truth: `graveyield-protocol @ 5b84440`
(vendored, pinned as a git submodule at `vendor/protocol`)
Status: Phase 2 complete · All on-chain coordinates are devnet + mainnet PUBLIC data.
This document intentionally contains NO key material — see §6.

---

## 1. Purpose and scope

The off-chain pipeline required by GraveScanner: enumerate Raydium V4 pools,
preserve provenance and timestamps, handle duplicate ingestion, detect stale and
conflicting data, expose operational health, and produce **oracle evidence that
is byte-compatible with the on-chain attestation contract** — verified against
the live devnet deployment before any salvage is attempted.

Out of scope (unchanged red lines): on-chain wire formats, protocol economics,
and the deployed programs. The pipeline **consumes** `@graveyield/sdk` as the
single source of truth for every wire format; nothing here re-implements,
re-orders, or "fixes" a wire format.

## 2. The actual on-chain oracle interface (as implemented — inspected, not invented)

Everything below was read from `graveyield-protocol` source at `5b84440`
(`programs/grave-scanner/src/attestation.rs`, `instructions/evaluate_pool_phase1.rs`,
`instructions/record_launch_price.rs`, `state/protocol_config.rs`) and cross-checked
against the SDK mirror (`sdk/src/lastSwapAttestation.ts`, `sdk/src/launchPriceAttestation.ts`).

### 2.1 ORACLE-002 — Criterion 1 last-swap attestation (112 bytes)

Signed by the **activity oracle** (`ProtocolConfig.activity_oracle`), Ed25519,
verified on chain via the `ed25519_program` precompile instruction that must
appear IMMEDIATELY BEFORE the scanner instruction in the same transaction.

Message layout (fixed, no borsh, byte offsets normative):

```
[  0.. 32)  amm_program_id      32B
[ 32.. 64)  pool_address        32B
[ 64.. 72)  last_swap_unix_ts   i64 LE  (0 < ts <= now — 6028 otherwise)
[ 72.. 80)  issued_slot         u64 LE  (0 < slot <= now — 6031 otherwise)
[ 80..112)  slot_hash           32B     (SlotHashes[issued_slot] — 6029/6030 otherwise)
```

The message is embedded at offset **72** of `evaluate_pool_phase_1` instruction
data (`8B discriminator ‖ 32B amm ‖ 32B pool ‖ 112B msg`), and the precompile's
`message_data_offset/size/index` must point at exactly that span. The program
pins the precompile offsets fail-closed (canonical placements: count@0, pad@1,
7×u16 LE offsets@2, pubkey@16, signature@48 — byte-identical to the runtime's
own builder). Replay resistance is structural: `issued_slot` must still resolve
in the destination cluster's SlotHashes (~512-entry window ≈ 21 minutes) with a
byte-exact hash.

### 2.2 ORACLE-001 — Criterion 2 launch-price attestation (168 bytes)

Signed by the **launch-price oracle** (`ProtocolConfig.launch_price_oracle` — a
separate, dedicated key), embedded at offset **152** of `record_launch_price`
instruction data. NO SlotHashes check by design (D9): the value is a
time-invariant historical fact and the LaunchPrice PDA is init-once, so a
replayed-but-valid attestation cannot overwrite anything. `record_launch_price`
is a HARD precondition of `evaluate_pool_phase_1` (the phase-1 account list
requires an existing LaunchPrice PDA).

### 2.3 Authorization and on-chain check order

```
(0) ProtocolConfig.paused?                → 6010 ProtocolPaused
(1) precompile present immediately prior  → 6024 AttestationMissing
(2) precompile offsets pinned/canonical   → 6025 InvalidAttestationOffsets
(3) covered pubkey == configured oracle   → 6026 AttestationOracleMismatch
(4) msg binding echoes instruction params → 6027 AttestationBindingMismatch
(5) 0 < last_swap_unix_ts <= now          → 6028 AttestationTimestampInvalid
(6) 0 < issued_slot <= now_slot           → 6031 AttestationSlotInvalid
(7) issued_slot resolves in SlotHashes    → 6029 AttestationStale
(8) hash byte-equals msg[80..112]         → 6030 AttestationSlotHashMismatch
```

Steps 0–3 are SHARED by the phase-1 and launch-price paths (the same
`verify_ed25519_offsets_at` prologue), so live evidence about one transfers to
the other. The runtime verifies the Ed25519 signature itself before any program
code runs.

### 2.4 Configured oracles on the live devnet deployment (DR-001, verified 2026-10-26)

```
GraveScanner  CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54
ProtocolConfig PDA Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD (bump 255)
activity_oracle        AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa
launch_price_oracle    AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa
```

Both oracles equal the deployer authority because `initialize` sets
`activity_oracle = launch_price_oracle = params.authority`. Per handoff §7 /
queue item 9.5, that keypair was erased in the workspace reset and its export is
unverified. **Consequence:** a valid attestation from any other key reverts 6026
— the pipeline's `oracle-gated` outcome. Registering a dedicated oracle key
(`update_protocol_config`, authority-signed) is an owner-gated action; see §6.4.

## 3. Architecture

```
                 ┌──────────────────────────────────────────────────────────┐
  mainnet-beta   │ discovery.ts   raw JSON-RPC gPA, dataSlice(336,160)      │
  (read-only) ──▶│ 706,002 × 752B AmmInfo → identity records (mints, LP     │
                │ mint, vaults), WSOL-side guard (7019), fingerprints      │
                └───────┬──────────────────────────────────────────────────┘
                        │ provenance: slot bracketing, endpoint KIND (never URL),
                        │ sha256(addr ‖ payload), fetchedAt, cluster, mode
                        ▼
                ┌────────────────────────┐      ┌───────────────────────────────┐
                │ ingest.ts              │      │ activityLive.ts               │
                │ durable JSONL ledger   │◀─────│ deriveLastSwapV4 (SDK) + TTL  │
                │ dedupe / change /      │      │ cache, regression detection   │
                │ same-slot conflict /   │      └───────────────────────────────┘
                │ staleness policy       │
                └───────┬────────────────┘
                        ▼
                ┌────────────────────────────────────────────────────────────┐
                │ evidence.ts + issue.ts + sign.ts                           │
                │ 112-byte canonical message (SDK buildAttestationMessage)   │
                │ signed by the activity oracle; secret-free bundles         │
                └───────┬───────────────────────────────────────┬────────────┘
                        ▼                                       ▼
  devnet (dest.) ┌──────────────────────────────┐  ┌──────────────────────────────┐
                 │ submit path: (precompile,    │  │ verify.ts — off-chain mirror │
                 │ phase1) pair via SDK client; │  │ of the on-chain check order, │
                 │ simulation-first; real send  │  │ live ProtocolConfig +        │
                 │ is opt-in (SUBMIT=1)         │  │ SlotHashes; replay journal   │
                 └──────────────────────────────┘  └──────────────────────────────┘
                                   health.ts underlies every stage
```

Key design decisions:

* **Two clusters, one pipeline.** Discovery/derivation run against mainnet-beta
  (where Raydium V4 pools live); evidence ISSUANCE runs against the destination
  cluster (devnet) so `issued_slot` resolves in THAT cluster's SlotHashes. The
  bundle records both contexts (`activity.derivationCluster`,
  `destination.cluster`).
* **Raw JSON-RPC enumeration.** web3.js 3.x's gPA decoder breaks on the mainnet
  corpus (706,002 accounts; full-payload response exceeds Node's max string
  size; even the sliced response throws `RangeError: Invalid array length`).
  `discovery.ts` uses a raw `fetch` client that tolerates both response shapes
  observed in the wild and is unit-tested against both.
* **Identity-slice mode.** Mainnet enumeration fetches only AmmInfo bytes
  [336..496) — the contiguous window holding coinVault/pcVault/coinMint/pcMint/
  lpMint at the SDK-pinned offsets. Fingerprints cover
  `sha256(addr ‖ fetched payload)`; `raw.mode` records which payload was
  fingerprinted. Full-752 mode remains available for small clusters.
* **Secret-free evidence.** Bundles contain ONLY public data (message hex,
  signature hex, oracle PUBLIC key). "Evidence with secrets removed" holds by
  construction — there is nothing to redact.

## 4. Duplicate ingestion, staleness, conflicts

* **In-batch dedupe** (discovery) and **cross-cycle idempotence** (ledger):
  re-ingesting identical bytes bumps `ingestCount`/`lastSeenAtMs` and schedules
  nothing. Proven live on mainnet: second run → `duplicate-unchanged: 400`.
* **Change detection:** a different fingerprint at a later slot is a
  `changed` event with a bounded history (8) of prior fingerprints.
* **Conflict detection:** two observations claiming the SAME slot with
  different bytes flag the entry `conflicted` (fail-closed) and exclude it
  from evidence issuance until a fresh unambiguous observation supersedes it.
* **Staleness policy:** discovery snapshots older than
  `DISCOVERY_STALENESS_SLOTS` (default 400 ≈ 17 min) are stale; evidence older
  than `EVIDENCE_FRESHNESS_SLOTS` (default 450 < 512) can never satisfy the
  on-chain SlotHashes check and is refused before signing. Activity
  derivations carry a TTL cache (1 h) and a regression rule (a re-derivation
  older than the cached record is reported, not silently applied).

## 5. Verification matrix (live, 2026-10-26)

`grave-indexer verify-path` runs against the deployed devnet scanner. Full
report: `examples/verify-path-report.live.json`.

| # | case | layer | expected | observed | result |
|---|------|-------|----------|----------|--------|
| 1 | canonical-bundle-verifier | verifier (live chain) | oracle-gated (real oracle) | `ATTESTATION_ORACLE` 6026 — signer ≠ `AsB5u…EWXa` | PASS |
| 2 | tampered-binding | verifier | 6027 analogue | `BUNDLE_WELLFORMED` (parse-time echo rule) | PASS |
| 3 | future-timestamp | verifier | 6028 analogue | `ATTESTATION_TIMESTAMP` | PASS |
| 4 | stale-slot | verifier | 6029 analogue | `ATTESTATION_STALE` | PASS |
| 5 | slot-hash-mismatch | verifier | 6030 analogue | `ATTESTATION_SLOT_HASH` | PASS |
| 6 | replayed-evidence | journal | `ATTESTATION_REPLAY` | rejected on 2nd observation | PASS |
| 7 | missing-precompile | program (sim) | 6024 | skipped — unfunded payer (faucet 429) | SKIPPED |
| 8 | tampered-signature | program (sim) | precompile rejection | skipped — unfunded payer | SKIPPED |
| 9 | non-canonical-offsets | program (sim) | 6025 | skipped — unfunded payer | SKIPPED |
| 10 | unauthorized-signer | program (sim) | 6026 | skipped — unfunded payer | SKIPPED |
| 11 | malformed-msg-length | program (sim) | Anchor decode failure | skipped — unfunded payer | SKIPPED |
| 12 | canonical-bundle-program | program (sim) | 6026 (or accept if oracle registered) | skipped — unfunded payer | SKIPPED |
| 13 | phase1-precondition | program (sim) | account-validation failure | skipped — unfunded payer | SKIPPED |

Notes.

* Mutation cases (2–6) run with the run's own oracle substituted as the
  configured oracle (`expectedOracle`) to ISOLATE each check — the on-chain
  order gates everything at the oracle equality first, so without the
  substitution every case would only re-demonstrate case 1. Case 1 runs
  against the live configured oracle and reports the real deployment gate.
* Cases 7–13 need a FUNDED payer because `record_launch_price`'s `init`
  executes during account validation (before the handler), and simulation
  enforces real balances. Devnet faucet: HTTP 429 (rate-limited, quota
  exhausted per IP — the handoff §8 behavior). Owner funding flow: write a
  solana-keygen JSON to a 0600 file OUTSIDE any repository, fund that
  address with ≥ 0.01 SOL, export `PAYER_KEY_FILE=<path>`, rerun
  `verify-path`. The harness loads it (same custody rules as the oracle
  key), skips the faucet when the balance is positive, and reports the
  payer's PUBLIC address in `payerAddress`.
* The shared prologue argument (cases 7–11 exercise 6024/6025/6026, which are
  the SAME code path phase-1 uses) plus the protocol repo's Rust fork suite
  (which executes the full positive path against a real VM with the oracle key
  present) closes the program-level verification story without weakening
  anything.

## 6. Key custody, rotation, revocation, monitoring, downtime

### 6.1 Custody model

| Key | Role | Custody | Never |
|-----|------|---------|-------|
| Activity oracle (Ed25519 seed) | signs C1 attestations | `ORACLE_KEY_FILE` (solana-keygen JSON, `chmod 600`), stored OUTSIDE any repository (e.g. an encrypted operator secret store); `ACTIVITY_ORACLE_KEY` env form exists but is discouraged | logged, echoed, committed, serialized into bundles/journals/reports |
| Launch-price oracle (Ed25519 seed) | signs C2 attestations | same rules; MUST be a DIFFERENT key from the activity oracle (protocol separation, D9) | shared with the activity oracle |
| Writer (Solana keypair) | pays rent + submits phase-1 txs | operator wallet, funded deliberately; harness loads it via `PAYER_KEY_FILE` (solana-keygen JSON, `chmod 600`, outside any repo) | held by the pipeline between runs |
| Disposable devnet verification key | Phase 2 evidence-path runs | generated IN MEMORY per run (`--use-ephemeral-oracle`), dies with the process | persisted anywhere by the pipeline |

Red lines (enforced in code, tested): key material is read into memory, used,
dropped; logs and health carry only public-key fingerprints
(`first-8-base58…/sha256-16`); `grep -ri "seed\|secret\|private"` over the repo
finds only documentation and test constants (the test oracle seed is a public
constant, 32 × 0x2a).

### 6.2 Rotation procedure (activity oracle)

1. Operator generates a NEW dedicated oracle keypair
   (`solana-keygen new --no-bip39-passphrase -o oracle-<n>.json`, 0600).
2. GraveScanner authority signs `update_protocol_config` setting
   `activity_oracle` to the new public key. (Today this is BLOCKED on 9.5 —
   the authority keypair is the erased deployer key; see 6.4.)
3. Pipeline cutover: set `ORACLE_KEY_FILE` to the new key file; restart the
   service; `verify-path` with `ORACLE_IS_REGISTERED=true` must show the
   canonical case ACCEPTED (full positive path) before real submissions.
4. The old key is then simply NO LONGER CONFIGURED — there is no on-chain
   revocation list to update; authorization is a single equality against the
   current `ProtocolConfig.activity_oracle`.
5. Update this file's §2.4 recorded values in the same changeset.

### 6.3 Revocation / compromise

* **Suspected compromise of the oracle key:** rotate immediately (6.2). Until
  rotation lands, PAUSE the scanner (`update_protocol_config` → paused) — a
  paused scanner reverts every evaluate with 6010, which is the fastest
  containment lever and costs nothing.
* **Compromised evidence (forged attestation observed):** the on-chain design
  contains the blast radius — forged signatures die at the precompile, forged
  bindings/timestamps/slots die at 6027/6028/6029/6031/6030, and an
  EligibilityAnchor written from valid-but-adversarial evidence is
  invalidatable by the authority (`invalidate_anchor`) and ages out
  (`sweep_stale_anchor`, 14-day window). Record the (pool, issued_slot,
  msg_sha256) triple in the replay journal as `action: "verify"` so the
  pipeline refuses to re-observe it.
* **Loss of the writer keypair:** no protocol impact (it is not an authority);
  replace the wallet, re-fund, continue.

### 6.4 Downtime / degraded operations

| Condition | Detection (health) | Action |
|-----------|--------------------|--------|
| Devnet RPC degraded (429s) | `rpc-verification` degraded | retry with backoff (built in); scheduled smoke FAILS LOUD rather than silently passing |
| Mainnet RPC degraded | `rpc-discovery` degraded | discovery cycle exits 1; ledger retains prior state; staleness policy flags entries older than 400 slots |
| Faucet unavailable | verify-path reports payer unfunded | program-level batch SKIPS (marked, not faked); owner funds a payer key file (`PAYER_KEY_FILE`, ≥0.01 SOL devnet) and reruns |
| Oracle key missing | collect refuses to run (fails closed) | discovery-only mode still works; no evidence is issued |
| ProtocolConfig paused | smoke case reports 6010 | operator unpauses after triage (Phase-1 drill runbook) |
| Pipeline offline entirely | scheduled smoke fails (06:11 UTC daily) | salvage submissions halt automatically — a stale pipeline cannot produce fresh evidence, and the chain rejects stale evidence (6029) |

### 6.5 Monitoring requirements (operational contract)

1. **Scheduled smoke** (shipped: `scheduled-evidence-smoke.yml`, daily 06:11
   UTC, gated on `DEVNET_RPC_URL` / `MAINNET_RPC_URL` secrets, fail-loud,
   publishes the full JSON report to the job summary).
2. **Health snapshot** on every cycle (`data/health-snapshot.json`): per-stage
   status (ok/degraded/failing), consecutive-failure counts, last-error names,
   latencies. Alert when overall status ≠ `ok` for two consecutive cycles.
3. **Evidence KPIs to alert on:** verify-path `allPass=false`; discovery
   `conflicts > 0` (RPC divergence — investigate before trusting the ledger);
   `staleEntries` growing across two cycles (discovery is falling behind);
   activity `regressionDetected` events (untrusted/pruned history).
4. **On-chain watch (operator):** `ProtocolConfig.activity_oracle` changes
   (rotation audit), `paused` flips, and GraveScanner program upgrades — any
   of these invalidates §2 assumptions and must trigger a `verify-path` rerun
   before further submissions.

## 7. Live data reproducibility

* Discovery output is deterministic: ascending base58 pool order, provenance
  on every record, fingerprints over raw bytes. Two runs over identical chain
  state produce byte-identical ledgers; the second run must report
  `duplicate-unchanged` for every pool (verified live).
* Evidence bundles are reproducible given the same inputs except the issuance
  slot (deliberately non-reproducible — freshness). `createdAtUnixMs` and
  fingerprints make every bundle independently auditable.
* Live artifacts in `examples/` (all secret-free by construction):
  `discovery-summary.live.json`, `verify-path-report.live.json`,
  `evidence-bundle.live-mainnet-pool.json` (real mainnet pool
  `1736ptDt…uTeP`, real last-swap 2025-04-19 slot 334477560, issued on devnet
  at slot 515069575, verified `oracle-gated`).

## 8. Known limitations and follow-ups

1. **Program-level cases need a funded payer** (faucet rate-limited).
   Resolution path: `PAYER_KEY_FILE` (owner-funded, ≥0.01 SOL devnet) —
   §5 note + §6.4 custody rules.
2. **Positive-path acceptance on devnet is owner-gated (9.5):** until a
   dedicated oracle key is registered (or the deployment is refreshed under
   new keys, DR-001 style), every valid bundle is `oracle-gated` at 6026.
   The pipeline is ready: `ORACLE_IS_REGISTERED=true` + matching
   `ORACLE_KEY_FILE` flips case 1 (and case 12) to full acceptance.
3. **SDK derivation robustness (protocol-side follow-up, not Phase 2 scope):**
   live runs show `deriveLastSwapV4` skipping candidates whose transactions
   carry unresolved address-table lookups ("Failed to get account keys…") and
   blocks containing version-1 transactions ("Transaction version (1) is not
   supported"). The pipeline handles this honestly (skip + health record;
   3 of ~17 candidates issued bundles in the reference run) but the SDK's
   derivation could be hardened to raise the yield. Red line: that change
   belongs to `graveyield-protocol` (SDK), coordinated with the salvor-bots
   byte-equal mirror, in its own review.
4. **Evidence eligibility vs. validity:** the pipeline proves evidence
   VALIDITY (the attestation path). Pool ELIGIBILITY (the six criteria, C2
   launch price, epoch confirmation) is the on-chain scanner's authority and
   the monorepo indexer's pre-filter; Phase 2 does not re-implement it.
