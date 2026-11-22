# Publication rehearsal — record and manual plan (PR #5 remediation, review Task 6; eighth-round correction — review Finding 2)

Status: **PREPARED — NOT EXECUTED.** The rehearsal workflow now rehearses
the SAME dedicated stable-reference architecture as production
(`refs/tags/console-snapshot-prod` → annotated pointer tag object →
versioned release assets). It has NOT been dispatched as part of this
correction: no authorized dispatch exists, `workflow_dispatch` is only
registrable from a default branch, and no rehearsal result may be
claimed until an authorized run has completed and been independently
verified.

Nothing in this remediation triggered a production publication, created
or modified a production release, moved a production stable reference,
changed Vercel configuration, deployed the Console, or touched
Mainnet/protocol state. No rehearsal release, tag, or reference was
created either.

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
verification, PAT isolation) and the rehearsal workflow's hard guard
plus its pointer-architecture step sequence.

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
| `happy` | versioned release created `--latest=false` + full asset upload; same-release verification (digests + lengths); pointer build + strict pointer-schema validation; annotated tag object creation; dedicated-ref create-or-update (404 → `POST /git/refs`, 200 → `PATCH /git/refs/tags/console-snapshot-prod` force); read-back (sha + message equality); full identity chain via `verify-stable`; an UNRELATED release taking the repo-wide latest designation does NOT move the dedicated reference; rollback drill — restore the previous pointer (verified through the full chain) or, on a first publication, delete the reference and verify HTTP 404; re-activation |
| `partial-upload` | uploading only the snapshot asset fails same-release verification; the DEDICATED stable reference is unchanged after the failed publication; the previously active artifact remains fully retrievable and internally consistent; cleanup deletes the partial rehearsal release |
| `promotion-failure` | building/activating a pointer for a MISSING release fails closed; the dedicated reference is unchanged |
| `incomplete-artifact` | an incomplete bundle (zero enriched pools) is refused by the independent `verify-snapshot` gate and never promoted (no release exists for its tag) |

## 3. Why it has not run yet, and what the owner must do

Dispatching `rehearsal-publication` from this branch is NOT possible:
GitHub registers `workflow_dispatch` workflows only from the default
branch, and dispatching it is explicitly outside this task's
authorization. Additionally, an earlier reconnaissance found the
rehearsal repository `GraveYield/grave-indexer-pub-rehearsal` exists but
the task's credential cannot write to it — provisioning that access is
an owner decision.

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

## 4. Residual rehearsal gap (honest)

Until the rehearsal runs on an authorized target, the following are
proven by tests + offline batteries but NOT yet by a live write-path
rehearsal: the exact `gh api` git-data mutation behavior on a real
release/tag set (pointer tag object creation, ref create/update/delete,
read-back), the unrelated-release probe against real GitHub pointer
semantics, and the rollback drill's end-to-end timing. The design does
not depend on any UNVERIFIED GitHub behavior for last-known-good
preservation (the pointer only moves through the atomic ref update,
after which the read-back and the post-activation gate either confirm
or fail the run, and both rollback paths verify their own result) — but
the owner should run the rehearsal above before the first production
publication.

Equally important, do NOT overstate other unverified claims: GitHub-side
immutable-release enforcement is NOT enabled (immutability is a
workflow-level convention; enabling GitHub's immutable-releases feature
is an owner decision — docs/SNAPSHOT_PUBLICATION.md §8), and production
Console ingestion is NOT operational (the Console's single-GET
`GY_SNAPSHOT_URL` contract requires the §13.2 two-step resolver, which
is an owner-approval gate outside this task).
