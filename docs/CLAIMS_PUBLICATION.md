# Claims-artifact publication — draft-first lifecycle and stable pointer

Status: **implemented** (`src/claimsArtifact.ts`, `src/claimsPublication.ts`).
Companion docs: `SNAPSHOT_PUBLICATION.md` (the ConsoleSnapshotV2
pool-discovery pipeline — a SEPARATE artifact family; this document
covers only the claims artifact).

## Scope and separation

The claims artifact is the exact byte document the Rust
`grave-snapshotter-cli` (D2/D3) seals: format v2, complete governed
provenance (sink ledger + locker evidence), the leaf set, and the
Merkle root. Claims publication is **logically separate** from
ConsoleSnapshotV2 pool-discovery publication:

| | ConsoleSnapshotV2 (existing) | Claims artifact (this doc) |
| --- | --- | --- |
| Stable ref | `console-snapshot-prod` | `claims-artifact-prod` |
| Pointer schema | `graveyield.console-snapshot-stable-pointer.v1` | `graveyield.claims-artifact-stable-pointer.v1` |
| Versioned tags | `console-snapshot-prod-<stamp>-<commit12>` | `claims-artifact-prod-<stamp>-<commit12>` |
| Assets | snapshot + provenance + checksum | artifact + manifest + checksum |
| Accepts | schema-v2 discovery snapshots | D3 claims-grade artifacts ONLY |

No pointer, ref, asset, or tag of the discovery pipeline is read,
written, or interpreted by the claims lifecycle.

## Producer contract (accepted input)

Only a D3-produced claims-grade artifact is accepted. The gate is
`verifyClaimsArtifactBytes` (`claimsArtifact.ts`) — an independent
transcription of snapshotter `artifact.rs::verify_integrity`:

* `format_version` exactly `2` (a genuine v1 document fails: the v2
  fields are required; a v1-labeled v2-shaped document fails the
  explicit version gate);
* identity binding (pool / AMM / LP mint may be pinned by the caller);
* full Merkle re-derivation (root, leaf count, depth, every leaf and
  proof) through the vendored SDK tree;
* the closing reconciliation identity and the exclusion / locked-LP
  ledgers;
* claims-grade provenance REQUIRED: lock evidence (source `rpc`, UNCX
  Raydium AMM V4 locker program, supported commitment,
  anchor_slot = snapshot_slot, records/totals agreement) and — with
  explicit sinks — governed sink-ledger provenance (schema version,
  identity, input digest);
* exact-u64 parsing (bigint; imprecise floats are refused, never
  rounded).

## The draft-first publication sequence

`runClaimsPublicationSequence` (`claimsPublication.ts`) codifies the
workflow's step order over an injectable `ClaimsReleaseStore` (each
interface method documents its exact GitHub REST mirror):

1. **validate-artifact** — full claims-grade verification over the exact bytes.
2. **compute-digest** — SHA-256 + byte length over the exact bytes.
3. **create-draft-release** — `POST /releases {draft:true, make_latest:"false"}`; the versioned tag `claims-artifact-prod-<stamp>-<commit12>` must not exist (duplicate ⇒ abort; an immutable identity is never overwritten).
4. **upload-draft-assets** — artifact + manifest + checksum uploaded into the DRAFT.
5. **verify-draft-readback** — fetch the assets BACK from the draft; verify digest + byte length + checksum sidecar + FULL claims-grade re-verification.
6. **publish-immutable-release** — `PATCH /releases/{id} {draft:false, make_latest:"false"}`. From here the versioned identity is immutable by publisher convention: assets are never re-uploaded, never mutated.
7. **verify-versioned-release** (I-05) — the FULL pointer-identity verification (digests, lengths, checksum, claims-grade re-verification, artifact identity) over the PUBLISHED versioned release, BEFORE any stable-ref write. Every content failure is caught while the stable pointer is still untouched, so destructive rollback is needed ONLY for failures of the ref move itself or of the post-move read — the architecture deliberately minimizes the scenarios that require destructive rollback.
8. **activate-stable-reference** — the pointer JSON (digests, byte lengths, schema version, pool, mint, snapshot slot, root, producer identity, previous pointer) is written into a NEW annotated tag object (`POST /git/tags`), and `refs/tags/claims-artifact-prod` moves with ONE ownership-checked ref update. This is the only stable-pointer operation in the whole sequence. Honest note (I-05): the GitHub refs API has no conditional write — the update is verify-then-write with a POST-WRITE READ-BACK, never a true compare-and-swap; the workflow `concurrency` group serializes publication runs, and an external writer that wins the race is reported (TERMINAL UNVERIFIED), never silently accepted.
9. **verify-stable-reference** — re-read the ref, parse the pointer, fetch the assets from the POINTER's versioned release, verify digests/lengths/checksum and the artifact identity (root/pool/mint/slot) against the pointer.

Failure semantics:

* Any failure **before step 8** deletes ONLY this run's un-published
  draft (a failed cleanup is surfaced loudly) — the previous
  last-known-good pointer is untouched and keeps serving. Since step 7
  was added (I-05), every CONTENT failure lands here, not in the
  rollback path.
* Any failure **at or after step 8** is rolled back by
  `rollbackClaimsStableReference`: the previous pointer's tag object is
  re-created and the ref moved back (or the first-publication ref is
  deleted), and the restoration is verified by read-back. An
  unverifiable restoration is reported as `unverified` — never silent.
  Every outcome is OBSERVABLE AND AUDITABLE: the sequence throws a
  `ClaimsRollbackOutcomeError` carrying `rollbackOutcome`
  (`restored` | `first-publication-removed` |
  `foreign-reference-untouched` | `unverified`) and `rollbackAudit` —
  the ordered ref observations (ownership-gate reads, refusals,
  ownership-verified writes, read-backs) that produced the outcome.

## Immutable identity and digest semantics

* Every publication is a unique versioned tag; the tag is the immutable
  identity. A duplicate tag aborts the run; existing identities and
  their assets are never overwritten or mutated (test-proven).
* The pointer carries SHA-256 + byte length for every asset. A consumer
  must fetch the exact bytes from the POINTER's versioned release and
  verify digest + length before trusting anything else.
* The artifact digest is over the exact published bytes — the same bytes
  the D3 producer wrote and the console consumes.

## Environment configuration (operator)

The production workflow (`publish-claims-artifact.yml`) requires:

* `GITHUB_TOKEN` (workflow scope: `contents: read and write`) for the
  publication writes in THIS repository (releases, tags, refs).
* `GY_CLAIMS_PRODUCER_TOKEN` (repository secret) — I-06 cross-repo
  auth: a fine-grained token scoped to **actions:read on
  `GraveYield/graveyield-protocol`, nothing more**. The automatic
  `GITHUB_TOKEN` of grave-indexer CANNOT read another repository's
  Actions runs or artifacts, so the handoff authenticates with this
  dedicated secret (`GY_CLAIMS_PRODUCER_GITHUB_TOKEN` for the CLI). The
  two tokens are never swapped: publication writes use `GITHUB_TOKEN`,
  producer-run reads use `GY_CLAIMS_PRODUCER_TOKEN`.

No artifact metadata, log line, pointer field, or test fixture may ever
carry a credential. The pointer schema is pinned to a fixed key set
(strict parser; unknown fields refuse).

## Local fixture procedure (no production dispatch)

```sh
pnpm install --frozen-lockfile
pnpm run build:sdk
pnpm exec tsc -p tsconfig.typecheck.json --noEmit
pnpm run test:offline        # includes test/claimsPublication.test.ts
```

The tests run the full sequence against `InMemoryClaimsReleaseStore`
(GitHub semantics mirrored: drafts, immutable tag objects, one stable
ref, HTTP-422 duplicate tags, 404 misses). They never touch the network
and never create real releases — production publication is dispatched
only by the owner-triggered workflow.

## Operator response guide

| Situation | Meaning | Action |
| --- | --- | --- |
| `claims-artifact-prod` ref missing | no claims artifact ever published | publish the first artifact (first-publication path) |
| Publication aborted: duplicate tag | this stamp+commit already published | do NOT retry under the same identity; investigate, then publish with a new stamp |
| Publication aborted: claims-grade verification | the staged artifact is not a valid D3 artifact | re-run D3; never publish a hand-edited artifact |
| Draft cleanup failure surfaced | the failed run's draft still exists | delete the draft release manually; the stable pointer is unaffected |
| Post-activation failure reported `unverified` | rollback could not verify restoration | treat the stable pointer as suspect; verify manually against the previous versioned release, then re-run |
| Consumer digest mismatch | pointer and bytes disagree (cache/tamper) | re-fetch from the pointer's versioned tag; if persistent, treat as an integrity incident |

## D3→D4 artifact handoff (I-06)

A dispatch starts a FRESH runner: a bare `artifact_path` string cannot
transfer the Rust-produced artifact to the publication runner, and a
local path is never proof of producer origin. The publication workflow
therefore retrieves the artifact from an explicit, validated PRODUCER
RUN.

### Actual producer (verified, not invented)

* The claims artifact is sealed by the Rust `grave-snapshotter-cli`
  (`snapshotter/src/bin/grave-snapshotter-cli.rs` in
  `GraveYield/graveyield-protocol`), which writes the deterministic
  artifact JSON to an `--out` path. Required inputs: `--url` (RPC),
  `--pool`, `--amm`, `--lp-mint`, `--out`, `--commitment
  <confirmed|finalized>` (required, never defaulted), `--lock-evidence
  rpc` (REQUIRED — real UNCX Raydium AMM V4 locker evidence via
  `getProgramAccounts`; an empty lock list is never substituted), and
  `--sink-ledger <file>` (a governed `gy.sink-ledger.v1` ledger;
  malformed/unsupported/mismatched input aborts the run).
* The manifest and checksum are DERIVED by the publication sequence from
  the artifact bytes — the only producer-side deliverable is the single
  `claims-artifact.json`.
* **Producer workflow (companion change):** the producer side is the
  `claims-snapshot.yml` workflow (workflow `name:`
  `grave-snapshotter-cli`) in `GraveYield/graveyield-protocol`. It is a
  `workflow_dispatch`-only, read-only validation producer: it checks out
  the exact dispatch commit, builds the pinned Rust toolchain (1.91.1,
  per `rust-toolchain.toml`, `--locked`), requires pool/AMM/LP-mint +
  commitment + a governed sink ledger as dispatch inputs, requires the
  `SNAPSHOTTER_RPC_URL` secret (fails closed when unset — the RPC URL is
  credential-bearing and never logged), runs the real
  `grave-snapshotter-cli`, and uploads TWO Actions run artifacts:
  `claims-artifact.json` (the exact sealed artifact — the name the
  indexer handoff retrieves) and `claims-artifact-provenance` (sha256,
  byte length, toolchain, producer commit SHA, run id, sink-ledger input
  digest). It NEVER creates a release, NEVER moves a ref, NEVER signs or
  submits a transaction, and its artifact is NEVER a production claims
  release.
* **Demonstration status (honest):** the producer workflow is
  implemented and validated structurally (parsed + safety-pinned by
  tests), and its fail-closed behavior was demonstrated against a real
  controlled dispatch WITHOUT the RPC secret (the run aborts at the
  secret gate before any RPC call). The POSITIVE path — a real run
  against governed sink-ledger input + RPC-backed locker evidence,
  followed by a genuine cross-repository artifact retrieval by the
  indexer — has NOT been demonstrated yet (it requires the
  `SNAPSHOTTER_RPC_URL` secret and real governed pool inputs, which are
  outside this change's authority). Until that demonstration exists,
  the producer workflow must be treated as prepared, not operational.

### Trusted producer identity (P125-01)

The indexer consumer does NOT accept an artifact merely because it came
from a successful Actions run carrying the expected workflow display
name. Before any artifact is downloaded — before ANY network write — the
handoff verifier (`src/claimsProducerHandoff.ts`) independently
establishes, from GitHub-AUTHORITATIVE API responses only:

* **Trusted repository.** `TRUSTED_CLAIMS_PRODUCER_REPO`
  (`GraveYield/graveyield-protocol`) is pinned in consumer code. A
  caller-supplied repo that disagrees is rejected before any network
  call; the run's `repository.full_name` and `head_repository.full_name`
  (the fork/source context) must BOTH equal the trusted repository.
* **Trusted branch.** `TRUSTED_CLAIMS_PRODUCER_BRANCH` (`main`) is pinned
  in consumer code. The run's GitHub-authoritative `head_branch` must
  equal it; a missing `head_branch` is rejected fail-closed. There is no
  caller-supplied branch argument at all.
* **Workflow identity — path and immutable ID, never a display name.**
  `TRUSTED_CLAIMS_PRODUCER_WORKFLOW_PATH`
  (`.github/workflows/claims-snapshot.yml`) is pinned in consumer code
  and resolved in the TRUSTED REPOSITORY's workflow registry
  (`GET /repos/{repo}/actions/workflows/{path}`). The registry record
  must be `active`, its `path` must equal the pinned path, and its
  GitHub-authoritative `name` must equal the pinned producer workflow
  name. The RUN is then bound to that exact definition twice: its
  immutable numeric `workflow_id` must equal the registry record's id,
  and its recorded `path` must equal the trusted path. Two workflows can
  share a display name; they cannot share the numeric workflow id or the
  registry path.
* **Provenance binding.** The run must be `completed` with conclusion
  `success`, and its `head_sha` must exactly equal the publication's
  requested source commit.
* **Artifact-to-run binding.** The artifact is retrieved ONLY from the
  requested run's artifact listing (run-scoped API URL), the name must
  match exactly, exactly one match may exist, it must not be expired and
  must be within the configured size limit, AND the record's
  GitHub-authoritative `workflow_run` binding must name the same run and
  the same head commit. Missing run-binding metadata is rejected
  fail-closed.
* **Bytes.** The downloaded zip must match the API-recorded byte length,
  pass ZIP central-directory + CRC32 integrity, and the extracted
  `claims-artifact.json` must pass the full claims-grade verification
  (schema, provenance digests, Merkle integrity, pool/AMM/mint identity
  expectations).

Caller-supplied values (`--producer-repo`, `--producer-workflow`,
`producer_identity`) are DECLARATIONS, not trust inputs: each must equal
the consumer's pinned constants or the handoff refuses before any
network call.

#### What code enforces vs. what GitHub repository controls must enforce

Code-enforced (this repository): repository, branch, workflow path +
immutable workflow id, run/completion state, head-SHA provenance,
artifact name/uniqueness/expiry/size/run-binding, byte length, ZIP/CRC
integrity, and the claims-grade content verification above.

Owner-configured GitHub controls (NOT enforceable from code — they
require branch protection / rulesets on `GraveYield/graveyield-protocol`):

* `main` branch protection / ruleset requiring pull-request review for
  workflow-file changes (`.github/workflows/claims-snapshot.yml`) —
  this is the control that protects the workflow DEFINITION itself.
* Restriction of `workflow_dispatch` on `main` to authorized actors.
* Actions permissions on the producer repository (no arbitrary forks
  running untrusted workflows with the trusted identity).

**Honest trust-boundary note:** binding a run's `head_sha` does NOT by
itself prove that the workflow file at that commit was unchanged or
trusted — a commit that tampered with the workflow file would still
carry its own SHA. The identity chain establishes (a) the run executed
the workflow definition at path `.github/workflows/claims-snapshot.yml`
(immutable id + path), (b) on the trusted branch, (c) in the trusted
repository, and (d) for the exact requested commit; the integrity of
the workflow FILE CONTENT at that commit is guaranteed by the
repository's branch-protection and review controls listed above, not by
this code. When GitHub's API response does not expose sufficient
identity evidence (missing branch, missing workflow id/path, missing
artifact run-binding, inactive workflow), the handoff FAILS CLOSED —
trust is never inferred from a display name or from absence.

### Operator procedure

1. Run the producer workflow (`grave-snapshotter-cli`) in
   `GraveYield/graveyield-protocol` from the intended commit with the
   governed inputs: `pool`, `amm`, `lp_mint` (base58 pubkeys),
   `commitment` (`confirmed`/`finalized`), and `sink_ledger` (the full
   `gy.sink-ledger.v1` document — a run with an empty or malformed
   ledger fails closed). Note its numeric run ID from the run URL
   (`.../actions/runs/<id>`) and its head commit (the dispatch ref).
2. Dispatch `publish-claims-artifact` in `grave-indexer` with:
   `producer_run_id` (that run ID), `source_commit` (the 40-hex commit —
   it must equal the producer run's head commit), `producer_identity`
   (must be the pinned `grave-snapshotter-cli`), `producer_version`, and
   `expected_pool` (the pool identity the artifact must carry).
3. The workflow's pre-flight resolves the trusted workflow registry
   record, the run (READ-ONLY, GET-only), and rejects: a nonexistent or
   inactive trusted workflow, a run executed from another repository,
   branch (non-`main`), fork, or workflow definition (immutable workflow
   id/path — not the display name), nonexistent run ID, unfinished or
   failed runs, head-commit mismatch, missing/expired/ambiguous/oversized
   artifacts, artifact run-binding mismatch, zip byte-length mismatch,
   CRC32 corruption, invalid schema/provenance, and pool/producer
   identity mismatch — all BEFORE any release, tag, asset, or reference
   is touched. See "Trusted producer identity (P125-01)" above.
4. The trusted producer repository, branch, workflow path, and workflow
   name are PINNED IN THE CONSUMER (the `TRUSTED_CLAIMS_PRODUCER_*`
   constants in `src/claimsProducerHandoff.ts`) — the workflow env vars
   (`GY_CLAIMS_PRODUCER_REPO`, `GY_CLAIMS_PRODUCER_WORKFLOW`,
   `GY_CLAIMS_ARTIFACT_NAME`) and CLI flags are declarations that must
   match the pins, never trust inputs. The pinned values are lock-step
   with the companion workflow's `name:` and enforced by
   `test/claimsReview.test.ts` and `test/claimsProducerHandoff.test.ts`.
5. Failures are reported in the step log and the job fails; no partial
   publication state can exist (the handoff performs zero writes).

### Rollback safety against foreign stable-reference updates (I-05)

The stable-reference rollback is OWNERSHIP-CONDITIONAL and
POST-WRITE-VERIFIED:

* An ALREADY-ABSENT ref is verified by re-read and treated as absent —
  no DELETE request is issued (the GitHub refs API answers 404 for an
  absent ref; the real adapter and the in-memory store share exactly
  these semantics).
* A ref may be deleted or restored ONLY while it still names THIS failed
  attempt's activated tag object (or, for first publication, is absent).
* A ref that changed hands (concurrent publisher or external writer) is
  NEVER overwritten or deleted — the run reports TERMINAL UNVERIFIED.
* Uncertain ownership (e.g. the ref vanishes while a previous pointer is
  known) and failed read-backs are reported TERMINAL UNVERIFIED with zero
  destructive calls.
* Ref moves and deletes verify the live sha against the caller's
  expectation before writing, and BOTH are verified AGAIN immediately
  after the write (post-write read-back): a foreign write that lands
  between the write and the read-back is DETECTED and reported, never
  silently accepted. An absent ref is created with `POST /git/refs`,
  which the real API refuses with HTTP 422 when the ref came into
  existence concurrently — a natural insert-if-absent guard.
* Honest residual boundary (recorded, not hidden): the GitHub REST API
  has NO conditional write or conditional DELETE for refs. This is
  verify-then-write, NOT atomic compare-and-swap. A foreign write that
  lands in the probe→write window (between the ownership check and the
  PATCH/DELETE) is overwritten — no REST call can prevent this. The
  detection window (write→read-back) is the adapter's guarantee, not the
  write window. Operational mitigations: the workflow `concurrency`
  group serializes this repo's publication runs, and a GitHub TAG
  PROTECTION RULE on `refs/tags/claims-artifact-prod` is the real
  defense against external writers — configure it before the first
  production publication. These regression bounds are pinned by
  adapter-level tests (`test/claimsRollbackGitHubAdapter.test.ts`) that
  reproduce each interleaving deterministically against a mock of the
  documented REST semantics — including the test that PROVES the
  probe→PATCH clobber cannot be prevented.
* Every rollback outcome carries a structured audit trail
  (`ClaimsRollbackOutcomeError.rollbackOutcome` + `rollbackAudit`) —
  observable, machine-readable, and safe to log (never a secret).

## Honest limitation (recorded)

The publication sequence is codified and tested as an executable
abstraction over `ClaimsReleaseStore` — the same approach the
console-snapshot pipeline uses (`snapshotPublicationSequence.ts`). The
production GitHub Actions job (modeled line-for-line on
`publish-console-snapshot.yml`, with the claims CLI + stable ref
`claims-artifact-prod`) is the wiring step; no production workflow was
dispatched and no real release was created while developing this
change, per the workstream constraints.
