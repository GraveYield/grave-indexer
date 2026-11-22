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

> **SUPERSEDED (sixth round, 2026-11-22):** the owner SELECTED the
> dedicated `console-snapshot-prod` stable-reference architecture —
> see §9 (the recorded decision) and §13 (the exact production
> resolution mechanism). This section is retained as the historical
> record of the interim repo-wide-latest design, which is no longer the
> production path.

Every publication is an immutable, versioned release tagged
`console-snapshot-prod-<YYYYMMDDTHHMMSSZ>-<source-commit-12>` created
with `--latest=false` (so creating it never moves the stable pointer).
The stable retrieval reference is the repo-wide **latest release
designation**, served through the constant URL

```
https://github.com/GraveYield/grave-indexer/releases/latest/download/console-snapshot.json
```

**PRIVATE-REPOSITORY NOTE (owner changed visibility, 2026-11-22):** that
URL — and the versioned tag asset URLs — now REQUIRE AUTHENTICATION.
Unauthenticated requests to a private repository return HTTP 404. The
workflow's own verification gates fetch through the authenticated REST
API path with the READ-ONLY workflow token (§11); UNAUTHENTICATED
consumers (the `graveyield-console` deployment) can NO LONGER FETCH THE
ARTIFACT AT ALL — the production integration blocker and the secure
alternatives are documented in §12. Verified GitHub behavior of the
latest-release redirect path itself (one release's bytes per fetch,
drafts/prereleases excluded) is unchanged; the tests below were live
while the repository was public.

Activation is a single metadata operation — `gh release edit <tag>
--latest` (API `PATCH make_latest=true`) — executed ONLY after:

1. the artifact passed the strict schema-v2 parser and the completeness
   gates (discovery + enrichment) in the generate job;
2. the staged bundle was re-verified after the workflow-artifact
   download (schema + SHA-256 + byte length) — first by the read-only
   `verify` job, then by the privileged job's pure-shell `sha256sum -c`
   belt over the exact bytes it is about to upload;
3. the versioned release was created (duplicate tag aborts, immutably);
4. the three assets were downloaded BACK through the authenticated API
   path (the public unauthenticated URLs were valid only while the
   repository was public) and re-verified (schema-v2 parse, `sha256sum
   -c`, and the provenance sidecar's `versionedTag`).

After activation the workflow re-fetches the stable URL and requires
the served bytes to verify against a sidecar that names the activated
tag (`assertStableReferenceServesVerifiedArtifact`).

Verified GitHub behavior (2026-11-21, live unauthenticated tests — the
repository was public at the time; since the visibility change the same
paths require authentication):

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
| Constant Console-compatible URL | `releases/latest/download/console-snapshot.json` — while the repository was public: plain `fetch`, redirects followed, no auth. **Since the visibility change this URL requires authentication — the Console can no longer fetch it (§12 blocker)** |

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
6. **Can the Console retrieve it without authentication?** NO — the
   repository is now PRIVATE. The visibility change makes unauthenticated
   retrieval IMPOSSIBLE and breaks the shipped Console consumer contract.
   See §12 for the production integration blocker and the owner-decision
   alternatives. (Historical, public-repository behavior: the
   latest-release asset path served unauthenticated HTTP with redirects
   (`fetch(url, { redirect: "follow" })` was compatible).)
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

## 9. Stable-reference architecture decision (PR #5 remediation — review Task 2; DECIDED — sixth round)

The originally approved GY-M1-INT-001 design specified a DEDICATED
stable reference named `console-snapshot-prod`. PR #5 implemented the
repo-wide latest-release promotion instead — a MATERIAL architecture
change. **On 2026-11-22 the owner explicitly selected the dedicated
architecture**, and the sixth-round correction implements it. The
alternatives are retained below for the audit record.

### Option A — dedicated stable reference (`console-snapshot-prod`) — SELECTED AND IMPLEMENTED

The production stable reference is the git ref
`refs/tags/console-snapshot-prod` — an ANNOTATED tag whose tag-object
MESSAGE carries the stable-pointer JSON
(`graveyield.console-snapshot-stable-pointer.v1`) naming ONE immutable
versioned release (tag + source commit + per-asset SHA-256 digests and
byte lengths). The pointer bytes are NEVER copied onto the stable
reference: the snapshot/provenance/checksum live exclusively on
immutable versioned releases, so the reference cannot become a second
mutable copy of the payload.

**The exact GitHub mechanism** (deliberately NOT treating release tag,
release name and latest designation as interchangeable):

1. Promotion builds the pointer JSON from the VERIFIED release bytes
   (read-only bundle step, `stable-pointer-build`).
2. The privileged step creates a NEW immutable annotated tag object
   (`POST /repos/{repo}/git/tags`, `message` = pointer JSON,
   `object` = the release's source commit).
3. The ref is then moved with ONE atomic update (`PATCH
   /repos/{repo}/git/refs/tags/console-snapshot-prod`, force; on a
   first publication the ref is CREATED via `POST /git/refs`). A reader
   of the ref sees the old pointer or the new pointer — never a missing
   window or a partial state.
4. Read-back verification (read-only) confirms the ref resolves to the
   created object sha and its message equals the validated pointer JSON,
   byte-for-byte.

**Why this satisfies the safety property** (answering §3-era objections):

* The previously rejected mechanism — asset clobbering on a stable
  release (`gh release upload --clobber`) — is NOT atomic per asset and
  can destroy the last-known-good bytes. This design deletes and
  overwrites NO assets at all: the only mutable thing is the ref, and a
  ref update is a single atomic operation.
* The previously open question "the pointer file needs a stable,
  atomically updatable location" is answered by the git ref itself:
  annotated tag objects are immutable git objects re-created per
  promotion, and the ref update is atomic.
* The stable reference is DEDICATED: an unrelated release taking the
  repo-wide latest designation cannot move it (verified by test).
* Rollback: the previous pointer JSON is recorded BEFORE the mutation
  (run summary + job output + the new pointer's `previous*` fields);
  rollback re-creates a tag object carrying the previous pointer
  verbatim, re-points the ref, and verifies by read-back — it does not
  depend on the old tag object remaining reachable. An unverifiable
  rollback fails loudly (the state is reported UNVERIFIED, never
  claimed restored).
* Residual limitation (disclosed): a reader racing the ref update may
  see either pointer; every consumer MUST verify the fetched bytes
  against the pointer digests (fail-closed), which is part of the
  documented Console contract (§13).

### Option B — repository-wide latest release (SUPERSEDED interim implementation)

Retired from the production path by the owner's decision. The historical
mechanism (immutable versioned releases + a single `make_latest` metadata
promotion + the exclusive-promotion policy) is documented in the git
history of this file and in §3. The `verify-release-assets --scope
latest` CLI capability and the `releases/latest/download/...` URL helpers
survive only as non-production utilities and tests.

## 10. Remediation hardening (PR #5 — review Tasks 1, 4, 5)

* **Execution restriction (Task 1):** ALL SEVEN jobs carry
  `if: github.ref == 'refs/heads/main'` AND an explicit guard step;
  every repository checkout is pinned to `github.sha` and asserts
  `git rev-parse HEAD` equals it, so the provenance
  `indexerSourceCommitSha` is the actual checked-out commit and the
  release `--target` is the same asserted commit.
* **Write-token isolation (Task 1 — FOURTH-round correction, final):**
  the first remediation attached `GH_TOKEN` per-step but kept a job-level
  `permissions: contents: write` on a job that also ran checkout,
  setup-node, pnpm and dependency installation. The second remediation
  removed checkout/setup-node/pnpm from the privileged job but STILL
  executed repository-built code (the release-ops bundle, provenance
  parsing) inside the write-permission job — and GitHub makes
  `github.token` write-capable for EVERY step of a job whose
  `permissions` grant write, whether or not an explicit `GH_TOKEN` env
  is attached. The third remediation moved ALL custom code into
  read-only jobs, leaving the write grant only on two jobs with zero
  custom code. The FINAL correction eliminates the write grant
  entirely: the owner provisioned a fine-grained PAT exclusively for
  this repository (repository secret `GY_RELEASE_PAT`), and the release
  mutations authenticate with THAT credential on the two mutation
  steps' env alone. **No job in the workflow declares `contents:
  write` — the automatic GITHUB_TOKEN is READ-ONLY in all seven jobs by
  explicit declaration** (each job carries `permissions: contents:
  read`; the workflow default is `contents: read`). Seven jobs:

  | Job | Effective permissions | Executes custom code? | Token access |
  | --- | --- | --- | --- |
  | `generate` | `contents: read` (EXPLICIT) | YES (build + `publish-snapshot`/`verify-snapshot`) | `github.token` READ-ONLY (consumed implicitly by checkout/setup-node; no `GH_TOKEN` env anywhere); RPC secrets to the snapshot CLI only |
  | `verify` | `contents: read` (EXPLICIT) | YES (independent re-verification + builds the zero-dep release-ops bundle) | `github.token` READ-ONLY (implicit via checkout/setup-node only) |
  | `publish` | `contents: read` (EXPLICIT) | YES (checksum belt, provenance tag parse, collision gates, `release-latest` discovery) | `github.token` READ-ONLY, step-level env on the tag-collision gate, the belt-check GET and the discovery step ONLY — never the PAT |
  | `release` | `contents: read` (EXPLICIT) | **NO** | `github.token` READ-ONLY, step-level env on the authenticated tag-collision gate ONLY; `GY_RELEASE_PAT` step-level env on the `gh release create/upload` mutation step ONLY |
  | `verify-versioned` | `contents: read` (EXPLICIT) | YES (prebuilt zero-dep bundle, `--scope versioned` roundtrip) | `github.token` READ-ONLY, step-level env on the roundtrip gate ONLY (the repository is private: release assets 404 unauthenticated) — never the PAT |
  | `promote` | `contents: read` (EXPLICIT) | **NO** | `GY_RELEASE_PAT` step-level env on the single `gh release edit --latest` mutation step ONLY; the tag-shape precondition step is token-free |
  | `verify-stable` | `contents: read` (EXPLICIT) | YES (reviewed commit's own verification CLI, `--scope latest`) | `github.token` READ-ONLY, step-level env on the gate step only |

  See §11 for the complete credential-access matrix and the trust
  assumptions, and §12 for the private-visibility consequences.

  Design points:
  * `generate` (read-only) — build, generate, validate, stage the
    artifact bundle;
  * `verify` (read-only) — independently re-download the staged bundle,
    re-verify schema-v2 + integrity against the downloaded bytes, and
    compile the release-ops CLI (src/releaseOpsCli.ts) into a single
    self-contained bundle with ZERO npm runtime dependencies
    (`pnpm run bundle:release-ops`, `node:` builtins only; pinned by
    test/releaseOpsCliBundle.test.ts);
  * `publish` (READ-ONLY) — every gate and every piece of custom code:
    checksum belt over the downloaded bytes, provenance tag parsing +
    strict shape validation, the fail-closed three-way tag/release
    collision gates, and the hardened `release-latest` rollback-pointer
    discovery (custom bundle, READ-ONLY token). It declares
    `permissions: contents: read` EXPLICITLY, so a write-capable token
    cannot exist in it under any circumstance;
  * `release` (`contents: read` + PAT on the mutation step, ZERO custom
    code) — no checkout, no setup-node, no pnpm, no node invocation, no
    repository or artifact-executed code. Its only action is
    actions/download-artifact (artifact-scoped runtime token, no
    `github.token` input). Steps: token-free sha256 belt + tag shape
    re-validation + the authenticated three-way tag-collision gate
    (READ-ONLY automatic token — the unauthenticated ls-remote probe
    cannot resolve a private repository) immediately before the
    mutation, then `gh release create --latest=false --target <asserted
    sha>` and `gh release upload` — the ONLY step where the
    `GY_RELEASE_PAT` write credential exists (step-level env). GitHub
    itself fails closed at the mutation (422 already-exists on create;
    asset-exists on upload);
  * `verify-versioned` (read-only) — the same-release roundtrip gate
    BETWEEN upload and promotion: the three assets of THAT EXACT
    versioned release are verified through the AUTHENTICATED API path
    with the prebuilt zero-dependency bundle and the READ-ONLY workflow
    token (the repository is private — release assets 404 for
    unauthenticated requests); the stable pointer cannot move until
    this job is green (`promote` has `needs: verify-versioned`);
  * `promote` (`contents: read` + PAT on the mutation step, ZERO custom
    code) — exactly ONE privileged operation, `gh release edit <tag>
    --latest`, with the `GY_RELEASE_PAT` credential as that step's env
    only (the automatic token is read-only);
  * `verify-stable` (read-only) — the post-activation stable gate, run
    with the READ-ONLY workflow token from a full repository checkout.
  The privileged jobs' trust chain: the bytes they upload were
  schema- and integrity-verified by BOTH read-only jobs; the release
  job re-checks the checksum over its own downloaded bytes
  (`sha256sum -c`) and re-validates the tag shape before anything is
  published; the tag crossing job boundaries is validated AGAIN in
  every consuming job; `verify-versioned` verifies the released bytes
  BEFORE `promote` may run (needs: chain enforces the order);
  `verify-stable` re-verifies the stable pointer after activation.

  **Honest limitation of the boundary (now reduced, not eliminated):**
  GitHub's automatic GITHUB_TOKEN can only obtain `contents: write`
  through a job-level `permissions` grant — there is no per-step
  permission knob. The final structure sidesteps this entirely: NO job
  grants write, so a write-capable AUTOMATIC token does not exist
  anywhere in the workflow. The write capability lives exclusively in
  the `GY_RELEASE_PAT` secret, which GitHub injects ONLY into the two
  steps whose env explicitly references it — and the jobs that hold it
  contain zero custom code (no checkout, no node, no dependencies), so
  nothing but the pinned `gh` release-mutation commands can read it.
  Residual trust assumptions are listed in §11. This structural
  boundary is pinned by test/publishWorkflow.test.ts (global
  invariants: no job declares a write grant; the PAT appears only on
  the two mutation steps; no code-executing, artifact or checkout step
  references it).
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

## 11. Credential-access matrix and PAT trust assumptions (final credential isolation)

The owner provisioned a fine-grained PAT exclusively for
`GraveYield/grave-indexer` and stored it as the repository Actions
secret `GY_RELEASE_PAT`. The workflow consumes it BY REFERENCE ONLY
(`${{ secrets.GY_RELEASE_PAT }}`); nothing in this repository ever
prints, decodes, logs or otherwise exposes its value, and the value was
never accessed while preparing this change.

### Who can access what

| Credential | Where it exists | What it can do |
| --- | --- | --- |
| `github.token` (automatic) | ALL SEVEN jobs — every job explicitly declares `permissions: contents: read` | READ-ONLY repository content, read API queries (release-by-tag belt check, git-ref tag gate, stable-ref and tag-object reads, authenticated asset fetches during verification, post-activation read-back) |
| `GY_RELEASE_PAT` (owner-provisioned fine-grained PAT) | STEP-level env of exactly THREE steps: the `release` job's `gh release create/upload` step; the `promote` job's stable-ref activation step (create annotated pointer tag object + atomic ref update); the `promote` job's failure-path rollback step (re-create the previous pointer object + re-point the ref, or delete the ref on first publication) | GitHub release mutations AND git-data mutations of the dedicated stable reference (`git/tags`, `git/refs`) — nothing else |
| `ACTIONS_RUNTIME_TOKEN` | Managed by GitHub for `actions/upload-artifact` / `actions/download-artifact` inside one workflow run | Run-scoped artifact transport only; not a `github.token` input |
| `MAINNET_RPC_URL` / `DEVNET_RPC_URL` | `generate` job env (RPC access for snapshot generation) | RPC endpoints; no GitHub capability |

### The steps that never receive a write credential

Every job that checks out code, installs dependencies, builds, runs
tests, generates snapshots, executes repository-built JavaScript,
downloads or verifies artifacts, validates schema/provenance/checksums,
or discovers the rollback pointer runs under an explicit
`contents: read` grant and references `github.token` (read-only) or no
token at all — NEVER the PAT. The release and promote jobs hold the PAT
but contain ZERO custom code: no checkout, no dependency installation,
no node, no repository script, no artifact-executed code — the only
commands that can read the credential are the pinned `gh release`
mutation invocations and the pinned `gh api` git-data mutations of the
dedicated stable reference (create the pointer tag object, move the
ref, and the failure-path rollback, which also reads back what it just
wrote to verify its own mutation).

### Trust assumptions (owner-side, not verifiable from this repository)

1. **PAT scope.** The workflow cannot verify the PAT's permission
   configuration. The isolation above assumes the owner provisioned it
   fine-grained, scoped to `GraveYield/grave-indexer` only, with
   Contents read/write (the minimum needed for release create/upload/
   edit) and no additional permissions. If the PAT is broader, the
   blast radius of the two mutation steps grows accordingly — that is a
   provisioning decision outside the workflow's control.
2. **Secret masking.** GitHub masks registered secret values in run
   logs; the workflow additionally never echoes, interpolates into
   URLs, or writes the credential to summaries (pinned by test).
3. **`gh` CLI trust.** The mutation steps execute the runner-preinstalled
   GitHub CLI (not a third-party action, not downloaded code). This
   trusts the runner image's `gh` binary — the same trust every
   `actions/*` step already requires.
4. **Job-level granularity is GitHub's floor.** For the AUTOMATIC
   token, permissions are job-scoped by GitHub's design; this workflow
   answers that by never requesting a write grant at all. The PAT
   achieves the per-OPERATION granularity the automatic token cannot.
5. **Environment protection rules.** GitHub environment secrets/rules
   could further restrict who can trigger the PAT-bearing jobs; the
   workflow currently relies on the `refs/heads/main` job gates plus
   the manual `workflow_dispatch` trigger. Adding a protected
   environment is an optional owner hardening step.

## 12. Private-repository impact (owner changed visibility to private; restored to public — see 12.4)

The owner changed `GraveYield/grave-indexer` from public to private
(2026-11-22). GitHub serves unauthenticated requests to a private
repository (including its release pages, `releases/download/...` asset
paths and the `releases/latest/download/...` stable URL) as HTTP 404 —
the resource is indistinguishable from a nonexistent one. Consequences:

### 12.1 The workflow itself — remediated in this change

The workflow previously relied on unauthenticated probes in three
places. All three now authenticate with the READ-ONLY automatic token:

1. the tag-collision gates in `publish` and `release`
   (`git ls-remote` → authenticated `GET /repos/{repo}/git/ref/tags/{tag}`,
   same three-way fail-closed semantics: 404 = absent, 200 = exists,
   anything else = gate failure);
2. the same-release roundtrip gate (`verify-versioned`) — assets are now
   fetched through the release record's `api.github.com` asset URLs with
   `Accept: application/octet-stream` (the documented path `gh release
   download` uses), authenticated by the READ-ONLY workflow token;
3. the post-activation stable gate (`verify-stable`) — same
   authenticated transport for the asset fetches (its designation query
   was already authenticated).

### 12.2 PRODUCTION INTEGRATION BLOCKER — the Console cannot fetch the snapshot

> **STATUS UPDATE (2026-11-22):** resolved by the owner — see 12.4.

The shipped `graveyield-console` consumer contract fetches the snapshot
with an UNAUTHENTICATED HTTP GET of
`https://github.com/GraveYield/grave-indexer/releases/latest/download/console-snapshot.json`
(no credential available client-side, by design). On a private
repository that request returns 404, so **production snapshot ingestion
is BROKEN until one of the alternatives below is implemented**. This is
a factual blocker: no claim is made that production ingestion still
works. The Console's fail-closed reader will report the artifact as
`missing` (and stale if a cached copy exists) rather than render
unverified data — the consumer contract degrades safely, but it
degrades.

Constraints honored while documenting this: the PAT must NEVER be
embedded in client-side Console code (a browser-visible secret), and
this change does NOT modify `graveyield-console` or the Vercel
deployment configuration (outside this task's authorization).

### 12.3 Secure alternatives (owner decision required)

1. **Server-side fetch proxy (recommended).** The Console's Vercel
   deployment adds a server-side API route/function that fetches the
   snapshot with a read-scoped credential (a fine-grained PAT with
   Contents:read only, stored as a server-side environment variable, or
   a minimal GitHub App). The browser only talks to the proxy; the
   credential never reaches client code. The proxy response must pass
   the SAME schema-v2 + freshness validation the Console already
   applies.
2. **Public distribution repository.** Keep `grave-indexer` private and
   mirror the verified release assets to a dedicated PUBLIC repository
   (e.g. via an isolated workflow that copies the verified bytes after
   `verify-stable` passes). The Console keeps its existing
   unauthenticated fetch against the distribution repo's stable URL.
   Cost: a second repository, a copy pipeline, and a trust question
   about what is published publicly (the snapshot contents themselves
   become public again).
3. **Restore public visibility** (or make only the releases public —
   GitHub does not support per-release visibility, so this is all-or-
   nothing for the repository). Cost: the indexer source becomes public
   again, which the owner evidently chose to avoid.
4. **Do nothing** — accept that the Console serves from its last cached
   artifact and reports staleness/missing until a decision is made. No
   publication should be dispatched under this option, since the newly
   published artifact would be unreachable by production.

**This decision was a blocker for the next production publication** (the
published artifact must be reachable by its production consumer); it
was resolved on 2026-11-22 by alternative 3 — see 12.4.

### 12.4 Addendum — visibility restored to public (owner decision, 2026-11-22)

The owner restored `GraveYield/grave-indexer` to **public** — i.e.
alternative 12.3.3 was chosen. Verified live on 2026-11-22,
unauthenticated (no credential used):

- `https://github.com/GraveYield/grave-indexer` → **HTTP 200**
- `https://github.com/GraveYield/grave-indexer/releases` → **HTTP 200**

Consequences, stated precisely:

1. **The 12.2 production integration blocker is lifted.** The Console's
   unauthenticated fetch contract is structurally compatible with the
   repository again. No Console or Vercel change is required.
2. **The stable URL is not yet live — because no release exists yet.**
   Verified: the releases page lists zero releases, `/releases/latest`
   redirects to the releases index, and
   `releases/latest/download/console-snapshot.json` → HTTP 404. That
   404 is "no latest release", not "unreachable repository". The stable
   URL begins resolving unauthenticated only once the first versioned
   release is created (`--latest=false`) and subsequently promoted
   (`gh release edit --latest`) by the workflow's release/promote
   steps. Until then, production ingestion has nothing to fetch — the
   same state as before the visibility change, and consistent with the
   no-release-yet invariant.
3. **The authenticated transports of 12.1 remain correct on a public
   repository.** They are not public-visibility-specific: the
   authenticated tag gates keep their three-way fail-closed semantics,
   and authenticated asset fetches work for public releases as well.
   The unauthenticated fallback paths in `verifyReleaseAssetSet` are
   likewise retained, so both visibility modes are covered.
4. **12.3 alternatives 1 and 2 remain documented** (not deleted) for
   the future case where the repository is made private again.

Nothing in this addendum changes the credential model of §11, the
workflow structure, or any release state: no release was created,
modified or promoted in the course of documenting this.

## 13. Console integration — the dedicated stable reference (sixth round)

The owner-selected architecture changes the production resolution
mechanism. The shipped `graveyield-console` contract (an UNAUTHENTICATED
single GET of `GY_SNAPSHOT_URL` = the repo-wide latest URL, expecting the
snapshot JSON) can no longer consume the production stable reference:
there is no single-GET URL behind the dedicated ref.

### 13.1 The exact production resolution mechanism

```
1. GET https://api.github.com/repos/GraveYield/grave-indexer/git/ref/tags/console-snapshot-prod
   → { object: { sha: <tag object sha>, type: "tag" } }
2. GET https://api.github.com/repos/GraveYield/grave-indexer/git/tags/<tag object sha>
   → { message: <stable-pointer JSON>, object: { sha: <source commit> } }
3. Parse `message` as graveyield.console-snapshot-stable-pointer.v1 (strict).
4. GET https://github.com/GraveYield/grave-indexer/releases/download/<pointer.versionedTag>/console-snapshot.json
   (+ the provenance and checksum assets from the SAME versioned tag)
5. Verify: sha256(bytes) == pointer.snapshot.sha256, byte length matches,
   provenance names pointer.versionedTag and pointer.sourceCommit.
   Only then parse and render (fail-closed on any mismatch).
```

Steps 1–2 are unauthenticated on the public repository (the standard
GitHub API rate limit applies; a server-side proxy is the recommended
hardening if higher throughput is ever needed).

### 13.2 REQUIRED future Console configuration change (owner approval gate)

The Console change itself is OUTSIDE this task's authorization and is
NOT implemented here. What the owner must approve and ship:

1. Replace the single-GET `GY_SNAPSHOT_URL` contract with the two-step
   resolution above (a small server-side fetch in the Console's data
   layer — the pointer indirection is browser-safe; no credential is
   involved).
2. Keep every existing fail-closed property: schema-v2 validation,
   freshness, and the NEW pointer-digest verification before rendering.
3. Until that change ships, the Console cannot consume publications
   under this architecture: production snapshot ingestion is BLOCKED on
   the Console change (do not dispatch a production publication before
   the Console resolves the dedicated reference, or accept the outage).

### 13.3 Rollback procedure (operator)

1. Locate the recorded previous pointer JSON: it is printed in the
   publication run summary (`previous pointer JSON (recorded
   verbatim for rollback)`) AND carried in the current pointer's
   `previousVersionedTag`/`previousTagObjectSha` fields.
2. Re-create the previous pointer tag object:
   `gh api --method POST repos/:repo/git/tags -f tag=console-snapshot-prod -f object=<pointer.sourceCommit> -f type=commit -f message=<previous pointer JSON>`
3. Move the ref:
   `gh api --method PATCH repos/:repo/git/refs/tags/console-snapshot-prod -f sha=<new sha> -F force=true`
4. Verify:
   `release-ops verify-stable <owner/repo> --expected-tag <previous versioned tag>`
   — exit 0 is the ONLY acceptable evidence of restoration. If any
   step fails, the stable state is UNVERIFIED: do not claim restoration
   without this evidence.
5. The workflow performs exactly this sequence automatically (the
   promote job's rollback step) when post-activation verification fails,
   and fails loudly when it cannot verify the result.

### 13.4 How to independently verify the stable target

```
release-ops verify-stable <owner/repo> --expected-tag <versioned tag>
```

exit 0 proves the FULL identity chain: ref → annotated tag object →
pointer → `pointer.versionedTag === <tag>` → release record identity →
the three assets FROM THAT EXACT RECORD → checksum + provenance +
integrity → pointer digests over the fetched bytes. The command
authenticates with a READ-scoped token when one is in the environment
and falls back to unauthenticated reads on a public repository.

## 14. Seventh-round correction — repository-qualified ref API endpoints, attempted-activation rollback gating, and the single-writer assumption

An independent review of the sixth-round implementation identified three
defects in the promotion job's ref mutations and one weak test assertion.
All are corrected in this round; the owner-selected dedicated stable
reference architecture (`refs/tags/console-snapshot-prod`) is unchanged.

### 14.1 Finding A — the activation PATCH endpoint

The mode=update activation branch issued
`gh api --method PATCH "$STABLE_REF"`. A bare ref is NOT a GitHub API
path: without the `repos/<owner>/<repo>/git/refs/...` prefix the request
does not address the git-refs endpoint at all. The activation now issues
exactly:

```
gh api --method PATCH "repos/$REPO/git/refs/tags/console-snapshot-prod" \
  -f sha="$new_sha" \
  -F force=true
```

`$REPO` resolves to `GraveYield/grave-indexer` through the promote job's
`REPO: ${{ github.repository }}` environment. The architecture is
preserved exactly: the annotated tag object carrying the validated
pointer JSON is still created by a SEPARATE request
(`POST repos/<repo>/git/tags`), the ref still moves with ONE atomic
update, no versioned release asset is touched, and the repo-wide
`latest` designation is still never written.

### 14.2 Finding B — both rollback endpoints

The rollback step used the same bare-`$STABLE_REF` form for both of its
operations. Both are now repository-qualified:

* Existing-pointer rollback:
  `gh api --method PATCH "repos/$REPO/git/refs/tags/console-snapshot-prod" -f sha="$old_sha" -F force=true`
  — after re-creating a tag object that carries the previous pointer
  JSON verbatim. The restoration is then verified by read-back: the ref
  must resolve to the restored tag-object sha, the object message must
  equal the previous pointer JSON byte-for-byte, and the parsed pointer
  must name the previous versioned release. Anything less is reported
  UNVERIFIED.
* First-publication rollback:
  `gh api --method DELETE "repos/$REPO/git/refs/tags/console-snapshot-prod"`
  — restoring the absent state. Absence is proven ONLY by an
  authenticated read-back returning exactly HTTP 404. The DELETE
  command's own errors are no longer suppressed from the log (its exit
  status is deliberately not trusted): an authentication failure,
  network error, rate limit or unexpected API response is NEVER treated
  as proof that the ref is absent, and rollback is claimed VERIFIED only
  when the read-back confirms the expected state.

### 14.3 Finding C — rollback runs only when activation was attempted

The rollback step previously ran on `if: failure()`, which also fired
when an earlier pre-activation gate failed — e.g. the three-way
stable-ref discovery gate or the pointer re-validation — even though
activation was never attempted and the ref was never touched. The
workflow now writes an explicit activation-start marker
(`id: activation_gate`, output `activation_started=true`) as the step
IMMEDIATELY BEFORE the privileged activation step, and the rollback
condition is:

```
if: failure() && steps.activation_gate.outputs.activation_started == 'true'
```

This distinguishes exactly the required cases:

| Scenario | Rollback? |
| --- | --- |
| Failure before the stable-reference gate (artifact/pointer gates) | no |
| Failure during stable-reference discovery (the three-way gate itself) | no |
| Failure after the gate but before activation begins (marker step skipped) | no |
| Activation request failure or uncertain response (timeout/interruption) | rollback ATTEMPTED |
| Successful activation followed by read-back failure | rollback ATTEMPTED |
| Successful activation and successful read-back | no |

The marker deliberately precedes the mutation: an activation request
that times out or is interrupted may STILL have been applied by GitHub,
so the marker is written before the first mutation command and the
rollback is attempted even when the activation step reports failure.
The condition does not consult `steps.activate.outcome`. The rollback
itself fails LOUDLY (UNVERIFIED) when it cannot determine or restore
the correct state.

### 14.4 Single-writer assumption and the residual concurrent-writer race

The GitHub git-refs REST API does not offer a compare-and-swap update:
`PATCH /repos/<repo>/git/refs/<ref>` accepts the NEW sha and `force`,
but there is no "update only if the current sha is X" precondition and
no If-Match-style header. The workflow therefore CANNOT make the ref
update conditional on the state it read during the three-way gate.

Within the intended single-writer model the existing protections are:

* the workflow's own publication runs are serialized by the
  `publish-console-snapshot` concurrency group
  (`cancel-in-progress: false`), so two workflow runs can never race
  each other;
* the three-way gate re-reads the ref IMMEDIATELY before the mutation,
  and the post-activation read-back plus the read-only `verify-stable`
  identity gate detect a ref that does not resolve to the activated
  pointer.

Residual race (documented, not eliminated): an EXTERNAL writer — an
authorized user or a process outside this workflow — could move
`console-snapshot-prod` between the pre-activation read and the
mutation. In that case the workflow's PATCH overwrites the external
pointer without detecting it (no CAS is available), and if the external
writer moves the ref again between the mutation and the read-back, the
read-back mismatch triggers a rollback to the recorded previous
pointer — which would itself replace the external writer's pointer.
Mitigations the owner should keep in force: (1) treat
`console-snapshot-prod` as written ONLY by the publish workflow
(branch protection / rulesets may restrict tag creation and deletion);
(2) the pointer chain makes any overwrite detectable after the fact —
every pointer carries `previousVersionedTag`/`previousTagObjectSha`,
and the run summary records the replaced pointer verbatim, so an
unexpected promotion is reconstructable and auditable. No protection
beyond the single-writer assumption is claimed.
