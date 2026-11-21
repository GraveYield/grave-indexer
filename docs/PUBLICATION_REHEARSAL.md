# Publication rehearsal — record and manual plan (PR #5 remediation, review Task 6)

Status: **PARTIALLY EXECUTED — external target unavailable; precise manual plan provided.**
Nothing in this remediation triggered a production publication, created or
modified a production release, moved a production stable reference, changed
Vercel configuration, deployed the Console, or touched Mainnet/protocol state.

## 1. What was executed

### 1.1 Live GitHub-semantics verification (read-only, unauthenticated)

Executed 2026-11-21 against public repositories (control: `oven-sh/bun`,
`nodejs/node`, `cli/cli`) — the exact URL semantics the stable-reference
design depends on:

| Check | Result |
| --- | --- |
| `releases/latest/download/<asset>` for an existing asset | HTTP 200 after 2 redirects, `application/octet-stream`, 39,827,261 bytes — plain-fetch compatible, one release's bytes |
| `releases/latest/download/<missing-asset>` | HTTP 404 (honest "missing") |
| Prerelease exclusion from the latest designation | `nodejs/node`: newest published list contains a prerelease (`v27.0.0-alpha.0.1.0`) while `/releases/latest` resolves to the newest non-prerelease (`v27.0.0-alpha.0.1.1`) — prereleases are excluded from the designation |
| Redirect target of the latest path | first redirect is to `/releases/download/<tag>/<asset>` — the URL family is per-release behind the scenes; the same-release cross-checks (Task 5) detect any mixture |

### 1.2 Local rehearsal of the publication sequence (executable abstraction, real verification logic)

`test/snapshotPublicationSequence.test.ts` drives
`runPublicationSequence` — the workflow's exact step order over an
injectable release store, with the REAL schema-v2 parser, integrity,
checksum and ordering gates. Failure-injection battery (13 scenarios) plus
the mixed-release race battery (review Task 5): pointer drift between the
three stable downloads, snapshot/provenance from different releases,
checksum from a different release, missing sidecar, mislabeled provenance.
All assert the last-known-good invariant after every fault.

`test/releaseOps.test.ts` drives the REAL CLI commands the workflow
invokes (`release-latest`, `verify-release-assets`) with the GitHub HTTP
layer monkeypatched — the full error-classification matrix (404/200/401/
403-permission/403-rate-limit/429/5xx/network/malformed/unexpected) and the
pointer-drift rejection.

### 1.3 Guard-refusal rehearsal in Actions — PREPARED, not dispatchable from this branch

`.github/workflows/rehearsal-publication.yml` is committed on this branch
with a HARD GUARD whose first step refuses to run anywhere except
`GraveYield/grave-indexer-pub-rehearsal`. Dispatching it here (in
`grave-indexer`, on the PR branch) was ATTEMPTED and is NOT possible
before merge: GitHub registers `workflow_dispatch` workflows only from
the default branch (`POST /actions/workflows/rehearsal-publication.yml/
dispatches` → 404 while the file exists only on this branch). The guard's
correctness is therefore pinned structurally by
`test/publishWorkflow.test.ts` (guard is the FIRST step, aborts with
exit 1, and no command may target the production repository); the live
guard-refusal run can be executed after merge or on the rehearsal repo
(no production release operation can occur either way — the guard aborts
first).

## 2. What could NOT be executed, and why

The full publication rehearsal (versioned release creation, asset upload,
unauthenticated roundtrip download, promotion, rollback drill, partial-upload
and promotion-failure injections) requires a WRITABLE, clearly separate
non-production repository. The owner-provided fine-grained PAT is scoped to
`GraveYield/grave-indexer` only:

* `POST /orgs/GraveYield/repos` succeeded (an empty
  `GraveYield/grave-indexer-pub-rehearsal` was created as the intended
  target), but the token cannot write content, releases, deploy keys, or
  delete the repo (`403 Resource not accessible by personal access token`
  for contents/releases/keys/forks — the token's repository-access list
  does not include the new repo, and it cannot be extended by this agent).
* Substituting a production release in `grave-indexer` was NOT done —
  prohibited by the task boundaries (any release in the production repo
  would move the repo-wide latest designation, i.e. the production stable
  reference).

**Consequently: no fake or inferred rehearsal results are reported. The
in-Actions scenarios below are prepared and guarded, awaiting an authorized
target.**

## 3. Prepared in-Actions rehearsal (awaiting an authorized target)

`.github/workflows/rehearsal-publication.yml` is committed on this branch.
It is HARD-GUARDED: the first step refuses to run unless
`GITHUB_REPOSITORY == "GraveYield/grave-indexer-pub-rehearsal"`
(structurally pinned by `test/publishWorkflow.test.ts`). It builds a REAL
schema-v2 fixture bundle from the production builders
(`test/fixturePublicationBundle.ts` — offline, no RPC, no secrets) and
rehearses the REAL GitHub operations via `gh` CLI + the same verification
CLI gates the production workflow uses.

Scenarios (dispatch input):

| Scenario | Proves |
| --- | --- |
| `happy` | versioned release created `--latest=false` does not move the pointer; same-release asset verification through public tag URLs; promotion moves the pointer in one metadata op; post-activation gate passes; rollback drill restores the previous release and re-promotes |
| `partial-upload` | uploading only the snapshot asset fails same-release verification; the latest designation is UNCHANGED after the failed publication; the previously active artifact remains fully retrievable and internally consistent; cleanup deletes the partial rehearsal release |
| `promotion-failure` | promoting a missing release fails non-zero; the designation is unchanged |
| `incomplete-artifact` | an incomplete bundle (zero enriched pools) is refused by `verify-snapshot` and never promoted (no release exists for its tag) |

### Owner steps to run the full rehearsal

1. Grant the CI token (or a scoped PAT) `contents: write` on
   `GraveYield/grave-indexer-pub-rehearsal`, or push this branch to that
   repository's `main` with any account that can.
2. Initialize the rehearsal repo (one commit), e.g. via the GitHub UI.
3. Dispatch `rehearsal-publication` with each scenario; record run URLs,
   run IDs, release/tag identifiers, asset download results, hash and
   schema verification results, failure-injection outcomes and the
   rollback result from the run summaries (the workflow writes a
   structured record to `GITHUB_STEP_SUMMARY`).
4. Optionally ALSO dispatch `publish-console-snapshot` in the rehearsal
   repo with small inputs (`max_pools=50`, `enrich=5`) to rehearse the
   ACTUAL production workflow end-to-end (its guard permits `main` of
   whatever repo it runs in; in the rehearsal repo it exercises the same
   steps against non-production releases).

### Precise manual rehearsal plan (no CI needed)

With `gh` authenticated to the rehearsal repo, in order:

1. `node --import tsx/esm test/fixturePublicationBundle.ts --out data` — build the fixture.
2. `gh release create <TAG> --repo <REHEARSAL_REPO> --target <SHA> --latest=false --title ...` — create the versioned release; then `gh release view <TAG>` and `gh api repos/<REHEARSAL_REPO>/releases/latest` must NOT show it as latest.
3. `gh release upload <TAG> data/console-snapshot.json data/console-snapshot-provenance.json data/console-snapshot.sha256`.
4. `node --import tsx/esm src/cli.ts verify-release-assets <REHEARSAL_REPO> --tag <TAG> --scope versioned --expected-tag <TAG>` — must exit 0 (unauthenticated roundtrip, same-release cross-check).
5. `gh release edit <TAG> --latest` — promote; then
   `node --import tsx/esm src/cli.ts verify-release-assets <REHEARSAL_REPO> --tag <TAG> --scope latest --expected-tag <TAG>` — must exit 0.
6. Rollback: `gh release edit <PREVIOUS_TAG> --latest` (repeat publication for a second tag first), then verify `--scope latest --expected-tag <PREVIOUS_TAG>`; re-promote `<TAG>` afterwards.
7. Partial upload: create another tag, upload ONLY `console-snapshot.json`, then `verify-release-assets --scope versioned` must exit non-zero; the latest designation must still be the previous tag; the previously active release's three assets must still download with HTTP 200 and verify.
8. Promotion failure: `gh release edit console-snapshot-prod-20990101T000000Z-notrack --latest` must fail non-zero; designation unchanged.
9. Incomplete artifact: `node --import tsx/esm test/fixturePublicationBundle.ts --out data-incomplete --incomplete` then `verify-snapshot data-incomplete/...` must exit non-zero and no release may be created for its tag.

## 4. Residual rehearsal gap (honest)

Until the rehearsal runs on an authorized target, the following are proven
by tests + live read-only verification but NOT yet by a live write-path
rehearsal: `gh release create --latest=false` pointer semantics on a real
release, asset upload/roundtrip latency, and the rollback drill's exact
API behavior. The design does not depend on any UNVERIFIED GitHub behavior
for last-known-good preservation (the pointer only moves through the
verified single-metadata promotion, after which the post-activation gate
either confirms or fails the run) — but the owner should run the rehearsal
above before the first production publication.
