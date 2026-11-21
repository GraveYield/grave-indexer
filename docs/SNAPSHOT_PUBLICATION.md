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
   download (schema + SHA-256 + byte length);
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
