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
7. **activate-stable-reference** — the pointer JSON (digests, byte lengths, schema version, pool, mint, snapshot slot, root, producer identity, previous pointer) is written into a NEW annotated tag object (`POST /git/tags`), and `refs/tags/claims-artifact-prod` moves with ONE ownership-checked ref update. This is the only stable-pointer operation in the whole sequence. Honest note (I-05): the GitHub refs API has no conditional write — the update is verify-then-write (the expected current sha is checked against the live ref first), never a true compare-and-swap; the workflow `concurrency` group serializes publication runs, and an external writer that wins the race is reported (TERMINAL UNVERIFIED), never clobbered.
8. **verify-stable-reference** — re-read the ref, parse the pointer, fetch the assets from the POINTER's versioned release, verify digests/lengths/checksum and the artifact identity (root/pool/mint/slot) against the pointer.

Failure semantics:

* Any failure **before step 6** deletes ONLY this run's un-published
  draft (a failed cleanup is surfaced loudly) — the previous
  last-known-good pointer is untouched and keeps serving.
* Any failure **at or after step 7** is rolled back by
  `rollbackClaimsStableReference`: the previous pointer's tag object is
  re-created and the ref moved back (or the first-publication ref is
  deleted), and the restoration is verified by read-back. An
  unverifiable restoration is reported as `unverified` — never silent.

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

The production workflow (modeled on `publish-console-snapshot.yml`)
requires only GitHub's standard tokens — no new secrets:

* `GITHUB_TOKEN` (workflow scope: `contents: read and write`) for
  releases, tags, and refs.
* The claims artifact bundle (artifact + manifest + checksum) is staged
  by the D3 run; the publication job re-verifies the bundle before any
  network write.

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
  artifact JSON to an `--out` path.
* The manifest and checksum are DERIVED by the publication sequence from
  the artifact bytes — the only producer-side deliverable is the single
  `claims-artifact.json`.
* **Missing producer-side dependency (honest):** NO workflow in
  `graveyield-protocol` currently runs `grave-snapshotter-cli` and
  uploads `claims-artifact.json` as a named run artifact
  (`ci.yml` runs `cargo test -p grave-snapshotter` only; `fork-harness.yml`
  uploads only a failure log). Until such a producer workflow exists,
  every publication dispatch fails CLOSED at the handoff step
  ("missing artifact") — by design. No fixture simulates the handoff.

### Operator procedure

1. Run the producer workflow in `GraveYield/graveyield-protocol` (once it
   exists) with the correct commit; note its numeric run ID from the run
   URL (`.../actions/runs/<id>`).
2. Dispatch `publish-claims-artifact` in `grave-indexer` with:
   `producer_run_id` (that run ID), `source_commit` (the 40-hex commit —
   it must equal the producer run's head commit), `producer_identity`
   (must be the pinned `grave-snapshotter-cli`), `producer_version`, and
   `expected_pool` (the pool identity the artifact must carry).
3. The workflow's pre-flight step resolves the run (READ-ONLY, GET-only)
   and rejects: nonexistent run ID, wrong workflow identity, unfinished or
   failed runs, head-commit mismatch, missing/expired/ambiguous artifacts,
   zip byte-length mismatch, CRC32 corruption, invalid schema/provenance,
   and pool/producer identity mismatch — all BEFORE any release, tag,
   asset, or reference is touched.
4. The producer workflow name and artifact name are PINNED in the
   publication workflow's environment
   (`GY_CLAIMS_PRODUCER_WORKFLOW`, `GY_CLAIMS_ARTIFACT_NAME`) — never
   accepted as dispatch inputs, so an attacker cannot point the
   provenance check at their own workflow. When the producer workflow
   lands, set `GY_CLAIMS_PRODUCER_WORKFLOW` to its exact `name`.
5. Failures are reported in the step log and the job fails; no partial
   publication state can exist (the handoff performs zero writes).

### Rollback safety against foreign stable-reference updates (I-05)

The stable-reference rollback is OWNERSHIP-CONDITIONAL:

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
  expectation before writing. Honest: the GitHub refs API has no
  conditional write — this is verify-then-write, NOT atomic
  compare-and-swap. The workflow `concurrency` group serializes this
  repo's publication runs; EXTERNAL writers are handled by the ownership
  gate and refusal, never by trusting the concurrency group.

## Honest limitation (recorded)

The publication sequence is codified and tested as an executable
abstraction over `ClaimsReleaseStore` — the same approach the
console-snapshot pipeline uses (`snapshotPublicationSequence.ts`). The
production GitHub Actions job (modeled line-for-line on
`publish-console-snapshot.yml`, with the claims CLI + stable ref
`claims-artifact-prod`) is the wiring step; no production workflow was
dispatched and no real release was created while developing this
change, per the workstream constraints.
