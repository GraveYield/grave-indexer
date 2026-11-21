# ConsoleSnapshot publication — stable reference design and semantics

GY-M1-INT-001 (correction). Supersedes the clobber-based stable-release
design in the initial implementation (commit `20a5c06ef5acc70e9eac6c1075ad1768c4567aeb`).

## 1. The safety requirement

The central requirement is preservation of the last-known-good
production snapshot. A publication system that can temporarily remove
or corrupt the currently served artifact is not acceptable. The
publication operation must behave like

```
OLD VALID ARTIFACT  →  NEW VALID ARTIFACT
```

with no intermediate state in which the stable reference is missing or
points to incomplete data.

## 2. Superseded design and its failure mode

The initial implementation published immutable versioned releases and
then replaced the three assets of a permanent `console-snapshot-prod`
release with `gh release upload --clobber`. That design is rejected:

* Asset replacement on GitHub is per-asset: the old asset is DELETED,
  then the new one CREATED. During that window the stable asset URL
  returns 404 — the Console honestly reports `missing`, but availability
  is lost.
* If an upload fails after the first deletion, the previous
  last-known-good bytes are permanently destroyed; the stable release
  is left with missing or mismatched assets (a NEW snapshot beside an
  OLD provenance is possible for a racing client).
* A three-asset swap cannot be made atomic on GitHub: there is no
  transaction covering multiple assets of one release.

## 3. Selected design — latest-release promotion

Every publication is an immutable, versioned release tagged
`console-snapshot-prod-<YYYYMMDDTHHMMSSZ>-<source-commit-12>` created
with `--latest=false` (so creating it never moves the stable pointer).
The stable retrieval reference is the repo-wide **latest release
designation**, served through the constant URL

```
https://github.com/GraveYield/grave-indexer/releases/latest/download/console-snapshot.json
```

Activation is a single metadata operation — `gh release edit <tag>
--latest` (API `PATCH make_latest=true`) — executed ONLY after:

1. the artifact passed the strict schema-v2 parser and the completeness
   gates (discovery + enrichment) in the generate job;
2. the staged bundle was re-verified after the workflow-artifact
   download (schema + SHA-256 + byte length) — first by the read-only
   `verify` job, then by the privileged job's pure-shell `sha256sum -c`
   belt over the exact bytes it is about to upload;
3. the versioned release was created (duplicate tag aborts, immutably);
4. the three assets were downloaded BACK through the public
   unauthenticated URLs and re-verified (schema-v2 parse, `sha256sum
   -c`, and the provenance sidecar's `versionedTag`).

After activation the workflow re-fetches the stable URL and requires
the served bytes to verify against a sidecar that names the activated
tag (`assertStableReferenceServesVerifiedArtifact`).

Verified GitHub behavior (2026-11-21, live unauthenticated tests):

* `releases/latest/download/<asset>` redirects to the latest release's
  tag path and serves that release's asset BY NAME — one release's
  bytes, never a mixture across releases. Control: `cli/cli`, asset
  download followed 2 redirects to
  `release-assets.githubusercontent.com` and returned HTTP 200,
  `application/octet-stream`, complete bytes; a missing asset name 404s.
* Drafts and prereleases are excluded from the latest designation
  (GitHub documented behavior); our releases are never drafts and never
  prereleases, and non-snapshot releases must not exist in this
  repository (see §6).
* `gh release create --latest=false` works when assets are uploaded in
  a separate command (upstream gh issue #8201 confirms the same-command
  combination is unreliable — the workflow never combines them).
* `gh release edit --latest` performs the designation flip (API
  `PATCH /repos/{owner}/{repo}/releases/{id}` with `make_latest=true`).

### Why this satisfies the safety property

| Property | Mechanism |
| --- | --- |
| Versioned releases immutable | Assets are never re-uploaded; a pre-existing versioned tag aborts the run |
| Old artifact available until activation verified | The previous release is never modified or deleted; `latest` still points at it throughout generation/upload/verification |
| Failed publication cannot destroy the previous artifact | The designation flip is the ONLY stable-pointer operation and it runs last; every earlier failure leaves `latest` unchanged |
| Partial upload cannot be mistaken for success | Promotion runs only after the roundtrip re-verification of ALL three assets |
| No mixture, no missing window | The stable URL resolves to ONE release's complete asset set before AND after the flip; the flip moves the whole pointer at once |
| Auditable history | Every publication remains a distinct immutable release |
| Constant Console-compatible URL | `releases/latest/download/console-snapshot.json` — plain `fetch`, redirects followed, no auth |

## 4. Stable-reference semantics (the ten questions)

1. **Does the stable tag move?** No. There is no mutable
   `console-snapshot-prod` tag/release. The string survives only as the
   versioned tag PREFIX. Versioned tags are unique per publication and
   never move.
2. **Does the stable release change?** The stable *reference* (the
   repo-wide latest designation) moves once per successful publication.
   The release it previously pointed to is unchanged and remains fully
   retrievable.
3. **Are stable assets overwritten?** Never. Each release's assets are
   written once and never touched again. There is no asset clobbering
   anywhere in the design.
4. **Can the previous artifact remain available during activation?**
   Yes — throughout generation, upload, and verification the previous
   release remains the latest designation and is served unchanged. The
   promotion itself does not touch the previous release's assets, which
   stay downloadable forever.
5. **Is the stable URL constant?** Yes —
   `https://github.com/GraveYield/grave-indexer/releases/latest/download/console-snapshot.json`
   (plus the `console-snapshot-provenance.json` and
   `console-snapshot.sha256` variants). Only the content behind it
   changes.
6. **Can the Console retrieve it without authentication?** Yes — the
   repository is public and the latest-release asset path serves
   unauthenticated HTTP with redirects (`fetch(url, { redirect:
   "follow" })` is compatible).
7. **Can a failed update leave the URL unavailable?** No. Failures
   before activation leave the previous release designated (available).
   The only failure mode AFTER activation is the activation itself
   succeeding while the post-activation spot check fails (e.g. CDN
   lag) — the URL then serves the NEW complete artifact; the run
   reports failure for investigation but availability is preserved.
   There is no window in which the URL 404s due to publication
   activity.
8. **Can a client receive mismatched snapshot and provenance files?**
   Not from publication activity. Both files live on the SAME release
   and the whole pointer moves atomically (single metadata operation).
   The residual exposure is a client fetching the two files across a
   promotion boundary — the provenance sidecar's `versionedTag` and the
   SHA-256 over the snapshot bytes make any such pair detectably
   inconsistent; consumers verifying the digest (or comparing
   `versionedTag`) cannot mistake a crossed-boundary pair for a valid
   publication.
9. **How is cache behavior controlled?** The GitHub latest-release path
   redirects to `release-assets.githubusercontent.com` signed URLs;
   intermediate redirects are short-lived and asset URLs are
   re-generated per fetch. Consumers must rely on the sidecar digest
   (`console-snapshot.sha256` / provenance `snapshotSha256`) for
   end-to-end integrity and on the artifact's own `freshness.maxAgeMs`
   for staleness. No cache headers are manipulable in this design —
   that limitation is disclosed, not hidden.
10. **How can an operator roll back to the previous version?** Re-promote
    the previous immutable release — one metadata operation:
    ```
    gh release edit <previous-tag> --repo GraveYield/grave-indexer --latest
    ```
    The previous tag and its verified assets are untouched history. The
    workflow prints the rollback pointer (the previous latest tag) in
    its run summary.

## 5. Failure matrix (verified by test/snapshotPublicationSequence.test.ts)

For every fault the invariant holds: before activation the stable
reference is unchanged and serves the complete previous artifact; after
activation it serves a complete artifact whose sidecar names the
activated versioned tag. See the test battery for the enumerated
scenarios (failures at creation, upload, verification, pre-activation,
activation, post-activation, duplicate tags, invalid provenance,
checksum mismatch, missing snapshot asset, partial publication,
interrupted runs, and concurrent/duplicate publication attempts).

## 6. Residual risks and operator policy

* **Repo-wide designation.** `latest` is per-repository. Any OTHER
  non-draft, non-prerelease release created in `grave-indexer` would
  move the stable pointer. Policy: every release in this repository
  must be a console-snapshot versioned release; any other publishing
  purpose must use prerelease or draft flags (both excluded from the
  designation) or a different repository. The workflow's
  post-activation verification catches a promotion that did not stick.
* **Provenance cross-check.** Consumers SHOULD fetch
  `console-snapshot-provenance.json` alongside the snapshot and verify
  the digest; the Console's current fetch consumes the snapshot URL
  only — its schema-v2 validator still enforces schema and freshness.
* **First publication.** Before the first release exists the stable URL
  404s — the Console reports `missing` honestly. This is bootstrap, not
  data loss.

## 7. What this design does NOT claim

The word "atomic" is reserved for the single release-record metadata
operation (`make_latest`) — GitHub executes it as one update and it
moves the pointer to a release whose asset set was already fully
verified. The overall publication (generate → upload → verify →
activate → verify) is a multi-step process, not atomic; its safety
comes from ordering plus immutability, not from a single transaction.

## 8. VERIFIED repository protection model (PR #5 remediation — review Task 3)

Inspected 2026-11-21 via the authenticated GitHub REST API with the
owner-provided token (evidence recorded in the PR remediation report):

| Configuration | Verified value | Consequence |
| --- | --- | --- |
| Branch protection on `main` | **ABSENT** (`GET /branches/main/protection` → 404 "Branch not protected") | Push access to `main` = direct commit access; the workflow's `refs/heads/main` restriction limits dispatchers to people with push access, but no PR requirement is enforced for the branch itself |
| Repository ruleset "enhancing indexer" (id 27244228, active) | Applies to `~DEFAULT_BRANCH` and `~ALL`; rules: deletion, non_fast_forward, code_quality, copilot_code_review; no bypass actors | `main` cannot be deleted or force-pushed, but the ruleset does NOT require pull requests and does NOT protect tags |
| Tag-protection rulesets | **NONE** (the only ruleset targets branches) | Versioned snapshot tags can be created, updated or deleted by anyone with push access — tag immutability is NOT GitHub-enforced |
| Immutable releases (GitHub feature) | **NOT VERIFIABLE** via the REST API (no endpoint exposes the setting; probing returned 404). Verifying it requires owner access to Settings → Releases or a write probe | The workflow must NOT assume assets are locked after upload |
| Releases / tags in the repository | **NONE exist** (no release, no tag) | The production stable reference is not yet bootstrapped; the first publication is the genuine first-publication path |

### What this means for the publication sequence

1. **Immutability is a WORKFLOW-LEVEL convention here, not a
   GitHub-enforced property.** The design is honest about this: releases
   are created `--latest=false`, assets are never re-uploaded or
   deleted, `--clobber` is never used, and any tag or release collision
   fails closed BEFORE creation. Nothing in the workflow relies on
   GitHub preventing an asset modification — it relies on the workflow
   never issuing one, plus the auditability of the release history.
2. **Tag collision handling is explicit three-way** (hardened in this
   remediation): `git ls-remote --exit-code` exit 2 = genuinely absent
   (proceed), exit 0 = exists (abort), ANY other exit = the gate itself
   failed (abort — never interpreted as "absent"). An existing RELEASE
   for the tag also aborts via `gh release view`.
3. **Compatibility with GitHub's immutable-releases feature:** the
   current sequence (create a published, empty release → upload assets)
   is compatible with the CURRENT model but would FAIL once immutable
   releases are enabled, because assets cannot be added to an already
   published release under that feature. If the owner enables immutable
   releases, the sequence MUST first be changed to draft-first (create
   draft → upload → publish with explicit `make_latest=false` → verify →
   promote), and the publish-time behavior (that un-drafting does not
   silently move the latest designation) must be re-verified on the
   rehearsal target first. **Do not enable immutable releases before
   that change is implemented and rehearsed.** This is an owner action,
   not something this PR does.
4. **A failed or partial upload cannot leave an unusable promoted
   release:** the partial release is never designated latest (the
   roundtrip verification precedes promotion), so the previous
   artifact keeps serving. The orphan versioned release remains visible
   in the release history for inspection — that is by design (audit),
   and it can be deleted by an operator without touching the stable
   reference.

### Owner/admin actions identified (NOT performed by this PR)

* Add a pull-request requirement (and required checks) to `main` via
  branch protection or a ruleset — the ruleset currently lacks a
  `pull_request` rule.
* Decide whether to enable GitHub's immutable releases; if yes, the
  draft-first sequence change above must land first.
* Optionally add tag-protection rules for the
  `console-snapshot-prod-*` namespace so versioned snapshot tags become
  GitHub-enforced immutable.

## 9. Stable-reference architecture decision (PR #5 remediation — review Task 2)

The originally approved GY-M1-INT-001 design specified a DEDICATED
stable reference named `console-snapshot-prod`. PR #5 implemented the
repo-wide latest-release promotion instead — a MATERIAL architecture
change that this remediation does NOT treat as owner-approved. Both
alternatives are documented here; the decision is an explicit OWNER
APPROVAL GATE.

### Option A — dedicated stable reference (`console-snapshot-prod`)

Keep a permanent stable release/tag named `console-snapshot-prod` and
make it always point at the last-known-good artifact.

* **Safety requirement it must satisfy:** the currently served artifact
  stays available until the replacement is verified and activated; no
  missing-asset window; no mixed snapshot/provenance set.
* **The GitHub-native mechanisms available, and why each fails the
  requirement:**
  1. *Asset clobbering on the stable release* (`gh release upload
     --clobber`) — REJECTED (see §2): per-asset delete-then-create is
     not atomic; a failed upload can permanently destroy the
     last-known-good bytes.
  2. *A pointer artifact* (a small stable file naming the versioned
     release's URL) — the pointer file itself needs a stable, atomically
     updatable location: the same problem one level down. Consuming it
     ALSO requires a Console change (the Console fetches one fixed URL
     and validates schema-v2; a pointer indirection is not in the
     shipped consumer contract), i.e. an explicit Console-side scope
     change.
  3. *GitHub Pages* hosting a pointer file — separate deployment
     pipeline and a second production system; a new production
     architecture that requires owner authorization and cannot be
     invented by this PR.
* **Status: NOT implementable with the required safety property on
  GitHub natively today.** If the owner requires Option A, the realistic
  path is option 2 or 3 above plus an authorized Console change — a
  decision and a scope extension that belong to the owner, not to this
  PR.

### Option B — repository-wide latest release (current implementation)

Publish immutable versioned releases and promote one to "latest" after
full verification (§3). The stable URL is the constant
`releases/latest/download/console-snapshot.json`.

* **What it buys:** the last-known-good property with GitHub-native
  semantics only (verified live: one release's bytes via one redirect,
  pointer = single metadata field, drafts/prereleases excluded).
* **What it costs:** the pointer is REPO-WIDE. An unrelated
  non-draft, non-prerelease release would take it over. Required
  compensating policy (documented, NOT technically enforceable from
  inside this repository's workflows):
  1. **Exclusive promotion policy:** every non-draft, non-prerelease
     release in `grave-indexer` must be a console-snapshot versioned
     release; other content must be released elsewhere or flagged
     prerelease/draft.
  2. **Operational responsibility:** the owner (or a delegated
     maintainer) owns release hygiene in this repository; any other
     workflow or actor that can create releases is in scope of this
     policy.
  3. **Rollback mechanism:** `gh release edit <previous-tag> --latest`
     + `verify-release-assets --scope latest --expected-tag
     <previous-tag>` (the workflow prints both in its run summary).
  4. **Detection (implemented):** the post-activation gate fails the
     run if the latest designation does not equal the activated tag —
     so a racing unrelated promotion is at least never mistaken for a
     successful publication.
* **Status: implemented as the interim mechanism. It remains subject to
  the owner's explicit approval of the repo-wide-latest architecture
  and the exclusive promotion policy above.** This PR does not claim
  that approval; the decision is restated as a blocker in the PR report.

### The decision the owner is asked to make

> Approve one of: (A) dedicated stable reference, accepting that it
> requires a pointer-artifact/Pages mechanism AND a Console change, or
> (B) repo-wide latest-release promotion, accepting the exclusive
> promotion policy and the residual repo-wide-pointer risk. Until the
> decision is recorded, no production publication should be dispatched.

## 10. Remediation hardening (PR #5 — review Tasks 1, 4, 5)

* **Execution restriction (Task 1):** ALL FOUR jobs carry
  `if: github.ref == 'refs/heads/main'` AND an explicit guard step;
  every repository checkout is pinned to `github.sha` and asserts
  `git rev-parse HEAD` equals it, so the provenance
  `indexerSourceCommitSha` is the actual checked-out commit.
* **Write-token isolation (Task 1 — second-round correction):** the
  first remediation attached `GH_TOKEN` per-step but kept a job-level
  `permissions: contents: write` on a job that also ran checkout,
  setup-node, pnpm and dependency installation. That was insufficient:
  the job-level grant makes `github.token` write-capable for the whole
  job, and first-party actions consume it BY DEFAULT
  (`actions/checkout`'s `token` input, `actions/setup-node`'s `token`
  input) even without an explicit `GH_TOKEN` env. The corrected
  structure separates read-only preparation/verification from the
  privileged release operations:
  * `generate` (read-only) — build, generate, validate, stage the
    artifact bundle;
  * `verify` (read-only) — independently re-download the staged bundle,
    re-verify schema-v2 + integrity against the downloaded bytes, and
    compile the release-ops CLI (src/releaseOpsCli.ts) into a single
    self-contained bundle with ZERO npm runtime dependencies
    (`pnpm run bundle:release-ops`, `node:` builtins only; pinned by
    test/releaseOpsCliBundle.test.ts);
  * `publish` (`contents: write`) — the ONLY privileged job, and it is
    minimal: no checkout, no dependency installation, no build, no pnpm,
    no repository code, and deliberately NO checkout/setup-node actions
    (both consume `github.token` by default). Its only `uses:` steps are
    actions/download-artifact (artifact-scoped runtime token, no
    `github.token` input). Every command is runner-preinstalled tooling
    (git, curl, sha256sum, gh) or the prebuilt zero-dependency bundle on
    the runner's plain `node`. The write-capable `GH_TOKEN` exists only
    as an explicit step-level env on the GitHub release API steps;
  * `verify-stable` (read-only) — the post-activation stable gate, run
    with the READ-ONLY workflow token from a full repository checkout.
  The privileged job's trust chain: the bundle it executes was built by
  the read-only verify job from the exact asserted commit and travels
  through the run-scoped artifact service within one workflow run; the
  artifact bytes it uploads were verified by BOTH read-only jobs, and
  the privileged job re-checks the checksum over the downloaded bytes
  (`sha256sum -c`) before anything is published.
* **Rollback-pointer discovery (Task 4):** the previous
  `gh api ... 2>/dev/null || echo ""` pattern is replaced by
  `release-latest` (src/releaseOps.ts): only a genuine HTTP 404 yields
  "first publication"; AUTHENTICATION, PERMISSION, RATE_LIMIT,
  API_OUTAGE, NETWORK, MALFORMED_RESPONSE and UNEXPECTED_STATUS are
  typed aborts. The pointer is recorded and written to the run summary
  BEFORE any release operation.
* **Same-release verification (Task 5):** `verify-release-assets
  --scope versioned` verifies all three assets of ONE exact versioned
  release (checksum over the exact bytes, provenance digest, and the
  provenance must NAME that release's tag — a cross-release mixture is
  detectable because only the release's own sidecar carries its tag).
  The post-activation gate `--scope latest` additionally requires the
  repo-wide latest designation (authenticated API query) to equal the
  activated tag before the three stable-URL files are cross-checked, so
  neither pointer drift nor an in-flight promotion race can bless a
  mixed artifact set.
