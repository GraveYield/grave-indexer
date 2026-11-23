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

## 3. SUPERSEDED interim design — repo-wide latest-release promotion (HISTORICAL RECORD ONLY)

> **SUPERSEDED (sixth round, 2026-11-22):** the owner SELECTED the
> dedicated `console-snapshot-prod` stable-reference architecture —
> see §9 (the recorded decision) and §13 (the exact production
> resolution mechanism). **This section is retained purely as the
> historical record of the interim repo-wide-latest design. It is NOT
> the production path and MUST NOT be read as one:** nothing in the
> current production workflow depends on the repo-wide latest
> designation, and the `releases/latest/download/...` URL family and
> the `verify-release-assets --scope latest` capability survive only as
> clearly labeled LEGACY, non-production utilities.

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

## 4. Stable-reference semantics (the ten questions) — CURRENT production mechanism

> Answers reflect the SELECTED dedicated stable-reference architecture
> (§9, §13). Where an answer differs from the superseded interim design
> of §3, the difference is stated explicitly.

1. **Does the stable tag move?** The dedicated stable REFERENCE
   `refs/tags/console-snapshot-prod` moves exactly once per successful
   publication (one atomic ref update). The ANNOTATED TAG OBJECT it
   pointed at is an immutable git object and never changes; each
   promotion creates a NEW tag object. Versioned release tags
   (`console-snapshot-prod-<stamp>-<commit>`) are unique per publication
   and never move.
2. **Does the stable release change?** The stable reference is the
   dedicated git ref — NOT the repo-wide latest designation. It moves
   once per successful publication, atomically. The versioned release it
   previously pointed to is unchanged and remains fully retrievable.
3. **Are stable assets overwritten?** Never. Each versioned release's
   assets are written once and never touched again. There is no asset
   clobbering anywhere in the design; the stable reference carries NO
   payload bytes at all (only the pointer in a tag-object message).
4. **Can the previous artifact remain available during activation?**
   Yes — throughout generation, upload, and verification the dedicated
   reference still names the previous pointer, and its release's assets
   stay downloadable forever. The promotion does not touch the previous
   release or its assets.
5. **Is the stable "URL" constant?** The stable RESOLUTION CHAIN is
   constant: `GET /repos/<repo>/git/ref/tags/console-snapshot-prod` →
   `GET /repos/<repo>/git/tags/<object.sha>` → pointer JSON in the
   tag-object message → assets from
   `releases/download/<pointer.versionedTag>/<asset>`. There is
   deliberately NO single repo-wide latest URL in the production path —
   that URL family is a LEGACY, non-production utility only (§3, §9.B).
6. **Can the Console retrieve it without authentication?** The ref and
   tag-object reads are unauthenticated on a public repository (the
   restored state — §12.4) with the standard API rate limit. NOTE: the
   shipped Console contract (a single-GET of `GY_SNAPSHOT_URL`) does NOT
   match this two-step resolution — the required Console change is an
   owner-approval gate (§13.2). Production ingestion is operational only
   after that change ships.
7. **Can a failed update leave the resolution chain unavailable?** No.
   Failures BEFORE the atomic ref move leave the previous pointer
   serving. A failure AFTER the move triggers the rollback paths: the
   promote job's in-job rollback (failure at or after the activation
   step) and — since the eighth-round correction — the dedicated
   downstream rollback job (failure of the post-activation
   `verify-stable` gate after a completed promotion). Both restore the
   recorded previous pointer (or delete the first-publication ref) and
   verify the restoration by read-back; an unverifiable restoration is
   reported as UNVERIFIED, loudly.
8. **Can a client receive mismatched snapshot and provenance files?**
   Not from publication activity. Both files live on the SAME versioned
   release and the pointer moves atomically (single ref update). A client
   fetching across a promotion boundary gets detectably inconsistent
   bytes — the pointer's per-asset SHA-256 digests and the provenance
   sidecar's `versionedTag` make any such pair fail the consumer's
   fail-closed verification (§13).
9. **How is cache behavior controlled?** Versioned asset URLs redirect
   to `release-assets.githubusercontent.com` signed URLs; intermediate
   redirects are short-lived and asset URLs are re-generated per fetch.
   Consumers must rely on the pointer's digests (and the sidecar's
   `snapshotSha256`) for end-to-end integrity and on the artifact's own
   `freshness.maxAgeMs` for staleness. No cache headers are manipulable
   in this design — that limitation is disclosed, not hidden.
10. **How can an operator roll back to the previous version?** Re-create
    the previous pointer tag object and move the dedicated ref (§13.3):
    ```
    gh api --method POST repos/:repo/git/tags -f tag=console-snapshot-prod \
      -f object=<pointer.sourceCommit> -f type=commit -f message=<previous pointer JSON>
    gh api --method PATCH repos/:repo/git/refs/tags/console-snapshot-prod \
      -f sha=<new tag object sha> -F force=true
    ```
    then re-verify with `verify-stable --expected-tag <previous versioned
    tag>`. The workflow performs exactly this sequence automatically —
    the promote job's in-job rollback for failures at/after activation,
    and the dedicated downstream rollback job when the post-activation
    verification fails after a completed promotion — and fails loudly
    when it cannot verify the result. The rollback NEVER overwrites a
    pointer that has moved independently (compare-before-rollback).

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

* **Dedicated-ref writers.** The stable pointer is the git ref
  `refs/tags/console-snapshot-prod`; anyone with git-data write access
  could move it (documented single-writer assumption — §14.4). Any
  OTHER release created in this repository CANNOT move it (verified by
  test and by the rehearsal's unrelated-release probe). The workflow's
  rollback paths refuse to overwrite a pointer that has moved
  independently (compare-before-rollback), and the post-activation
  verification catches a promotion that did not stick.
* **Provenance cross-check.** Consumers SHOULD fetch
  `console-snapshot-provenance.json` alongside the snapshot and verify
  the digest; the Console's current fetch consumes the snapshot URL
  only — its schema-v2 validator still enforces schema and freshness.
* **First publication.** Before the first publication the dedicated
  reference does not exist — the resolution chain returns HTTP 404 and
  the Console reports `missing` honestly. This is bootstrap, not data
  loss.

## 7. What this design does NOT claim

The word "atomic" is reserved for the single git ref update (PATCH
`repos/<repo>/git/refs/tags/console-snapshot-prod`, force) — GitHub
executes it as one update and it moves the pointer to a release whose
asset set was already fully verified. The overall publication
(generate → upload → verify → activate → verify) is a multi-step
process, not atomic; its safety comes from ordering plus immutability,
not from a single transaction.

## 8. VERIFIED repository protection model (PR #5 remediation — review Task 3)

Inspected 2026-11-21 via the authenticated GitHub REST API with the
owner-provided token (evidence recorded in the PR remediation report):

| Configuration | Verified value | Consequence |
| --- | --- | --- |
| Branch protection on `main` | **ABSENT** (`GET /branches/main/protection` → 404 "Branch not protected") | Push access to `main` = direct commit access; the workflow's `refs/heads/main` restriction limits dispatchers to people with push access, but no PR requirement is enforced for the branch itself |
| Repository ruleset "enhancing indexer" (id 27244228, active) | Applies to `~DEFAULT_BRANCH` and `~ALL`; rules: deletion, non_fast_forward, code_quality, copilot_code_review; no bypass actors | `main` cannot be deleted or force-pushed, but the ruleset does NOT require pull requests and does NOT protect tags |
| Tag-protection rulesets | **NONE** (the only ruleset targets branches) | Versioned snapshot tags can be created, updated or deleted by anyone with push access — tag immutability is NOT GitHub-enforced |
| Immutable releases (GitHub feature) | **NOT enabled** (FOURTEENTH-ROUND RECONCILIATION, 2026-11-23: SETTLED with an AUTHORIZED endpoint result — `GET /repos/GraveYield/grave-indexer/immutable-releases` with the owner-provided credential returned **HTTP 200** with body `{"enabled": false, "enforced_by_owner": false}`; read-only query, no setting was changed. This supersedes the twelfth-round UNKNOWN: until then only unauthenticated 401/403 responses were available, which cannot distinguish "disabled" from "not visible to me") | The workflow must NOT assume assets are locked after upload — and must NOT assume they are not: the publication sequence must be enforcement-compatible BEFORE the feature is ever switched on; the draft-first sequence (§8.3, implemented in the production workflow as of the thirteenth round, §17) satisfies that requirement in BOTH states (§18) |
| Releases / tags in the repository | **NONE exist** (no release, no tag) | The production stable reference is not yet bootstrapped; the first publication is the genuine first-publication path |

### What this means for the publication sequence

1. **Immutability is a WORKFLOW-LEVEL convention here; GitHub-enforced
   immutable releases are NOT enabled (FOURTEENTH ROUND: settled with an
   authorized endpoint result — HTTP 200, `enabled: false`,
   `enforced_by_owner: false`; see the §8 table and §18).** The design is
   honest about both: releases are created `--latest=false`, assets are
   never re-uploaded or deleted, `--clobber` is never used, and any tag
   or release collision fails closed BEFORE creation. Nothing in the
   workflow relies on GitHub preventing an asset modification — it
   relies on the workflow never issuing one, plus the auditability of
   the release history. The prior uncertainty is resolved: the
   authorized endpoint result, not an unauthenticated probe, is what
   settled it (§16.1 records the twelfth-round correction that made the
   authorized result a hard requirement; §18 records the result).
2. **Tag collision handling is explicit three-way** (hardened in this
   remediation): `git ls-remote --exit-code` exit 2 = genuinely absent
   (proceed), exit 0 = exists (abort), ANY other exit = the gate itself
   failed (abort — never interpreted as "absent"). An existing RELEASE
   for the tag also aborts via `gh release view`.
3. **Compatibility with GitHub's immutable-releases feature (TWELFTH
   ROUND — status, rehearsal, and the exact required change):** the
   current production sequence (create a published, empty release →
   upload assets to it) is compatible with the observed state — the
   immutable-release status is UNKNOWN and no enforcement is verified —
   but is INCOMPATIBLE with GitHub-enforced immutable releases: under
   that feature, assets cannot be added to an already published release,
   so the upload step would fail AFTER a release already existed. The
   required draft-first sequence is therefore REHEARSED end-to-end by the
   rehearsal workflow (create draft → upload BY RELEASE ID → verify draft
   assets → publish `draft=false` + `make_latest=false` → verify →
   promote — see docs/PUBLICATION_REHEARSAL.md §2) and — as of the
   THIRTEENTH round (§17) — IMPLEMENTED in the production workflow on
   this branch: the `release` job creates the versioned release as a
   DRAFT, uploads the assets BY RELEASE ID, runs the draft belt, and
   only then publishes, with a failure-path step that deletes ONLY this
   run's verified un-published draft. The sequence the production
   publisher implements:

   1. create the versioned release as a DRAFT (`--latest=false --draft`,
      `--target` pinned to the asserted commit);
   2. upload all three assets to the draft BY RELEASE ID (GitHub REST,
      verified 2026-11-23: "Get a release by tag name" serves PUBLISHED
      releases only, and draft listings are visible only to push-access
      users — every draft operation addresses the release by ID, never
      by tag);
   3. verify the draft assets: exact asset presence, recorded byte
      lengths vs local bytes, download-back `sha256sum -c` digest belt,
      and the provenance sidecar must name the release tag — all BEFORE
      the immutable publish;
   4. publish: `PATCH /releases/<id>` with `draft=false` and an explicit
      `make_latest=false` (string — the API models true/false/legacy),
      then read back the published state (draft flag + tag identity);
   5. the read-only `verify-versioned` job re-verifies the PUBLISHED
      release end-to-end (schema + completeness over fetched bytes) —
      unchanged, and still the gate before activation (`needs:` chain;
      a read-only token cannot see drafts, so this verification
      deliberately runs AFTER publish);
   6. only then the promote job activates the dedicated stable reference
      (unchanged), followed by read-back verification.

   Safety properties: any failure before the publish leaves an
   un-published DRAFT (no immutable residue, no tag materialized — the
   versioned tag is created at publish time from the pinned target), the
   stable reference untouched, and the previous artifact serving; a
   failure-path cleanup step additionally deletes ONLY this run's
   verified un-published draft (by-ID read-back must prove `draft==true`
   AND this run's exact tag before the deletion — a published release or
   a foreign release is never deleted). The PAT-bearing step count
   becomes SIX (the draft belt needs the PAT: a draft is only readable
   with push access; the cleanup needs it to delete the draft).
   **Do not enable immutable releases before this change lands on the
   production workflow and is rehearsed.** This is an owner decision,
   not something this PR does.
4. **A failed or partial upload cannot leave an unusable promoted
   release:** the partial release is never designated latest (the
   roundtrip verification precedes promotion), so the previous
   artifact keeps serving. Under the rehearsed draft-first sequence an
   incomplete asset set is additionally refused on the DRAFT, before
   the immutable publish (the rehearsal's partial-upload scenario
   proves this end-to-end). The orphan versioned release remains
   visible in the release history for inspection — that is by design
   (audit), and it can be deleted by an operator without touching the
   stable reference.

### Owner/admin actions identified (NOT performed by this PR)

* Add a pull-request requirement (and required checks) to `main` via
  branch protection or a ruleset — the ruleset currently lacks a
  `pull_request` rule.
* ~~Settle the immutable-release status with an AUTHORIZED endpoint
  result~~ — **DONE, fourteenth round (2026-11-23):** the authorized
  query returned HTTP 200 with `{"enabled": false,
  "enforced_by_owner": false}` — the feature is NOT enabled. Evidence
  recorded in §18.
* Decide whether to enable GitHub's immutable releases. The draft-first
  sequence is now IMPLEMENTED in the production workflow on this branch
  (thirteenth round, §17) and rehearsed by the rehearsal workflow, so
  the publisher is compatible with the feature enabled AND disabled —
  re-verify the publish-time latest-designation behavior on the
  rehearsal target BEFORE switching the feature on (the rehearsal
  dispatch itself remains blocked — see docs/PUBLICATION_REHEARSAL.md
  §3 for the updated, exact prerequisites).
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
  read`; the workflow default is `contents: read`). Eight jobs (the
  eighth — the dedicated downstream rollback job — was added by the
  eighth-round correction, review Finding 1; see §15):

  | Job | Effective permissions | Executes custom code? | Token access |
  | --- | --- | --- | --- |
  | `generate` | `contents: read` (EXPLICIT) | YES (build + `publish-snapshot`/`verify-snapshot`) | `github.token` READ-ONLY (consumed implicitly by checkout/setup-node; no `GH_TOKEN` env anywhere); RPC secrets to the snapshot CLI only |
  | `verify` | `contents: read` (EXPLICIT) | YES (independent re-verification + builds the zero-dep release-ops bundle) | `github.token` READ-ONLY (implicit via checkout/setup-node only) |
  | `publish` | `contents: read` (EXPLICIT) | YES (checksum belt, provenance tag parse, collision gates, `stable-pointer-current` discovery over the DEDICATED ref) | `github.token` READ-ONLY, step-level env on the tag-collision gate, the belt-check GET and the discovery step ONLY — never the PAT |
  | `release` | `contents: read` (EXPLICIT) | **NO** | `github.token` READ-ONLY, step-level env on the authenticated tag-collision gate ONLY; `GY_RELEASE_PAT` step-level env on the `gh release create/upload` mutation step ONLY (TWELFTH-ROUND NOTE: the prepared draft-first patch splits this into draft create+upload and draft-belt verify+publish steps — §8.3, §16.2) |
  | `verify-versioned` | `contents: read` (EXPLICIT) | YES (prebuilt zero-dep bundle, `--scope versioned` roundtrip) | `github.token` READ-ONLY, step-level env on the roundtrip gate ONLY (the repository is private: release assets 404 unauthenticated) — never the PAT |
  | `promote` | `contents: read` (EXPLICIT) | **NO** | `GY_RELEASE_PAT` step-level env on the stable-ref activation step (create annotated pointer tag object + atomic ref update) and the in-job rollback step ONLY; the pointer jq gate and read-back are token-free or READ-ONLY |
  | `verify-stable` | `contents: read` (EXPLICIT) | YES (reviewed commit's own verification CLI, `verify-stable --expected-tag` over the DEDICATED ref) | `github.token` READ-ONLY, step-level env on the gate step only |
  | `rollback` (eighth round) | `contents: read` (EXPLICIT) | **NO** (pinned `gh api`/`curl`/`jq` only) | `github.token` READ-ONLY on the compare-before-rollback and read-back steps; `GY_RELEASE_PAT` step-level env on the single ref-mutation step ONLY |

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
    collision gates, and the hardened `stable-pointer-current`
    rollback-pointer discovery over the DEDICATED reference (custom
    bundle, READ-ONLY token). It declares
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
  * `promote` (`contents: read` + PAT on the mutation steps, ZERO
    custom code) — activation of the DEDICATED stable reference: create
    the annotated pointer tag object (`gh api POST /git/tags`) and move
    `refs/tags/console-snapshot-prod` with ONE atomic update
    (`gh api PATCH repos/<repo>/git/refs/tags/console-snapshot-prod`,
    force), with the `GY_RELEASE_PAT` credential as those steps' env
    only (the automatic token is read-only); an in-job rollback step
    restores the previous pointer when the promote job itself fails at
    or after activation;
  * `verify-stable` (read-only) — the post-activation stable gate, run
    with the READ-ONLY workflow token from a full repository checkout;
  * `rollback` (eighth round — Finding 1) — the dedicated downstream
    rollback job: runs ONLY when promotion succeeded and the
    post-activation `verify-stable` gate FAILED after it; compares the
    live ref against this run's created pointer tag object before any
    mutation (refuses to overwrite a moved pointer), restores the
    previous pointer or deletes the first-publication ref in ONE
    PAT-bearing step, and verifies the restoration by read-back
    (§15).
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
  the pinned mutation steps; no code-executing, artifact or checkout
  step references it).
* **Rollback-pointer discovery (Task 4, sixth-round supersession):**
  the previous `gh api ... 2>/dev/null || echo ""` pattern was first
  replaced by the typed `release-latest` gate (only a genuine HTTP 404
  yields "first publication"; every auth/permission/rate-limit/outage/
  network/malformed failure is a typed abort). Under the OWNER-SELECTED
  architecture the workflow's discovery now reads the DEDICATED
  reference through `stable-pointer-current` (the same fail-closed
  classification over `refs/tags/console-snapshot-prod`);
  `release-latest` survives only as a LEGACY, non-production utility.
  The pointer is recorded and written to the run summary BEFORE any
  release operation.
* **Same-release verification (Task 5):** `verify-release-assets
  --scope versioned` verifies all three assets of ONE exact versioned
  release (checksum over the exact bytes, provenance digest, and the
  provenance must NAME that release's tag — a cross-release mixture is
  detectable because only the release's own sidecar carries its tag).
  The post-activation gate (`verify-stable --expected-tag`) verifies
  the FULL identity chain over the DEDICATED stable reference (ref →
  tag object → pointer → release record → assets → pointer digests), so
  neither pointer drift nor an in-flight promotion race can bless a
  mixed artifact set. (`--scope latest` survives only as a LEGACY,
  non-production utility — never used by the production workflow.)

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
| `github.token` (automatic) | ALL EIGHT jobs — every job explicitly declares `permissions: contents: read` | READ-ONLY repository content, read API queries (release-by-tag belt check, git-ref tag gate, stable-ref and tag-object reads, authenticated asset fetches during verification, post-activation read-back, the rollback job's compare-before-rollback and read-back) |
| `GY_RELEASE_PAT` (owner-provisioned fine-grained PAT) | STEP-level env of exactly SIX steps: the `release` job's draft create+upload step; the `release` job's draft verify+publish step (the PAT is required there to READ the draft — draft listings are visible only to push-access users); the `release` job's failure-path draft-cleanup step (`if: failure()`; deletes ONLY this run's verified un-published draft — a published release or a foreign release is never deleted); the `promote` job's stable-ref activation step (create annotated pointer tag object + atomic ref update); the `promote` job's failure-path rollback step (re-create the previous pointer object + re-point the ref, or delete the ref on first publication); the dedicated `rollback` job's single ref-mutation step (same two rollback cases, after a failed post-activation verification) | GitHub release mutations AND git-data mutations of the dedicated stable reference (`git/tags`, `git/refs`) — nothing else |
| `ACTIONS_RUNTIME_TOKEN` | Managed by GitHub for `actions/upload-artifact` / `actions/download-artifact` inside one workflow run | Run-scoped artifact transport only; not a `github.token` input |
| `MAINNET_RPC_URL` / `DEVNET_RPC_URL` | `generate` job env (RPC access for snapshot generation) | RPC endpoints; no GitHub capability |

### The steps that never receive a write credential

Every job that checks out code, installs dependencies, builds, runs
tests, generates snapshots, executes repository-built JavaScript,
downloads or verifies artifacts, validates schema/provenance/checksums,
or discovers the rollback pointer runs under an explicit
`contents: read` grant and references `github.token` (read-only) or no
token at all — NEVER the PAT. The release, promote and rollback jobs
hold the PAT but contain ZERO custom code: no checkout, no dependency
installation, no node, no repository script, no artifact-executed code
— the only commands that can read the credential are the pinned `gh
release` mutation invocations and the pinned `gh api` git-data
mutations of the dedicated stable reference (create the pointer tag
object, move the ref, and the rollback mutations, whose read-back
verification uses the READ-ONLY token).

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

1. **Restoring public visibility removes ONLY the unauthenticated
   repository-access blocker of 12.2 — nothing else.** The repository's
   public GitHub resources (the repo page, the releases page, API reads)
   are reachable by an unauthenticated fetch again, which was the
   structural incompatibility recorded in 12.2. **This does NOT make the
   Console compatible with the production publication mechanism**: the
   shipped Console still consumes a single-GET `GY_SNAPSHOT_URL` contract,
   and the production stable pointer is the dedicated two-step reference
   of §13.1 — there is no single-GET URL behind it. **The Console-side
   two-step resolver described in §13.2 is still REQUIRED before
   production ingestion can consume publications under this
   architecture**; no Console or Vercel change is included in the PR that
   carries this documentation, and none is authorized by that task.
   Separately, the retired repo-wide `releases/latest/download/...` URL
   (§3) is NOT the production mechanism either and remains retired (§9,
   §13).
2. **The production stable reference is not yet live — because no
   publication has happened yet.** Verified: the releases page lists
   zero releases and no `refs/tags/console-snapshot-prod` reference
   exists, so the production resolution chain (§13.1) returns HTTP 404.
   That 404 is "no publication yet", not "unreachable repository". The
   chain begins resolving unauthenticated only once the first versioned
   release is created (`--latest=false`) and the workflow's promote step
   creates the annotated pointer tag object and the dedicated reference
   (`refs/tags/console-snapshot-prod`). NOTE: the
   `releases/latest/download/...` URL mentioned in earlier revisions of
   this addendum is NOT the production mechanism — under the
   owner-selected architecture (§9, §13) production consumption uses the
   two-step dedicated-reference resolution only. Until the first
   publication (and the Console change of §13.2), production ingestion
   has nothing to fetch — the same state as before the visibility
   change, and consistent with the no-publication-yet invariant.
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
5. The workflow performs exactly this sequence automatically and fails
   loudly when it cannot verify the result — in TWO places: the promote
   job's in-job rollback step (failures at or after activation inside
   promote) and, since the eighth-round correction, the dedicated
   downstream `rollback` job (a failure of the post-activation
   `verify-stable` gate AFTER promotion completed — the case the in-job
   step can no longer cover). Both compare the live ref against the
   run's created pointer tag object first and refuse to overwrite a
   pointer that has moved independently (§15).

### 13.4 How to independently verify the stable target

```
release-ops verify-stable <owner/repo> --expected-tag <versioned tag>
```

exit 0 proves the FULL identity chain: ref → annotated tag object →
pointer → `pointer.versionedTag === <tag>` → release record identity →
the three assets FROM THAT EXACT RECORD → checksum + provenance +
integrity → pointer digests over the fetched bytes. NINTH-ROUND
ADDITION (review Finding 4): the identity chain also verifies the
ANNOTATED TAG OBJECT'S ACTUAL TARGET directly from the tag-object
response — the target type must be exactly `commit` and the target SHA
must EQUAL `pointer.sourceCommit` — so a tag object pointing at one
commit while its pointer (and the release provenance) claim another is a
typed failure instead of an accepted inconsistency. The target is read
from the tag object itself, never inferred from release provenance. The
command
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

## 15. Eighth-round correction — downstream rollback, pointer-architecture rehearsal, independent completeness verification, and documentation reconciliation

The latest independent end-to-end review identified four findings. All
four are corrected in this round; the owner-selected dedicated
stable-reference architecture and every existing security control are
preserved (no redesign).

### 15.1 Finding 1 — a failure of the downstream `verify-stable` job now supports rollback

The rollback logic lived inside `promote`, so a failure of the SEPARATE
post-activation `verify-stable` job — after promotion had completed —
could leave the stable reference pointed at a publication that never
passed the full downstream verification chain. The workflow now has a
dedicated `rollback` job (the eighth job) with an explicit
dependency-graph gate:

```
if: failure() &&
    needs.promote.result == 'success' &&
    needs.verify-stable.result == 'failure' &&
    github.ref == 'refs/heads/main'
```

Design properties (all pinned by test/publishWorkflow.test.ts):

* **Runs ONLY after a completed promotion followed by a failed
  downstream verification.** A failed or skipped promotion can never
  trigger it (the promote job's in-job rollback step and the
  `activation_started` marker still own the pre-activation and
  failed-activation cases). A green verification never triggers it.
* **Rollback inputs cross the job boundary as explicit outputs** of the
  promotion process: `ref_mode`, `previous_pointer_json`,
  `previous_versioned_tag` and `new_tag_object_sha` (the annotated tag
  object this run created).
* **Compare-before-rollback (single-writer guard):** BEFORE any
  mutation the job reads the CURRENT `refs/tags/console-snapshot-prod`
  with the READ-ONLY token and requires it to still point at THIS run's
  created tag object. A different object, an absent ref, or any gate
  failure → the rollback REFUSES, reports `OPERATOR INTERVENTION
  REQUIRED`, and preserves the observed state as evidence. This is the
  enforcement of the documented single-writer assumption — workflow
  concurrency alone provides NO compare-and-swap protection against
  external writers.
* **Both rollback cases:** a previous pointer is restored (re-create the
  previous pointer tag object + ONE repository-qualified PATCH); a
  first publication restores the ABSENT state (repository-qualified
  DELETE of `refs/tags/console-snapshot-prod`).
* **Read-back verification with the READ-ONLY token:** update mode
  requires ref sha + message + previous-versioned-tag identity; create
  mode requires a genuine HTTP 404. An unverifiable outcome fails
  LOUDLY with the previous pointer JSON and the restoration procedure
  preserved in the run summary.
* **PAT isolation:** discovery (comparison) and read-back verification
  authenticate with the READ-ONLY automatic token; the narrowly scoped
  PAT exists ONLY in the exact step that performs the ref mutation. The
  job contains zero custom code (no checkout, no node).
* **Ambiguous activation:** the decision input is REMOTE state — the
  live ref is read before anything is decided or mutated; no rollback
  decision relies on a step's reported success.

The `activation_started` safety concept is preserved: a rollback occurs
only after activation was actually attempted and completed (promote
succeeded) or at/after the activation step inside promote (marker
semantics unchanged).

### 15.2 Finding 2 — the rehearsal now rehearses the pointer architecture

`.github/workflows/rehearsal-publication.yml` previously exercised the
retired repo-wide latest mechanism (`gh release edit --latest`,
`release-latest`, `--scope latest`,
`/releases/latest/download/...`). It now rehearses, against
`GraveYield/grave-indexer-pub-rehearsal` ONLY (hard guard as the first
step, before checkout and any write operation):

1. `--latest=false` versioned release creation + asset upload;
2. same-release asset verification (`--scope versioned`);
3. pointer build from the VERIFIED bytes + strict pointer-schema
   validation (the same jq gate production uses);
4. annotated tag object creation (`POST /git/tags`) and dedicated-ref
   create-or-update (`POST /git/refs` / `PATCH
   repos/<repo>/git/refs/tags/console-snapshot-prod`, force);
5. read-back (ref sha + message equality) and the FULL production
   identity chain (`verify-stable --expected-tag`);
6. an unrelated-release probe that deliberately takes the repo-wide
   latest designation and proves it CANNOT move the dedicated reference;
7. rollback to the previous pointer (verified through the full chain)
   and first-publication rollback (DELETE + 404 read-back);
8. failure injections before activation (partial upload leaves the
   prior pointer intact) and after activation (rollback drill), plus a
   failed activation for a missing release;
9. NINTH-ROUND Finding 2 — state-aware re-activation: after the
   first-publication drill DELETED the reference, reactivation reads the
   live reference and uses `POST repos/<repo>/git/refs` when it is
   absent (the retired unconditional PATCH required an existing ref and
   could never complete the first-publication cycle) and the
   repository-qualified PATCH when it exists; both paths read the
   reference back, verify the annotated tag object and re-run
   `verify-stable`;
10. NINTH-ROUND Finding 3 — a genuine post-activation failure-injection
    scenario (`post-activation-failure`): after a VERIFIED activation, a
    deliberate, controlled failure (explicit `exit 1`) triggers the SAME
    `if: failure()` rollback gating production uses, including
    compare-before-rollback; the restored state is proven by
    `verify-stable` (previous pointer) or a genuine HTTP 404 (first
    publication), and the four phases (publication → injected failure →
    rollback → restored-state verification) are reported distinctly. The
    job conclusion for this scenario is EXPECTED failure and is never
    reported as a successful publication.

Credential boundary: the rehearsal uses the run's own `github.token`
(which, by the hard guard, exists only inside the rehearsal repository)
— never the production-scoped `GY_RELEASE_PAT`, never any repository
secret. No permissions were broadened; the existing guards are intact
and pinned by tests.

**Execution status: NOT RUN.** The rehearsal workflow has not been
dispatched as part of this correction (dispatch authorization is
explicitly out of scope; workflow_dispatch is also only registrable
from a default branch). No rehearsal pass/fail may be claimed until an
authorized run has completed and its results have been independently
verified — see docs/PUBLICATION_REHEARSAL.md.

### 15.3 Finding 3 — the independent verifier enforces the producer's completeness contract

`cmdVerifySnapshot` (the `verify-snapshot` gate the verification job
runs against the staged AND re-downloaded artifact) previously required
only `provenance.counts.enriched > 0`. It now independently:

1. rejects an artifact carrying a `discovery-completeness` or
   `enrichment-completeness` failure marker;
2. fails closed on MISSING completeness evidence (no `failures` array,
   no counts object in the sidecar) and on MALFORMED evidence (a
   non-integer enriched count anywhere);
3. rejects a CONTRADICTION: the sidecar's `counts.enriched` must
   EXACTLY equal the artifact's own enriched count (which the strict
   schema-v2 parser pins to `pools.length`);
4. requires a positive enriched count (no empty publication).

The same contract is enforced over the FETCHED bytes by the release-ops
verification gates (`verify-release-assets` and the `verify-stable`
identity chain via the zero-dependency `verifyRawArtifactCompleteness`
core in src/snapshotPublication.ts — the release-ops bundle graph stays
free of npm dependencies). The producer (`cmdPublishSnapshot`) shares
the same stage list, so the producer refuses to stage exactly what the
independent verifiers refuse to endorse. No schema-v2 field was added,
removed or reinterpreted.

Regression fixtures cover: valid complete artifacts still pass;
nonempty artifacts carrying either completeness marker fail; enriched
count mismatch fails; missing/malformed evidence fails; the empty
artifact fails; and the same rejections hold through the release-ops
gates over fetched bytes.

### 15.4 Finding 4 — documentation and CLI reconciliation

The dedicated stable-reference architecture
(`refs/tags/console-snapshot-prod` → annotated pointer tag object →
versioned release assets) is now the sole documented production
mechanism:

* §3 is retitled "SUPERSEDED interim design … HISTORICAL RECORD ONLY";
* §4 (the ten questions) answers are rewritten for the dedicated-ref
  semantics; the rollback answer documents both automated rollback
  paths and the compare-before-rollback refusal;
* §6/§7 no longer describe the repo-wide designation or `make_latest`
  as production mechanisms;
* §10/§11 credential and job matrices now describe the eight-job graph
  and the (then) four PAT-bearing steps;
* §12.4 no longer presents the `releases/latest/...` URL as the stable
  URL or `gh release edit --latest` as promotion;
* §13.3 documents both automated rollback paths;
* the CLI's `publish-snapshot` success line describes the dedicated
  stable-reference activation; `release-latest` and
  `verify-release-assets --scope latest` are labeled LEGACY,
  non-production utilities in the CLI help (they remain for tests and
  manual diagnostics only — the production workflow does not use
  them).

## 16. Twelfth-round correction — immutable-release status UNKNOWN, draft-first readiness (specified + rehearsed + prepared patch), and rehearsal prerequisites

Follow-up to the independent review requiring (a) the immutable-release
status claim to be reconciled with the authorized endpoint semantics,
and (b) the publisher to be prepared for GitHub-enforced immutable
releases, plus an isolated rehearsal attempt. The approved architecture
and every existing safeguard are unchanged; no validation was weakened.

### 16.1 Immutable-release status: UNKNOWN (never "disabled")

The former wording — "GitHub-enforced immutable releases are NOT
enabled (verified: no tag-protection ruleset / immutable-release
configuration)" — claimed a negative that was never verified. Evidence
gathered 2026-11-23 (READ-ONLY; no repository setting was changed):

* `GET /repos/GraveYield/grave-indexer/immutable-releases`, unauthenticated,
  from two independent network paths → **HTTP 401 "Requires
  authentication"** (and a third attempt → HTTP 403, IP rate-limit).
  Both are INCONCLUSIVE responses: they cannot distinguish "the setting
  is disabled" from "the setting is not visible to an unauthorized
  caller".
* No authorized credential was available to the task (and requesting or
  exposing secrets in chat is forbidden), so the authorized 200/404
  verdict could not be obtained.

**Status: UNKNOWN.** Interpretation rule recorded in §8: HTTP 200 =
enabled (report `enabled` and `enforced_by_owner`); HTTP 404 = not
enabled (consistent with GitHub's documented endpoint behavior); HTTP
403 / insufficient permissions / anything else inconclusive = UNKNOWN —
never inferred to "disabled". Only an actor with authorized access can
settle it (§8, owner actions). The reconciliation comment on the PR
(2026-11-23) is preserved as the historical record of this correction.

> **FOURTEENTH-ROUND UPDATE (2026-11-23): SETTLED — NOT enabled.** The
> owner provided an authorized credential; the endpoint was queried
> READ-ONLY and returned **HTTP 200** with body `{"enabled": false,
> "enforced_by_owner": false}`. The status is therefore NOT enabled,
> with the endpoint reachable and reporting its state (not an inferred
> negative from an unauthorized response). The UNKNOWN text above and
> the twelfth-round reasoning are preserved as the historical record;
> §18 records the evidence, and §17.3 is superseded by this result.

### 16.2 The publisher is PREPARED for enforcement: sequence specified, rehearsed, and a validated production patch recorded

> **THIRTEENTH-ROUND UPDATE:** the draft-first sequence described here is
> now IMPLEMENTED in the production workflow on this branch (with a
> failure-path draft-cleanup step; six PAT-bearing steps) — see §17. The
> text below is preserved as the historical record of the twelfth round,
> when the patch was validated locally but deliberately not applied.

The production release sequence — create a PUBLISHED empty release, then
upload assets to it — is incompatible with GitHub-enforced immutable
releases (assets cannot be added to an already published release). The
required draft-first sequence is fully specified in §8.3 and is now
REHEARSED end-to-end by the rehearsal workflow's twelfth-round update
(draft create → BY-ID asset upload → draft belt: presence + byte
lengths + download-back `sha256sum -c` + provenance tag → publish PATCH
`draft=false`, `make_latest=false` → read-only `verify-versioned` gate
(unchanged, still the activation precondition) → dedicated-ref
activation + read-back (unchanged)). The rehearsal's partial-upload
scenario proves an incomplete asset set is refused on the DRAFT and
never published. PUSH STATUS: the updated workflow file itself is
validated and preserved in this change's working state, but it could
NOT be pushed to this branch with the task's credential — see the
exact prerequisite at the end of this subsection.

The exact production patch that adopts the sequence was prepared and
validated locally (a battery of 431 tests including the draft-first
readiness pins, typecheck, build, bundle, YAML parse, `bash -n`) and is
recorded alongside the remediation report for the owner. The production
publisher on this branch is deliberately UNCHANGED: with the
enforcement status UNKNOWN, the change ships only together with the
owner's enablement decision, never speculatively — the currently
published-first sequence is compatible with the observed state, and
every rollback and last-known-good safeguard is unaffected.

Key facts the prepared implementation relies on (GitHub REST, verified
2026-11-23 from the official docs): "Get a release by tag name" serves
PUBLISHED releases only, and draft listings are visible only to
push-access users — therefore every draft operation addresses the
release BY ID, and the draft belt necessarily carries the PAT (the only
push-access credential in the workflow). The PAT-bearing step count
would become SIX (§11 note; the sixth is the failure-path draft-cleanup
step, which needs the PAT to delete this run's verified un-published
draft); no other credential boundary moves, no
job grants write, and the belt step remains zero-custom-code (pinned
`gh api`, `jq`, `sha256sum` invocations only).

Safety properties of the prepared change: a partial upload fails on the
DRAFT and never creates immutable residue; the versioned tag is
materialized only at publish (from the pinned target commit);
`--latest=false`/`make_latest=false` keep the repo-wide designation out
of the path; the pointer still cannot move until the PUBLISHED release
passes the full read-only verification.

**Exact prerequisite — the workflow file must be pushed by an actor
with `workflows` permission.** The twelfth-round update of
`.github/workflows/rehearsal-publication.yml` (the draft-first `happy`
and `partial-upload` scenarios, 105 changed lines, validated by the
full offline battery) could not be pushed to this branch by the task's
credential: GitHub refuses ANY workflow-file creation or update by a
GitHub App without the `workflows` permission — `HTTP 403 "refusing to
allow a GitHub App to create or update workflow
.github/workflows/rehearsal-publication.yml without workflows
permission"`, on both the git-trees path (`POST /git/trees`) and the
contents path (`PUT /contents/...`). This is a GitHub platform rule,
not a transient failure. Until a credential holding `workflows`
permission (for example a user personal access token with the workflow
scope) pushes that single file to this branch, the rehearsal workflow
AS IT EXISTS ON THE REMOTE is the pre-twelfth-round version — the
draft-first rehearsal scenarios exist in the validated working state
only. The production publisher is UNAFFECTED: it is deliberately
unchanged in both the local working state and the remote branch.

### 16.3 The rehearsal was NOT dispatched — exact prerequisites

Per the authorization boundary (do not dispatch unless the
rehearsal-repository access, credential scope, and workflow target
guard are verified), the isolated rehearsal against
`GraveYield/grave-indexer-pub-rehearsal` was NOT executed. Verified
prerequisite state (read-only probes, 2026-11-23):

1. The rehearsal repository `GraveYield/grave-indexer-pub-rehearsal`
   EXISTS but is **EMPTY** — no commits, no branches, no default branch,
   no files. GitHub registers `workflow_dispatch` workflows only from a
   repository's default branch, so the rehearsal workflow cannot be
   dispatched there at all (it is also not yet merged into
   `grave-indexer`'s default branch: PR #5 remains open and in draft,
   as required).
2. Dispatching additionally requires a credential with
   `actions:write`/write access to the rehearsal repository; none was
   available to the task, and none was requested or exposed.
3. The workflow's own safety properties WERE verified by inspection and
   structure tests: the hard repository-identity guard is the FIRST
   step (before checkout and any write), the rehearsal uses only its
   repository-scoped `github.token`, no production secret
   (`GY_RELEASE_PAT` or otherwise) is referenced (pinned by
   test/publishWorkflow.test.ts), and the rehearsal now exercises the
   §8.3 draft-first sequence (§16.2) — while the production publisher
   itself is deliberately UNCHANGED (UNKNOWN enforcement status; the
   validated patch is recorded for the owner).

What the owner must do (unchanged in substance, updated in facts):
initialize the rehearsal repository (one commit) with this branch's
workflow on its default branch (or grant a scoped credential), then
dispatch once per scenario and record run IDs, summaries, and resulting
repository state — docs/PUBLICATION_REHEARSAL.md §3. Additionally, push
the validated twelfth-round rehearsal workflow file to this branch
(requires a credential with `workflows` permission — see §16.2). Until
then, no rehearsal result is claimed, and the workflow remains
PREPARED — NOT EXECUTED.

### 16.4 Validation (twelfth round)

* `pnpm run test:offline`: 425 tests, 0 failures (the shipped branch
  state; the prepared production patch was additionally validated
  against a 431-test battery including the draft-first readiness pins
  before being recorded separately).
* `pnpm run typecheck`, `pnpm run build`, `pnpm run bundle:release-ops`:
  pass.
* All workflow YAMLs parse; every `run:` block passes `bash -n` (100
  blocks across the four workflows on the shipped branch state).
* Diff review: no production repository reference in rehearsal code, no
  credential-scope change on the shipped state, no new workflow
  triggers, and no remaining "NOT enabled" immutable-release claim.
* NO publication or rehearsal workflow was dispatched; NO release, tag,
  or stable reference was created, modified, or deleted in any
  repository; NO repository setting, ruleset, or immutable-release
  configuration was changed; NO Vercel/Console/blockchain state was
  touched.

## 17. Thirteenth-round correction — draft-first publication IMPLEMENTED in the production workflow (2026-11-23)

The twelfth round recorded the draft-first sequence as PREPARED
(validated locally, reverted from the branch) under a compatibility
exemption. The follow-up remediation task withdraws that exemption: the
production publisher must actually implement draft-first publication,
not merely document it. This round therefore applies the validated
patch to the branch and completes it with the previously missing piece
— the failure-path draft cleanup.

### 17.1 What changed on the branch

* `.github/workflows/publish-console-snapshot.yml` — the `release` job
  now runs the §8.3 sequence end-to-end: `gh release create --draft
  --latest=false --target $CHECKOUT_SHA`; the draft's release ID is
  resolved from the LIST endpoint (drafts are not addressable by tag),
  strictly validated, and its `draft` flag re-read before use; all
  three assets are uploaded BY RELEASE ID through `uploads.github.com`
  with per-asset byte-length verification against the local files; the
  DRAFT belt verifies presence (exactly the three required assets),
  downloads the three assets BACK from the draft by asset ID and runs
  the `sha256sum -c` belt over the exact uploaded bytes, and requires
  the staged provenance to name THIS release tag — ALL before publish;
  publish is `PATCH draft=false` + explicit `make_latest=false`,
  verified by read-back (draft flag + tag identity). The unchanged
  read-only `verify-versioned` job still gates the pointer activation,
  and the promote/rollback chain is untouched.
* NEW failure-path cleanup step (`id: draft-cleanup`, `if: failure()`):
  when any step of the release job failed, the run's un-published draft
  is deleted so the run leaves NO release residue. The deletion is
  authorized ONLY after a release-by-ID read-back proves BOTH
  `draft == true` AND `tag_name == $TAG` (this run's exact tag — the
  versioned tag encodes the generation timestamp and source commit). A
  PUBLISHED release, a foreign tag, an unreadable release, or an
  unusable captured ID is NEVER deleted (OPERATOR INTERVENTION
  REQUIRED). If no draft ID was captured, the step resolves this run's
  own draft by the exact tag from the draft list; if no such draft
  exists, it exits cleanly (the failure happened before the draft
  existed). The stable reference and every published release are never
  touched by this step.
* `test/publishWorkflow.test.ts` — the draft-first readiness pins are
  extended: the PAT-bearing step count is pinned at SIX (draft
  create+upload; draft verify+publish; failure-path draft-cleanup;
  stable-ref activation; promote-job rollback; downstream rollback-job
  mutation), and a NEW suite EXECUTES the actual cleanup script
  extracted from the workflow against a stateful mock `gh` binary,
  covering: happy cleanup (exactly one by-ID DELETE, proven by
  read-back), refusal on a published release, refusal on a foreign
  tag, refusal on an unreadable release, clean exit with zero
  deletions when no draft exists, the fallback list-resolution path,
  and fail-closed on an unusable captured ID.

### 17.2 Credential posture (updated)

Six PAT-bearing steps, all step-level env, zero job-level grants, zero
custom code in any PAT step (pinned `gh api`/`jq`/`stat`/`sha256sum`
invocations only). The cleanup step is the sixth: deleting a draft
requires push access, so the automatic read-only token cannot perform
it. Everything else in the credential matrix (§11) is unchanged.

### 17.3 Immutable-release status (unchanged)

> **SUPERSEDED, fourteenth round:** the authorized endpoint result
> settles this as **NOT enabled** (HTTP 200, `enabled: false`,
> `enforced_by_owner: false`) — see §16.1 and §18. The text below is
> the historical thirteenth-round record.

UNKNOWN. The authorized endpoint
`GET /repos/GraveYield/grave-indexer/immutable-releases` still requires
authentication; no authorized result is available to this task, and
unauthenticated responses remain inconclusive. With draft-first now
implemented, the publisher is compatible with the feature enabled AND
disabled; enabling it remains an owner decision (§8, §16.1).

### 17.4 Validation (thirteenth round)

* `pnpm run test:offline`: 440 tests, 0 failures (431 from the applied
  draft-first battery + 9 new draft-cleanup tests).
* `pnpm run typecheck`, `pnpm run build`, `pnpm run bundle:release-ops`:
  pass.
* All four workflow YAMLs parse; every `run:` block passes `bash -n`
  (102 blocks across the four workflows).
* Diff review: production/rehearsal separation intact, no credential
  leakage, no excessive permissions, no new workflow triggers (still
  manual-only `workflow_dispatch`, main-gated), no published-first
  sequence left in production, stable-pointer activation still strictly
  behind the verified publish + read-only gates.
* NO publication or rehearsal workflow was dispatched; NO release, tag,
  or stable reference was created, modified, or deleted in any
  repository; NO repository setting, ruleset, or immutable-release
  configuration was changed; NO Vercel/Console/blockchain state was
  touched.

## 18. Fourteenth-round reconciliation — immutable-release status SETTLED (NOT enabled); rehearsal prerequisites updated (2026-11-23)

Documentation-only round (no workflow or source change). Two material
status updates, both evidenced, with every stale "UNKNOWN / prepared /
blocked" claim reconciled in place (§8 table, §8 item 1, owner actions,
§16.1, §17.3) while the historical per-round text is preserved.

### 18.1 Immutable-release status: NOT enabled — authorized endpoint result

* Evidence (READ-ONLY, 2026-11-23): `GET
  /repos/GraveYield/grave-indexer/immutable-releases` with the
  owner-provided authorized credential → **HTTP 200**, body
  `{"enabled": false, "enforced_by_owner": false}`.
* Per the interpretation rule recorded in §8/§16.1, a 200 response is
  authoritative: the endpoint is reachable and REPORTS its state. The
  reported state is `enabled: false` — the feature is NOT enabled, and
  it is NOT enforced by the owner. This is not an inferred negative: it
  is the endpoint's own answer to an authorized caller.
* Consequences: (a) the workflow-level immutability convention remains
  the ONLY immutability in effect — every existing safeguard
  (compare-before-rollback, --clobber prohibition, collision gates,
  never re-upload/delete assets, draft-first publish) is unchanged and
  remains load-bearing; (b) the draft-first production sequence
  implemented in the thirteenth round (§17) is compatible with the
  feature disabled (current) AND enabled (future owner decision) — no
  further publisher change is required before an enablement decision;
  (c) the twelfth-round UNKNOWN record in §16.1/§17.3 is preserved as
  history, superseded in place.

### 18.2 Rehearsal: push prerequisite RESOLVED, new exact prerequisite recorded

* RESOLVED: the twelfth-round workflow-push blocker (GitHub App without
  the `workflows` permission → HTTP 403) is gone. The owner provided a
  fine-grained PAT; the thirteenth-round commit (which MODIFIES
  `.github/workflows/rehearsal-publication.yml` and
  `.github/workflows/publish-console-snapshot.yml`) was pushed to this
  branch successfully — GitHub accepted workflow-file changes through
  that credential, proving the `workflows` permission is held. The
  branch's rehearsal workflow is now the current draft-first version.
* Still blocking, now with the exact cause verified live: the
  rehearsal repository `GraveYield/grave-indexer-pub-rehearsal` remains
  EMPTY (size 0, no default branch content), and the owner-provided
  fine-grained PAT does NOT cover it:
  - `PUT /repos/GraveYield/grave-indexer-pub-rehearsal/contents/probe.txt`
    → HTTP 403 "Resource not accessible by personal access token"
    (probe write REFUSED, nothing created — repo still size 0);
  - `git push` over HTTPS → 403 "Permission to
    GraveYield/grave-indexer-pub-rehearsal.git denied to sethoshi18".
  The same PAT DOES hold admin/push on `grave-indexer` (proven by the
  successful branch push). This is a token repository-selection /
  permission-scope gap, NOT a repository-state problem.
* Exact owner fix (owner settings, not this task's authority): edit the
  fine-grained token (Settings → Developer settings → Fine-grained
  tokens) to add `grave-indexer-pub-rehearsal` to its repository access
  with Contents: read/write, Workflows: read/write, and Actions:
  read/write; then initialize the rehearsal repository (one commit
  carrying `rehearsal-publication.yml` + `docs/PUBLICATION_REHEARSAL.md`
  + a README on `main`) and dispatch the five scenarios per
  docs/PUBLICATION_REHEARSAL.md §3. NO rehearsal result is claimed;
  the rehearsal remains PREPARED — NOT EXECUTED.

### 18.3 Validation (fourteenth round)

* Documentation-only change; the full offline battery was re-run on the
  exact tree: `pnpm run test:offline`, `pnpm run typecheck`,
  `pnpm run build`, `pnpm run bundle:release-ops` — all pass; all four
  workflow YAMLs parse; every `run:` block passes `bash -n`.
* No workflow content, source file, test, or repository setting was
  changed by this round; NO publication or rehearsal workflow was
  dispatched; NO release, tag, or stable reference was created,
  modified, or deleted in ANY repository; NO Vercel/Console/blockchain
  state was touched.
