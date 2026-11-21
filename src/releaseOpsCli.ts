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

import { pathToFileURL } from "node:url";
import {
  ReleaseOpsError,
  authedHttp,
  resolveLatestRelease,
  verifyReleaseAssetSet,
  type AssetScope,
} from "./releaseOps.js";

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

const USAGE = `grave-indexer release-ops — the GitHub-facing commands the privileged publication job runs

  release-ops release-latest <owner/repo>
      Hardened rollback-pointer discovery: kind=none ONLY on a genuine
      HTTP 404; auth/permission/rate-limit/outage/malformed failures exit
      non-zero (never guessed).
  release-ops verify-release-assets <owner/repo> --tag <tag> --scope versioned|latest --expected-tag <tag>
      Same-release verification of snapshot + provenance + checksum;
      --scope latest additionally requires the repo-wide latest
      designation to equal the expected tag.
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
