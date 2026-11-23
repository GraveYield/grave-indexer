// SPDX-License-Identifier: Apache-2.0
//
// STANDALONE release-ops CLI entry point (PR #5 remediation — review
// Task 1 correction, second round).
//
// WHY THIS MODULE EXISTS: the privileged publication job must run with
// the SMALLEST trusted execution boundary possible. The full `cli.ts`
// pulls in the entire indexer dependency graph (@solana/web3.js, the
// workspace SDK, bs58, tweetnacl, RPC transports) and can only run
// inside `node_modules`. Running that stack inside the job that holds
// `contents: write` would force the privileged job to either check out
// the repository and install dependencies with the write token present
// (the exact exposure the independent review rejected) or ship
// `node_modules` around. So the two GitHub-facing commands the
// privileged job actually needs — `release-latest` and
// `verify-release-assets` — live here instead, in a module graph that
// reaches ONLY `node:` builtins and the pure verification modules:
//
//   releaseOpsCli.ts
//     └─ releaseOps.ts
//          ├─ snapshotPublication.ts        (node:crypto only)
//          └─ snapshotPublicationSequence.ts
//               └─ consoleSnapshotParse.ts  (node builtins + SDK constants)
//
// The read-only `verify` job compiles this entry into a SINGLE
// self-contained bundle (`pnpm run bundle:release-ops`, esbuild) with
// zero npm runtime dependencies, and the privileged `publish` job runs
// that prebuilt bundle with the runner's plain `node` — no checkout, no
// dependency installation, no repository code, in the write-token job.
//
// TRUST CHAIN: the bundle is built by the read-only job from the EXACT
// `github.sha` commit (checkout + `git rev-parse HEAD` assertion in
// that job), and travels to the privileged job through the run-scoped
// artifact service (actions/upload-artifact → actions/download-artifact
// within one workflow run; those actions use the artifact runtime
// token, NOT `github.token`). The privileged job therefore executes
// only code that provably originates from the reviewed commit.
//
// `cli.ts` re-exports the two command functions so the behavioral test
// battery (test/releaseOps.test.ts) keeps exercising the REAL
// production entry points used by the workflow.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ReleaseOpsError,
  authedHttp,
  buildStablePointerForRelease,
  fetchStablePointer,
  resolveStableRef,
  resolveLatestRelease,
  verifyArtifactTriple,
  verifyReleaseAssetSet,
  verifyStableReference,
  type AssetScope,
} from "./releaseOps.js";
import { CHECKSUM_ASSET_NAME, PROVENANCE_ASSET_NAME, SNAPSHOT_ASSET_NAME } from "./snapshotPublication.js";

/**
 * Read the GitHub API token from the environment WITHOUT ever printing it.
 * Returns null when absent (unauthenticated calls are valid for public
 * repos but carry a low rate limit — the workflow always supplies one).
 */
function githubApiToken(): string | null {
  return process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
}

/**
 * `release-latest` — HARDENED rollback-pointer discovery (PR #5 remediation,
 * review Task 4). Replaces the previous `gh api ... 2>/dev/null || echo ""`
 * pattern that silently reinterpreted authentication failures, rate
 * limits, outages and malformed responses as "no previous release".
 *
 * Output protocol (machine-consumed by the workflow via GITHUB_OUTPUT):
 *   * kind=none|found  tag=<tag or empty>
 * `kind: none` is produced ONLY by a genuine HTTP 404 from
 * /releases/latest. Any other failure prints the typed category to
 * stderr and exits non-zero — the workflow aborts BEFORE any release
 * operation, leaving the stable reference untouched.
 */
export async function cmdReleaseLatest(repository: string): Promise<number> {
  const token = githubApiToken();
  try {
    const resolution = await resolveLatestRelease({ repository, ...(token ? { http: authedHttp(token) } : {}) });
    if (resolution.kind === "none") {
      console.error(`release-latest: ${resolution.detail}`);
      console.log("kind=none");
      console.log("tag=");
    } else {
      console.error(`release-latest: current latest release tag: ${resolution.tag}`);
      console.log("kind=found");
      console.log(`tag=${resolution.tag}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof ReleaseOpsError) {
      console.error(`release-latest: refusing to guess the rollback pointer — ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/**
 * `verify-release-assets` — SAME-RELEASE asset verification (PR #5
 * remediation, review Task 5).
 *
 *   --scope versioned  Verify the three assets of ONE exact versioned
 *                      release through its immutable tag URLs: checksum
 *                      matches the exact snapshot bytes, provenance
 *                      verifies over the bytes, and the provenance sidecar
 *                      names the SAME tag.
 *   --scope latest     Additionally (BEFORE the asset fetches) require the
 *                      repo-wide latest designation to equal the expected
 *                      versioned tag — an unrelated promotion that moved
 *                      the stable pointer fails the run, and a pointer
 *                      that moves between the downloads and the
 *                      designation query fails the mismatch check.
 *
 * TRANSPORT (fourth-round correction — private repository): with a token
 * in the environment, the assets are fetched through the AUTHENTICATED
 * REST API path (`Accept: application/octet-stream`) — a private
 * repository's release assets 404 for unauthenticated requests. The
 * token supplied here is the READ-ONLY automatic workflow token: the
 * verification jobs hold no release-write credential and must never see
 * one.
 *
 * Exit 0 = the fetched triple is one complete, internally consistent,
 * correctly-named artifact set. Exit 1 = any mismatch, missing sidecar,
 * pointer drift, or API failure — the workflow aborts (and, post-activation,
 * reports failure for operator investigation; the previously serving
 * release's bytes were never modified by this design).
 */
export async function cmdVerifyReleaseAssets(args: {
  repository: string;
  tag: string;
  scope: AssetScope;
  expectedTag: string;
}): Promise<number> {
  const token = githubApiToken();
  try {
    if (args.scope === "latest") {
      const resolution = await resolveLatestRelease({ repository: args.repository, ...(token ? { http: authedHttp(token) } : {}) });
      if (resolution.kind === "none") {
        console.error("verify-release-assets: no latest release is designated — the stable reference is missing; failing");
        return 1;
      }
      if (resolution.tag !== args.expectedTag) {
        console.error(
          `verify-release-assets: the latest designation is '${resolution.tag}', expected the activated release '${args.expectedTag}' — an unrelated promotion moved the stable pointer; failing`,
        );
        return 1;
      }
    }
    await verifyReleaseAssetSet({
      repository: args.repository,
      tag: args.tag,
      scope: args.scope,
      expectedTag: args.expectedTag,
      ...(token ? { authToken: token } : {}),
    });
    console.error(
      `verify-release-assets: OK — ${args.scope} scope resolved to ONE complete artifact set naming ${args.expectedTag} (checksum + provenance digest + tag cross-check)`,
    );
    return 0;
  } catch (err) {
    console.error(`verify-release-assets: FAILED — ${String((err as Error).message ?? err)}`);
    return 1;
  }
}

/**
 * `verify-local-release-assets` — FULL verification of a LOCAL artifact
 * triple (sixteenth round — P1 correction). This is the credential-free
 * half of the draft-verification separation: a privileged retrieval step
 * downloads the three DRAFT assets by release ID (the only step that
 * holds the release-write credential), and THIS command then runs the
 * EXACT same verification core `verify-release-assets` applies to its
 * own fetched bytes — checksum file over the exact snapshot bytes,
 * provenance parse + tag identity + SHA-256/byte-length integrity, and
 * the producer's completeness contract (no completeness failure markers,
 * well-formed count evidence, exact count agreement, non-empty
 * publication) — over the exact downloaded bytes, with NO network access
 * and NO credential in the environment.
 *
 * NOT a parallel validator: the checks ARE `verifyArtifactTriple` — the
 * same function `verifyReleaseAssetSet` calls post-fetch. Missing,
 * unreadable or empty files fail closed with actionable, asset-naming
 * errors.
 *
 * Exit 0 = the local triple is one complete, internally consistent,
 * correctly-named artifact set. Exit 1 = any violation.
 */
export async function cmdVerifyLocalReleaseAssets(args: { dir: string; expectedTag: string }): Promise<number> {
  const wanted: Array<[kind: "snapshot" | "provenance" | "checksum", name: string]> = [
    ["snapshot", SNAPSHOT_ASSET_NAME],
    ["provenance", PROVENANCE_ASSET_NAME],
    ["checksum", CHECKSUM_ASSET_NAME],
  ];
  try {
    const bytes: Record<"snapshot" | "provenance" | "checksum", Uint8Array> = {
      snapshot: new Uint8Array(),
      provenance: new Uint8Array(),
      checksum: new Uint8Array(),
    };
    for (const [kind, name] of wanted) {
      const path = `${args.dir.replace(/\/+$/, "")}/${name}`;
      let content: Buffer;
      try {
        content = readFileSync(path);
      } catch (err) {
        throw new ReleaseOpsError(
          "NOT_FOUND",
          `the '${name}' artifact is missing or unreadable at '${path}' (${String((err as Error).message ?? err)}) — refusing verification of an incomplete artifact set`,
        );
      }
      bytes[kind] = new Uint8Array(content);
    }
    verifyArtifactTriple({
      snapshotBytes: bytes.snapshot,
      provenanceBytes: bytes.provenance,
      checksumBytes: bytes.checksum,
      expectedTag: args.expectedTag,
    });
    console.error(
      `verify-local-release-assets: OK — the local triple in '${args.dir}' is ONE complete artifact set naming ${args.expectedTag} (checksum + provenance digest + tag cross-check + schema/completeness gate)`,
    );
    return 0;
  } catch (err) {
    console.error(`verify-local-release-assets: FAILED — ${String((err as Error).message ?? err)}`);
    return 1;
  }
}

/**
 * `stable-pointer-current` — READ-ONLY discovery of the dedicated stable
 * reference (`refs/tags/console-snapshot-prod`) for rollback bookkeeping.
 *
 * Output protocol (machine-consumed by the workflow via GITHUB_OUTPUT):
 *   * kind=none|found  tag=<versioned tag or empty>  sha=<tag object sha or empty>
 *     pointer_json=<compact pointer JSON or empty>
 * `kind: none` is produced ONLY by a genuine HTTP 404 from the stable-ref
 * endpoint (first publication). Any other failure prints the typed
 * category to stderr and exits non-zero.
 */
export async function cmdStablePointerCurrent(repository: string): Promise<number> {
  const token = githubApiToken();
  try {
    const resolution = await resolveStableRef({ repository, ...(token ? { http: authedHttp(token) } : {}) });
    if (resolution.kind === "none") {
      console.error(`stable-pointer-current: ${resolution.detail}`);
      console.log("kind=none");
      console.log("tag=");
      console.log("sha=");
      console.log("pointer_json=");
    } else {
      const stable = await fetchStablePointer({ repository, tagObjectSha: resolution.tagObjectSha, ...(token ? { http: authedHttp(token) } : {}) });
      console.error(`stable-pointer-current: stable reference resolves to ${stable.pointer.versionedTag} (tag object ${resolution.tagObjectSha})`);
      console.log("kind=found");
      console.log(`tag=${stable.pointer.versionedTag}`);
      console.log(`sha=${resolution.tagObjectSha}`);
      console.log(`pointer_json=${JSON.stringify(stable.pointer)}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof ReleaseOpsError) {
      console.error(`stable-pointer-current: refusing to guess the rollback pointer — ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/**
 * `stable-pointer-build` — READ-ONLY preparation for activation: verify
 * the versioned release's own asset triple (identity + checksum +
 * provenance + integrity), build the stable-pointer JSON from the
 * VERIFIED bytes, and resolve the CURRENT stable pointer as the rollback
 * reference. The pointer JSON crosses the job boundary as an output; the
 * actual ref mutation happens ONLY in the workflow's privileged `gh api`
 * steps — this bundle code NEVER holds the release-write credential.
 *
 * Output protocol (machine-consumed via GITHUB_OUTPUT):
 *   * pointer_json=<compact pointer JSON>
 *     previous_kind=none|found
 *     previous_versioned_tag=<...>  previous_tag_object_sha=<...>
 */
export async function cmdStablePointerBuild(args: { repository: string; tag: string; expectedTag: string }): Promise<number> {
  const token = githubApiToken();
  try {
    const built = await buildStablePointerForRelease({
      repository: args.repository,
      tag: args.tag,
      expectedTag: args.expectedTag,
      ...(token ? { authToken: token } : {}),
    });
    console.error(
      `stable-pointer-build: verified ${built.pointer.versionedTag} (snapshot ${built.pointer.snapshot.sha256}, ${built.pointer.snapshot.byteLength} bytes); previous stable pointer: ${built.previous?.versionedTag ?? "<none — first publication>"}`,
    );
    console.log(`pointer_json=${built.pointerJson}`);
    console.log(`previous_kind=${built.previous === null ? "none" : "found"}`);
    console.log(`previous_versioned_tag=${built.previous?.versionedTag ?? ""}`);
    console.log(`previous_tag_object_sha=${built.previous?.tagObjectSha ?? ""}`);
    return 0;
  } catch (err) {
    if (err instanceof ReleaseOpsError) {
      console.error(`stable-pointer-build: refusing to build the pointer — ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/**
 * `verify-stable` — post-activation identity gate for the DEDICATED
 * stable reference (owner-selected architecture). Verifies the FULL
 * identity chain: ref → annotated tag object → pointer JSON →
 * `pointer.versionedTag === expected-tag` → release record identity →
 * the three assets FROM THAT EXACT RECORD → checksum + provenance +
 * integrity → pointer digests over the fetched bytes. An unexpected
 * pointer target, a raced ref, a mixed artifact set or a digest
 * divergence is a typed failure — the workflow rolls back or reports
 * failure, never success.
 */
export async function cmdVerifyStable(args: { repository: string; expectedTag: string }): Promise<number> {
  const token = githubApiToken();
  try {
    const stable = await verifyStableReference({
      repository: args.repository,
      expectedTag: args.expectedTag,
      ...(token ? { authToken: token } : {}),
    });
    console.error(
      `verify-stable: OK — the stable reference (refs/tags/console-snapshot-prod, tag object ${stable.tagObjectSha}) resolves to ONE verified artifact set naming ${args.expectedTag} (source commit ${stable.pointer.sourceCommit}; snapshot digest ${stable.pointer.snapshot.sha256})`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ReleaseOpsError) {
      console.error(`verify-stable: FAILED — ${err.message}`);
      return 1;
    }
    throw err;
  }
}

const USAGE = `grave-indexer release-ops — the GitHub-facing commands the privileged publication job runs

  release-ops release-latest <owner/repo>
      Hardened rollback-pointer discovery: kind=none ONLY on a genuine
      HTTP 404; auth/permission/rate-limit/outage/malformed failures exit
      non-zero (never guessed).
  release-ops verify-release-assets <owner/repo> --tag <tag> --scope versioned|latest --expected-tag <tag>
      Same-release verification of snapshot + provenance + checksum;
      --scope latest requires the repo-wide latest designation to equal
      the expected tag (NON-production utility — the production stable
      reference is the dedicated console-snapshot-prod ref).
  release-ops verify-local-release-assets --dir <dir> --expected-tag <tag>
      FULL verification of a LOCAL snapshot + provenance + checksum
      triple (the exact bytes a privileged retrieval step downloaded
      from a DRAFT release): checksum + provenance digest + tag
      cross-check + the completeness gate — NO network, NO credential.
  release-ops stable-pointer-current <owner/repo>
      Read the dedicated stable reference (refs/tags/console-snapshot-prod)
      for rollback bookkeeping: kind=none ONLY on a genuine 404.
  release-ops stable-pointer-build <owner/repo> --tag <tag> --expected-tag <tag>
      Verify the versioned release and build the stable-pointer JSON
      (read-only preparation for the privileged activation step).
  release-ops verify-stable <owner/repo> --expected-tag <tag>
      Post-activation identity gate over the dedicated stable reference.
`;

/** Dispatch for the standalone bundle. argv excludes node and the script path. */
export async function releaseOpsMain(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "release-latest") {
    const repo = argv.slice(1).find((a) => !a.startsWith("--"));
    if (!repo) {
      console.error(USAGE);
      return 1;
    }
    return cmdReleaseLatest(repo);
  }
  if (command === "verify-release-assets") {
    const rest = argv.slice(1);
    const repo = rest.find((a) => !a.startsWith("--"));
    const scope = rest.includes("--scope") ? rest[rest.indexOf("--scope") + 1] : undefined;
    const tag = rest.includes("--tag") ? rest[rest.indexOf("--tag") + 1] : undefined;
    const expected = rest.includes("--expected-tag") ? rest[rest.indexOf("--expected-tag") + 1] : undefined;
    if (!repo || !scope || !tag || !expected || !(["versioned", "latest"] as const).includes(scope as AssetScope)) {
      console.error(USAGE);
      return 1;
    }
    return cmdVerifyReleaseAssets({ repository: repo, tag, scope: scope as AssetScope, expectedTag: expected });
  }
  if (command === "verify-local-release-assets") {
    const rest = argv.slice(1);
    const dir = rest.includes("--dir") ? rest[rest.indexOf("--dir") + 1] : undefined;
    const expected = rest.includes("--expected-tag") ? rest[rest.indexOf("--expected-tag") + 1] : undefined;
    if (!dir || !expected) {
      console.error(USAGE);
      return 1;
    }
    return cmdVerifyLocalReleaseAssets({ dir, expectedTag: expected });
  }
  if (command === "stable-pointer-current") {
    const repo = argv.slice(1).find((a) => !a.startsWith("--"));
    if (!repo) {
      console.error(USAGE);
      return 1;
    }
    return cmdStablePointerCurrent(repo);
  }
  if (command === "stable-pointer-build") {
    const rest = argv.slice(1);
    const repo = rest.find((a) => !a.startsWith("--"));
    const tag = rest.includes("--tag") ? rest[rest.indexOf("--tag") + 1] : undefined;
    const expected = rest.includes("--expected-tag") ? rest[rest.indexOf("--expected-tag") + 1] : undefined;
    if (!repo || !tag || !expected) {
      console.error(USAGE);
      return 1;
    }
    return cmdStablePointerBuild({ repository: repo, tag, expectedTag: expected });
  }
  if (command === "verify-stable") {
    const rest = argv.slice(1);
    const repo = rest.find((a) => !a.startsWith("--"));
    const expected = rest.includes("--expected-tag") ? rest[rest.indexOf("--expected-tag") + 1] : undefined;
    if (!repo || !expected) {
      console.error(USAGE);
      return 1;
    }
    return cmdVerifyStable({ repository: repo, expectedTag: expected });
  }
  console.error(USAGE);
  return 1;
}

// Bundle entry: when run directly (`node release-ops.mjs ...`), dispatch.
// The `import.meta.url` comparison works for the bundled ESM output; it is
// inert when this module is imported by cli.ts or the tests.
if (typeof process !== "undefined" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  releaseOpsMain(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(String((err as Error).message ?? err));
      process.exitCode = 1;
    },
  );
}
