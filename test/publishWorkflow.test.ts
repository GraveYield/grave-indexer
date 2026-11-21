// SPDX-License-Identifier: Apache-2.0
//
// publish-console-snapshot.yml — workflow-level validation (GY-M1-INT-001
// correction §5; PR #5 remediation — review Tasks 1-5, Task 1 corrected
// THREE times). YAML parsing alone proves nothing about behavior, so these
// tests pin the SECURITY-CRITICAL structure of the real workflow file:
// trigger restrictions, least-privilege permissions, job separation
// (read-only preparation/verification vs privileged jobs that contain ZERO
// custom code), artifact integrity handling, release behavior (latest
// promotion, no clobber), concurrency, and explicit failure paths. The
// behavioral sequence itself is exercised end-to-end by
// test/snapshotPublicationSequence.test.ts.
//
// Parsing uses PyYAML via a thin synchronous bridge (no YAML dependency
// is added to the package manifest for a test-only concern).
//
// KNOWN LIMITATION (stated explicitly, per the review requirement): these
// tests inspect the workflow's DECLARED structure — job permissions, step
// env blocks, command lines and action references. They cannot observe
// GitHub's runtime behavior (e.g. they cannot execute a workflow run to
// prove that actions/download-artifact never touches github.token, or
// that the runner injects nothing beyond what is declared). The runtime
// properties pinned here rest on GitHub's documented behavior:
//   - a job-level `permissions` grant makes github.token write-capable
//     for EVERY step of that job (which is exactly why the repository-
//     built code was moved OUT of the write-permission jobs);
//   - actions/download-artifact authenticates with the artifact-scoped
//     ACTIONS_RUNTIME_TOKEN and takes no github.token input;
//   - `run:` steps receive secrets only through explicitly declared env.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  env?: Record<string, unknown>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      name?: string;
      if?: string;
      needs?: string[];
      permissions?: Record<string, string>;
      env?: Record<string, unknown>;
      outputs?: Record<string, string>;
      steps: Array<Record<string, unknown>>;
    }
  >;
}

function loadWorkflow(): Workflow {
  const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
  const json = execFileSync(
    "python3",
    ["-c", "import sys,yaml,json;d=yaml.safe_load(sys.stdin.read());\nif True in d: d['on']=d.pop(True)\nprint(json.dumps(d))"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, input: raw },
  );
  return JSON.parse(json) as Workflow;
}

/** All shell snippets a job runs (run: blocks), in order. */
function runBlocks(job: Workflow["jobs"][string]): string[] {
  return job.steps.filter((s) => typeof s["run"] === "string").map((s) => s["run"] as string);
}

function stepEnv(step: Record<string, unknown>): Record<string, unknown> {
  return ((step["env"] ?? {}) as Record<string, unknown>) ?? {};
}

function hasTokenEnv(step: Record<string, unknown>): boolean {
  const env = stepEnv(step);
  return "GH_TOKEN" in env || "GITHUB_TOKEN" in env;
}

describe("publish-console-snapshot workflow — security-critical structure", () => {
  const wf = loadWorkflow();
  const generate = wf.jobs["generate"];
  const verify = wf.jobs["verify"];
  const publish = wf.jobs["publish"];
  const release = wf.jobs["release"];
  const verifyVersioned = wf.jobs["verify-versioned"];
  const promote = wf.jobs["promote"];
  const verifyStable = wf.jobs["verify-stable"];
  const allJobs: Array<[string, Workflow["jobs"][string] | undefined]> = [
    ["generate", generate],
    ["verify", verify],
    ["publish", publish],
    ["release", release],
    ["verify-versioned", verifyVersioned],
    ["promote", promote],
    ["verify-stable", verifyStable],
  ];
  assert.ok(allJobs.every(([, j]) => j), "all seven jobs exist");
  if (!allJobs.every(([, j]) => j)) throw new Error("workflow jobs missing");
  const jobs = allJobs.map(([, j]) => j!) as NonNullable<Workflow["jobs"][string]>[];

  test("workflow_dispatch is the ONLY trigger", () => {
    assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
    const inputs = (wf.on["workflow_dispatch"] as { inputs?: Record<string, unknown> }).inputs ?? {};
    assert.ok("max_pools" in inputs && "enrich" in inputs);
  });

  test("no scheduled, push, or pull_request publication exists anywhere in the file", () => {
    const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
    for (const banned of ["cron:", "schedule:", "push:", "pull_request:"]) {
      // these must not appear as trigger keys; occurrences in comments are fine
      const triggerBlock = (raw.split("jobs:")[0] ?? "").split("on:")[1] ?? "";
      assert.ok(!triggerBlock.includes(banned), `${banned} must not be a trigger of the publication workflow`);
    }
  });

  test("top-level permissions are read-only; ONLY release + promote get contents:write", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    assert.equal(generate!.permissions, undefined, "generate inherits the read-only default");
    assert.equal(verify!.permissions, undefined, "verify inherits the read-only default");
    assert.deepEqual(publish!.permissions, { contents: "read" }, "publish is EXPLICITLY read-only: repository-built code runs there");
    assert.deepEqual(release!.permissions, { contents: "write" }, "release is the release-creation job");
    assert.equal(verifyVersioned!.permissions, undefined, "verify-versioned inherits the read-only default");
    assert.deepEqual(promote!.permissions, { contents: "write" }, "promote is the activation job");
    assert.equal(verifyStable!.permissions, undefined, "verify-stable inherits the read-only default");
    // dependency chain: every privileged job is gated behind read-only preparation
    assert.ok(release!.needs?.includes("publish"), "release depends on the read-only publish gates");
    assert.ok(verifyVersioned!.needs?.includes("release"), "the roundtrip gate runs after upload");
    assert.ok(promote!.needs?.includes("verify-versioned"), "promotion is UNREACHABLE until same-release verification passed");
    assert.ok(verifyStable!.needs?.includes("promote") && verifyStable!.needs?.includes("publish"), "the post-activation gate runs after promotion");
    assert.ok(publish!.needs?.includes("generate") && publish!.needs?.includes("verify"), "publish depends on BOTH read-only preparation jobs");
    assert.ok(verify!.needs?.includes("generate"), "verify depends on generate");
  });

  test("concurrency: one publication at a time, never cancelled mid-run", () => {
    assert.equal(wf.concurrency.group, "publish-console-snapshot");
    assert.equal(wf.concurrency["cancel-in-progress"], false);
  });

  test("actions are pinned to full commit SHAs", () => {
    for (const job of jobs) {
      for (const step of job.steps) {
        if (typeof step["uses"] === "string") {
          const ref = step["uses"].split("@")[1] ?? "";
          assert.match(ref, /^[0-9a-f]{40}/, `${step["uses"]} must be pinned to a full commit SHA`);
        }
      }
    }
  });

  test("dispatch inputs reach the CLI through env indirection and are validated as positive integers", () => {
    const runs = runBlocks(generate!).join("\n");
    assert.ok(runs.includes("MAX_POOLS") && runs.includes("ENRICH"), "inputs are consumed from env, not inline interpolation");
    assert.ok(runs.includes("must be a positive integer"), "a numeric validation gate exists");
    assert.ok(
      !generate!.steps.some(
        (s) => typeof s["run"] === "string" && (s["run"] as string).includes("${{ inputs."),
        "no direct ${{ inputs.* }} interpolation inside run blocks",
      ),
    );
  });

  test("the staged bundle passes between jobs through a named workflow artifact with fail-closed upload", () => {
    const up = generate!.steps.find((s) => s["uses"]?.toString().startsWith("actions/upload-artifact"));
    assert.ok(up, "generate uploads the bundle");
    const upWith = (up?.["with"] ?? {}) as Record<string, unknown>;
    assert.equal(upWith["if-no-files-found"], "error");
    assert.equal(upWith["name"], "snapshot-publication-bundle");
    const down = verify!.steps.find((s) => s["uses"]?.toString().startsWith("actions/download-artifact"));
    assert.equal((down?.["with"] as Record<string, unknown> | undefined)?.["name"], "snapshot-publication-bundle");
    const pubDown = publish!.steps.find((s) => s["uses"]?.toString().startsWith("actions/download-artifact") && JSON.stringify(s["with"]).includes("snapshot-publication-bundle"));
    assert.ok(pubDown, "the read-only publish job downloads the verified publication bundle");
    const relDown = release!.steps.find((s) => s["uses"]?.toString().startsWith("actions/download-artifact") && JSON.stringify(s["with"]).includes("snapshot-publication-bundle"));
    assert.ok(relDown, "the release job downloads the verified publication bundle for upload");
    const opsDown = verifyVersioned!.steps.find((s) => s["uses"]?.toString().startsWith("actions/download-artifact") && JSON.stringify(s["with"]).includes("release-ops-cli"));
    assert.ok(opsDown, "the roundtrip gate downloads the prebuilt release-ops bundle");
  });

  test("integrity is recalculated against downloaded bytes at every gate: independent re-verification, pre-upload belts, same-release roundtrip, post-activation", () => {
    // Gate 1 (read-only verify job): strict schema-v2 + integrity re-check
    // of the DOWNLOADED bundle, independent of the generate job.
    const verifyRuns = runBlocks(verify!).join("\n");
    assert.match(verifyRuns, /verify-snapshot[\s\\]+bundle\//, "independent re-verification BEFORE any publication");
    // Gates 2a/2b (publish + release): pure-shell checksum over the exact
    // downloaded bytes — including INSIDE the privileged release job,
    // immediately before the upload.
    assert.match(runBlocks(publish!).join("\n"), /sha256sum -c console-snapshot\.sha256/, "the read-only gate job re-checks the checksum over the downloaded bytes");
    assert.match(runBlocks(release!).join("\n"), /sha256sum -c console-snapshot\.sha256/, "the PRIVILEGED release job re-checks the checksum over its own downloaded bytes before uploading");
    // The roundtrip and stable gates recompute the checksum over the exact
    // downloaded bytes inside verifyReleaseAssetSet (verifyChecksumFile),
    // exercised by test/releaseOps.test.ts; here we pin that the workflow
    // invokes them at both scopes.
    assert.match(runBlocks(verifyVersioned!).join("\n"), /--scope versioned/, "same-release roundtrip gate (read-only job, between upload and promotion)");
    const stableRuns = runBlocks(verifyStable!).join("\n");
    assert.match(stableRuns, /--scope latest/, "post-activation stable gate (read-only job)");
  });

  test("duplicate versioned tags abort before creation; releases are created explicitly NOT latest", () => {
    const relRuns = runBlocks(release!).join("\n");
    assert.match(relRuns, /git ls-remote --exit-code --tags/, "duplicate-tag gate runs in the privileged job, immediately before the mutation");
    assert.match(relRuns, /--latest=false/, "versioned releases never become latest on creation");
    assert.ok(!relRuns.includes("--clobber"), "no asset clobbering anywhere");
    const pubRuns = runBlocks(publish!).join("\n");
    assert.match(pubRuns, /git ls-remote --exit-code --tags/, "the duplicate-tag gate ALSO runs in the read-only publish job (early fail-closed)");
  });

  test("the stable reference is activated only AFTER same-release verification, then re-verified through the stable gate", () => {
    // Cross-job ordering: release → verify-versioned → promote.
    assert.equal(promote!.needs?.includes("verify-versioned"), true, "promotion is gated on the same-release verification JOB");
    const promoteRuns = runBlocks(promote!).join("\n");
    assert.match(promoteRuns, /gh release edit "\$TAG" --repo "\$REPO" --latest/, "the stable reference is activated by a single promotion command");
    const releaseRuns = runBlocks(release!).join("\n");
    assert.match(releaseRuns, /--latest=false/, "the release job creates the release explicitly NOT latest");
    assert.ok(!/--latest(?!=false)/.test(releaseRuns), "the release job must NOT set the latest designation (only --latest=false)");
    const stableRuns = runBlocks(verifyStable!).join("\n");
    assert.match(stableRuns, /--scope latest --expected-tag "\$TAG"/, "the stable gate cross-checks the activated tag");
    assert.match(stableRuns, /verify-release-assets/, "the stable gate runs the same-release verification CLI");
  });

  test("the workflow records the previous latest tag as a rollback pointer (read-only discovery)", () => {
    const runs = runBlocks(publish!).join("\n");
    assert.match(runs, /release-latest/, "the current latest designation is read through the hardened gate before activation");
    assert.match(runs, /previous_latest_tag/, "the rollback pointer is captured as a job output");
    assert.match(runs, /rollback/, "the rollback pointer is surfaced in the summary");
    const summaryStep = verifyStable!.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("ConsoleSnapshot publication")));
    assert.ok(summaryStep, "the final publication summary exists in the read-only verify-stable job");
    assert.equal(
      stepEnv(summaryStep!)["PREV"],
      "${{ needs.publish.outputs.previous_latest_tag }}",
      "the rollback pointer reaches the final publication summary through the validated job output",
    );
  });

  test("no secret material is echoed; authenticated URLs never reach provenance or step summaries", () => {
    const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
    const summaryBlocks = raw.split("GITHUB_STEP_SUMMARY").slice(1).join("");
    assert.ok(!summaryBlocks.includes("${{ secrets."), "no secrets interpolate into the summary");
    const allRuns = jobs.map((j) => runBlocks(j).join("\n")).join("\n");
    assert.ok(!allRuns.includes("MAINNET_RPC_URL") || !allRuns.includes("echo $DISCOVERY_RPC_URL"), "RPC secrets are consumed, never echoed");
    // The only URLs printed are the public unauthenticated ones (the
    // match is line-bounded so the regex cannot span into other keys).
    assert.ok(!/https:\/\/[^\s)"'`]*(@|token)/i.test(raw), "no authenticated URL is written anywhere");
  });
});

// ─── Review Task 1 — execution restriction + write-token exposure ──────────

describe("publish-console-snapshot workflow — main-only restriction and token scoping (review Task 1)", () => {
  const wf = loadWorkflow();
  const generate = wf.jobs["generate"]!;
  const verify = wf.jobs["verify"]!;
  const publish = wf.jobs["publish"]!;
  const release = wf.jobs["release"]!;
  const verifyVersioned = wf.jobs["verify-versioned"]!;
  const promote = wf.jobs["promote"]!;
  const verifyStable = wf.jobs["verify-stable"]!;
  const allJobs = [generate, verify, publish, release, verifyVersioned, promote, verifyStable];
  const readOnlyJobs: Array<[string, typeof generate]> = [
    ["generate", generate],
    ["verify", verify],
    ["publish", publish],
    ["verify-versioned", verifyVersioned],
    ["verify-stable", verifyStable],
  ];
  const privilegedJobs: Array<[string, typeof generate]> = [
    ["release", release],
    ["promote", promote],
  ];
  const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");

  function effectivePermissions(job: typeof generate): Record<string, string> {
    return job.permissions ?? { contents: "read" };
  }

  test("ALL SEVEN jobs carry the job-level main-only guard (`if: github.ref == 'refs/heads/main'`)", () => {
    for (const job of allJobs) {
      assert.equal(
        job["if"],
        "github.ref == 'refs/heads/main'",
        "a dispatch against any other ref must skip the job entirely (release-writing steps unreachable)",
      );
    }
  });

  test("ALL SEVEN jobs carry an explicit in-step ref guard that rejects anything but refs/heads/main", () => {
    for (const job of allJobs) {
      const guards = job.steps.filter(
        (s) => typeof s["run"] === "string" && (s["run"] as string).includes("refs/heads/main") && (s["run"] as string).includes("GITHUB_REF"),
      );
      assert.ok(
        guards.length > 0,
        "defense-in-depth: an explicit guard step must re-check GITHUB_REF == refs/heads/main before anything else",
      );
      const guardRun = guards[0]!["run"] as string;
      assert.ok(guardRun.includes('!= "refs/heads/main"'), "the guard REJECTS non-main refs");
    }
  });

  test("the workflow cannot reach release-writing steps from an arbitrary branch or tag (layered)", () => {
    // Layer 1: job-level if on every job. Layer 2: guard steps. Layer 3: dispatch-only trigger.
    assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"], "dispatch-only trigger: no push/PR/schedule context can run it");
    const releaseRuns = runBlocks(release).join("\n");
    assert.ok(releaseRuns.includes("refusing to publish"), "the release job's guard names its refusal explicitly");
    const promoteRuns = runBlocks(promote).join("\n");
    assert.ok(promoteRuns.includes("refusing to promote"), "the promotion job's guard names its refusal explicitly");
  });

  test("every repository checkout is pinned to the selected commit; the workflow asserts HEAD equals it", () => {
    for (const [name, job] of readOnlyJobs) {
      if (name === "publish" || name === "verify-versioned") continue; // these jobs deliberately have NO checkout
      const checkout = job.steps.find((s) => typeof s["uses"] === "string" && (s["uses"] as string).startsWith("actions/checkout"));
      assert.ok(checkout, `checkout step exists in the read-only job ${name}`);
      const withRef = ((checkout?.["with"] ?? {}) as Record<string, unknown>)["ref"];
      assert.equal(withRef, "${{ github.sha }}", "checkout must be the EXACT commit Actions selected, never a moving branch head");
      const assertStep = job.steps.find(
        (s) => typeof s["run"] === "string" && (s["run"] as string).includes("git rev-parse HEAD"),
      );
      assert.ok(assertStep, "a step asserts git rev-parse HEAD equals the selected commit");
      assert.match((assertStep?.["run"] as string) ?? "", /checkout mismatch|!= "\$CHECKOUT_SHA"/, "the assertion FAILS the job on mismatch");
    }
  });

  test("the privileged release job targets the asserted commit (github.sha), never a moving ref", () => {
    assert.equal(release.env?.["CHECKOUT_SHA"], "${{ github.sha }}", "the release job pins the release target to the workflow's selected commit");
    const runs = runBlocks(release).join("\n");
    assert.match(runs, /--target "\$CHECKOUT_SHA"/, "gh release create uses the pinned commit");
  });

  // ── THIRD-ROUND CORRECTION (review follow-up): the second remediation
  // removed checkout/setup-node/pnpm from the privileged job but STILL ran
  // repository-built code (the release-ops bundle, provenance parsing)
  // inside the write-permission job. GitHub makes github.token write-
  // capable for EVERY step of a job whose permissions grant write, whether
  // or not an explicit GH_TOKEN env is attached. The corrected structure
  // moves ALL custom code into read-only jobs; the write-permission jobs
  // contain NOTHING but token-free precondition checks and the pinned
  // `gh release` mutation commands. These tests pin that boundary. ────────

  test("the publish job is EXPLICITLY READ-ONLY: repository-built code runs there, so contents:write must not exist in it", () => {
    assert.deepEqual(publish.permissions, { contents: "read" }, "publish declares contents:read explicitly — the review's finding was a write-capable token reaching custom code in this job");
    const runs = runBlocks(publish).join("\n");
    // The custom operations live here — under a read-only grant.
    assert.match(runs, /node ops\/release-ops\.mjs release-latest/, "rollback discovery (custom code) runs in the read-only job");
    assert.match(runs, /node -e "console\.log\(JSON\.parse/, "provenance parsing runs in the read-only job");
    // And nothing in this job can mutate releases. (The rollback summary
    // MENTIONS the rollback command in its documentation text, so only
    // actual command lines count — line-anchored.)
    assert.ok(!/^\s*gh release (create|upload|edit|delete) /m.test(runs), "the read-only publish job performs NO release-mutating operation");
  });

  test("custom `release-latest` execution receives a READ-ONLY credential, never a write-capable one", () => {
    // Find the step that actually executes the custom bundle for rollback
    // discovery and inspect ITS job's effective permissions.
    const step = publish.steps.find((s) => typeof s["run"] === "string" && (s["run"] as string).includes("release-latest"));
    assert.ok(step, "the rollback-discovery step exists");
    const perms = effectivePermissions(publish);
    assert.equal(perms["contents"], "read", "the job running custom discovery code grants only contents:read — github.token is read-only for EVERY step of it");
    const env = stepEnv(step!);
    assert.equal(env["GH_TOKEN"], "${{ github.token }}", "discovery authenticates with the workflow token, which is READ-ONLY because of the job grant");
    // Belt-and-suspenders: no OTHER job that runs release-latest exists with write permission.
    for (const [name, job] of privilegedJobs) {
      const runs = runBlocks(job).join("\n");
      assert.ok(!runs.includes("release-latest"), `${name} (write-permission job) must not execute the custom release-latest code`);
    }
  });

  test("PRIVILEGED JOBS CONTAIN ZERO CUSTOM CODE: no node, no repository script, no pnpm/npm, no build, no compilation", () => {
    for (const [name, job] of privilegedJobs) {
      const runs = runBlocks(job).join("\n");
      for (const banned of ["node ", "pnpm ", "npm ", "npx ", "src/cli.ts", ".mjs", "tsc ", "build:sdk", "tsx"]) {
        assert.ok(!runs.includes(banned), `${name} (contents:write) must not contain '${banned}' — no custom or repository-built code may execute where github.token is write-capable`);
      }
      assert.ok(!job.steps.some((s) => (s["uses"] as string | undefined)?.startsWith("actions/checkout")), `${name} NEVER checks out the repository`);
      assert.ok(!job.steps.some((s) => (s["uses"] as string | undefined)?.startsWith("actions/setup-node")), `${name} NEVER runs setup-node (its token input defaults to github.token)`);
      const usesSteps = job.steps.filter((s) => typeof s["uses"] === "string").map((s) => s["uses"] as string);
      for (const uses of usesSteps) {
        assert.match(uses, /^actions\/download-artifact@/, `${name}'s only allowed action is download-artifact (found: ${uses})`);
      }
    }
  });

  test("GLOBAL INVARIANT: every step that invokes node or executes a bundle lives in a job WITHOUT contents:write", () => {
    // Walk every job; any run block that executes node/npm/pnpm/a bundle
    // must belong to a job whose effective github.token is read-only.
    for (const job of allJobs) {
      const writeCapable = effectivePermissions(job)["contents"] === "write";
      for (const run of runBlocks(job)) {
        const executesCode = /\bnode\b|\bpnpm\b|\bnpm\b|\bnpx\b|\.mjs|src\/cli\.ts/.test(run);
        if (executesCode && writeCapable) {
          assert.fail(`a write-permission job executes custom/repository code: ${run.slice(0, 120)}`);
        }
      }
    }
  });

  test("only the EXPLICIT release-mutation steps receive the write-capable token; every other step in privileged jobs is token-free", () => {
    const expectedMutations: Array<[string, RegExp]> = [
      ["release", /gh release create "\$TAG"/],
      ["release", /gh release upload "\$TAG"/],
      ["promote", /gh release edit "\$TAG" --repo "\$REPO" --latest/],
    ];
    const found: string[] = [];
    for (const [name, job] of privilegedJobs) {
      for (const step of job.steps) {
        const run = (step["run"] as string) ?? "";
        if (hasTokenEnv(step)) {
          const matched = expectedMutations.filter(([jn, re]) => jn === name && re.test(run));
          assert.ok(matched.length > 0, `a token-bearing step in ${name} is not a recognized release mutation: ${run.slice(0, 120)}`);
          assert.ok(!run.includes("node ") && !run.includes(".mjs"), "token-bearing steps execute only the pinned gh CLI, never custom code");
          found.push(...matched.map(() => name));
        } else {
          // Token-free steps must not invoke the release API or make
          // authenticated calls, and must not interpolate github.token.
          assert.ok(!/^\s*gh release (create|upload|edit|delete) /m.test(run), `token-free step in ${name} must not call the GitHub release API`);
          assert.ok(!run.includes("Authorization: Bearer"), "token-free steps never make authenticated API calls");
          assert.ok(!run.includes("${{ github.token }}"), "token-free steps never reference the token context directly");
        }
      }
      assert.ok(!("GH_TOKEN" in (job.env ?? {})) && !("GITHUB_TOKEN" in (job.env ?? {})), `${name} must not declare GH_TOKEN/GITHUB_TOKEN at JOB level (it would leak to every step)`);
    }
    assert.deepEqual(found.sort(), ["promote", "release", "release"], "exactly three privileged mutation steps carry the write token: create, upload, promote");
  });

  test("no workflow-level or job-level env exposes the release credential anywhere", () => {
    assert.equal(wf.env, undefined, "no workflow-level env block exists (a token declared there would leak to every step of every job)");
    for (const job of allJobs) {
      assert.ok(!("GH_TOKEN" in (job.env ?? {})), `job ${job.name ?? "(unnamed)"} must not declare GH_TOKEN at job level`);
      assert.ok(!("GITHUB_TOKEN" in (job.env ?? {})), `job ${job.name ?? "(unnamed)"} must not declare GITHUB_TOKEN at job level`);
    }
    // The token string may only appear inside step-level env values.
    const tokenSteps = allJobs.flatMap((j) => j.steps.filter((s) => typeof s["env"] === "object" && s["env"] !== null && "GH_TOKEN" in ((s["env"] ?? {}) as Record<string, unknown>)));
    for (const step of tokenSteps) {
      assert.equal(stepEnv(step)["GH_TOKEN"], "${{ github.token }}", "step-level tokens always reference the automatic workflow token (no other credential source exists)");
    }
  });

  test("artifact download and integrity/verification steps never carry a release-write credential", () => {
    for (const job of allJobs) {
      const writeCapable = effectivePermissions(job)["contents"] === "write";
      for (const step of job.steps) {
        const uses = (step["uses"] as string | undefined) ?? "";
        if (uses.startsWith("actions/download-artifact") || uses.startsWith("actions/upload-artifact")) {
          assert.ok(!hasTokenEnv(step), `${uses} in ${job.name ?? "(unnamed)"} must not receive a GitHub token (it authenticates with the artifact-scoped runtime token)`);
        }
        const run = (step["run"] as string) ?? "";
        const isVerification = run.includes("sha256sum -c") || run.includes("--scope versioned") || run.includes("--scope latest") || run.includes("verify-snapshot");
        if (isVerification && writeCapable) {
          assert.ok(!run.includes("node ") && !run.includes(".mjs"), "verification inside a write-permission job must be pure shell (sha256sum), never custom code");
          assert.ok(!hasTokenEnv(step), "verification steps never carry the write token");
        }
      }
    }
    // The same-release roundtrip gate is a READ-ONLY job with NO token at all.
    assert.equal(verifyVersioned.permissions, undefined, "verify-versioned inherits the read-only default");
    for (const step of verifyVersioned.steps) {
      assert.ok(!hasTokenEnv(step), "the roundtrip gate runs completely token-free (the tag URLs are public)");
    }
  });

  test("read-only rollback discovery remains possible AND the post-activation gate stays read-only", () => {
    const step = publish.steps.find((s) => typeof s["run"] === "string" && (s["run"] as string).includes("release-latest"));
    assert.ok(step, "rollback discovery exists in the read-only publish job");
    assert.equal(publish.permissions?.["contents"], "read", "discovery runs under a read-only grant");
    // Post-activation gate: read-only token, no mutation.
    assert.equal(verifyStable.permissions, undefined, "verify-stable has no elevated permissions");
    const gate = verifyStable.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("--scope latest")));
    assert.ok(gate, "the stable gate step exists");
    assert.equal(stepEnv(gate!)["GH_TOKEN"], "${{ github.token }}", "the stable gate authenticates with the READ-ONLY workflow token");
    assert.ok(!runBlocks(verifyStable).join("\n").includes("gh release"), "the stable gate performs NO release-mutating operations");
  });

  test("permissions stay least-privilege: five read-only jobs, two narrow write jobs", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    assert.equal(generate.permissions, undefined);
    assert.equal(verify.permissions, undefined);
    assert.deepEqual(publish.permissions, { contents: "read" });
    assert.deepEqual(release.permissions, { contents: "write" });
    assert.equal(verifyVersioned.permissions, undefined);
    assert.deepEqual(promote.permissions, { contents: "write" });
    assert.equal(verifyStable.permissions, undefined);
    for (const [, job] of privilegedJobs) {
      assert.ok(Object.keys(job.permissions ?? {}).every((k) => k === "contents"), "privileged jobs grant ONLY contents (nothing else is elevated)");
    }
  });
});

// ─── Review Task 4 — hardened rollback-pointer discovery ────────────────────

describe("publish-console-snapshot workflow — rollback discovery hardening (review Task 4)", () => {
  const wf = loadWorkflow();
  const publish = wf.jobs["publish"]!;
  const release = wf.jobs["release"]!;

  test("rollback discovery uses the typed `release-latest` gate, not error-suppressed gh api", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /release-latest/, "the hardened discovery CLI is used");
    assert.ok(!runs.includes("2>/dev/null || echo"), "the old suppress-all-errors pattern is GONE");
    assert.ok(!runs.includes('--jq ".tag_name" 2>/dev/null'), "no raw gh api latest query that can silently fail into 'none'");
  });

  test("the tag-collision gate distinguishes absent / exists / gate-failure (never treats an API failure as 'absent')", () => {
    for (const [name, job] of [["publish", publish], ["release", release]] as const) {
      const runs = runBlocks(job).join("\n");
      assert.match(runs, /case "\$status" in/, `${name}: explicit three-way exit-status handling`);
      assert.match(runs, /status=\$\?/, `${name}: the gate captures the real exit status`);
      assert.match(runs, /refusing to treat this as 'tag absent'/, `${name}: a failing gate aborts the run`);
    }
  });

  test("the release-collision belt check is ALSO three-way (404 absent / 200 exists / anything else aborts)", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /releases\/tags\/\$TAG/, "the belt check queries the release-by-tag endpoint");
    assert.match(runs, /case "\$code" in/, "explicit three-way HTTP-status handling");
    assert.match(runs, /404\) echo "no release exists/, "HTTP 404 is the ONLY 'absent' verdict");
    assert.match(runs, /200\) echo "a release for tag \$TAG already exists/, "HTTP 200 is an aborting collision");
    assert.match(runs, /refusing to treat this as 'no release'/, "a transport failure or unexpected status aborts the run");
    const beltStep = publish.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("releases/tags/")));
    assert.ok(beltStep, "the belt-check step exists");
    assert.equal(stepEnv(beltStep!)["GH_TOKEN"], "${{ github.token }}", "the belt check authenticates with the workflow token");
    assert.equal(publish.permissions?.["contents"], "read", "the belt check's token is READ-ONLY because the job grants only contents:read");
  });

  test("the rollback pointer is recorded BEFORE any release operation (job chain enforces the order)", () => {
    const steps = publish.steps;
    const runs = steps.map((s) => (typeof s["run"] === "string" ? (s["run"] as string) : ""));
    const rollbackIdx = runs.findIndex((r) => r.includes("previous_latest_tag"));
    assert.ok(rollbackIdx > -1, "rollback discovery runs in the publish job");
    const rollbackRun = runs[rollbackIdx] ?? "";
    assert.match(rollbackRun, /GITHUB_STEP_SUMMARY/, "the pointer is written to the run summary at discovery time");
    // The release job (which performs the first mutation) DEPENDS on publish.
    assert.equal(release.needs?.includes("publish"), true, "release creation is unreachable until the rollback pointer has been recorded (needs chain)");
    assert.equal(publish.outputs?.["previous_latest_tag"], "${{ steps.rollback.outputs.previous_latest_tag }}", "the pointer crosses the job boundary as a job output");
  });
});

// ─── Review Task 5 — same-release verification, no cross-release mixtures ──

describe("publish-console-snapshot workflow — same-release verification (review Task 5)", () => {
  const wf = loadWorkflow();
  const publish = wf.jobs["publish"]!;
  const release = wf.jobs["release"]!;
  const verifyVersioned = wf.jobs["verify-versioned"]!;
  const promote = wf.jobs["promote"]!;
  const verifyStable = wf.jobs["verify-stable"]!;

  test("roundtrip verification is tag-scoped (--scope versioned) — all three assets from ONE exact release", () => {
    const runs = runBlocks(verifyVersioned).join("\n");
    assert.match(runs, /verify-release-assets[\s\S]*--scope versioned/, "versioned verification uses the same-release CLI gate");
  });

  test("post-activation verification requires BOTH the designation match AND the stable-URL artifact check", () => {
    const runs = runBlocks(verifyStable).join("\n");
    assert.match(runs, /verify-release-assets[\s\S]*--scope latest/, "the stable gate checks the latest designation");
    const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
    assert.ok(!raw.includes("latest/download/console-snapshot.json\""), "raw curl of separate latest URLs is no longer the verification mechanism");
    assert.ok(!/curl[\s\S]*stable-check/.test(raw), "the three-separate-curl stable check is replaced by the same-release gate");
  });

  test("verification and promotion run in the required order ACROSS JOBS", () => {
    const relRuns = runBlocks(release);
    const uploadIdx = relRuns.findIndex((r) => r.includes("gh release upload"));
    assert.ok(uploadIdx > -1, "the release job uploads the assets");
    // The roundtrip verification is a SEPARATE job that needs `release`,
    // and promotion is a job that needs the roundtrip verification.
    assert.equal(verifyVersioned.needs?.includes("release"), true, "same-release verification follows upload (job boundary)");
    assert.equal(promote.needs?.includes("verify-versioned"), true, "promotion follows verification (job boundary)");
    assert.equal(verifyStable.needs?.includes("promote"), true, "post-activation verification follows promotion (job boundary)");
    // The promotion job contains exactly ONE gh command — the metadata flip.
    const promoteRuns = runBlocks(promote);
    const ghSteps = promoteRuns.filter((r) => /gh release /.test(r));
    assert.equal(ghSteps.length, 1, "the promotion job performs exactly one GitHub release operation");
    assert.match(ghSteps[0] ?? "", /gh release edit "\$TAG" --repo "\$REPO" --latest/);
  });

  test("the activated tag crosses every job boundary through validated outputs and is re-checked for shape", () => {
    assert.equal(publish.outputs?.["versioned_tag"], "${{ steps.facts.outputs.tag }}", "publish exposes the strictly-validated tag as a job output");
    for (const [name, job, from] of [
      ["release", release, "${{ needs.publish.outputs.versioned_tag }}"],
      ["verify-versioned", verifyVersioned, "${{ needs.release.outputs.versioned_tag }}"],
      ["promote", promote, "${{ needs.verify-versioned.outputs.versioned_tag }}"],
    ] as const) {
      assert.equal(job.outputs?.["versioned_tag"], from, `${name} passes the tag through its job output`);
      const shapeStep = job.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("strict versioned-tag shape") || (s["run"] as string).includes("fails the strict versioned-tag shape")));
      assert.ok(shapeStep, `${name} re-validates the tag shape before use`);
    }
    const stableGateStep = verifyStable.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("--scope latest")));
    assert.ok(stableGateStep, "the stable gate step exists");
    assert.equal(
      ((stableGateStep!["env"] ?? {}) as Record<string, unknown>)["TAG"],
      "${{ needs.publish.outputs.versioned_tag }}",
      "verify-stable consumes the activated tag from the publish output (via the step's env mapping)",
    );
    const runs = runBlocks(verifyStable).join("\n");
    assert.match(runs, /activated tag fails the strict versioned-tag shape/, "verify-stable re-validates the tag shape before use");
  });
});

// ─── Review Task 6 — the rehearsal workflow is inert outside its target ─────

describe("rehearsal-publication workflow — hard non-production guard", () => {
  function loadRehearsal(): Workflow {
    const raw = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
    const json = execFileSync(
      "python3",
      ["-c", "import sys,yaml,json;d=yaml.safe_load(sys.stdin.read());\nif True in d: d['on']=d.pop(True)\nprint(json.dumps(d))"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, input: raw },
    );
    return JSON.parse(json) as Workflow;
  }

  const rehearsal = loadRehearsal();
  const job = rehearsal.jobs["rehearse"]!;

  test("the rehearsal workflow exists with a dispatch-only trigger", () => {
    assert.deepEqual(Object.keys(rehearsal.on), ["workflow_dispatch"]);
    assert.ok(job, "the rehearse job exists");
  });

  test("the FIRST step refuses to run anywhere except the designated rehearsal repository", () => {
    const firstRun = job.steps[0]!["run"] as string;
    assert.ok(firstRun.includes("grave-indexer-pub-rehearsal"), "the guard names the exact non-production target");
    assert.ok(firstRun.includes("REFUSING TO RUN"), "it refuses loudly outside the target");
    assert.match(firstRun, /exit 1/, "the guard aborts before any release operation");
    // The guard IS the first step — nothing can run before it.
    assert.equal(job.steps[0]?.["name"], "HARD GUARD — this rehearsal may run ONLY in the designated non-production repository");
  });

  test("the rehearsal never targets the production repository in any command", () => {
    const raw = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
    assert.ok(!raw.includes("GraveYield/grave-indexer/releases"), "no production release path is referenced");
    assert.ok(!raw.includes("--repo GraveYield/grave-indexer "), "no command pins the production repo");
    assert.match(raw, /grave-indexer-pub-rehearsal/, "all operations use REPO (the guarded rehearsal repository)");
  });

  test("rehearsal actions are pinned to full commit SHAs like production", () => {
    for (const step of job.steps) {
      if (typeof step["uses"] === "string") {
        const ref = (step["uses"] as string).split("@")[1] ?? "";
        assert.match(ref, /^[0-9a-f]{40}/, `${step["uses"]} must be pinned`);
      }
    }
  });
});
