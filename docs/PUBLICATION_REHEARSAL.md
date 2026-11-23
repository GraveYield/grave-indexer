# Publication rehearsal — record and manual plan (PR #5 remediation, review Task 6; eighth-round correction — review Finding 2; ninth-round correction — review Findings 2 and 3)

Status: **EXECUTED (2026-11-23).** All five scenarios ran live in the
isolated rehearsal repository `GraveYield/grave-indexer-pub-rehearsal`
with the owner-provided authorized credential, exercising the SAME
dedicated stable-reference architecture as production
(`refs/tags/console-snapshot-prod` → annotated pointer tag object →
versioned release assets) and the draft-first publication sequence.
Actual outcomes (run IDs; §5 holds the full record):

| Scenario | Run ID | Actual outcome |
| --- | --- | --- |
| `happy` | 45178513528 | success — full draft-first pointer architecture end-to-end, unrelated-release probe, rollback drill, state-aware re-activation |
| `partial-upload` | 45178674124 | success — the draft belt refused the partial draft BEFORE publish; stable reference unchanged; draft cleaned up by ID |
| `promotion-failure` | 45179021062 | success — pointer for a MISSING release refused; stable reference unchanged |
| `post-activation-failure` | 45178728162 | failure (EXPECTED) — verified activation → deliberate injection → failure-triggered rollback and restored-state verification SUCCEEDED |
| `incomplete-artifact` | 45179687002 | success — marker-carrying bundle refused by `verify-snapshot`; no release created |

Nothing in this remediation triggered a production publication, created
or modified a production release, moved a production stable reference,
changed Vercel configuration, deployed the Console, or touched
Mainnet/protocol state. Rehearsal artifacts exist ONLY in the rehearsal
repository.

## 1. What was executed (read-only verification, no writes)

### 1.1 Live GitHub-semantics verification (read-only, unauthenticated; historical)

Executed 2026-11-21 against public repositories (controls: `oven-sh/bun`,
`nodejs/node`, `cli/cli`) — the URL semantics that informed the interim
latest-release design. These results are HISTORICAL: under the
owner-selected dedicated stable-reference architecture the production
mechanism is the two-step ref → tag-object → versioned-release
resolution (docs/SNAPSHOT_PUBLICATION.md §13.1), which does not depend
on the repo-wide latest designation at all.

### 1.2 Local rehearsal of the publication sequence (executable abstraction, real verification logic)

`test/snapshotPublicationSequence.test.ts` drives
`runPublicationSequence` — the workflow's exact step order over an
injectable release store, with the REAL schema-v2 parser, integrity,
checksum and ordering gates. Failure-injection battery (13 scenarios)
plus the mixed-release race battery (review Task 5). All assert the
last-known-good invariant after every fault.

`test/releaseOps.test.ts` drives the REAL CLI commands the workflow
invokes with the GitHub HTTP layer monkeypatched — the full
error-classification matrix (404/200/401/403-permission/403-rate-limit/
429/5xx/network/malformed/unexpected), the pointer-drift rejections,
and (eighth round) the independent completeness gate over fetched
bytes.

`test/publishWorkflow.test.ts` pins the STRUCTURE of both workflows:
the publication workflow's eight-job dependency graph (including the
dedicated downstream rollback job and its exact run condition, the
compare-before-rollback refusal, both rollback cases, read-back
verification, PAT isolation, and the ninth-round in-job
compare-before-rollback chain) and the rehearsal workflow's hard guard
plus its pointer-architecture step sequence — including the
state-aware reactivation (Finding 2) and the genuine post-activation
failure-injection scenario (Finding 3).

Ninth-round corrections, stated precisely:

- **Finding 2 — state-aware reactivation.** The rehearsal's
  first-publication rollback drill deletes the dedicated reference; the
  former reactivation step then moved the ref with an UNCONDITIONAL
  `PATCH /git/refs/tags/console-snapshot-prod`, which requires an
  EXISTING reference — the expected first-publication cycle could never
  complete. Reactivation now reads the live reference first: 404 →
  `POST repos/<repo>/git/refs`, 200 → `PATCH .../git/refs/tags/
  console-snapshot-prod` (force), anything else → fail closed. Both
  paths read the reference back and verify it against the expected
  annotated tag object, then re-run `verify-stable`.
- **Finding 3 — genuine post-activation failure injection.** The
  rehearsal previously demonstrated rollback API operations through a
  MANUAL drill only; it never proved that a failure AFTER activation
  invokes the FAILURE-TRIGGERED rollback path. The new
  `post-activation-failure` scenario publishes and verifies the full
  pointer chain, activates the dedicated reference, verifies the
  activation, then injects a DELIBERATE, CONTROLLED failure (an explicit
  `exit 1` — never a network error, a credential problem, or a
  destructive action) and exercises the SAME `if: failure()` gating
  production uses, including compare-before-rollback. The restored
  state is proven by `verify-stable` (previous pointer) or a genuine
  HTTP 404 (first publication). The run summary reports the four phases
  distinctly, and the job conclusion for this scenario is EXPECTED to be
  failure — it is never reported as a successful publication.
- **Status (SUPERSEDED — see §5): the scenarios HAVE run.** The
  twelfth-to-fourteenth-round "NOT DISPATCHED" record below was true at
  the time; both the state-aware reactivation (Finding 2) and the
  post-activation failure injection (Finding 3) have since been executed
  live and verified in the rehearsal repository (§5).

## 2. The rehearsal workflow (current architecture)

`.github/workflows/rehearsal-publication.yml` is hard-guarded: the
FIRST step refuses to run unless
`GITHUB_REPOSITORY == "GraveYield/grave-indexer-pub-rehearsal"` — the
guard runs BEFORE checkout and before any write operation. It builds a
REAL schema-v2 fixture bundle from the production builders
(`test/fixturePublicationBundle.ts` — offline, no RPC, no secrets) and
rehearses the REAL GitHub operations via `gh` CLI + `gh api` + the same
verification CLI gates the production workflow uses.

Credential boundary: the rehearsal uses the run's own `github.token`,
which — because of the hard guard — exists only inside the rehearsal
repository. The production release credential (`GY_RELEASE_PAT`) is
never referenced (outside comments, pinned by test), and no repository
secret is wired into the rehearsal at all.

Scenarios (dispatch input):

| Scenario | Proves |
| --- | --- |
| `happy` | the DRAFT-FIRST sequence required before enforcement (twelfth round: versioned release created `--latest=false --draft`, assets uploaded BY RELEASE ID, draft belt over the uploaded bytes, then publish `draft=false` + `make_latest=false`); same-release verification (digests + lengths); pointer build + strict pointer-schema validation; annotated tag object creation; dedicated-ref create-or-update (404 → `POST /git/refs`, 200 → `PATCH /git/refs/tags/console-snapshot-prod` force); read-back (sha + message equality); full identity chain via `verify-stable`; an UNRELATED release taking the repo-wide latest designation does NOT move the dedicated reference; rollback drill — restore the previous pointer (verified through the full chain) or, on a first publication, delete the reference and verify HTTP 404; state-aware re-activation (Finding 2: 404 → `POST /git/refs`, 200 → `PATCH`, read-back + `verify-stable` in both paths) |
| `post-activation-failure` | (ninth round, Finding 3) the FULL pointer architecture up to and INCLUDING a verified activation; then a deliberate, controlled failure injection (explicit `exit 1` after the ref verifiably moved); the FAILURE-TRIGGERED rollback path (`if: failure()` gating, compare-before-rollback against the live ref, refusal on an independently moved pointer, fail-closed on an unreadable ref) restores the previous pointer or the absent first-publication state; the restoration is proven by `verify-stable` or a genuine HTTP 404; the four phases are reported distinctly and the job conclusion is EXPECTED failure |
| `partial-upload` | (twelfth round) only the snapshot asset is uploaded to a DRAFT; the draft belt's presence check fails on the DRAFT — BEFORE any publish; same-release verification also fails (an un-published draft is invisible to the by-tag endpoint — fail closed in both layers); the release must STILL be a draft (publishing an incomplete asset set is a loud SAFETY FAILURE); the DEDICATED stable reference is unchanged after the failed publication; the previously active artifact remains fully retrievable and internally consistent; cleanup deletes the un-published draft by release ID (no tag was ever materialized) |
| `promotion-failure` | building/activating a pointer for a MISSING release fails closed; the dedicated reference is unchanged |
| `incomplete-artifact` | an incomplete bundle (zero enriched pools) is refused by the independent `verify-snapshot` gate and never promoted (no release exists for its tag) |

## 3. SUPERSEDED HISTORY — why it had not run then, and what the owner did

> **SUPERSEDED (fifteenth round, 2026-11-23):** every blocker recorded in
> this section was subsequently resolved — the rehearsal repository was
> initialized, the credential gap was closed, and all five scenarios ran
> live (§5). The text below is preserved as superseded history; it no
> longer describes the current state.

**TWELFTH-ROUND PREREQUISITE VERIFICATION (2026-11-23, read-only):**
the rehearsal was NOT dispatched at that time because three concrete
prerequisites failed, verified live:

1. `GraveYield/grave-indexer-pub-rehearsal` exists but is **EMPTY** —
   no commits, no branches, no default branch, no files. GitHub
   registers `workflow_dispatch` workflows ONLY from a repository's
   default branch, so the rehearsal workflow cannot be dispatched there
   at all, and there is no workflow to dispatch (PR #5 is not merged —
   by requirement — so `grave-indexer`'s own default branch does not
   carry the workflow either).
2. No credential with write access to the rehearsal repository was
   available to the task (an earlier reconnaissance found the same);
   dispatch additionally requires such access. None was requested or
   exposed in chat.
3. The workflow's OWN guard properties were verified by inspection and
   structure tests (not dispatch): the hard repository-identity guard
   is the FIRST step, before checkout and any write; the rehearsal uses
   only its repository-scoped `github.token`; no production secret is
   referenced; the rehearsal exercises the §8.3 draft-first sequence
   (twelfth round) — which as of the thirteenth round is ALSO the
   production publisher's implemented sequence on this branch
   (docs/SNAPSHOT_PUBLICATION.md §8.3, §17): the rehearsal and
   production now both create the versioned release as a DRAFT, verify
   the assets on the DRAFT, publish by release ID with
   `make_latest=false`, and gate the pointer activation on the
   read-only verification.

**FOURTEENTH-ROUND UPDATE (2026-11-23):** the workflow-file push
prerequisite is RESOLVED — the owner provided a fine-grained PAT and the
thirteenth-round commit (which modifies this workflow file) was pushed
to PR #5's branch successfully, proving the credential holds the
`workflows` permission; the branch now carries the current draft-first
version of this workflow. The REMAINING blocker, now verified live with
its exact cause: this repository is still EMPTY, and that PAT does not
cover it — `PUT .../contents/probe.txt` → HTTP 403 "Resource not
accessible by personal access token" (refused; nothing was created) and
`git push` → 403 "Permission ... denied". The same PAT holds
admin/push on `grave-indexer`, so this is a token repository-selection
gap, not a repository problem. Exact fix: add
`grave-indexer-pub-rehearsal` to the token's repository access with
Contents: read/write, Workflows: read/write, Actions: read/write, then
perform owner steps 1–4 below. The rehearsal remains PREPARED — NOT
EXECUTED; no result is claimed.

Per the task's authorization boundary, dispatch was therefore skipped
and the exact prerequisites are reported instead. Dispatching from this
branch is also NOT possible: GitHub registers `workflow_dispatch`
workflows only from the default branch, and dispatching was explicitly
outside this task's authorization.

Owner steps to run the full rehearsal (NOT performed by this change):

1. Grant the CI token (or a scoped credential) write access to
   `GraveYield/grave-indexer-pub-rehearsal`, or push this branch's
   workflow file to that repository's `main`.
2. Initialize the rehearsal repo (one commit) if empty.
3. Dispatch `rehearsal-publication` once per scenario; record run URLs,
   run IDs, release/tag identifiers, asset download results, hash and
   schema verification results, failure-injection outcomes and the
   rollback results from the run summaries (the workflow writes a
   structured record to `GITHUB_STEP_SUMMARY`).
4. Independently verify the recorded outcomes (re-run `verify-stable`
   against the rehearsal repository after the fact).

### Precise manual rehearsal plan (no CI needed)

With `gh` authenticated to the rehearsal repository, in order:

1. `node --import tsx/esm test/fixturePublicationBundle.ts --out data` — build the fixture.
2. `gh release create <TAG> --repo <REHEARSAL_REPO> --target <SHA> --latest=false` — create the versioned release; then `gh release upload <TAG> data/console-snapshot.json data/console-snapshot-provenance.json data/console-snapshot.sha256`.
3. `node --import tsx/esm src/cli.ts verify-release-assets <REHEARSAL_REPO> --tag <TAG> --scope versioned --expected-tag <TAG>` — must exit 0 (same-release cross-check).
4. `node --import tsx/esm src/cli.ts stable-pointer-build <REHEARSAL_REPO> --tag <TAG> --expected-tag <TAG>` — build + capture the pointer JSON.
5. Create the annotated pointer tag object: `gh api --method POST repos/<REHEARSAL_REPO>/git/tags -f tag=console-snapshot-prod -f object=<SHA> -f type=commit -f message=<pointer JSON>`.
6. Create-or-update the dedicated reference: `gh api repos/<REHEARSAL_REPO>/git/ref/tags/console-snapshot-prod` first (404 → `POST repos/<REHEARSAL_REPO>/git/refs -f ref=refs/tags/console-snapshot-prod -f sha=<tag object sha>`; 200 → `PATCH repos/<REHEARSAL_REPO>/git/refs/tags/console-snapshot-prod -f sha=<tag object sha> -F force=true`).
7. `node --import tsx/esm src/cli.ts verify-stable <REHEARSAL_REPO> --expected-tag <TAG>` — must exit 0 (full identity chain).
8. Unrelated-release probe: create another release with `--latest`; the dedicated reference must still resolve to `<TAG>` (`stable-pointer-current`, `verify-stable`).
9. Rollback: re-create the PREVIOUS pointer tag object from the recorded pointer JSON and PATCH the ref to it; `verify-stable --expected-tag <PREVIOUS_TAG>` must exit 0. For a first publication: DELETE `repos/<REHEARSAL_REPO>/git/refs/tags/console-snapshot-prod` and verify the ref read returns HTTP 404.
10. Partial upload: create another tag, upload ONLY `console-snapshot.json`; `verify-release-assets --scope versioned` must exit non-zero; the dedicated reference must still resolve to the previous tag; the previously active release's three assets must still verify.
11. Activation failure: `stable-pointer-build --tag console-snapshot-prod-20990101T000000Z-notrack` must fail non-zero; the dedicated reference must be unchanged.
12. Incomplete artifact: `node --import tsx/esm test/fixturePublicationBundle.ts --out data-incomplete --incomplete`; `verify-snapshot` must exit non-zero and no release may be created for its tag.
13. Post-activation failure injection (Finding 3, manual equivalent): after step 7, inject a deliberate failure (e.g. `false` in the operator shell), then compare the live reference against the activated tag object (`gh api repos/<REHEARSAL_REPO>/git/ref/tags/console-snapshot-prod`); restore the previous pointer (or delete the ref for a first publication), and re-verify via `verify-stable --expected-tag <PREVIOUS_TAG>` (or a genuine HTTP 404). An independently moved reference must be left untouched.

## 4. CLOSED — residual rehearsal gap (superseded record)

> **CLOSED (fifteenth round, 2026-11-23):** the gap described below no
> longer exists — the rehearsal ran live and covered every behavior listed
> here (§5). Preserved as superseded history.

Until the rehearsal ran on an authorized target, the following were
proven by tests + offline batteries but NOT yet by a live write-path
rehearsal: the exact `gh api` git-data mutation behavior on a real
release/tag set (pointer tag object creation, ref create/update/delete,
read-back), the unrelated-release probe against real GitHub pointer
semantics, the rollback drill's end-to-end timing, the state-aware
reactivation (Finding 2) against a genuinely deleted reference, and the
failure-triggered rollback path (Finding 3) against a real injected
failure. The design does
not depend on any UNVERIFIED GitHub behavior for last-known-good
preservation (the pointer only moves through the atomic ref update,
after which the read-back and the post-activation gate either confirm
or fail the run, and both rollback paths verify their own result) —
and the rehearsal has now been run before the first production
publication, closing this gap (§5).

Equally important, do NOT overstate other claims. GitHub-enforced
immutable-release status is now SETTLED, not UNKNOWN (fourteenth round,
2026-11-23): the authorized endpoint
`GET /repos/GraveYield/grave-indexer/immutable-releases` returned HTTP
200 with `{"enabled": false, "enforced_by_owner": false}` — the feature
is NOT enabled (docs/SNAPSHOT_PUBLICATION.md §18). Immutability is a
workflow-level convention, and as of the thirteenth round the
production publisher on PR #5's branch IMPLEMENTS the draft-first
sequence (docs/SNAPSHOT_PUBLICATION.md §8.3, §17), which this rehearsal
exercises — the publisher is compatible with the feature disabled
(current) and enabled (future owner decision). Enabling GitHub's
immutable-releases feature is an owner decision, and the publish-time
latest-designation behavior should be re-verified on the rehearsal
target first. Production Console ingestion is NOT operational (the
Console's single-GET `GY_SNAPSHOT_URL` contract requires the §13.2
two-step resolver, which is an owner-approval gate outside this task).

---

## 5. EXECUTED (2026-11-23): all five scenarios ran live — evidence and findings

The repository was initialized (full project mirror with the
`vendor/protocol` submodule gitlink; the workflow + this protocol) with
the owner-provided authorized credential, and all five scenarios were
dispatched and completed on the branch head's workflow:

| Scenario | Run | Conclusion | Note |
| --- | --- | --- | --- |
| `happy` | 45178513528 | success | full draft-first pointer architecture, rollback drill, re-activation |
| `partial-upload` | 45178674124 | success | draft belt refuses the partial draft; stable ref unchanged |
| `promotion-failure` | 45179021062 | success | missing-release activation refused |
| `incomplete-artifact` | 45179687002 | success | marker bundle refused by verify-snapshot; no release |
| `post-activation-failure` | 45178728162 | failure (EXPECTED) | injection; failure-triggered rollback verified the restored state |

The first dispatch attempt for the last two scenarios was CANCELLED while
queued (GitHub keeps only the newest queued run in a concurrency group);
they were re-dispatched individually after the previous run completed.

Four real defects were found live and fixed on the PR branch before the
successful runs (releases-LIST eventual-consistency retry; the sorted-list
presence check that could never pass; the GITHUB_ENV case-sensitivity bug;
the unconstructible incomplete fixture). Full details:
docs/SNAPSHOT_PUBLICATION.md §19. The residual rehearsal gap (§4) is now
CLOSED for every behavior the five scenarios cover: the pointer
architecture, the unrelated-release probe, the rollback drill, the
state-aware reactivation, the failure-triggered rollback path, and the
draft-first publish sequence all ran against real GitHub behavior with the
runs' own read-only gates proving each result.
