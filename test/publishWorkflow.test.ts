// SPDX-License-Identifier: Apache-2.0
//
// publish-console-snapshot.yml — workflow-level validation (GY-M1-INT-001
// correction §5; PR #5 remediation — review Tasks 1-5, Task 1 corrected
// FOUR times; final credential isolation via the dedicated
// `GY_RELEASE_PAT` secret). YAML parsing alone proves nothing about
// behavior, so these tests pin the SECURITY-CRITICAL structure of the
// real workflow file: trigger restrictions, least-privilege permissions,
// job separation (read-only preparation/verification vs privileged jobs
// that contain ZERO custom code), artifact integrity handling, release
// behavior (latest promotion, no clobber), concurrency, and explicit
// failure paths. The behavioral sequence itself is exercised end-to-end by
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
//     for EVERY step of that job (which is exactly why NO job in this
//     workflow declares `contents: write` anymore — the release
//     mutations use the dedicated `GY_RELEASE_PAT` secret instead);
//   - actions/download-artifact authenticates with the artifact-scoped
//     ACTIONS_RUNTIME_TOKEN and takes no github.token input;
//   - `run:` steps receive secrets only through explicitly declared env.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const rollback = wf.jobs["rollback"];
  const allJobs: Array<[string, Workflow["jobs"][string] | undefined]> = [
    ["generate", generate],
    ["verify", verify],
    ["publish", publish],
    ["release", release],
    ["verify-versioned", verifyVersioned],
    ["promote", promote],
    ["verify-stable", verifyStable],
    ["rollback", rollback],
  ];
  assert.ok(allJobs.every(([, j]) => j), "all eight jobs exist");
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

  test("top-level permissions are read-only; EVERY job declares contents:read explicitly (no write-permission job exists)", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    // Fourth-round correction: ALL EIGHT jobs declare contents:read
    // EXPLICITLY — the automatic GITHUB_TOKEN is read-only everywhere by
    // declaration, never by inheritance from org defaults alone.
    for (const [name, job] of allJobs) {
      assert.deepEqual(job!.permissions, { contents: "read" }, `${name} must declare contents:read explicitly`);
    }
    // dependency chain: the privileged mutation jobs are gated behind read-only preparation
    assert.ok(release!.needs?.includes("publish"), "release depends on the read-only publish gates");
    assert.ok(verifyVersioned!.needs?.includes("release"), "the roundtrip gate runs after upload");
    assert.ok(promote!.needs?.includes("verify-versioned"), "promotion is UNREACHABLE until same-release verification passed");
    assert.ok(verifyStable!.needs?.includes("promote") && verifyStable!.needs?.includes("publish"), "the post-activation gate runs after promotion");
    assert.ok(publish!.needs?.includes("generate") && publish!.needs?.includes("verify"), "publish depends on BOTH read-only preparation jobs");
    assert.ok(verify!.needs?.includes("generate"), "verify depends on generate");
    // EIGHTH-ROUND CORRECTION (Finding 1): the dedicated downstream rollback
    // job is wired into the graph — it needs the promotion outputs AND the
    // downstream verification result.
    assert.ok(rollback!.needs?.includes("promote") && rollback!.needs?.includes("verify-stable") && rollback!.needs?.includes("publish"), "the rollback job needs the promotion outputs and the downstream verification result");
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
    // downloaded bytes inside verifyReleaseAssetSet / verifyStableReference
    // (verifyChecksumFile), exercised by test/releaseOps.test.ts; here we
    // pin that the workflow invokes them at both gates.
    assert.match(runBlocks(verifyVersioned!).join("\n"), /--scope versioned/, "same-release roundtrip gate (read-only job, between upload and promotion)");
    const stableRuns = runBlocks(verifyStable!).join("\n");
    assert.match(stableRuns, /verify-stable[\s\\]+\"\$REPO\" --expected-tag/, "post-activation stable-reference identity gate (read-only job)");
  });

  test("duplicate versioned tags abort before creation (authenticated three-way gates); releases are created explicitly NOT latest", () => {
    const relRuns = runBlocks(release!).join("\n");
    assert.match(relRuns, /git\/ref\/tags\/\$TAG/, "duplicate-tag gate runs in the privileged job, immediately before the mutation (authenticated API probe — a private repo is unresolvable unauthenticated)");
    assert.match(relRuns, /--latest=false/, "versioned releases never become latest on creation");
    assert.ok(!relRuns.includes("--clobber"), "no asset clobbering anywhere");
    const pubRuns = runBlocks(publish!).join("\n");
    assert.match(pubRuns, /git\/ref\/tags\/\$TAG/, "the duplicate-tag gate ALSO runs in the read-only publish job (early fail-closed)");
    // The unauthenticated ls-remote probe is gone (it cannot resolve a private repo).
    assert.ok(!relRuns.includes("git ls-remote"), "no unauthenticated tag probe remains in the privileged job");
    assert.ok(!pubRuns.includes("git ls-remote"), "no unauthenticated tag probe remains in the read-only gate job");
  });

  test("the stable reference is activated only AFTER same-release verification, then re-verified through the stable gate", () => {
    // Cross-job ordering: release → verify-versioned → promote.
    assert.equal(promote!.needs?.includes("verify-versioned"), true, "promotion is gated on the same-release verification JOB");
    const promoteRuns = runBlocks(promote!).join("\n");
    assert.match(promoteRuns, /git\/tags[\s\S]*--jq '\.sha'/, "the stable pointer is a NEW immutable annotated tag object (created via gh api)");
    assert.match(promoteRuns, /git\/refs/, "the ref is moved with the atomic ref update (gh api)");
    assert.match(promoteRuns, /console-snapshot-prod/, "the dedicated stable ref name is pinned");
    const releaseRuns = runBlocks(release!).join("\n");
    assert.match(releaseRuns, /--latest=false/, "the release job creates the release explicitly NOT latest");
    assert.ok(!/--latest(?!=false)/.test(releaseRuns), "the release job must NOT set the latest designation (only --latest=false)");
    const stableRuns = runBlocks(verifyStable!).join("\n");
    assert.match(stableRuns, /--expected-tag "\$TAG"/, "the stable gate cross-checks the activated tag");
    assert.match(stableRuns, /verify-stable/, "the stable gate runs the stable-reference identity CLI");
  });

  test("the workflow records the previous stable pointer as a rollback reference (read-only discovery)", () => {
    const runs = runBlocks(publish!).join("\n");
    assert.match(runs, /stable-pointer-current/, "the dedicated stable reference is read through the hardened gate before activation");
    assert.match(runs, /previous_versioned_tag/, "the rollback reference is captured as a job output");
    assert.match(runs, /rollback/, "the rollback reference is surfaced in the summary");
    const summaryStep = verifyStable!.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("ConsoleSnapshot publication")));
    assert.ok(summaryStep, "the final publication summary exists in the read-only verify-stable job");
    assert.equal(
      stepEnv(summaryStep!)["PREV"],
      "${{ needs.publish.outputs.previous_versioned_tag }}",
      "the rollback reference reaches the final publication summary through the validated job output",
    );
  });

  test("no secret material is echoed; authenticated URLs never reach provenance or step summaries", () => {
    const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
    // Inspect each GITHUB_STEP_SUMMARY heredoc BLOCK (the `{ ... } >> ...`
    // lines) — not the raw text after the redirect, which legitimately
    // contains later steps (e.g. the PAT env of the mutation steps).
    const lines = raw.split("\n");
    // A run-summary block is `{ ... } >> "$GITHUB_STEP_SUMMARY"`: it opens
    // with a bare `{` line and closes at the first redirect line.
    let blockStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (blockStart === -1 && trimmed === "{") blockStart = i;
      if (lines[i]!.includes('>> "$GITHUB_STEP_SUMMARY"')) {
        assert.ok(blockStart >= 0, `summary redirect at line ${i + 1} opens a { } block`);
        for (let k = blockStart; k <= i; k++) {
          if (lines[k]!.includes("${{ secrets.")) {
            assert.fail(`a run-summary block interpolates a secret: ${lines[k]!.trim()}`);
          }
        }
        blockStart = -1;
      }
    }
    // Belt-and-suspenders: no `echo`/`cat` line anywhere writes a secret
    // reference into the summary.
    const echoLines = lines.filter((l) => /(^|\s)(echo|cat)\s/.test(l));
    assert.ok(!echoLines.some((l) => l.includes("${{ secrets.")), "no echo/cat line outputs a secret reference");
    const allRuns = jobs.map((j) => runBlocks(j).join("\n")).join("\n");
    assert.ok(!allRuns.includes("MAINNET_RPC_URL") || !allRuns.includes("echo $DISCOVERY_RPC_URL"), "RPC secrets are consumed, never echoed");
    // No authenticated URL (token in URL, userinfo in URL) is written anywhere.
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
  const rollback = wf.jobs["rollback"]!;
  const allJobs = [generate, verify, publish, release, verifyVersioned, promote, verifyStable, rollback];
  // Fourth-round correction: EVERY job's automatic token is read-only.
  // "privileged" now refers to the three jobs that carry the dedicated
  // GY_RELEASE_PAT release credential (on mutation steps only).
  const privilegedJobs: Array<[string, typeof generate]> = [
    ["release", release],
    ["promote", promote],
    ["rollback", rollback],
  ];
  const namedJobs: Array<[string, typeof generate]> = [
    ["generate", generate],
    ["verify", verify],
    ["publish", publish],
    ["release", release],
    ["verify-versioned", verifyVersioned],
    ["promote", promote],
    ["verify-stable", verifyStable],
    ["rollback", rollback],
  ];
  const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");

  function effectivePermissions(job: typeof generate): Record<string, string> {
    return job.permissions ?? { contents: "read" };
  }

  test("job-level gating: the seven unconditional jobs require refs/heads/main; the downstream rollback job requires main AND promotion success AND a failed downstream verification", () => {
    for (const job of allJobs) {
      if (job === rollback) continue; // the rollback job carries a compound failure-path gate, pinned below
      assert.equal(
        job["if"],
        "github.ref == 'refs/heads/main'",
        "a dispatch against any other ref must skip the job entirely (release-writing steps unreachable)",
      );
    }
    // EIGHTH-ROUND CORRECTION (Finding 1): the rollback job's dependency-
    // graph gate. It runs ONLY when promotion COMPLETED (activation was
    // attempted and the ref was moved) and the DOWNSTREAM verify-stable
    // job FAILED after it — never for a promotion failure (promote's own
    // in-job rollback handles that) and never when promotion never
    // started (that would violate the activation_started safety concept).
    assert.match(
      rollback["if"] ?? "",
      /failure\(\) &&\s*needs\.promote\.result == 'success' &&\s*needs\.verify-stable\.result == 'failure' &&\s*github\.ref == 'refs\/heads\/main'/,
      "the rollback job runs ONLY after a successful promotion followed by a failed downstream verification",
    );
  });

  test("ALL EIGHT jobs carry an explicit in-step ref guard that rejects anything but refs/heads/main", () => {
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
    // Only these jobs check out the repository; publish and
    // verify-versioned deliberately have NO checkout, and the privileged
    // jobs must never check out code (pinned by a dedicated test below).
    const checkoutJobs: Array<[string, typeof generate]> = [
      ["generate", generate],
      ["verify", verify],
      ["verify-stable", verifyStable],
    ];
    for (const [name, job] of checkoutJobs) {
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
  // or not an explicit GH_TOKEN env is attached. ──
  // ── FOURTH-ROUND CORRECTION: the owner provisioned the fine-grained
  // `GY_RELEASE_PAT` secret. NO job grants `contents: write` anymore —
  // the automatic GITHUB_TOKEN is read-only in all seven jobs, and the
  // ONLY write-capable credential is the PAT on the two trusted mutation
  // steps. These tests pin BOTH boundaries. ─────────────────────────

  test("the publish job is EXPLICITLY READ-ONLY: repository-built code runs there, so contents:write must not exist in it", () => {
    assert.deepEqual(publish.permissions, { contents: "read" }, "publish declares contents:read explicitly — the review's finding was a write-capable token reaching custom code in this job");
    const runs = runBlocks(publish).join("\n");
    // The custom operations live here — under a read-only grant.
    assert.match(runs, /node ops\/release-ops\.mjs stable-pointer-current/, "rollback discovery (custom code) runs in the read-only job");
    assert.match(runs, /node -e "console\.log\(JSON\.parse/, "provenance parsing runs in the read-only job");
    // And nothing in this job can mutate releases. (The rollback summary
    // MENTIONS the rollback command in its documentation text, so only
    // actual command lines count — line-anchored.)
    assert.ok(!/^\s*gh release (create|upload|edit|delete) /m.test(runs), "the read-only publish job performs NO release-mutating operation");
  });

  test("custom `stable-pointer-current` execution receives a READ-ONLY credential, never a write-capable one", () => {
    // Find the step that actually executes the custom bundle for rollback
    // discovery and inspect ITS job's effective permissions.
    const step = publish.steps.find((s) => typeof s["run"] === "string" && (s["run"] as string).includes("stable-pointer-current"));
    assert.ok(step, "the rollback-discovery step exists");
    const perms = effectivePermissions(publish);
    assert.equal(perms["contents"], "read", "the job running custom discovery code grants only contents:read — github.token is read-only for EVERY step of it");
    const env = stepEnv(step!);
    assert.equal(env["GH_TOKEN"], "${{ github.token }}", "discovery authenticates with the workflow token, which is READ-ONLY because of the job grant");
    // Belt-and-suspenders: no OTHER job that runs stable-pointer-current exists with write permission.
    for (const [name, job] of privilegedJobs) {
      const runs = runBlocks(job).join("\n");
      assert.ok(!runs.includes("stable-pointer-current"), `${name} (write-permission job) must not execute the custom stable-pointer discovery code`);
    }
  });

  test("PRIVILEGED JOBS CONTAIN ZERO CUSTOM CODE IN CREDENTIAL-BEARING STEPS: no node, no repository script, no pnpm/npm, no build, no compilation where any token exists", () => {
    // SIXTEENTH-ROUND REFINEMENT (P1): the credential is STEP-level, so
    // the exact invariant is per-step: a step that carries ANY token
    // (the PAT step env or the automatic-token read gates) executes
    // zero custom code; repository-built code may run ONLY in steps
    // whose env carries no token at all. promote and rollback remain
    // fully code-free jobs.
    for (const [name, job] of privilegedJobs) {
      if (name !== "release") {
        const runs = runBlocks(job).join("\n");
        for (const banned of ["node ", "pnpm ", "npm ", "npx ", "src/cli.ts", ".mjs", "tsc ", "build:sdk", "tsx"]) {
          assert.ok(!runs.includes(banned), `${name} (the PAT-privileged job) must not contain '${banned}' — no custom or repository-built code may execute in the job that carries the release-write credential`);
        }
      }
      for (const step of job.steps) {
        const env = stepEnv(step);
        const run = (step["run"] as string) ?? "";
        const carriesAnyToken = "GH_TOKEN" in env || "GITHUB_TOKEN" in env || "GY_RELEASE_PAT" in env;
        if (carriesAnyToken) {
          for (const banned of ["node ", "pnpm ", "npm ", "npx ", "src/cli.ts", ".mjs", "tsc ", "build:sdk", "tsx"]) {
            assert.ok(!run.includes(banned), `${name}: a token-bearing step must not execute '${banned}' — repository-built code NEVER coexists with a credential`);
          }
        }
      }
      assert.ok(!job.steps.some((s) => (s["uses"] as string | undefined)?.startsWith("actions/checkout")), `${name} NEVER checks out the repository`);
      assert.ok(!job.steps.some((s) => (s["uses"] as string | undefined)?.startsWith("actions/setup-node")), `${name} NEVER runs setup-node (its token input defaults to github.token)`);
      const usesSteps = job.steps.filter((s) => typeof s["uses"] === "string").map((s) => s["uses"] as string);
      for (const uses of usesSteps) {
        assert.match(uses, /^actions\/download-artifact@/, `${name}'s only allowed action is download-artifact (found: ${uses})`);
      }
    }
    // The release job's ONLY node invocation is the credential-free full
    // verification of the exact draft bytes (sixteenth round, P1).
    const release = wf.jobs["release"]!;
    const nodeSteps = release.steps.filter((s) => typeof s["run"] === "string" && /\bnode\b/.test(s["run"] as string));
    assert.equal(nodeSteps.length, 1, "the release job runs repository-built code in EXACTLY ONE step");
    const nodeRun = (nodeSteps[0]!["run"] as string) ?? "";
    assert.match(nodeRun, /verify-local-release-assets/, "the single node step is the full draft verification");
    assert.ok(!("GH_TOKEN" in stepEnv(nodeSteps[0]!)) && !("GY_RELEASE_PAT" in stepEnv(nodeSteps[0]!)), "that node step carries NO credential of any kind");
  });

  test("GLOBAL INVARIANT: NO job grants contents:write — the automatic GITHUB_TOKEN is read-only in every job", () => {
    // GitHub exposes github.token to EVERY step of a job whose grant is
    // write. The workflow therefore never declares a write grant: the
    // release mutations authenticate with the dedicated GY_RELEASE_PAT
    // secret instead.
    for (const job of allJobs) {
      const perms = effectivePermissions(job);
      for (const [scope, level] of Object.entries(perms)) {
        assert.notEqual(level, "write", `${job.name ?? "(unnamed)"}: ${scope}:write would make github.token write-capable for EVERY step of the job`);
      }
    }
    // And the raw file contains no write grant at all (catches any scope
    // not modeled above, e.g. newly added permission keys; comments are
    // stripped first — they document history, they do not configure).
    const uncommented = raw.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    assert.ok(!uncommented.includes("contents: write"), "the literal 'contents: write' must not appear anywhere outside comments in the workflow");
  });

  test("GLOBAL INVARIANT: every step that invokes node or executes a bundle lives in a job WITHOUT any write grant", () => {
    // Walk every job; any run block that executes node/npm/pnpm/a bundle
    // must belong to a job whose effective github.token is read-only.
    for (const job of allJobs) {
      const writeCapable = effectivePermissions(job)["contents"] === "write";
      assert.equal(writeCapable, false, "no job is write-capable (fourth-round invariant)");
      for (const run of runBlocks(job)) {
        const executesCode = /\bnode\b|\bpnpm\b|\bnpm\b|\bnpx\b|\.mjs|src\/cli\.ts/.test(run);
        if (executesCode && writeCapable) {
          assert.fail(`a write-permission job executes custom/repository code: ${run.slice(0, 120)}`);
        }
      }
    }
  });

  test("only the EXPLICIT mutation steps receive GY_RELEASE_PAT; the only other token-bearing steps carry the READ-ONLY automatic token", () => {
    // SIXTH ROUND: the mutation set is the versioned release (create +
    // upload) PLUS the dedicated-ref activation (create the annotated
    // pointer tag object + move the ref) PLUS the failure-path rollback
    // (re-create the previous pointer object + re-point the ref, or
    // delete the ref on first publication).
    const expectedMutations: Array<[string, RegExp]> = [
      ["release", /gh release create "\$TAG"/],
      // TWELFTH ROUND (draft-first): the draft upload addresses the release
      // BY ID through the uploads.github.com asset endpoint (the by-tag
      // endpoint serves published releases only — drafts are unaddressable
      // by tag), and the publish step PATCHes draft=false +
      // make_latest=false. Both are PAT-bearing release-mutation steps and
      // are pinned here.
      ["release", /uploads\.github\.com[\s\S]*draft release created and uploaded/s],
      // SIXTEENTH ROUND (P1): the draft-byte retrieval step is the one
      // PAT-bearing NON-mutation operation — a draft is only readable
      // with push access, so the exact uploaded bytes must be fetched
      // with the PAT (pinned gh api + jq + shell only, zero custom
      // code). The FULL verification over those bytes runs in the
      // SEPARATE credential-free step (pinned in the sixteenth-round
      // suite below), so the PAT never coexists with node.
      ["release", /refusing to retrieve a foreign release[\s\S]*the exact draft bytes are retrieved/s],
      ["release", /PATCH "repos\/\$REPO\/releases\/\$DRAFT_RELEASE_ID"[\s\S]*draft assets verified and release published/s],
      // THIRTEENTH ROUND (draft-first residue bound): the failure-path
      // draft-cleanup step deletes ONLY this run's verified un-published
      // draft — a by-ID DELETE, authorized by a read-back that proves
      // draft==true AND this run's exact tag; published and foreign
      // releases are never deleted.
      ["release", /--method DELETE "repos\/\$REPO\/releases\/\$DRAFT_RELEASE_ID"[\s\S]*the un-published draft \$DRAFT_RELEASE_ID \(tag \$TAG\) was deleted/s],
      // SEVENTH ROUND: the activation's ref update is the repository-qualified
      // PATCH; the pattern is anchored on the activation's own completion
      // echo so it cannot also match the rollback step (which now contains
      // the same repo-qualified endpoint for its own PATCH).
      ["promote", /git\/tags[\s\S]*stable ref activation issued/s],
      ["promote", /git\/tags[\s\S]*rollback mutation issued/s],
      // EIGHTH ROUND (Finding 1): the dedicated downstream rollback job's
      // single mutation step — restore the previous pointer (POST /git/tags
      // + PATCH refs) or delete the first-publication ref (DELETE refs).
      ["rollback", /git\/tags[\s\S]*rollback mutation issued/s],
    ];
    // The ONLY authenticated non-mutation steps allowed in the privileged
    // jobs are the three-way READ gates (automatic token): the versioned
    // tag-collision gate and the dedicated stable-ref gate.
    const readOnlyGate = /git\/ref\/tags\/(\$TAG|console-snapshot-prod)/;
    const mutationsFound: string[] = [];
    for (const [name, job] of privilegedJobs) {
      for (const step of job.steps) {
        const run = (step["run"] as string) ?? "";
        if (stepEnv(step)["GH_TOKEN"] === "${{ secrets.GY_RELEASE_PAT }}") {
          // A PAT-bearing step MUST be one of the pinned mutations.
          const matched = expectedMutations.filter(([jn, re]) => jn === name && re.test(run));
          assert.ok(matched.length > 0, `a GY_RELEASE_PAT-bearing step in ${name} is not a recognized mutation: ${run.slice(0, 120)}`);
          assert.ok(!run.includes("node ") && !run.includes(".mjs"), "PAT-bearing steps execute only the pinned gh CLI, never custom code");
          // The rollback mutation step re-reads nothing with the PAT —
          // its outcome is proven by the separate read-only read-back step
          // (ninth-round Finding 1); every other PAT step must not query.
          const isRollback = run.includes("rollback mutation issued");
          if (!isRollback) {
            assert.ok(!/git\/ref\/tags/.test(run), "a PAT-bearing step must not double as a query gate");
          } else {
            assert.ok(run.includes("rollback"), "the exempted PAT step is the verified rollback mutation");
          }
          mutationsFound.push(...matched.map(() => name));
        } else if (stepEnv(step)["GH_TOKEN"] === "${{ github.token }}") {
          // A github.token-bearing step in a privileged job must be a
          // read-only gate — never a mutation.
          assert.ok(readOnlyGate.test(run) || run.includes("READ-BACK"), `a github.token step in ${name} must be an authenticated read-only gate: ${run.slice(0, 120)}`);
          assert.ok(!/^\s*gh release (create|upload|edit|delete) /m.test(run), `the read-only gate in ${name} must not mutate releases`);
          assert.ok(!/git\/(refs|tags)\"/.test(run) || run.includes("READ-BACK") || readOnlyGate.test(run), "a github.token step must not mutate the git data (read-only gates and read-back only)");
        } else if (hasTokenEnv(step)) {
          assert.fail(`a token env with an unexpected value exists in ${name}: ${JSON.stringify(stepEnv(step))}`);
        } else {
          // Token-free steps must not invoke the release API or make
          // authenticated calls, and must not interpolate github.token.
          assert.ok(!/^\s*gh release (create|upload|edit|delete) /m.test(run), `token-free step in ${name} must not call the GitHub release API`);
          assert.ok(!run.includes("Authorization: Bearer"), "token-free steps never make authenticated API calls");
          assert.ok(!run.includes("${{ github.token }}"), "token-free steps never reference the token context directly");
        }
      }
      assert.ok(!("GH_TOKEN" in (job.env ?? {})) && !("GITHUB_TOKEN" in (job.env ?? {})), `${name} must not declare GH_TOKEN/GITHUB_TOKEN at JOB level (it would leak to every step)`);
      assert.ok(!("GY_RELEASE_PAT" in (job.env ?? {})), `${name} must not declare GY_RELEASE_PAT at JOB level (it would leak to every step)`);
    }
    assert.deepEqual(mutationsFound.sort(), ["promote", "promote", "release", "release", "release", "release", "release", "rollback"], "exactly EIGHT privileged PAT-bearing STEP matches (SEVEN steps; the release create+upload step matches twice): release draft-create+upload, release draft-byte retrieval, release publish, release failure-path draft-cleanup, stable-ref activation, promote-job rollback, downstream rollback-job mutation");
  });

  test("no workflow-level or job-level env exposes the release credential anywhere", () => {
    assert.equal(wf.env, undefined, "no workflow-level env block exists (a token declared there would leak to every step of every job)");
    for (const job of allJobs) {
      assert.ok(!("GH_TOKEN" in (job.env ?? {})), `job ${job.name ?? "(unnamed)"} must not declare GH_TOKEN at job level`);
      assert.ok(!("GITHUB_TOKEN" in (job.env ?? {})), `job ${job.name ?? "(unnamed)"} must not declare GITHUB_TOKEN at job level`);
      assert.ok(!("GY_RELEASE_PAT" in (job.env ?? {})), `job ${job.name ?? "(unnamed)"} must not declare GY_RELEASE_PAT at job level`);
    }
    // A token may only appear inside step-level env values, and only with
    // one of the two sanctioned credential sources: the READ-ONLY
    // automatic workflow token (query steps) or the dedicated PAT (the
    // two release-mutation steps).
    const tokenSteps = allJobs.flatMap((j) => j.steps.filter((s) => typeof s["env"] === "object" && s["env"] !== null && "GH_TOKEN" in ((s["env"] ?? {}) as Record<string, unknown>)));
    let patStepCount = 0;
    let automaticTokenStepCount = 0;
    for (const step of tokenSteps) {
      const value = stepEnv(step)["GH_TOKEN"];
      const run = (step["run"] as string) ?? "";
      if (value === "${{ secrets.GY_RELEASE_PAT }}") {
        // SIXTEENTH ROUND: the pinned PAT-bearing step set covers the release
        // mutations (gh release create, the uploads.github.com draft upload,
        // the draft-byte retrieval, the PATCH publish) and the git-data mutations.
        assert.ok(
          /gh release (create|upload|edit)|uploads\.github\.com|releases\/\$DRAFT_RELEASE_ID|git\/(tags|refs)/.test(run),
          `a GY_RELEASE_PAT step must be a pinned mutation (found: ${run.slice(0, 80)})`,
        );
        patStepCount += 1;
      } else if (value === "${{ github.token }}") {
        assert.ok(!/^\s*gh release (create|upload|edit|delete) /m.test(run), `the automatic token must never drive a release mutation (found: ${run.slice(0, 80)})`);
        automaticTokenStepCount += 1;
      } else {
        assert.fail(`GH_TOKEN env references an unsanctioned credential source: ${String(value)}`);
      }
    }
    assert.equal(patStepCount, 7, "exactly SEVEN steps carry the release-write PAT (release draft-create+upload, release draft-byte retrieval, release publish, release failure-path draft-cleanup, stable-ref activation, promote-job rollback, downstream rollback-job mutation)");
    assert.ok(automaticTokenStepCount >= 4, "every authenticated query step uses the READ-ONLY automatic token");
  });

  test("artifact download and integrity/verification steps never carry a release-write credential", () => {
    for (const job of allJobs) {
      for (const step of job.steps) {
        const uses = (step["uses"] as string | undefined) ?? "";
        if (uses.startsWith("actions/download-artifact") || uses.startsWith("actions/upload-artifact")) {
          assert.ok(!hasTokenEnv(step), `${uses} in ${job.name ?? "(unnamed)"} must not receive a GitHub token (it authenticates with the artifact-scoped runtime token)`);
        }
        const run = (step["run"] as string) ?? "";
        const isVerification = run.includes("sha256sum -c") || run.includes("--scope versioned") || run.includes("verify-stable") || run.includes("verify-snapshot") || run.includes("stable-pointer-build") || run.includes("verify-local-release-assets");
        // SIXTEENTH ROUND: the release job's draft-byte steps are the
        // sanctioned pair — the PAT-bearing RETRIEVAL step (the draft is
        // only readable with push access; pinned gh api + jq + shell,
        // zero custom code) and the credential-free FULL verification
        // step (node over the exact downloaded bytes). Every OTHER
        // verification step stays PAT-free.
        const isDraftByteRetrieval = isVerification && run.includes("releases/$DRAFT_RELEASE_ID/assets") && run.includes("sha256sum -c");
        if (isDraftByteRetrieval) {
          assert.ok(stepEnv(step)["GH_TOKEN"] === "${{ secrets.GY_RELEASE_PAT }}", "the draft-byte retrieval step is the release job's PAT step (a draft is only readable with push access)");
          assert.ok(!/\bnode\b|\.mjs|pnpm|npm|checkout|tsx/.test(run), "the PAT-bearing retrieval step executes ZERO custom code (pinned gh api + jq + shell only)");
          assert.ok(run.indexOf("sha256sum -c") < run.indexOf("the exact draft bytes are retrieved"), "the checksum belt runs over the downloaded bytes BEFORE the retrieval completes");
          continue;
        }
        const isDraftLocalVerify = run.includes("verify-local-release-assets");
        if (isDraftLocalVerify) {
          assert.ok(!("GH_TOKEN" in stepEnv(step)) && !("GY_RELEASE_PAT" in stepEnv(step)), "the FULL draft verification step carries NO credential of any kind");
          assert.ok(/\bnode\b.*release-ops\.mjs verify-local-release-assets/.test(run), "the full draft verification runs the prebuilt release-ops bundle");
          continue;
        }
        if (isVerification) {
          // No job is write-capable anymore; the check pins that custom
          // verification code never runs where a write grant exists AND
          // that verification steps never receive the release-write PAT.
          assert.ok(stepEnv(step)["GH_TOKEN"] !== "${{ secrets.GY_RELEASE_PAT }}", "verification steps never carry the release-write PAT");
        }
      }
    }
    // The same-release roundtrip gate authenticates with the READ-ONLY
    // automatic token (the repository is private — unauthenticated asset
    // requests 404); it must NEVER receive the PAT.
    assert.deepEqual(verifyVersioned.permissions, { contents: "read" }, "verify-versioned declares the read-only grant explicitly");
    const roundtrip = verifyVersioned.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("--scope versioned")));
    assert.ok(roundtrip, "the roundtrip gate step exists");
    assert.equal(stepEnv(roundtrip!)["GH_TOKEN"], "${{ github.token }}", "the roundtrip gate authenticates with the READ-ONLY workflow token, never the PAT");
  });

  test("read-only rollback discovery remains possible AND the post-activation gate stays read-only", () => {
    const step = publish.steps.find((s) => typeof s["run"] === "string" && (s["run"] as string).includes("stable-pointer-current"));
    assert.ok(step, "rollback discovery exists in the read-only publish job");
    assert.equal(publish.permissions?.["contents"], "read", "discovery runs under a read-only grant");
    assert.equal(stepEnv(step!)["GH_TOKEN"], "${{ github.token }}", "discovery uses the READ-ONLY workflow token, never the PAT");
    // Post-activation gate: read-only token, no mutation.
    assert.deepEqual(verifyStable.permissions, { contents: "read" }, "verify-stable declares the read-only grant explicitly");
    const gate = verifyStable.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("verify-stable")));
    assert.ok(gate, "the stable gate step exists");
    assert.equal(stepEnv(gate!)["GH_TOKEN"], "${{ github.token }}", "the stable gate authenticates with the READ-ONLY workflow token");
    assert.ok(!runBlocks(verifyStable).join("\n").includes("gh release"), "the stable gate performs NO release-mutating operations");
    assert.ok(!/^\s*(gh api --method (POST|PATCH|DELETE)|gh api -X (POST|PATCH|DELETE))/m.test(runBlocks(verifyStable).join("\n")), "the stable gate performs NO git-data-mutating operations (mentions in documentation text are not commands)");
  });

  test("permissions stay least-privilege: eight read-only jobs, no write-permission job anywhere", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    for (const [name, job] of namedJobs) {
      assert.deepEqual(job.permissions, { contents: "read" }, `${name} must declare contents:read explicitly`);
      assert.ok(Object.keys(job.permissions ?? {}).every((k) => k === "contents"), `${name} grants ONLY contents (nothing else is elevated)`);
    }
  });
});

// ─── Fourth-round correction — GY_RELEASE_PAT credential isolation ─────────

describe("publish-console-snapshot workflow — GY_RELEASE_PAT isolation (final credential isolation)", () => {
  const wf = loadWorkflow();
  const allJobs = Object.entries(wf.jobs);
  const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");

  test("the PAT appears ONLY inside the step-level env of the seven draft-first mutation/retrieval steps", () => {
    // Every literal occurrence of the secret reference in the file must be
    // either a comment mention or one of the sanctioned step env values
    // (TWELFTH ROUND: the draft-first sequence splits the former single
    // create+upload step into create+upload and verify+publish; THIRTEENTH
    // ROUND: the failure-path draft-cleanup step is the sixth; SIXTEENTH
    // ROUND: the draft-verify step is SPLIT into the PAT-bearing
    // draft-byte retrieval step (zero custom code) and the credential-
    // free full-verification step (node) plus the publish step — the
    // retrieval step is the SEVENTH PAT operation, and the PAT still
    // never reaches repository-built code).
    let envOccurrences = 0;
    for (const [, job] of allJobs) {
      for (const step of job.steps) {
        const env = ((step["env"] ?? {}) as Record<string, unknown>) ?? {};
        if (env["GH_TOKEN"] === "${{ secrets.GY_RELEASE_PAT }}") envOccurrences += 1;
      }
    }
    assert.equal(envOccurrences, 7, "exactly SEVEN step env blocks reference the PAT (release draft-create+upload, release draft-byte retrieval, release publish, release failure-path draft-cleanup, stable-ref activation, promote-job rollback, downstream rollback-job mutation)");
    // The remaining occurrences must be comments only.
    const stripped = raw.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    assert.equal(stripped.split("secrets.GY_RELEASE_PAT").length - 1, 7, "outside comments, the PAT reference appears ONLY in the seven sanctioned step env values");
  });

  test("no build, test, generation, verification, artifact, checkout or dependency step receives the PAT in any form", () => {
    for (const [name, job] of allJobs) {
      for (const step of job.steps) {
        const env = ((step["env"] ?? {}) as Record<string, unknown>) ?? {};
        const uses = (step["uses"] as string | undefined) ?? "";
        const run = (step["run"] as string) ?? "";
        const carriesPat = "GY_RELEASE_PAT" in env || JSON.stringify(step).includes("secrets.GY_RELEASE_PAT");
        if (!carriesPat) continue;
        // The ONLY PAT-bearing steps are the pinned mutations: the gh
        // release mutations and the dedicated-ref gh api mutations.
        assert.ok(/gh release (create|upload|edit)|uploads\.github\.com|releases\/\$DRAFT_RELEASE_ID|git\/(tags|refs)/.test(run), `${name}: a PAT-bearing step must be a pinned mutation`);
        assert.ok(!uses, `a PAT-bearing step must not be an action (${uses})`);
        assert.ok(!/node|pnpm|npm|npx|\.mjs|checkout|tsx/.test(run), `a PAT-bearing step must not execute custom code or dependencies`);
      }
    }
  });

  test("the only repository secrets referenced anywhere are the RPC endpoints and the release PAT", () => {
    const stripped = raw.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    const secrets = [...stripped.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1] as string);
    assert.deepEqual([...new Set(secrets)].sort(), ["DEVNET_RPC_URL", "GY_RELEASE_PAT", "MAINNET_RPC_URL"], "no unexpected secret is referenced by the publication workflow");
  });

  test("the PAT never reaches any job that runs repository-built code, downloads artifacts, or discovers the rollback pointer", () => {
    const codeJobs = ["generate", "verify", "publish", "verify-versioned", "verify-stable"];
    for (const name of codeJobs) {
      const job = wf.jobs[name] as NonNullable<typeof wf.jobs[string]>;
      const dumped = JSON.stringify({ env: job.env ?? {}, steps: job.steps });
      assert.ok(!dumped.includes("GY_RELEASE_PAT"), `job ${name} must not reference the release PAT in any env, step or command`);
      assert.deepEqual(job.permissions, { contents: "read" }, `${name} stays read-only`);
    }
  });
});

// ─── Review Task 4 — hardened rollback-pointer discovery ────────────────────

describe("publish-console-snapshot workflow — rollback discovery hardening (review Task 4)", () => {
  const wf = loadWorkflow();
  const publish = wf.jobs["publish"]!;
  const release = wf.jobs["release"]!;

  test("rollback discovery uses the typed `stable-pointer-current` gate, not error-suppressed gh api", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /stable-pointer-current/, "the hardened discovery CLI is used");
    assert.ok(!runs.includes("2>/dev/null || echo"), "the old suppress-all-errors pattern is GONE");
    assert.ok(!runs.includes('--jq ".tag_name" 2>/dev/null'), "no raw gh api latest query that can silently fail into 'none'");
  });

  test("the tag-collision gate distinguishes absent / exists / gate-failure (never treats an API failure as 'absent')", () => {
    for (const [name, job] of [["publish", publish], ["release", release]] as const) {
      const runs = runBlocks(job).join("\n");
      assert.match(runs, /git\/ref\/tags\/\$TAG/, `${name}: the gate queries the git-ref API for the versioned tag (authenticated — a private repo is unresolvable unauthenticated)`);
      assert.match(runs, /case "\$code" in/, `${name}: explicit three-way HTTP-status handling`);
      assert.match(runs, /404\) echo "versioned tag \$TAG does not exist/, `${name}: HTTP 404 is the ONLY 'absent' verdict`);
      assert.match(runs, /200\) echo "versioned tag \$TAG already exists/, `${name}: HTTP 200 is an aborting collision`);
      assert.match(runs, /refusing to treat this as 'tag absent'/, `${name}: a failing gate aborts the run`);
      // The gate step authenticates with the READ-ONLY workflow token, not the PAT.
      const gateStep = job.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("git/ref/tags/")));
      assert.ok(gateStep, `${name}: the gate step exists`);
      assert.equal(stepEnv(gateStep!)["GH_TOKEN"], "${{ github.token }}", `${name}: the tag-collision gate uses the READ-ONLY automatic token, never the release PAT`);
      assert.equal(job.permissions?.["contents"], "read", `${name}: the gate's token is READ-ONLY because the job declares contents:read`);
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

  test("the rollback reference is recorded BEFORE any release operation (job chain enforces the order)", () => {
    const steps = publish.steps;
    const runs = steps.map((s) => (typeof s["run"] === "string" ? (s["run"] as string) : ""));
    const rollbackIdx = runs.findIndex((r) => r.includes("previous_versioned_tag"));
    assert.ok(rollbackIdx > -1, "rollback discovery runs in the publish job");
    const rollbackRun = runs[rollbackIdx] ?? "";
    assert.match(rollbackRun, /GITHUB_STEP_SUMMARY/, "the pointer is written to the run summary at discovery time");
    // The release job (which performs the first mutation) DEPENDS on publish.
    assert.equal(release.needs?.includes("publish"), true, "release creation is unreachable until the rollback pointer has been recorded (needs chain)");
    assert.equal(publish.outputs?.["previous_versioned_tag"], "${{ steps.rollback.outputs.previous_versioned_tag }}", "the pointer crosses the job boundary as a job output");
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

  test("post-activation verification requires the full identity chain over the dedicated ref", () => {
    const runs = runBlocks(verifyStable).join("\n");
    assert.match(runs, /verify-stable[\s\S]*--expected-tag/, "the stable gate verifies the dedicated stable reference's identity chain");
    const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
    assert.ok(!raw.includes("latest/download/console-snapshot.json\""), "raw curl of separate latest URLs is no longer the verification mechanism");
    assert.ok(!/curl[\s\S]*stable-check/.test(raw), "the three-separate-curl stable check is replaced by the identity gate");
  });

  test("verification and promotion run in the required order ACROSS JOBS", () => {
    const relRuns = runBlocks(release);
    const uploadIdx = relRuns.findIndex((r) => r.includes("uploads.github.com"));
    assert.ok(uploadIdx > -1, "the release job uploads the assets (draft-first: uploads.github.com asset endpoint by release ID)");
    const publishIdx = relRuns.findIndex((r) => r.includes("draft assets verified and release published"));
    assert.ok(publishIdx > -1, "the release job publishes the verified draft");
    assert.ok(publishIdx > uploadIdx, "publish follows upload (draft-first ordering)");
    // The roundtrip verification is a SEPARATE job that needs `release`,
    // and promotion is a job that needs the roundtrip verification.
    assert.equal(verifyVersioned.needs?.includes("release"), true, "same-release verification follows upload (job boundary)");
    assert.equal(promote.needs?.includes("verify-versioned"), true, "promotion follows verification (job boundary)");
    assert.equal(verifyStable.needs?.includes("promote"), true, "post-activation verification follows promotion (job boundary)");
    // The promotion job's mutation set is pinned: the activation step
    // (create tag object + move ref) and the failure-path rollback.
    const promoteRuns = runBlocks(promote).join("\n");
    assert.match(promoteRuns, /git\/tags[\s\S]*git\/refs/s, "the activation creates the pointer object and moves the ref");
    assert.ok(!promoteRuns.includes("gh release edit"), "the retired latest-release promotion is GONE");
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
    const stableGateStep = verifyStable.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("verify-stable")) && (s["run"] as string).includes("--expected-tag"));
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

  test("the rehearsal NEVER references the production release PAT (GY_RELEASE_PAT)", () => {
    const rawRehearsal = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
    // Comments may DOCUMENT the prohibition; the CONFIGURATION must never
    // reference the production credential.
    const strippedRehearsal = rawRehearsal.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    assert.ok(!strippedRehearsal.includes("GY_RELEASE_PAT"), "the production release credential must never be wired into the rehearsal workflow");
    assert.ok(!rawRehearsal.includes("secrets."), "no repository secret is referenced anywhere in the rehearsal");
  });
});

// ─── Eighth round (review Finding 2) — the rehearsal tests the POINTER ───────
// ─── architecture, not the retired repo-wide "latest" mechanism ──────────────

describe("rehearsal-publication workflow — dedicated stable-reference architecture (eighth round, Finding 2)", () => {
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
  const runs = job.steps
    .filter((s) => typeof s["run"] === "string")
    .map((s) => s["run"] as string)
    .join("\n");
  const stripped = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  test("the guard precedes EVERY write operation (checkout and all release/ref steps come after it)", () => {
    const names = job.steps.map((s) => String(s["name"] ?? s["uses"] ?? ""));
    const guardIdx = names.findIndex((n) => n.startsWith("HARD GUARD"));
    assert.equal(guardIdx, 0, "the hard guard is the FIRST step");
    const firstCheckout = job.steps.findIndex((s) => typeof s["uses"] === "string" && (s["uses"] as string).startsWith("actions/checkout"));
    const firstWrite = runs.search(/gh release (create|upload|delete)|gh api --method (POST|PATCH|DELETE)/);
    assert.ok(firstCheckout > guardIdx, "checkout happens after the guard");
    assert.ok(firstWrite >= 0 && firstCheckout > 0, "write steps exist and are pinned relative to checkout");
  });

  test("the rehearsal creates versioned releases with --latest=false and NEVER promotes through the repo-wide latest mechanism", () => {
    assert.match(stripped, /--latest=false/, "versioned releases are created explicitly NOT latest");
    assert.ok(!stripped.includes("gh release edit"), "the retired `gh release edit --latest` promotion is GONE");
    assert.ok(!stripped.includes("--scope latest"), "no `--scope latest` verification remains");
    assert.ok(!stripped.includes("release-latest"), "the retired release-latest discovery CLI is not part of the rehearsal");
    assert.ok(!stripped.includes("releases/latest/download"), "no repo-wide latest download URL is exercised");
  });

  test("the rehearsal exercises the FULL dedicated stable-reference architecture", () => {
    assert.match(runs, /stable-pointer-current/, "the hardened stable-pointer discovery is used for rollback bookkeeping");
    assert.match(runs, /stable-pointer-build/, "the pointer JSON is built from the VERIFIED release bytes");
    assert.match(runs, /pointerSchema[\s\S]*graveyield\.console-snapshot-stable-pointer\.v1/, "the pointer is strictly validated against the approved schema before use");
    // The annotated tag object + dedicated ref mutations, repository-qualified.
    assert.match(runs, /--method POST "repos\/\$REPO\/git\/tags"/, "an ANNOTATED pointer tag object is created via POST /git/tags");
    assert.match(runs, /-f message="\$POINTER_JSON"/, "the pointer JSON is the tag-object message");
    assert.match(runs, /--method POST "repos\/\$REPO\/git\/refs"/, "first publication CREATES the dedicated ref");
    assert.match(runs, /--method PATCH "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"[\s\S]*-F force=true/s, "subsequent publications MOVE the dedicated ref with ONE atomic PATCH");
    assert.match(runs, /-f ref="\$STABLE_REF"/, "ref creation uses the dedicated ref constant");
    assert.equal(job.env?.["STABLE_REF"], "refs/tags/console-snapshot-prod", "the rehearsal pins the exact dedicated ref name");
    // Read-back + full identity chain.
    assert.match(runs, /READ-BACK MISMATCH/, "the ref read-back is verified (sha + message equality)");
    assert.match(runs, /verify-stable[\s\\]+/, "the FULL production identity chain (verify-stable) validates the activated pointer");
    assert.match(runs, /--scope versioned/, "assets are verified through the VERSIONED scope (same-release cross-check), never through a repo-wide alias");
  });

  test("the rehearsal exercises BOTH rollback cases and failure injection around activation", () => {
    assert.match(runs, /--method DELETE "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"/, "first-publication rollback deletes the dedicated ref");
    assert.match(runs, /\[ "\$code" != "404" \]/, "the first-publication rollback proves absence by a genuine HTTP 404 read-back");
    assert.match(runs, /verify-stable[\s\S]*PRIOR_TAG/, "the previous-pointer rollback is verified through the FULL identity chain for the restored release");
    // Failure injection BEFORE activation (partial upload) and AFTER
    // activation (rollback drill + failed-activation probe).
    assert.match(runs, /verification PASSED on a partial release/, "a pre-activation failure injection exists (partial upload must fail verification)");
    assert.match(runs, /the dedicated stable reference is unchanged after the partial-upload failure|SAFETY FAILURE: the stable reference moved after a FAILED publication/, "the pre-activation failure must leave the prior pointer intact");
    assert.match(runs, /pointer build for missing release .* fails/, "an activation for a missing release must fail closed");
    assert.match(runs, /rollback drill/, "a post-activation rollback drill exists");
  });

  test("an UNRELATED release (even taking the repo-wide latest designation) is proven unable to move the dedicated ref", () => {
    const probe = job.steps.find((s) => typeof s["run"] === "string" && (s["run"] as string).includes("unrelated"));
    assert.ok(probe, "the unrelated-release probe step exists");
    const runsProbe = (probe!["run"] as string) ?? "";
    assert.match(runsProbe, /--latest/, "the probe deliberately takes the repo-wide latest designation");
    assert.match(runsProbe, /stable-pointer-current/, "and the dedicated reference is re-read afterward");
    assert.match(runsProbe, /SAFETY FAILURE: the dedicated stable reference moved/, "a moved dedicated reference fails the rehearsal loudly");
    assert.match(runsProbe, /verify-stable/, "the probe also re-verifies the full identity chain for the expected tag");
    assert.match(runsProbe, /gh release delete/, "the probe release is cleaned up afterward");
  });

  test("the rehearsal's credential stays scoped to the rehearsal repository", () => {
    assert.equal(job.env?.["GH_TOKEN"], "${{ github.token }}", "the rehearsal uses the run's own repository-scoped token");
    const raw = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
    assert.ok(!raw.includes("secrets."), "no repository secret (including the production PAT) is referenced anywhere in the rehearsal");
  });
});

// ─── Sixth round — the dedicated `console-snapshot-prod` stable reference ───

describe("publish-console-snapshot workflow — dedicated stable reference (owner-selected architecture)", () => {
  const wf = loadWorkflow();
  const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
  const stripped = raw.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  const promote = wf.jobs["promote"]!;
  const publish = wf.jobs["publish"]!;
  const verifyVersioned = wf.jobs["verify-versioned"]!;
  const verifyStable = wf.jobs["verify-stable"]!;

  test("the workflow NEVER depends on the repo-wide latest designation anywhere in its execution path", () => {
    assert.ok(!stripped.includes("releases/latest"), "no releases/latest URL appears outside comments");
    assert.ok(!stripped.includes("gh release edit"), "no latest-release promotion command exists");
    // TWELFTH ROUND: the draft-first publish pins the designation OFF with
    // an explicit make_latest=false — the ONLY permitted form. Any
    // promotion form (true / legacy / a gh release edit --latest) stays
    // forbidden.
    assert.ok(!stripped.includes("make_latest=true") && !stripped.includes("make_latest=legacy") && !stripped.includes("--latest\n"), "no make_latest promotion exists (only make_latest=false pins the designation off)");
    assert.ok(!stripped.includes("gh release edit"), "no latest-release promotion command exists (re-check after draft-first)");
    assert.ok(!/--latest(?!-latest=)/.test(stripped.replace(/--latest=false/g, "")), "--latest appears only as --latest=false");
    assert.match(stripped, /--latest=false/, "versioned releases are still explicitly NOT latest");
  });

  test("the dedicated stable ref name is pinned and every ref mutation addresses it", () => {
    assert.match(stripped, /console-snapshot-prod/, "the stable ref name appears in the execution path");
    // Every ref mutation in the privileged job addresses the dedicated ref
    // (via the literal name or the job-level STABLE_REF constant).
    const promoteRuns = runBlocks(promote).join("\n");
    assert.match(promoteRuns, /-f ref="\$STABLE_REF"/, "ref creation uses the dedicated ref constant");
    assert.match(promoteRuns, /--method PATCH "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"/, "ref update uses the COMPLETE repository-qualified API endpoint (SEVENTH-ROUND CORRECTION)");
    assert.ok(!promoteRuns.includes('PATCH "$STABLE_REF"'), "no ref update addresses the bare ref constant as an API endpoint");
    assert.equal(promote.env?.["STABLE_REF"], "refs/tags/console-snapshot-prod", "the job pins the exact dedicated ref name");
  });

  test("the pointer JSON is re-validated at the promote boundary (token-free jq gate) before any privileged command consumes it", () => {
    const runs = runBlocks(verifyVersioned).join("\n");
    assert.match(runs, /stable-pointer-build/, "the pointer is built by the read-only verify-versioned job");
    const promoteRuns = runBlocks(promote).join("\n");
    assert.match(promoteRuns, /pointerSchema[\s\S]*console-snapshot-stable-pointer\.v1/, "the pointer schema discriminator is pinned at the boundary");
    assert.match(promoteRuns, /versionedTag == \$tag/, "the pointer must name the boundary tag");
    assert.match(promoteRuns, /sourceCommit == \$commit/, "the pointer must name the asserted checkout commit");
    const jqStep = promote.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("pointerSchema")));
    assert.ok(jqStep, "the pointer-validation step exists");
    assert.equal(stepEnv(jqStep!)["GH_TOKEN"], undefined, "the pointer validation is TOKEN-FREE (pure jq over the boundary output)");
    // The pointer crosses the job boundary as a validated output.
    assert.equal(verifyVersioned.outputs?.["pointer_json"], "${{ steps.pointer.outputs.pointer_json }}", "verify-versioned exposes the pointer JSON");
    const activateStep = promote.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("git/tags") && (s["run"] as string).includes("git/refs")));
    assert.equal(stepEnv(activateStep!)["POINTER_JSON"], "${{ needs.verify-versioned.outputs.pointer_json }}", "the activation consumes exactly the validated pointer output");
  });

  test("activation creates a NEW immutable annotated tag object and moves the ref with ONE atomic update", () => {
    const runs = runBlocks(promote).join("\n");
    assert.match(runs, /--method POST "repos\/\$REPO\/git\/tags"/, "the pointer object is created via POST /git/tags (immutable git object)");
    assert.match(runs, /-f type="commit"/, "the tag object points at the release commit");
    assert.match(runs, /-f message="\$POINTER_JSON"/, "the pointer JSON is the tag-object message");
    assert.match(runs, /--method POST "repos\/\$REPO\/git\/refs"/, "first publication CREATES the ref");
    assert.match(runs, /--method PATCH "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"/, "subsequent publications move the ref with ONE PATCH against the COMPLETE repository-qualified endpoint (SEVENTH-ROUND CORRECTION)");
    assert.match(runs, /-F force=true/, "the ref move is the single atomic update");
    assert.ok(!runs.includes("--clobber"), "no asset is ever clobbered");
  });

  test("read-back verification exists and is READ-ONLY (ref sha + message equality)", () => {
    const readback = promote.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("READ-BACK MISMATCH")));
    assert.ok(readback, "the read-back verification step exists");
    assert.equal(stepEnv(readback!)["GH_TOKEN"], "${{ github.token }}", "read-back authenticates with the READ-ONLY automatic token");
    const runs = (readback!["run"] as string) ?? "";
    assert.match(runs, /\[ "\$sha" != "\$NEW_SHA" \]/, "the ref must resolve to the created object sha");
    assert.match(runs, /\[ "\$message" != "\$POINTER_JSON" \]/, "the activated object's message must equal the validated pointer JSON");
  });

  test("the in-job rollback is a compare-before-rollback chain that runs on failure, restores the recorded previous pointer, and fails LOUDLY on unverifiable rollback", () => {
    // NINTH-ROUND CORRECTION (Finding 1): the former single rollback step
    // is now a three-step chain — read-only compare → PAT mutation →
    // read-only read-back — where the mutation is gated on the compare's
    // verdict over the LIVE remote state.
    const compare = promote.steps.find((s) => s["id"] === "rollback_compare");
    const mutate = promote.steps.find((s) => s["id"] === "rollback_mutate");
    const verify = promote.steps.find((s) => s["id"] === "rollback_verify");
    assert.ok(compare && mutate && verify, "the compare → mutate → verify rollback chain exists");
    const expectedCond = "failure() && steps.activation_gate.outputs.activation_started == 'true'";
    assert.equal(compare!["if"], expectedCond, "the compare runs ONLY on failure AND only when activation was attempted");
    assert.equal(
      mutate!["if"],
      "failure() && steps.activation_gate.outputs.activation_started == 'true' && steps.rollback_compare.outputs.rollback_case == 'restore'",
      "the mutation runs ONLY on failure, with the marker, AND only after the compare classified the live ref as this run's pointer",
    );
    assert.equal(
      verify!["if"],
      "failure() && steps.activation_gate.outputs.activation_started == 'true' && steps.rollback_compare.outputs.rollback_case == 'restore'",
      "the read-back verification is likewise unreachable without the compare verdict and the marker",
    );
    assert.equal(stepEnv(mutate!)["GH_TOKEN"], "${{ secrets.GY_RELEASE_PAT }}", "only the mutation step carries the PAT");
    assert.equal(stepEnv(compare!)["GH_TOKEN"], "${{ github.token }}", "the compare is a READ-ONLY step (automatic token)");
    assert.equal(stepEnv(verify!)["GH_TOKEN"], "${{ github.token }}", "the read-back is a READ-ONLY step (automatic token)");
    const mutateRuns = (mutate!["run"] as string) ?? "";
    assert.match(mutateRuns, /ref_mode/i, "the rollback branches on the pre-mutation ref state");
    assert.match(mutateRuns, /--method DELETE "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"/, "first-publication rollback removes the ref via the COMPLETE repository-qualified endpoint (restores the absent state)");
    assert.match(mutateRuns, /previous_pointer_json|PREV_POINTER_JSON/, "the rollback restores the RECORDED previous pointer verbatim");
    const verifyRuns = (verify!["run"] as string) ?? "";
    assert.match(verifyRuns, /ROLLBACK UNVERIFIED[\s\S]*exit 1/s, "an unverifiable rollback fails LOUDLY — the state is reported as unverified");
    assert.match(verifyRuns, /rollback VERIFIED/, "a successful rollback is verified by read-back before being claimed");
  });

  test("the three-way stable-ref gate aborts on any failure (never treats an API failure as 'ref absent')", () => {
    const runs = runBlocks(promote).join("\n");
    assert.match(runs, /git\/ref\/tags\/console-snapshot-prod/, "the gate queries the dedicated ref");
    assert.match(runs, /404\)/, "404 = genuinely absent (mode=create)");
    assert.match(runs, /200\)/, "200 = exists (mode=update)");
    assert.match(runs, /refusing to treat this as 'ref absent'/, "a failing gate aborts the run");
    const gateStep = promote.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("git/ref/tags/console-snapshot-prod")));
    assert.equal(stepEnv(gateStep!)["GH_TOKEN"], "${{ github.token }}", "the stable-ref gate uses the READ-ONLY automatic token, never the PAT");
  });
});

// ─── Seventh round — repository-qualified stable-ref API endpoints and ───────
// ─── attempted-activation rollback gating ────────────────────────────────────

describe("publish-console-snapshot workflow — repository-qualified endpoints and rollback gating (seventh round)", () => {
  const wf = loadWorkflow();
  const promote = wf.jobs["promote"]!;
  const steps = promote.steps;
  const allRuns = Object.values(wf.jobs)
    .flatMap((j) => runBlocks(j))
    .join("\n");

  const stablegateIdx = steps.findIndex((s) => s["id"] === "stablegate");
  const markerIdx = steps.findIndex((s) => s["id"] === "activation_gate");
  const activateIdx = steps.findIndex((s) => s["id"] === "activate");
  const readbackIdx = steps.findIndex((s) => s["id"] === "readback");
  // NINTH-ROUND CORRECTION (Finding 1): the in-job rollback is a
  // compare → mutate → verify chain; the endpoint pins target the
  // mutation and read-back steps by their step ids.
  const rollbackMutateIdx = steps.findIndex((s) => s["id"] === "rollback_mutate");
  const rollbackVerifyIdx = steps.findIndex((s) => s["id"] === "rollback_verify");
  const rollbackCompareIdx = steps.findIndex((s) => s["id"] === "rollback_compare");

  test("activation PATCH uses the COMPLETE repository-qualified endpoint repos/$REPO/git/refs/tags/console-snapshot-prod", () => {
    assert.ok(activateIdx > -1, "the activation step exists");
    const runs = steps[activateIdx]!["run"] as string;
    assert.match(
      runs,
      /gh api --method PATCH "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod" \\\n\s*-f sha="\$new_sha" \\\n\s*-F force=true/,
      "the activation ref update is the exact repository-qualified PATCH: new tag-object sha + force",
    );
    assert.ok(!runs.includes('PATCH "$STABLE_REF"'), "the activation does NOT address the bare ref constant as an endpoint");
    assert.equal(stepEnv(steps[activateIdx]!)["GH_TOKEN"], "${{ secrets.GY_RELEASE_PAT }}", "the activation remains the PAT-scoped privileged step");
  });

  test("existing-pointer rollback PATCH uses the SAME complete repository-qualified endpoint", () => {
    assert.ok(rollbackMutateIdx > -1, "the rollback mutation step exists");
    const runs = steps[rollbackMutateIdx]!["run"] as string;
    assert.match(
      runs,
      /gh api --method PATCH "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod" -f sha="\$old_sha" -F force=true/,
      "the rollback ref update is the exact repository-qualified PATCH restoring the re-created previous pointer object",
    );
    assert.ok(!runs.includes('PATCH "$STABLE_REF"'), "the rollback does NOT address the bare ref constant as an endpoint");
    // The restoration is verified by the separate READ-ONLY read-back
    // step: ref sha, tag-object message (previous pointer JSON verbatim)
    // and the previous versioned release identity.
    const verifyRuns = steps[rollbackVerifyIdx]!["run"] as string;
    assert.match(verifyRuns, /\[ "\$sha" = "\$OLD_SHA" \]/, "read-back checks the ref resolves to the restored tag object");
    assert.match(verifyRuns, /\[ "\$message" = "\$PREV_POINTER_JSON" \]/, "read-back checks the restored object carries the previous pointer JSON verbatim");
    assert.match(verifyRuns, /\[ "\$restored_tag" = "\$PREV_VERSIONED_TAG" \]/, "read-back checks the restored pointer names the previous versioned release");
  });

  test("first-publication rollback DELETE uses the COMPLETE repository-qualified endpoint and proves absence by read-back only", () => {
    const runs = steps[rollbackMutateIdx]!["run"] as string;
    const verifyRuns = steps[rollbackVerifyIdx]!["run"] as string;
    assert.match(
      runs,
      /gh api --method DELETE "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"/,
      "the first-publication rollback deletes the ref via the repository-qualified endpoint",
    );
    assert.ok(!runs.includes('DELETE "$STABLE_REF"'), "the rollback does NOT delete the bare ref constant as an endpoint");
    // Absence is proven ONLY by the authenticated read-back returning 404 —
    // never by the DELETE command's own exit status (an auth failure,
    // network error, rate limit or unexpected API response is not evidence
    // that the ref is absent).
    assert.match(verifyRuns, /-w '%\{http_code\}'[\s\S]*git\/ref\/tags\/console-snapshot-prod/, "the read-back queries the dedicated ref through the repository-qualified GET");
    assert.match(verifyRuns, /\[ "\$code" = "404" \]/, "rollback is claimed VERIFIED only when the read-back returns exactly 404");
    assert.match(verifyRuns, /rollback verification FAILED[\s\S]*expected a genuine 404/, "any other read-back result leaves the rollback UNVERIFIED");
    // The DELETE's own error output is NOT suppressed: an UNVERIFIED outcome
    // must carry the API's own failure detail for the operator.
    assert.match(runs, /gh api --method DELETE "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod" \|\| true/, "the DELETE keeps running so the read-back decides the outcome, but its errors stay visible in the log");
  });

  test("NO mutation command anywhere in the workflow uses the bare \"$STABLE_REF\" as its API endpoint", () => {
    const mutationLines = allRuns
      .split("\n")
      .filter((line) => /gh api\s+--method\s+(POST|PATCH|DELETE)|gh api\s+-X\s+(POST|PATCH|DELETE)/.test(line));
    assert.ok(mutationLines.length >= 6, `the workflow contains the expected pinned mutation commands (found ${mutationLines.length})`);
    for (const line of mutationLines) {
      const endpoint = line.match(/gh api\s+(?:--method|-X)\s+(?:POST|PATCH|DELETE)\s+"([^"]+)"/)?.[1];
      assert.ok(endpoint, `every mutation command quotes its endpoint: ${line.trim()}`);
      // TWELFTH ROUND: endpoints must be HOST-qualified — either the
      // repository-qualified repos/ path (git data, release records) or a
      // full https:// api.github.com / uploads.github.com URL (the
      // draft-first asset upload). A BARE ref or bare path remains
      // forbidden — that is the original defect this test pins.
      assert.match(endpoint!, /^(repos\/|https:\/\/(api|uploads)\.github\.com\/)/, `every mutation endpoint is repository- or host-qualified (got "${endpoint}"): ${line.trim()}`);
    }
    assert.ok(!allRuns.includes('gh api --method PATCH "$STABLE_REF"'), "no bare-$STABLE_REF PATCH endpoint anywhere");
    assert.ok(!allRuns.includes('gh api --method DELETE "$STABLE_REF"'), "no bare-$STABLE_REF DELETE endpoint anywhere");
    assert.ok(!allRuns.includes('gh api "$STABLE_REF"'), "no bare-$STABLE_REF default-method endpoint anywhere");
  });

  test("the stable ref name remains exactly refs/tags/console-snapshot-prod", () => {
    assert.equal(promote.env?.["STABLE_REF"], "refs/tags/console-snapshot-prod", "the job pins the exact dedicated ref name");
    const promoteRuns = runBlocks(promote).join("\n");
    // Every ref mutation addresses the tags/console-snapshot-prod path and
    // the tag OBJECT is always created with the same name.
    assert.match(promoteRuns, /repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod/, "ref updates address the dedicated ref path");
    assert.match(promoteRuns, /-f tag="console-snapshot-prod"/, "pointer tag objects are always created with the dedicated tag name");
    assert.ok(!runBlocks(promote).join("\n").includes("releases/latest"), "no repo-wide latest dependency exists in the promotion job");
  });

  test("the activation-start marker exists and is written IMMEDIATELY before the mutation step", () => {
    assert.ok(markerIdx > -1, "the activation_gate marker step exists");
    const markerRun = steps[markerIdx]!["run"] as string;
    assert.match(markerRun, /activation_started=true/, "the marker records activation_started=true");
    assert.match(markerRun, /GITHUB_OUTPUT/, "the marker is a step output consumable by the rollback condition");
    assert.equal(markerIdx + 1, activateIdx, `the marker is the step immediately before the mutation (marker=${markerIdx}, activate=${activateIdx})`);
    assert.equal(steps[markerIdx]!["continue-on-error"], undefined, "the marker step cannot be skipped by continue-on-error");
    const activateRun = steps[activateIdx]!["run"] as string;
    assert.ok(!activateRun.includes("activation_started"), "the marker is NOT written by the mutation step itself — an interrupted step cannot be relied on to have written it");
  });

  test("rollback CANNOT execute when the stable-reference gate fails (activation never attempted)", () => {
    assert.ok(stablegateIdx > -1, "the three-way stable-ref gate exists");
    assert.ok(stablegateIdx < markerIdx, `the gate runs BEFORE the marker (gate=${stablegateIdx}, marker=${markerIdx}) — its failure prevents the marker from ever being written`);
    for (const idx of [stablegateIdx, markerIdx, activateIdx]) {
      assert.equal(steps[idx]!["continue-on-error"], undefined, "no pre-activation step can continue past its own failure");
    }
    // EVERY step of the rollback chain (compare, mutate, verify) requires
    // the marker that only exists after the gate passed — without it
    // (gate failed → step skipped → output unset), failure() alone cannot
    // trigger any rollback step.
    for (const idx of [rollbackCompareIdx, rollbackMutateIdx, rollbackVerifyIdx]) {
      const cond = steps[idx]!["if"] as string;
      assert.match(cond, /steps\.activation_gate\.outputs\.activation_started == 'true'/, "the rollback condition requires the marker that only exists after the gate passed");
      assert.equal(steps[idx]!["continue-on-error"], undefined, "no rollback step can be silently skipped either");
    }
  });

  test("rollback EXECUTES when activation was attempted and its result is uncertain (timeout/interruption after the request was issued)", () => {
    // The marker is written BEFORE the first mutation command: if the
    // activation step fails, times out or is killed mid-request — even
    // though GitHub may already have applied the ref update — the marker
    // is already set and failure() is true, so the rollback runs.
    assert.equal(markerIdx + 1, activateIdx, "the marker precedes the mutation");
    const cond = steps[rollbackCompareIdx]!["if"] as string;
    assert.match(cond, /failure\(\)/, "the rollback condition includes failure() — any failure at or after the marker (including the activate step itself) triggers it");
    assert.match(cond, /activation_started == 'true'/, "and the marker is the attempt evidence");
    // Regression guard against the rejected design: the condition must not
    // depend on the activation step REPORTING success/failure.
    assert.ok(!cond.includes("steps.activate.outcome"), "the rollback does NOT rely on steps.activate.outcome — a failed/interrupted request may still have changed the ref");
  });

  test("rollback EXECUTES when read-back verification fails after successful activation", () => {
    assert.ok(readbackIdx > -1, "the read-back step exists");
    assert.ok(readbackIdx < rollbackCompareIdx, `read-back precedes the rollback (readback=${readbackIdx}, rollback=${rollbackCompareIdx})`);
    assert.equal(steps[readbackIdx]!["if"], "success()", "read-back runs when activation succeeded");
    const readbackRun = steps[readbackIdx]!["run"] as string;
    assert.match(readbackRun, /READ-BACK MISMATCH[\s\S]*exit 1/, "a read-back divergence fails the step — failure() becomes true with the marker already set, so the rollback runs");
    const cond = steps[rollbackCompareIdx]!["if"] as string;
    assert.match(cond, /failure\(\)/, "the rollback condition fires on the read-back failure");
  });

  test("rollback does NOT execute after successful activation AND successful read-back", () => {
    const cond = steps[rollbackCompareIdx]!["if"] as string;
    assert.equal(
      cond,
      "failure() && steps.activation_gate.outputs.activation_started == 'true'",
      "the exact condition: on a fully successful promotion failure() is false, so the rollback never runs even though the marker is set",
    );
    assert.equal(steps[readbackIdx]!["if"], "success()", "the read-back gate lets a verified activation complete the job without the rollback");
  });
});

// ─── Eighth round (review Finding 1) — the dedicated downstream rollback job ─
//
// The promote job's in-job rollback step can only run while promote itself
// is failing. Once promotion COMPLETES, the separate verify-stable job runs
// — and if THAT job fails, the stable reference could stay pointed at a
// publication that never passed the full downstream verification chain.
// These tests pin the dedicated `rollback` job: its dependency-graph gate,
// its compare-before-rollback single-writer guard, both rollback cases
// (previous pointer restore / first-publication ref deletion), its
// read-back verification, its loud failure with preserved evidence, and
// its PAT isolation.

describe("publish-console-snapshot workflow — downstream rollback job (eighth round, Finding 1)", () => {
  const wf = loadWorkflow();
  const rollback = wf.jobs["rollback"]!;
  const promote = wf.jobs["promote"]!;
  const verifyStable = wf.jobs["verify-stable"]!;

  test("the rollback job exists and is wired AFTER the downstream verification", () => {
    assert.ok(rollback, "the rollback job exists");
    assert.ok(rollback.needs?.includes("publish"), "the rollback job consumes the publish job's outputs (versioned tag, previous pointer)");
    assert.ok(rollback.needs?.includes("promote"), "the rollback job consumes the promotion outputs");
    assert.ok(rollback.needs?.includes("verify-stable"), "the rollback job's trigger is the downstream verification result");
  });

  test("promotion succeeds AND downstream verification succeeds → NO rollback", () => {
    // The exact dependency-graph condition: it requires
    // needs.verify-stable.result == 'failure', so a green verification
    // (run success) can never trigger the rollback job.
    const cond = rollback["if"] ?? "";
    assert.match(cond, /failure\(\)/, "the condition requires the run to be in failure state");
    assert.match(cond, /needs\.verify-stable\.result == 'failure'/, "the condition requires the DOWNSTREAM verification to have failed — success never triggers a rollback");
    assert.match(cond, /github\.ref == 'refs\/heads\/main'/, "the rollback is still main-gated");
  });

  test("promotion succeeds AND downstream verification fails → rollback is attempted", () => {
    const cond = rollback["if"] ?? "";
    assert.match(cond, /needs\.promote\.result == 'success'/, "the condition requires promotion to have COMPLETED (the case the in-job rollback cannot cover)");
    assert.match(cond, /needs\.verify-stable\.result == 'failure'/, "and the downstream verification to have failed");
    // The mutation exists in the job: a committed compare + mutate + read-back chain.
    const runs = runBlocks(rollback).join("\n");
    assert.match(runs, /rollback mutation issued/, "the mutation step issues and records the rollback mutation");
    assert.match(runs, /rollback VERIFIED|rollback verification FAILED/, "the job verifies the rollback outcome by read-back");
  });

  test("a previous pointer existed → the previous pointer is restored and verified", () => {
    const runs = runBlocks(rollback).join("\n");
    // The update branch: re-create the previous pointer tag object and move the ref to it.
    assert.match(runs, /--method POST "repos\/\$REPO\/git\/tags"/, "the previous pointer tag object is re-created (POST /git/tags)");
    assert.match(runs, /-f message="\$PREV_POINTER_JSON"/, "the re-created object carries the recorded previous pointer JSON verbatim");
    assert.match(runs, /--method PATCH "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod" -f sha="\$old_sha" -F force=true/, "the ref is moved back with ONE repository-qualified PATCH");
    // Read-back: sha + message + previous versioned tag identity.
    assert.match(runs, /\[ "\$sha" = "\$OLD_SHA" \]/, "read-back checks the ref resolves to the restored object");
    assert.match(runs, /\[ "\$message" = "\$PREV_POINTER_JSON" \]/, "read-back checks the restored message byte-for-byte");
    assert.match(runs, /\[ "\$restored_tag" = "\$PREV_VERSIONED_TAG" \]/, "read-back checks the restored pointer names the previous versioned release");
    // The rollback inputs cross the job boundary through explicit outputs.
    assert.equal(promote.outputs?.["ref_mode"], "${{ steps.stablegate.outputs.ref_mode }}", "promote exposes the pre-activation ref mode");
    assert.equal(promote.outputs?.["previous_pointer_json"], "${{ steps.stablegate.outputs.previous_pointer_json }}", "promote exposes the verbatim previous pointer JSON");
    assert.equal(promote.outputs?.["previous_versioned_tag"], "${{ steps.stablegate.outputs.previous_versioned_tag }}", "promote exposes the previous versioned tag");
    assert.equal(promote.outputs?.["new_tag_object_sha"], "${{ steps.activate.outputs.new_tag_object_sha }}", "promote exposes the tag object this run created (the compare anchor)");
    // The rollback job consumes the previous pointer across the job
    // boundary through the mutate step's explicit env indirection.
    const mutate = rollback.steps.find((s) => s["id"] === "mutate")!;
    assert.equal(stepEnv(mutate!)["PREV_POINTER_JSON"], "${{ needs.promote.outputs.previous_pointer_json }}", "the rollback job consumes the previous pointer across the job boundary");
    assert.equal(stepEnv(mutate!)["PREV_VERSIONED_TAG"], "${{ needs.promote.outputs.previous_versioned_tag }}", "the rollback job consumes the previous versioned tag across the job boundary");
    assert.equal(stepEnv(mutate!)["REF_MODE"], "${{ needs.promote.outputs.ref_mode }}", "the rollback job consumes the pre-activation ref mode across the job boundary");
  });

  test("no previous pointer existed (first publication) → the newly created stable reference is deleted and absence is verified by 404", () => {
    const runs = runBlocks(rollback).join("\n");
    assert.match(runs, /--method DELETE "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"/, "first-publication rollback deletes the ref via the repository-qualified endpoint");
    assert.match(runs, /\[ "\$code" = "404" \]/, "absence is proven ONLY by a genuine 404 read-back");
    assert.match(runs, /rollback VERIFIED: the stable ref is absent again/, "the restored absent state is explicitly verified");
  });

  test("the stable reference no longer points at this run's tag object → the rollback REFUSES to overwrite it", () => {
    const compare = rollback.steps.find((s) => typeof s["run"] === "string" && (s["run"] as string).includes("COMPARE-BEFORE-ROLLBACK"));
    assert.ok(compare, "the compare-before-rollback step exists");
    assert.equal(stepEnv(compare!)["GH_TOKEN"], "${{ github.token }}", "the comparison runs with the READ-ONLY token");
    assert.equal(stepEnv(compare!)["NEW_SHA"], "${{ needs.promote.outputs.new_tag_object_sha }}", "the comparison anchors on THIS run's created tag object");
    const runs = (compare!["run"] as string) ?? "";
    assert.match(runs, /\[ "\$sha" != "\$NEW_SHA" \]/, "a moved pointer (different object sha) is detected");
    assert.match(runs, /refusing to overwrite a moved pointer/, "the refusal is explicit");
    assert.match(runs, /OPERATOR INTERVENTION REQUIRED/, "the refusal is an explicit operator-intervention failure");
    assert.match(runs, /exit 1/, "the job fails instead of proceeding to any mutation");
    assert.match(runs, /GITHUB_STEP_SUMMARY/, "the observed state is preserved as evidence");
    // The mutation step is unreachable unless the comparison passed.
    const mutate = rollback.steps.find((s) => s["id"] === "mutate");
    assert.ok(mutate, "the mutation step exists");
    assert.equal(mutate!["if"], "steps.compare.outputs.compare_ok == 'true'", "the mutation runs ONLY after a successful comparison");
    const readbackStep = rollback.steps.find((s) => typeof s["run"] === "string" && (s["run"] as string).includes("rollback VERIFIED") || typeof s["run"] === "string" && (s["run"] as string).includes("rollback verification FAILED"));
    assert.equal(readbackStep!["if"], "steps.compare.outputs.compare_ok == 'true'", "the read-back verification is likewise unreachable without a comparison");
  });

  test("promotion never started (or failed) → the rollback job does NOT run", () => {
    // The gate demands promote.result == 'success': a skipped or failed
    // promotion means the ref was never (successfully) moved by this run —
    // the activation_started safety concept is preserved at the GRAPH level.
    const cond = rollback["if"] ?? "";
    assert.match(cond, /needs\.promote\.result == 'success'/, "a failed or skipped promotion can never trigger this job");
    // The in-job promote rollback still owns the pre-activation / failed-
    // activation cases (ninth-round Finding 1 adds the compare guard to it).
    const promoteRollback = promote.steps.find((s) => s["id"] === "rollback_mutate");
    assert.ok(promoteRollback, "the promote job's own rollback mutation step still exists for failures before/at activation");
    assert.match(
      String(promoteRollback!["if"] ?? ""),
      /failure\(\) && steps\.activation_gate\.outputs\.activation_started == 'true' && steps\.rollback_compare\.outputs\.rollback_case == 'restore'/,
      "the in-job rollback still requires the activation-start marker AND the live-state compare verdict",
    );
  });

  test("an ambiguous activation result is decided from REMOTE state, never from reported step success", () => {
    // The downstream rollback job re-reads the live ref BEFORE mutating:
    // the decision input is the remote state, so an activation whose
    // reported result is ambiguous (timeout, interruption, partial
    // completion) is handled by observing what actually happened.
    const runs = runBlocks(rollback).join("\n");
    assert.match(runs, /git\/ref\/tags\/console-snapshot-prod/, "the comparison reads the live stable ref");
    assert.match(runs, /compare_ok=true/, "the comparison's verdict gates the mutation");
    // The design is documented on the compare step (raw file, comments included).
    const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
    assert.match(raw, /The decision to roll back is made from the REMOTE state/, "the design is documented in the step itself");
    // The promote job's in-job rollback keeps the same property: the
    // compare step reads the LIVE ref with the read-only token and its
    // verdict gates the mutation — the activation status never decides.
    const promoteCompare = promote.steps.find((s) => s["id"] === "rollback_compare")!;
    assert.equal(stepEnv(promoteCompare)["GH_TOKEN"], "${{ github.token }}", "the in-job compare reads the live ref with the READ-ONLY token");
    assert.match((promoteCompare["run"] as string), /git\/ref\/tags\/console-snapshot-prod/, "the in-job compare reads the live stable ref");
    assert.ok(!((promoteCompare["if"] ?? "") as string).includes("steps.activate.outcome"), "the in-job rollback does not rely on steps.activate.outcome either");
  });

  test("a rollback mutation or read-back failure reports failure and preserves diagnostic evidence", () => {
    const readback = rollback.steps.find((s) => typeof s["run"] === "string" && (s["run"] as string).includes("ROLLBACK UNVERIFIED"));
    assert.ok(readback, "the read-back verification step exists");
    assert.equal(stepEnv(readback!)["GH_TOKEN"], "${{ github.token }}", "read-back authenticates with the READ-ONLY automatic token");
    const runs = (readback!["run"] as string) ?? "";
    assert.match(runs, /ROLLBACK UNVERIFIED[\s\S]*exit 1/s, "an unverifiable rollback fails LOUDLY");
    assert.match(runs, /GITHUB_STEP_SUMMARY/, "diagnostic evidence (previous pointer JSON, restoration procedure) is preserved in the run summary");
    assert.match(runs, /PREV_POINTER_JSON/, "the recorded previous pointer JSON is part of the preserved evidence");
    assert.match(runs, /Manual restoration required|MANUAL RESTORATION REQUIRED/, "the operator is given the restoration path");
  });

  test("PAT isolation holds across the rollback job: discovery and verification are read-only, only the mutation carries the PAT", () => {
    assert.deepEqual(rollback.permissions, { contents: "read" }, "the rollback job's automatic token is READ-ONLY");
    const mutate = rollback.steps.find((s) => s["id"] === "mutate")!;
    assert.equal(stepEnv(mutate!)["GH_TOKEN"], "${{ secrets.GY_RELEASE_PAT }}", "the mutation step carries the dedicated PAT");
    // Every other token-bearing step in the job uses the READ-ONLY token.
    for (const step of rollback.steps) {
      const env = stepEnv(step);
      if ("GH_TOKEN" in env && step !== mutate) {
        assert.equal(env["GH_TOKEN"], "${{ github.token }}", "discovery/verification steps never receive the PAT");
      }
    }
    // The job contains no checkout / setup-node / custom code at all.
    for (const step of rollback.steps) {
      const uses = (step["uses"] as string | undefined) ?? "";
      assert.ok(!uses.startsWith("actions/checkout") && !uses.startsWith("actions/setup-node"), "the rollback job never checks out code or runs setup-node");
      const run = (step["run"] as string) ?? "";
      assert.ok(!/\bnode\b|pnpm|npm|npx|\.mjs|tsx/.test(run), "the rollback job executes no custom or repository-built code");
    }
    // The downstream verification job that TRIGGERS the rollback stays read-only.
    assert.deepEqual(verifyStable.permissions, { contents: "read" }, "verify-stable remains read-only — a failing verification job must not need write access to recover");
  });
});

// ─── Ninth round (review Finding 1) — in-job compare-before-rollback ────────
//
// The promote job's former single rollback step restored the recorded
// previous pointer from CAPTURED state without ever re-reading the live
// reference — a second writer could move the ref between the activation
// marker and the rollback, and the restore would overwrite it. These tests
// pin the corrected THREE-STEP in-job rollback chain: a READ-ONLY compare
// step that classifies the LIVE remote state (cases A–D), a PAT mutation
// step gated on the compare's verdict, and a READ-ONLY read-back
// verification. The conditions and endpoint paths are pinned exactly.

describe("publish-console-snapshot workflow — in-job compare-before-rollback chain (ninth round, Finding 1)", () => {
  const wf = loadWorkflow();
  const promote = wf.jobs["promote"]!;
  const compare = promote.steps.find((s) => s["id"] === "rollback_compare")!;
  const mutate = promote.steps.find((s) => s["id"] === "rollback_mutate")!;
  const verify = promote.steps.find((s) => s["id"] === "rollback_verify")!;
  const compareRun = (compare["run"] as string) ?? "";
  const mutateRun = (mutate["run"] as string) ?? "";
  const verifyRun = (verify["run"] as string) ?? "";

  test("the chain exists in order: compare → mutate → verify, all gated on the activation-start marker", () => {
    const ids = promote.steps.map((s) => s["id"]);
    const compareIdx = ids.indexOf("rollback_compare");
    const mutateIdx = ids.indexOf("rollback_mutate");
    const verifyIdx = ids.indexOf("rollback_verify");
    assert.ok(compareIdx > -1 && mutateIdx > -1 && verifyIdx > -1, "all three rollback steps exist");
    assert.ok(compareIdx < mutateIdx && mutateIdx < verifyIdx, "the rollback runs compare → mutate → verify");
    const markerCond = "steps.activation_gate.outputs.activation_started == 'true'";
    for (const cond of [compare["if"], mutate["if"], verify["if"]]) {
      assert.match(cond as string, /failure\(\)/, "every rollback step runs only on failure");
      assert.match(cond as string, new RegExp(markerCond.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "every rollback step requires the activation-start marker");
    }
    // Activation was NEVER attempted (any pre-activation gate failed →
    // marker never written) → the output is unset and NO rollback step can
    // run, even though failure() is true.
    assert.ok(!(compare["if"] as string).includes("steps.activate.outcome"), "the compare never inspects steps.activate.outcome");
  });

  test("CASE A — activation attempted but the ref remains at its ORIGINAL pre-activation state: no mutation, original state verified", () => {
    // update mode: the observed sha equals the recorded previous tag object.
    assert.match(compareRun, /\[ "\$REF_MODE" = "update" \] && \[ "\$sha" = "\$PREV_TAG_OBJECT_SHA" \]/, "an unchanged ref (still the pre-activation tag object) is classified CASE A");
    assert.match(compareRun, /CASE A: the stable ref still carries its ORIGINAL pre-activation tag object/, "CASE A is reported explicitly");
    assert.match(compareRun, /rollback_case=none/, "CASE A outputs 'none' — the mutation step's gate cannot open");
    // create mode: the ref is still absent (404) — original absent state intact.
    assert.match(compareRun, /CASE A: the stable ref is still ABSENT/, "a still-absent ref in first-publication mode is CASE A (no mutation needed)");
    // The compare step itself contains NO mutation command at all.
    assert.ok(!/gh api\s+--method\s+(POST|PATCH|DELETE)/.test(compareRun), "the read-only compare step issues NO mutation");
    assert.equal(mutate["if"], "failure() && steps.activation_gate.outputs.activation_started == 'true' && steps.rollback_compare.outputs.rollback_case == 'restore'", "the mutation is unreachable unless the compare said 'restore'");
  });

  test("CASE B — the ref points at THIS run's new tag object: the previous pointer is restored and verified", () => {
    // TENTH-ROUND CORRECTION (ownership identity): CASE B is authorized by
    // EXACT tag-object sha identity ONLY. Pointer-message equality was
    // removed as an ownership alternative: it proves payload equality,
    // not tag-object identity — a different writer can mint a distinct
    // annotated tag object carrying an identical pointer JSON and move
    // the stable ref to it, so message equality must never authorize a
    // rollback mutation.
    assert.match(compareRun, /if \[ "\$sha" = "\$NEW_SHA" \]; then/, "CASE B is authorized by the EXACT tag-object sha identity ONLY (a single strict condition)");
    assert.ok(!compareRun.includes('|| [ "$message" = "$POINTER_JSON" ]'), "pointer-message equality is NO LONGER an ownership alternative");
    assert.ok(!compareRun.includes('[ "$message" = "$POINTER_JSON" ]'), "no message-equality ownership test exists anywhere in the compare step");
    assert.match(compareRun, /rollback_case=restore/, "CASE B opens the mutation gate");
    assert.equal(stepEnv(compare)["NEW_SHA"], "${{ steps.activate.outputs.new_tag_object_sha }}", "the compare anchors on THIS run's created tag object");
    // The restore: re-create the previous pointer object + repository-qualified PATCH.
    assert.match(mutateRun, /--method POST "repos\/\$REPO\/git\/tags"/, "the previous pointer tag object is re-created");
    assert.match(mutateRun, /-f message="\$PREV_POINTER_JSON"/, "the restored object carries the recorded previous pointer JSON verbatim");
    assert.match(mutateRun, /gh api --method PATCH "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod" -f sha="\$old_sha" -F force=true/, "the ref is moved back via the repository-qualified PATCH");
    // The restored state is verified by the separate read-only read-back.
    assert.match(verifyRun, /\[ "\$sha" = "\$OLD_SHA" \] && \[ "\$message" = "\$PREV_POINTER_JSON" \] && \[ "\$restored_tag" = "\$PREV_VERSIONED_TAG" \]/, "read-back verifies ref sha + pointer message + previous release identity");
    assert.match(verifyRun, /rollback VERIFIED: the stable ref again resolves to/, "the restoration is claimed only after the read-back proof");
  });

  test("CASE B (first publication) — the newly created reference is deleted and absence is verified by a genuine 404", () => {
    assert.match(mutateRun, /gh api --method DELETE "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"/, "the first-publication rollback deletes the ref via the repository-qualified endpoint");
    assert.match(verifyRun, /\[ "\$code" = "404" \]/, "absence is proven ONLY by a genuine 404 read-back");
    assert.match(verifyRun, /rollback VERIFIED: the stable ref is absent again/, "the restored absent state is explicitly verified");
    assert.match(verifyRun, /\|\| code="transport-error"/, "a transport failure during read-back is NEVER interpreted as absence");
  });

  test("CASE C — the ref moved independently: the rollback REFUSES to overwrite or delete it", () => {
    assert.match(compareRun, /CASE C/, "the unexpected-target case is classified explicitly");
    assert.match(compareRun, /OPERATOR INTERVENTION REQUIRED/, "the refusal is an explicit operator-intervention failure");
    assert.match(compareRun, /it will NOT be recreated blindly/, "a deleted pointer is not blindly recreated either");
    assert.match(compareRun, /The documented single-writer assumption was violated/, "the refusal cites the single-writer assumption");
    assert.match(compareRun, /exit 1/, "the compare fails the job instead of proceeding to any mutation");
    assert.match(compareRun, /GITHUB_STEP_SUMMARY/, "the observed reference state is preserved as evidence");
    // Every verdict output (the ONLY way the mutation gate can open) is
    // immediately followed by `exit 0`; there is exactly ONE restore path
    // (CASE B) and exactly the two CASE A no-mutation paths. Every refusal
    // path (CASE C / CASE D) ends in `exit 1` without a verdict output.
    const cmpLines = compareRun.split("\n");
    for (let i = 0; i < cmpLines.length; i++) {
      if (/rollback_case=(restore|none)/.test(cmpLines[i]!)) {
        assert.match(cmpLines[i + 1] ?? "", /exit 0/, `a verdict output is always immediately followed by exit 0 (line: ${cmpLines[i]!.trim()})`);
      }
    }
    assert.equal((compareRun.match(/rollback_case=restore/g) ?? []).length, 1, "exactly ONE path (CASE B) opens the mutation gate");
    assert.equal((compareRun.match(/rollback_case=none/g) ?? []).length, 2, "exactly the two CASE A paths close the rollback without mutation");
  });

  test("CASE D — the ref cannot be read or its state is unusable: FAIL CLOSED without any mutation", () => {
    assert.match(compareRun, /code="transport-error"/, "a curl transport failure is captured as an unreadable state");
    assert.match(compareRun, /CASE D[\s\S]*fail closed/s, "the unreadable state is classified CASE D and fails closed");
    assert.match(compareRun, /unusable object\.sha/, "an HTTP 200 response without a usable object.sha cannot establish state");
    const caseDPaths = compareRun.split("CASE D").slice(1).join("CASE D");
    assert.match(caseDPaths, /exit 1/, "CASE D fails the job");
    assert.match(caseDPaths, /no mutation was issued/, "CASE D records that nothing was mutated");
    assert.ok(!/gh api\s+--method\s+(POST|PATCH|DELETE)/.test(compareRun), "no mutation exists anywhere in the compare step (fail closed means exactly that)");
  });

  test("an ambiguous activation API outcome is decided from the REMOTE state; an unusable captured NEW_SHA fails closed (never message equality)", () => {
    // The decision inputs are the observed ref sha and THIS run's captured
    // created-object sha — NOT steps.activate.outcome, NOT step status,
    // and NEVER the pointer message.
    assert.match(compareRun, /if \[ "\$sha" = "\$NEW_SHA" \]; then/, "ownership is anchored on the live ref's EXACT tag-object sha");
    // TENTH-ROUND CORRECTION: an activation whose output capture died
    // mid-flight (absent/empty/malformed NEW_SHA) can NO LONGER be
    // recognized by pointer-message equality — that state is classified
    // CASE D (identity cannot be established) and FAILS CLOSED.
    assert.ok(!compareRun.includes('[ "$message" = "$POINTER_JSON" ]'), "an interrupted capture is never papered over with a message-equality test");
    assert.match(compareRun, /ownership identity cannot be established/, "an unusable NEW_SHA classifies the live state as unknown (CASE D) and fails closed");
    const newShaGate = compareRun.split("NEW_SHA\" | grep -Eq")[1] ?? "";
    assert.match(newShaGate, /exit 1/, "the unusable-NEW_SHA path fails closed");
    assert.match(newShaGate, /OPERATOR INTERVENTION REQUIRED/, "the unusable-NEW_SHA path demands operator intervention");
    assert.ok(!(compare["if"] as string).includes("steps.activate.outcome") && !(mutate["if"] as string).includes("steps.activate.outcome"), "neither the compare nor the mutation consults the activation step's reported outcome");
    // The design is documented in the workflow itself.
    const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
    assert.match(raw, /rollback decision is therefore made from the OBSERVED REMOTE/, "the remote-state decision design is documented on the compare step");
    assert.match(raw, /Pointer-message equality is NOT an ownership\s*\n\s*# test/, "the ownership-identity rule (message equality \u2260 identity) is documented on the compare step");
  });

  test("PAT isolation holds across the in-job rollback chain: only the mutation step carries the release-write credential", () => {
    assert.equal(stepEnv(compare)["GH_TOKEN"], "${{ github.token }}", "the compare uses the READ-ONLY automatic token");
    assert.equal(stepEnv(verify)["GH_TOKEN"], "${{ github.token }}", "the read-back uses the READ-ONLY automatic token");
    assert.equal(stepEnv(mutate)["GH_TOKEN"], "${{ secrets.GY_RELEASE_PAT }}", "ONLY the mutation step carries the PAT");
    // The PAT-bearing mutation step makes no authenticated reads.
    assert.ok(!/git\/ref\/tags/.test(mutateRun), "the mutation step never doubles as a query gate");
    assert.ok(!/\bnode\b|pnpm|npm|npx|\.mjs|tsx/.test(mutateRun), "the mutation step executes only pinned gh api, never custom code");
  });

  test("a rollback mutation or read-back failure reports failure loudly and preserves diagnostic evidence", () => {
    // Unusable previous-pointer evidence refuses the blind restore.
    assert.match(mutateRun, /refusing a blind rollback/, "an unusable recorded pointer refuses a blind restore");
    assert.match(mutateRun, /OPERATOR INTERVENTION REQUIRED/, "the refusal is an explicit operator-intervention failure");
    // The read-back failure path preserves the full evidence.
    assert.match(verifyRun, /ROLLBACK UNVERIFIED[\s\S]*exit 1/s, "an unverifiable restoration fails LOUDLY");
    assert.match(verifyRun, /OPERATOR INTERVENTION REQUIRED/, "the unverified state demands operator intervention");
    assert.match(verifyRun, /GITHUB_STEP_SUMMARY/, "the evidence (previous pointer JSON + restoration procedure) is preserved in the run summary");
    assert.match(verifyRun, /PREV_POINTER_JSON/, "the recorded previous pointer JSON is part of the preserved evidence");
    assert.match(verifyRun, /docs\/SNAPSHOT_PUBLICATION\.md §13\.3/, "the operator is given the documented restoration path");
    assert.match(verifyRun, /The run does NOT claim the pointer was restored/, "the run never claims restoration without evidence");
  });
});

// ─── Ninth round (review Findings 2 and 3) — rehearsal corrections ──────────
//
// Finding 2: the rehearsal's first-publication rollback drill DELETES the
// dedicated reference; the former reactivation step then unconditionally
// PATCHed it — an endpoint that requires an EXISTING ref, so the expected
// first-publication happy path could never complete. The corrected
// reactivation is aware of the actual reference state (404 → POST /git/refs,
// 200 → PATCH, else fail closed) and verifies the result in both paths.
//
// Finding 3: the rehearsal previously demonstrated rollback API operations
// via a MANUAL drill, but never proved that a failure AFTER activation
// actually invokes the failure-triggered rollback path. The new
// `post-activation-failure` scenario injects a deliberate, controlled
// failure after a VERIFIED activation and exercises the SAME `if: failure()`
// gating production uses, including compare-before-rollback.

describe("rehearsal-publication workflow — state-aware reactivation (ninth round, Finding 2)", () => {
  const loadRehearsal = (): Workflow => {
    const raw = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
    const json = execFileSync(
      "python3",
      ["-c", "import sys,yaml,json;d=yaml.safe_load(sys.stdin.read());\nif True in d: d['on']=d.pop(True)\nprint(json.dumps(d))"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, input: raw },
    );
    return JSON.parse(json) as Workflow;
  };
  const rehearsal = loadRehearsal();
  const steps = rehearsal.jobs["rehearse"]!.steps;
  const reactivate = steps.find((s) => typeof s["name"] === "string" && (s["name"] as string).startsWith("Re-activate the rehearsal pointer"))!;
  const reactivateRun = (reactivate["run"] as string) ?? "";

  test("reactivation is state-aware: an ABSENT reference is re-created via POST repos/$REPO/git/refs", () => {
    assert.match(reactivateRun, /case "\$code" in/, "the reactivation reads the actual reference state first");
    assert.match(reactivateRun, /reactivation from an ABSENT reference \(first-publication restore\): POST repos\/\$REPO\/git\/refs/, "the absent-ref path is explicit");
    assert.match(reactivateRun, /gh api --method POST "repos\/\$REPO\/git\/refs" \\\n\s*-f ref="\$STABLE_REF" \\\n\s*-f sha="\$new_sha"/, "a deleted reference is re-created with POST repos/$REPO/git/refs (never PATCH)");
  });

  test("reactivation onto an EXISTING reference uses the repository-qualified PATCH", () => {
    assert.match(reactivateRun, /reactivation onto an EXISTING reference: PATCH repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod/, "the existing-ref path is explicit");
    assert.match(reactivateRun, /gh api --method PATCH "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod" \\\n\s*-f sha="\$new_sha" \\\n\s*-F force=true/, "an existing reference is moved with the repository-qualified PATCH");
  });

  test("BOTH reactivation paths read back and verify the expected annotated tag object, then the full identity chain", () => {
    assert.match(reactivateRun, /\[ "\$sha" != "\$new_sha" \]/, "the reactivated ref is read back against the created tag object");
    assert.match(reactivateRun, /REACTIVATION READ-BACK MISMATCH/, "a divergence fails loudly in BOTH paths");
    assert.match(reactivateRun, /\[ "\$message" != "\$POINTER_JSON" \]/, "the reactivated tag object's message is verified against the pointer JSON");
    assert.match(reactivateRun, /verify-stable "\$REPO" --expected-tag "\$TAG"/, "the full production identity chain confirms the reactivated pointer");
  });

  test("an unexpected or ambiguous reference state fails closed (never PATCH-into-404, never guess)", () => {
    assert.match(reactivateRun, /\*\) echo "reactivation gate FAILED \(unexpected HTTP \$code\); refusing to reactivate"; exit 1/, "any status other than 404/200 aborts the reactivation");
    assert.match(reactivateRun, /\[ "\$code" != "404" \] && \[ "\$code" != "200" \]|\*\) echo "reactivation gate FAILED/, "the gate is a genuine three-way classification");
  });

  test("the first-publication drill deletes the reference and reactivation completes the cycle (404 → POST)", () => {
    const rollbackDrill = steps.find((s) => typeof s["name"] === "string" && (s["name"] as string).startsWith("Rollback drill"))!;
    const drillRun = (rollbackDrill["run"] as string) ?? "";
    assert.match(drillRun, /\[ "\$PRIOR_KIND" = "found" \]/, "the drill branches on the recorded prior state");
    assert.match(drillRun, /gh api --method DELETE "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"/, "the first-publication branch DELETES the ref");
    assert.match(drillRun, /\[ "\$code" != "404" \]/, "and proves absence by a genuine 404 read-back");
    // The reactivation step's POST branch is what completes the deleted-ref
    // cycle — PATCH (the retired unconditional endpoint) would fail here.
    assert.match(reactivateRun, /POST repos\/\$REPO\/git\/refs/, "the deleted-ref cycle ends in a POST re-creation");
  });
});

describe("rehearsal-publication workflow — genuine post-activation failure injection (ninth round, Finding 3)", () => {
  const loadRehearsal = (): Workflow => {
    const raw = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
    const json = execFileSync(
      "python3",
      ["-c", "import sys,yaml,json;d=yaml.safe_load(sys.stdin.read());\nif True in d: d['on']=d.pop(True)\nprint(json.dumps(d))"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, input: raw },
    );
    return JSON.parse(json) as Workflow;
  };
  const rehearsal = loadRehearsal();
  const steps = rehearsal.jobs["rehearse"]!.steps;
  const names = steps.map((s) => String(s["name"] ?? s["uses"] ?? ""));
  const inject = steps.find((s) => s["id"] === "inject_failure")!;
  const frRollback = steps.find((s) => s["id"] === "failure_rollback")!;
  const verifyChainIdx = names.findIndex((n) => n.startsWith("Verify the stable reference serves the activated artifact"));
  const injectIdx = names.findIndex((n) => n.startsWith("INJECT a controlled post-activation failure"));
  const rollbackIdx = names.findIndex((n) => n.startsWith("Failure-triggered rollback"));

  test("the post-activation-failure scenario is a declared dispatch input", () => {
    const raw = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
    assert.match(raw, /post-activation-failure/, "the scenario exists");
  });

  test("the failure is injected strictly AFTER the stable reference has verifiably moved", () => {
    assert.ok(injectIdx > verifyChainIdx, `the injection step runs after the activation + read-back + identity-chain verification (inject=${injectIdx}, verify=${verifyChainIdx})`);
    const injectRun = (inject["run"] as string) ?? "";
    // Pre-injection precondition: the ref MUST point at this run's tag object.
    assert.match(injectRun, /\[ "\$sha" != "\$NEW_TAG_OBJECT_SHA" \]/, "the injection verifies the ref points at this run's tag object first");
    assert.match(injectRun, /INJECTION PRECONDITION FAILED/, "an unexpected pre-injection state refuses the injection");
    // The failure itself is deliberate and identifiable — an explicit exit.
    assert.match(injectRun, /exit 1/, "the failure is an explicit, controlled exit");
    assert.match(injectRun, /INJECTED POST-ACTIVATION FAILURE/, "the injection is identifiable in the log");
    assert.match(injectRun, /::error::INJECTED POST-ACTIVATION FAILURE/, "the injection is announced as a workflow error annotation");
    assert.ok(!injectRun.includes("gh release delete") && !injectRun.includes("gh api --method DELETE"), "the injection performs NO destructive action");
  });

  test("the FAILURE-TRIGGERED rollback path runs: gated on failure() after the injected step failed", () => {
    assert.equal(
      frRollback["if"],
      "failure() && env.SCENARIO == 'post-activation-failure' && steps.inject_failure.outcome == 'failure'",
      "the rollback runs because the injected step FAILED (the same failure() gating production uses) — not via a manual invocation",
    );
    assert.ok(rollbackIdx > injectIdx, "the rollback step is ordered after the injection step");
    // The rollback step exists and performs the real restore operations.
    const runs = (frRollback["run"] as string) ?? "";
    assert.match(runs, /--method POST "repos\/\$REPO\/git\/tags"/, "the previous pointer tag object is re-created");
    assert.match(runs, /--method PATCH "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod" -f sha="\$old_sha" -F force=true/, "the previous pointer is restored");
    assert.match(runs, /--method DELETE "repos\/\$REPO\/git\/refs\/tags\/console-snapshot-prod"/, "the first-publication absent state is restored by deleting the ref");
  });

  test("the compare-before-rollback guard is exercised INSIDE the failure-triggered rollback", () => {
    const runs = (frRollback["run"] as string) ?? "";
    assert.match(runs, /COMPARE-BEFORE-ROLLBACK/, "the live ref is classified BEFORE any mutation");
    assert.match(runs, /git\/ref\/tags\/console-snapshot-prod/, "the comparison reads the LIVE reference");
    // TENTH-ROUND CORRECTION (ownership identity): the guard anchors on
    // THIS run's captured tag-object sha ONLY — pointer-message equality
    // (even byte-for-byte) is NOT an ownership test.
    assert.match(runs, /if \[ "\$sha" = "\$NEW_TAG_OBJECT_SHA" \]; then/, "the guard anchors on THIS run's tag-object EXACT sha identity (a single strict condition)");
    assert.ok(!runs.includes('|| [ "$message" = "$POINTER_JSON" ]'), "pointer-message equality is NO LONGER an ownership alternative");
    assert.ok(!runs.includes('[ "$message" = "$POINTER_JSON" ]'), "no message-equality ownership test exists anywhere in the failure-triggered rollback");
    assert.match(runs, /identity cannot be established/, "an unusable captured sha fails closed (identity cannot be established)");
    assert.match(runs, /OPERATOR INTERVENTION REQUIRED/, "an independently moved ref triggers the refusal");
    assert.match(runs, /refusing to overwrite it|refusing a blind recreation/, "both unexpected states refuse mutation");
    assert.match(runs, /fail closed, no mutation/, "an unreadable ref state fails closed");
    // The compare precedes every mutation command in the script.
    const compareEnd = runs.indexOf("esac") + "esac".length;
    const firstMutation = runs.search(/gh api --method (POST|PATCH|DELETE)/);
    assert.ok(firstMutation > compareEnd, "no mutation command appears before the compare classification completes");
  });

  test("the restored state is verified: full identity chain for the previous pointer, genuine 404 for first publication", () => {
    const runs = (frRollback["run"] as string) ?? "";
    assert.match(runs, /verify-stable "\$REPO" --expected-tag "\$PRIOR_TAG"/, "the restored pointer is verified through the FULL production identity chain");
    assert.match(runs, /\[ "\$code_after" != "404" \]/, "the first-publication restore proves absence by a genuine 404 read-back");
    assert.match(runs, /SAFETY FAILURE: the ref read returned HTTP \$code_after/, "any other read-back result fails loudly");
    assert.match(runs, /failure-triggered rollback VERIFIED/, "the verified restoration is reported distinctly");
  });

  test("the injected scenario is NEVER reported as an ordinary successful publication", () => {
    // The happy-scenario result step is gated to the happy scenario only.
    const happyResult = steps.find((s) => typeof s["name"] === "string" && (s["name"] as string).startsWith("Rehearsal result (happy)"))!;
    assert.equal(happyResult["if"], "env.SCENARIO == 'happy'", "the success summary cannot fire for the injected-failure scenario");
    // The scenario's own result step runs always() and declares the EXPECTED failure.
    const scenarioResult = steps.find((s) => typeof s["name"] === "string" && (s["name"] as string).startsWith("Rehearsal result (post-activation-failure)"))!;
    assert.equal(scenarioResult["if"], "always() && env.SCENARIO == 'post-activation-failure'", "the scenario summary is written even when the job failed");
    const resultRun = (scenarioResult["run"] as string) ?? "";
    assert.match(resultRun, /run conclusion: EXPECTED FAILURE \(injected\)/, "the summary declares the injected failure");
    assert.match(resultRun, /NOT a successful publication/, "the summary explicitly disclaims publication success");
    assert.match(resultRun, /job outcome: \$\{\{ job\.status \}\}/, "the actual job outcome is reported, not asserted to be success");
    // The four phases are reported distinctly.
    for (const phase of ["Phase 1", "Phase 2", "Phase 3", "Phase 4"]) {
      const raw = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
      assert.ok(raw.includes(phase), `phase marker ${phase} exists in the workflow`);
    }
  });

  test("the rehearsal hard guard and repository scoping are untouched by the new scenario", () => {
    const raw = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
    assert.match(raw, /GraveYield\/grave-indexer-pub-rehearsal/, "the rehearsal still targets only the designated repository");
    assert.ok(!raw.includes("secrets."), "no repository secret is referenced anywhere in the rehearsal");
    const guard = steps[0]!;
    const guardRun = (guard["run"] as string) ?? "";
    assert.match(guardRun, /grave-indexer-pub-rehearsal/, "the FIRST step is still the hard repository-identity guard");
    // The new scenario's rollback runs in the same single job — after the guard.
    const guardIdx = names.findIndex((n) => n.startsWith("HARD GUARD"));
    assert.equal(guardIdx, 0, "the guard remains the first step");
    assert.ok(rollbackIdx > guardIdx, "the failure-triggered rollback runs after the guard");
  });
});

// ─── Tenth round — rollback ownership: strict tag-object SHA identity ────────
//
// The rollback comparison logic previously authorized the restore when the
// live ref's tag-object sha matched this run's NEW_SHA **or** the live tag
// object's message equaled this run's POINTER_JSON. Message equality is NOT
// an ownership test: a different writer can mint a DISTINCT annotated tag
// object whose message is byte-for-byte identical to this run's pointer JSON
// and move the stable ref to it — the rollback would then overwrite that
// independently created object. Pointer-message equality proves payload
// equality, not tag-object identity.
//
// The tests below EXECUTE the actual `run:` block text extracted from both
// workflows (production promote job `rollback_compare`, rehearsal
// `failure_rollback`) against mocked `curl` / `gh` / `node` binaries, so the
// classification AND the absence of mutation are proven against the real
// workflow scripts — not against copies or comment strings.

describe("rollback ownership — strict tag-object SHA identity (tenth round)", () => {
  const SHA_LIVE = "a".repeat(40); // a DIFFERENT writer's tag object (the live ref)
  const SHA_NEW = "b".repeat(40); // THIS run's created tag object (captured NEW_SHA)
  const SHA_PREV = "c".repeat(40); // the recorded previous pointer's tag object
  const POINTER_JSON = JSON.stringify({
    pointerSchema: "graveyield.console-snapshot-stable-pointer.v1",
    stableRef: "console-snapshot-prod",
    versionedTag: "console-snapshot-prod-20260101T000000Z-" + SHA_NEW,
    sourceCommit: "d".repeat(40),
  });

  interface SimResult {
    status: number;
    stdout: string;
    summary: string;
    outputs: string;
    ghCalls: string[];
  }

  function loadWorkflowFile(path: string): Workflow {
    const raw = readFileSync(path, "utf8");
    const json = execFileSync(
      "python3",
      ["-c", "import sys,yaml,json;d=yaml.safe_load(sys.stdin.read());\nif True in d: d['on']=d.pop(True)\nprint(json.dumps(d))"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, input: raw },
    );
    return JSON.parse(json) as Workflow;
  }

  const prodCompareRun = ((loadWorkflowFile(".github/workflows/publish-console-snapshot.yml").jobs["promote"]!)
    .steps.find((s) => s["id"] === "rollback_compare")!["run"] as string);
  const rehearsalRollbackRun = ((loadWorkflowFile(".github/workflows/rehearsal-publication.yml").jobs["rehearse"]!)
    .steps.find((s) => s["id"] === "failure_rollback")!["run"] as string);

  // Mock curl: in every curl call of both rollback scripts the URL is the
  // LAST argument. Serves the ref / tag-object state configured via env.
  const mockCurl = [
    "#!/usr/bin/env bash",
    "# test-harness mock: serves the ref / tag-object state configured via env",
    'url=""',
    'outfile=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "-o" ]; then outfile="$a"; fi',
    '  prev="$a"',
    '  case "$a" in http://*|https://*) url="$a" ;; esac',
    "done",
    'case "$url" in',
    "  */git/ref/tags/*)",
    '    if [ -n "$outfile" ]; then printf "%s" "$MOCK_REF_BODY" > "$outfile"; fi',
    '    printf "%s" "$MOCK_REF_CODE"',
    "    ;;",
    "  */git/tags/*)",
    '    jq -cn --arg m "$MOCK_TAG_MESSAGE" "{message:\\$m}"',
    "    ;;",
    "  *)",
    '    echo "mock curl: unexpected URL: $url" >&2',
    "    exit 1",
    "    ;;",
    "esac",
  ].join("\n");
  const mockGh = '#!/usr/bin/env bash\nprintf \'%s\\n\' "gh $*" >> "$MOCK_GH_LOG"\nexit 0\n';
  const mockNode = '#!/usr/bin/env bash\nprintf \'%s\\n\' "node $*" >> "$MOCK_GH_LOG"\nexit 0\n';

  function runStepScript(script: string, env: Record<string, string>): SimResult {
    const dir = mkdtempSync(join(tmpdir(), "wf-ownership-sim-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), mockCurl, { mode: 0o755 });
    writeFileSync(join(bin, "gh"), mockGh, { mode: 0o755 });
    writeFileSync(join(bin, "node"), mockNode, { mode: 0o755 });
    const summaryPath = join(dir, "summary.md");
    const outputPath = join(dir, "outputs.txt");
    const ghLogPath = join(dir, "gh.log");
    writeFileSync(summaryPath, "");
    writeFileSync(outputPath, "");
    writeFileSync(ghLogPath, "");
    const scriptPath = join(dir, "step.sh");
    writeFileSync(scriptPath, script);
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
        encoding: "utf8",
        cwd: dir,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME ?? dir,
          GITHUB_STEP_SUMMARY: summaryPath,
          GITHUB_OUTPUT: outputPath,
          MOCK_GH_LOG: ghLogPath,
          ...env,
        },
      });
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string };
      status = e.status ?? 1;
      stdout = String(e.stdout ?? "");
    }
    const result: SimResult = {
      status,
      stdout,
      summary: readFileSync(summaryPath, "utf8"),
      outputs: readFileSync(outputPath, "utf8"),
      // every mutation (and every gh api call) issued by the step under test
      ghCalls: readFileSync(ghLogPath, "utf8").split("\n").filter((l) => l.startsWith("gh ")),
    };
    rmSync(dir, { recursive: true, force: true });
    return result;
  }

  const refBody = (sha: string) =>
    JSON.stringify({ ref: "refs/tags/console-snapshot-prod", object: { sha, type: "tag" } });

  function prodCompareEnv(overrides: Record<string, string>): Record<string, string> {
    return {
      REPO: "GraveYield/grave-indexer",
      REF_MODE: "update",
      PREV_TAG_OBJECT_SHA: SHA_PREV,
      PREV_VERSIONED_TAG: "console-snapshot-prod-20251231T000000Z-" + SHA_PREV,
      NEW_SHA: SHA_NEW,
      GH_TOKEN: "sim-read-only-token",
      MOCK_REF_CODE: "200",
      MOCK_REF_BODY: refBody(SHA_LIVE),
      MOCK_TAG_MESSAGE: POINTER_JSON, // byte-for-byte identical to this run's pointer JSON
      ...overrides,
    };
  }

  function rehearsalRollbackEnv(overrides: Record<string, string>): Record<string, string> {
    return {
      REPO: "GraveYield/grave-indexer-pub-rehearsal",
      PRIOR_KIND: "found",
      PRIOR_TAG: "console-snapshot-prod-20251231T000000Z-" + SHA_PREV,
      PRIOR_POINTER_JSON: POINTER_JSON,
      PRIOR_COMMIT: SHA_PREV,
      NEW_TAG_OBJECT_SHA: SHA_NEW,
      POINTER_JSON,
      GH_TOKEN: "sim-rehearsal-token",
      MOCK_REF_CODE: "200",
      MOCK_REF_BODY: refBody(SHA_LIVE),
      MOCK_TAG_MESSAGE: POINTER_JSON, // byte-for-byte identical to this run's pointer JSON
      ...overrides,
    };
  }

  test("Test A (production) — a DIFFERENT tag object whose message is byte-identical to this run's pointer JSON is Case C: rollback mutation refused", () => {
    const res = runStepScript(prodCompareRun, prodCompareEnv({}));
    assert.notEqual(res.status, 0, "the compare FAILS instead of authorizing a rollback");
    assert.ok(!res.outputs.includes("rollback_case=restore"), "the mutation gate never opens");
    assert.deepEqual(res.ghCalls, [], "NO PATCH/POST/DELETE is issued — message equality alone never authorizes mutation");
    assert.match(res.stdout, /CASE C/, "the live state is classified Case C (independently moved)");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
    assert.match(res.summary, /Message equality is NOT accepted as ownership/, "the summary explains why the identical message did not authorize mutation");
  });

  test("Test B (production) — missing captured NEW_SHA with a byte-identical pointer message live is Case D: fail closed, no mutation", () => {
    const res = runStepScript(prodCompareRun, prodCompareEnv({ NEW_SHA: "" }));
    assert.notEqual(res.status, 0, "the compare FAILS CLOSED when identity cannot be established");
    assert.ok(!res.outputs.includes("rollback_case=restore"), "the mutation gate never opens");
    assert.deepEqual(res.ghCalls, [], "NO PATCH/POST/DELETE is issued without an usable captured sha");
    assert.match(res.stdout, /CASE D/, "the live state is classified Case D (unknown identity)");
    assert.match(res.stdout, /ownership identity cannot be established/, "the run reports that identity cannot be established");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });

  test("control (production) — the EXACT captured sha authorizes restore even when the live message DIFFERS: identity is sha-based, not message-based", () => {
    const res = runStepScript(prodCompareRun, prodCompareEnv({
      NEW_SHA: SHA_LIVE, // the live ref points EXACTLY at this run's captured object ...
      MOCK_TAG_MESSAGE: "a different writer's message — ownership is decided by sha identity, not payload equality", // ... whose message differs
    }));
    assert.equal(res.status, 0, "the strict sha identity authorizes the rollback classification");
    assert.match(res.outputs, /rollback_case=restore/, "the strict sha identity opens the mutation gate");
    assert.match(res.stdout, /CASE B/,);
    assert.deepEqual(res.ghCalls, [], "the compare step itself issues no mutation (mutation is a separate gated step)");
  });

  test("Test A (rehearsal) — a DIFFERENT tag object whose message is byte-identical to this run's pointer JSON: failure-triggered rollback refused, no mutation", () => {
    const res = runStepScript(rehearsalRollbackRun, rehearsalRollbackEnv({}));
    assert.notEqual(res.status, 0, "the failure-triggered rollback FAILS instead of mutating");
    assert.deepEqual(res.ghCalls, [], "NO PATCH/POST/DELETE is issued — message equality alone never authorizes mutation");
    assert.match(res.stdout, /COMPARE-BEFORE-ROLLBACK FAILED/, "the guard refuses the mutation");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
    assert.match(res.summary, /message equality is NOT identity/, "the summary explains why the identical message did not authorize mutation");
  });

  test("Test B (rehearsal) — missing captured NEW_TAG_OBJECT_SHA with a byte-identical pointer message live: fail closed, no mutation", () => {
    const res = runStepScript(rehearsalRollbackRun, rehearsalRollbackEnv({ NEW_TAG_OBJECT_SHA: "" }));
    assert.notEqual(res.status, 0, "the failure-triggered rollback FAILS CLOSED when identity cannot be established");
    assert.deepEqual(res.ghCalls, [], "NO PATCH/POST/DELETE is issued without a usable captured sha");
    assert.match(res.stdout, /COMPARE-BEFORE-ROLLBACK FAILED/, "the guard refuses the mutation");
    assert.match(res.summary, /identity cannot be established/, "the run reports that identity cannot be established");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });

  test("control (rehearsal) — the EXACT captured sha authorizes the rollback even when the live message DIFFERS: the restore mutations are issued", () => {
    const res = runStepScript(rehearsalRollbackRun, rehearsalRollbackEnv({
      NEW_TAG_OBJECT_SHA: SHA_LIVE, // the live ref points EXACTLY at this run's captured object ...
      MOCK_TAG_MESSAGE: "a different writer's message — ownership is decided by sha identity, not payload equality", // ... whose message differs
    }));
    assert.equal(res.status, 0, "the strict sha identity authorizes the failure-triggered rollback");
    assert.match(res.stdout, /compare-before-rollback OK/, "the guard passes on exact sha identity alone");
    assert.ok(
      res.ghCalls.some((l) => l.includes("--method POST") && l.includes("/git/tags")),
      "the previous pointer tag object is re-created (mutation authorized ONLY by sha identity)",
    );
    assert.ok(
      res.ghCalls.some((l) => l.includes("--method PATCH") && l.includes("/git/refs/tags/console-snapshot-prod")),
      "the ref is moved back via the repository-qualified PATCH",
    );
  });

  test("rehearsal guard — an independently DELETED reference (404 after a verified activation) refuses mutation", () => {
    const res = runStepScript(rehearsalRollbackRun, rehearsalRollbackEnv({
      MOCK_REF_CODE: "404",
      MOCK_REF_BODY: "",
    }));
    assert.notEqual(res.status, 0, "the absence of the ref after a verified activation is NOT interpreted as the original state");
    assert.deepEqual(res.ghCalls, [], "NO mutation is issued against an independently deleted reference");
    assert.match(res.stdout, /refusing a blind recreation/, "the deleted reference is not blindly recreated");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });
});

// ─── Eleventh round — downstream rollback SHA-format validation ─────────────
//
// The dedicated downstream rollback job's Compare-before-rollback step
// compared the live stable-reference object.sha with NEW_SHA by raw
// equality ALONE. Two unusable values that happen to be equal — both
// empty ("" == ""), or both malformed but identical — would have
// authorized the rollback mutation without proving any tag-object
// identity, violating the strict identity rule the in-job rollback and
// the rehearsal rollback already enforce (tenth round). The correction
// format-validates BOTH values against ^[0-9a-f]{40}$ BEFORE the
// ownership comparison and fails closed (unknown state, no compare_ok
// output, no mutation, operator intervention required) when either is
// empty, malformed, unavailable, or otherwise unusable.
//
// These tests EXECUTE the actual compare step script extracted from the
// workflow and — behind its real `compare_ok` gate — the actual mutation
// step, against mocked `curl`/`gh` binaries. Refusal is proven by the
// gate never opening and ZERO mutation commands being invoked, not by
// string assertions. The mocked gh binary cannot reach GitHub, so even
// the authorized case performs no real mutation.

describe("publish-console-snapshot workflow — downstream rollback SHA-format validation (eleventh round)", () => {
  const SHA_LIVE = "a".repeat(40); // a valid 40-hex sha (a different writer's object)
  const SHA_NEW = "b".repeat(40); // a valid 40-hex sha (this run's captured created object)
  const SHA_PREV = "c".repeat(40); // the recorded previous pointer's tag object
  const MALFORMED = "not-a-sha-ZZZ"; // unusable: not 40 lowercase hex characters
  const POINTER_JSON = JSON.stringify({
    pointerSchema: "graveyield.console-snapshot-stable-pointer.v1",
    stableRef: "console-snapshot-prod",
    versionedTag: "console-snapshot-prod-20260101T000000Z-" + SHA_NEW,
    sourceCommit: "d".repeat(40),
  });

  const wf = loadWorkflow();
  const rollback = wf.jobs["rollback"]!;
  const compareStep = rollback.steps.find((s) => s["id"] === "compare")!;
  const mutateStep = rollback.steps.find((s) => s["id"] === "mutate")!;
  const compareRun = compareStep["run"] as string;
  const mutateRun = mutateStep["run"] as string;

  // Mock curl: the compare step only reads the dedicated ref endpoint
  // (`-o <file>` + `-w %{http_code}`). Serves the HTTP status and JSON
  // body configured via env — ALWAYS overwriting the output file, so no
  // state can leak between simulated runs.
  const mockCurl = [
    "#!/usr/bin/env bash",
    "# test-harness mock: serves the configured ref state",
    'outfile=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "-o" ]; then outfile="$a"; fi',
    '  prev="$a"',
    "done",
    'if [ -n "$outfile" ]; then printf "%s" "$MOCK_REF_BODY" > "$outfile"; fi',
    'printf "%s" "$MOCK_REF_CODE"',
  ].join("\n");
  // Mock gh: records every invocation (the ONLY way a mutation could be
  // issued) and exits 0 — it cannot reach GitHub at all.
  const mockGh = '#!/usr/bin/env bash\nprintf \'%s\\n\' "gh $*" >> "$MOCK_GH_LOG"\nexit 0\n';

  interface SimResult {
    compareStatus: number;
    stdout: string;
    summary: string;
    outputs: string;
    ghCalls: string[]; // every gh invocation recorded across the whole simulated chain
    mutateRan: boolean; // whether the compare_ok gate opened
  }

  function runDownstreamRollback(env: Record<string, string>): SimResult {
    const dir = mkdtempSync(join(tmpdir(), "wf-shaformat-sim-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), mockCurl, { mode: 0o755 });
    writeFileSync(join(bin, "gh"), mockGh, { mode: 0o755 });
    const summaryPath = join(dir, "summary.md");
    const ghLogPath = join(dir, "gh.log");
    writeFileSync(summaryPath, "");
    writeFileSync(ghLogPath, "");
    const runScript = (script: string, outputPath: string): { status: number; stdout: string } => {
      writeFileSync(outputPath, "");
      const scriptPath = join(dir, "step.sh");
      writeFileSync(scriptPath, script);
      try {
        const stdout = execFileSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
          encoding: "utf8",
          cwd: dir,
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HOME: process.env.HOME ?? dir,
            GITHUB_STEP_SUMMARY: summaryPath,
            GITHUB_OUTPUT: outputPath,
            MOCK_GH_LOG: ghLogPath,
            ...env,
          },
        });
        return { status: 0, stdout };
      } catch (err) {
        const e = err as { status?: number | null; stdout?: string };
        return { status: e.status ?? 1, stdout: String(e.stdout ?? "") };
      }
    };
    // 1) the actual compare step decides; its outputs open (or keep shut)
    //    the same gate the workflow's `if:` condition reads.
    const compareOut = join(dir, "compare-outputs.txt");
    const cmp = runScript(compareRun, compareOut);
    const outputs = readFileSync(compareOut, "utf8");
    // 2) the actual mutation step runs ONLY when the compare authorized
    //    the rollback (mirrors `if: steps.compare.outputs.compare_ok == 'true'`).
    let mutateRan = false;
    if (/(^|\n)compare_ok=true/.test(outputs)) {
      mutateRan = true;
      runScript(mutateRun, join(dir, "mutate-outputs.txt"));
    }
    const result: SimResult = {
      compareStatus: cmp.status,
      stdout: cmp.stdout,
      summary: readFileSync(summaryPath, "utf8"),
      outputs,
      ghCalls: readFileSync(ghLogPath, "utf8").split("\n").filter((l) => l.startsWith("gh ")),
      mutateRan,
    };
    rmSync(dir, { recursive: true, force: true });
    return result;
  }

  const refBody = (sha: string) =>
    JSON.stringify({ ref: "refs/tags/console-snapshot-prod", object: { sha, type: "tag" } });

  function baseEnv(overrides: Record<string, string>): Record<string, string> {
    return {
      REPO: "GraveYield/grave-indexer",
      NEW_SHA: SHA_NEW,
      GH_TOKEN: "sim-read-only-token",
      MOCK_REF_CODE: "200",
      MOCK_REF_BODY: refBody(SHA_NEW),
      // mutation-step env (consumed only when the gate opens)
      REF_MODE: "update",
      PREV_POINTER_JSON: POINTER_JSON,
      PREV_VERSIONED_TAG: "console-snapshot-prod-20251231T000000Z-" + SHA_PREV,
      ...overrides,
    };
  }

  // ── structural pins: the validation exists, runs BEFORE the ownership
  //    comparison, and the mutation stays behind the compare_ok gate ──
  test("the compare step format-validates BOTH identity values against ^[0-9a-f]{40}$ BEFORE the ownership comparison (read-only token)", () => {
    assert.equal(stepEnv(compareStep)["GH_TOKEN"], "${{ github.token }}", "the comparison runs with the READ-ONLY automatic token");
    assert.equal(stepEnv(compareStep)["NEW_SHA"], "${{ needs.promote.outputs.new_tag_object_sha }}", "the comparison anchors on THIS run's captured created tag-object sha");
    const checks = [...compareRun.matchAll(/printf '%s' "\$(NEW_SHA|sha)" \| grep -Eq '\^\[0-9a-f\]\{40\}\$'/g)].map((m) => m[1]);
    assert.ok(checks.includes("NEW_SHA"), "NEW_SHA is format-validated against ^[0-9a-f]{40}$ before any ownership decision");
    assert.ok(checks.includes("sha"), "the live ref's object.sha is format-validated against the SAME exact format");
    const firstCheck = compareRun.indexOf("grep -Eq '^[0-9a-f]{40}$'");
    const ownershipComparison = compareRun.indexOf('[ "$sha" != "$NEW_SHA" ]');
    const gateOutput = compareRun.indexOf("compare_ok=true");
    assert.ok(firstCheck > -1 && ownershipComparison > -1, "both the validation and the ownership comparison exist");
    assert.ok(firstCheck < ownershipComparison, "the format validation runs BEFORE the ownership comparison — an equal-but-invalid pair can never be compared");
    assert.ok(ownershipComparison < gateOutput, "compare_ok is written only AFTER the exact-equality check");
  });

  test("the mutation step remains gated on compare_ok with the step-scoped PAT — validation failures cannot reach it", () => {
    assert.equal(mutateStep["if"], "steps.compare.outputs.compare_ok == 'true'", "the mutation is unreachable unless the comparison authorized it");
    assert.equal(stepEnv(mutateStep)["GH_TOKEN"], "${{ secrets.GY_RELEASE_PAT }}", "the PAT remains scoped to the mutation step only");
    assert.ok(!compareRun.includes("GY_RELEASE_PAT"), "the compare step never touches the write credential");
    assert.ok(!/gh api --method (POST|PATCH|DELETE)/.test(compareRun), "the compare step itself issues NO gh api mutation — it is a pure read-only classification step");
  });

  // ── Case A: both SHA values empty ──
  test("Case A — NEW_SHA empty AND the live ref returns an empty sha: refuse, classify UNKNOWN, no mutation", () => {
    const res = runDownstreamRollback(baseEnv({ NEW_SHA: "", MOCK_REF_BODY: refBody("") }));
    assert.notEqual(res.compareStatus, 0, "the compare FAILS CLOSED instead of authorizing a rollback");
    assert.ok(!res.outputs.includes("compare_ok=true"), "the rollback authorization output is never set");
    assert.ok(!res.mutateRan, "the gated mutation step never runs");
    assert.deepEqual(res.ghCalls, [], "NO PATCH/POST/DELETE is invoked — equal-but-empty values never prove identity");
    assert.match(res.stdout, /UNKNOWN STATE/, "the state is classified as unknown");
    assert.match(res.stdout, /identity cannot be established/, "the run reports that identity cannot be established");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });

  // ── Case B: both SHA values malformed but identical ──
  test("Case B — NEW_SHA malformed AND the live ref returns the SAME malformed value: refuse, classify UNKNOWN, no mutation", () => {
    const res = runDownstreamRollback(baseEnv({ NEW_SHA: MALFORMED, MOCK_REF_BODY: refBody(MALFORMED) }));
    assert.notEqual(res.compareStatus, 0, "identical-but-malformed values FAIL CLOSED instead of authorizing a rollback");
    assert.ok(!res.outputs.includes("compare_ok=true"), "the rollback authorization output is never set");
    assert.ok(!res.mutateRan, "the gated mutation step never runs");
    assert.deepEqual(res.ghCalls, [], "NO PATCH/POST/DELETE is invoked — equal-but-malformed values never prove identity");
    assert.match(res.stdout, /UNKNOWN STATE/, "the state is classified as unknown");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });

  // extra: a valid captured sha with a MALFORMED live sha exercises the
  // live-side validation branch
  test("extra — valid captured NEW_SHA but a malformed live object.sha: refuse, classify UNKNOWN, no mutation", () => {
    const res = runDownstreamRollback(baseEnv({ NEW_SHA: SHA_NEW, MOCK_REF_BODY: refBody(MALFORMED) }));
    assert.notEqual(res.compareStatus, 0, "a malformed live sha FAILS CLOSED even when the captured sha is valid");
    assert.ok(!res.outputs.includes("compare_ok=true"), "the rollback authorization output is never set");
    assert.deepEqual(res.ghCalls, [], "NO mutation is invoked against an unusable live identity value");
    assert.match(res.stdout, /UNKNOWN STATE/, "the state is classified as unknown");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });

  // ── Case C: valid matching SHA values ──
  test("Case C — both values valid 40-hex and EXACTLY equal: comparison passes and rollback authorization is established (no real mutation)", () => {
    const res = runDownstreamRollback(baseEnv({}));
    assert.equal(res.compareStatus, 0, "two valid, exactly equal 40-hex SHAs authorize the rollback");
    assert.match(res.outputs, /compare_ok=true/, "the rollback authorization output is set");
    assert.match(res.stdout, /compare OK/, "the comparison passes explicitly");
    assert.ok(res.mutateRan, "the gated mutation step runs behind the authorization");
    // The only "mutations" here are against the in-sandbox mock binary —
    // they prove the gate OPENS; nothing reaches GitHub.
    assert.ok(
      res.ghCalls.some((l) => l.includes("--method POST") && l.includes("/git/tags")),
      "the previous pointer tag object is re-created (authorization flows to the mutation step)",
    );
    assert.ok(
      res.ghCalls.some((l) => l.includes("--method PATCH") && l.includes("/git/refs/tags/console-snapshot-prod")),
      "the ref is moved back via the repository-qualified PATCH",
    );
  });

  // ── Case D: valid but different SHA values ──
  test("Case D — both values valid 40-hex but DIFFERENT: refuse, operator intervention, no mutation", () => {
    const res = runDownstreamRollback(baseEnv({ MOCK_REF_BODY: refBody(SHA_LIVE) }));
    assert.notEqual(res.compareStatus, 0, "a moved pointer (different valid sha) REFUSES the rollback");
    assert.ok(!res.outputs.includes("compare_ok=true"), "the rollback authorization output is never set");
    assert.ok(!res.mutateRan, "the gated mutation step never runs");
    assert.deepEqual(res.ghCalls, [], "NO PATCH/POST/DELETE is invoked against a pointer that moved independently");
    assert.match(res.stdout, /refusing to overwrite a moved pointer/, "the refusal is explicit");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });

  // ── extra hardening: missing API fields and failed lookups ──
  test("extra — the ref response is missing the object.sha field entirely: refuse, classify UNKNOWN, no mutation", () => {
    const res = runDownstreamRollback(baseEnv({ MOCK_REF_BODY: "{}" }));
    assert.notEqual(res.compareStatus, 0, "a missing object.sha FAILS CLOSED (never compares an empty value)");
    assert.ok(!res.outputs.includes("compare_ok=true"), "the rollback authorization output is never set");
    assert.deepEqual(res.ghCalls, [], "NO mutation is invoked on a response without an object.sha");
    assert.match(res.stdout, /UNKNOWN STATE/, "the state is classified as unknown");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });

  test("extra — failed reference lookup (unexpected HTTP status): refuse, no mutation", () => {
    const res = runDownstreamRollback(baseEnv({ MOCK_REF_CODE: "500", MOCK_REF_BODY: "" }));
    assert.notEqual(res.compareStatus, 0, "a failed reference lookup refuses to authorize anything");
    assert.ok(!res.outputs.includes("compare_ok=true"), "the rollback authorization output is never set");
    assert.ok(!res.mutateRan, "the gated mutation step never runs");
    assert.deepEqual(res.ghCalls, [], "NO mutation is invoked from an unreadable remote state");
    assert.match(res.stdout, /unexpected HTTP/, "the failed lookup is reported as an unexpected state");
    assert.match(res.summary, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });
});

// ─── Twelfth round — draft-first immutable-release readiness ─────────────────
//
// The GitHub-enforced immutable-release status of the production repository
// is UNKNOWN (the authorized endpoint requires authentication; unauthorized
// calls return 401/403, which cannot distinguish "disabled" from "not
// visible"). The publication sequence must therefore be compatible with the
// feature ENABLED: assets can never be added to an already PUBLISHED release
// under enforcement, so the publisher now creates the versioned release as a
// DRAFT, uploads the assets BY RELEASE ID (the by-tag endpoint serves
// published releases only — GitHub REST, verified 2026-11-23), verifies the
// draft assets (presence + byte lengths + download-back digest belt +
// provenance tag), and only then publishes (PATCH draft=false,
// make_latest=false) — after which the read-only verify-versioned job still
// gates the pointer activation (needs: chain). These pins hold the sequence
// in place; they are workflow-text pins, NOT a substitute for the live
// rehearsal (docs/PUBLICATION_REHEARSAL.md).
describe("publish-console-snapshot workflow — draft-first immutable-release readiness (twelfth round)", () => {
  const wf = loadWorkflow();
  const release = wf.jobs["release"]!;
  const runs = runBlocks(release).join("\n");
  const steps = release.steps.filter((s) => typeof s["run"] === "string") as Array<Record<string, string>>;

  test("the versioned release is created as a DRAFT with --latest=false and --target pinned to the asserted commit", () => {
    assert.match(runs, /gh release create "\$TAG"/, "the release job creates the release");
    assert.match(runs, /--draft/, "the release is created as a DRAFT");
    assert.match(runs, /--latest=false/, "explicitly NOT latest");
    assert.match(runs, /--target "\$CHECKOUT_SHA"/, "at the pinned commit");
  });

  test("draft assets are uploaded BY RELEASE ID through the uploads.github.com endpoint (never by tag)", () => {
    assert.match(runs, /DRAFT_RELEASE_ID=\$\(gh api "repos\/\$REPO\/releases"/, "the draft's release id is resolved from the release LIST endpoint");
    assert.match(runs, /jq -r --arg tag "\$TAG" '\[\.\[\] \| select\(\.tag_name == \$tag and \.draft == true\)\]\[0\]\.id \/\/ 0'/, "the id resolution requires the release to be a DRAFT matching the tag");
    assert.match(runs, /case "\$DRAFT_RELEASE_ID" in[\s\S]*refusing to upload/, "an unresolvable draft id fails closed before any upload");
    assert.match(runs, /uploads\.github\.com\/repos\/\$REPO\/releases\/\$DRAFT_RELEASE_ID\/assets\?name=/, "assets are uploaded by release id, not by tag");
    assert.ok(!runs.includes("gh release upload"), "the by-tag upload command is gone (it cannot address a draft)");
  });

  test("the draft belt verifies presence, byte lengths, digests and provenance BEFORE publishing", () => {
    const beltIdx = runs.indexOf("draft asset presence check FAILED");
    const publishIdx = runs.indexOf("gh api --method PATCH \"repos/$REPO/releases/$DRAFT_RELEASE_ID\"");
    assert.ok(beltIdx > -1 && publishIdx > -1 && beltIdx < publishIdx, "the draft belt runs before the publish PATCH inside the release job");
    // FIFTEENTH ROUND: the expected asset list is sorted with LC_ALL=C so
    // it matches jq's codepoint sort byte-for-byte (the live rehearsal
    // proved the unsorted printf order could NEVER equal the sorted list:
    // "-" 0x2D sorts before "." 0x2E, putting provenance.json first).
    assert.match(runs, /expected_names=\$\(printf 'console-snapshot\.json\\nconsole-snapshot-provenance\.json\\nconsole-snapshot\.sha256' \| LC_ALL=C sort\)/, "exactly the three required assets are required (sorted to match jq's codepoint order)");
    assert.match(runs, /names=\$\(gh api "repos\/\$REPO\/releases\/\$DRAFT_RELEASE_ID\/assets" --jq '\[\.\[\]\.name\] \| sort \| join\("\\n"\)'\)/, "the observed asset list is sorted");
    assert.match(runs, /Accept: application\/octet-stream" "repos\/\$REPO\/releases\/assets\/\$asset_id"/, "the assets are downloaded BACK from the draft by asset id");
    assert.match(runs, /sha256sum -c console-snapshot\.sha256/, "the checksum belt runs over the exact uploaded bytes");
    // SIXTEENTH ROUND: the provenance-tag identity check is enforced by
    // the FULL local verification (verify-local-release-assets → the
    // verifyArtifactTriple core: versionedTag === expectedTag), which
    // replaces the former single jq probe and adds integrity +
    // completeness — no weaker parallel validator exists.
    assert.match(runs, /verify-local-release-assets --dir dl --expected-tag "\$TAG"/, "the full verification of the downloaded bytes names this run's expected tag");
    assert.match(runs, /uploaded_size.*vs local/, "recorded asset sizes must match the local bytes");
  });

  test("the publish step is explicit: PATCH draft=false + make_latest=false, then verified by read-back", () => {
    assert.match(runs, /-F draft=false[\s\S]*-f make_latest=false/s, "publish is draft=false with the latest designation explicitly pinned OFF");
    assert.match(runs, /publish verification FAILED/, "the published state is read back (draft flag + tag identity) and a mismatch fails the run");
    assert.ok(!runs.includes("make_latest=true") && !runs.includes("make_latest=legacy"), "the publish never promotes the repo-wide latest designation");
  });

  test("the downstream verification and activation ordering is unchanged: release → verify-versioned → promote", () => {
    const verifyVersioned = wf.jobs["verify-versioned"]!;
    const promote = wf.jobs["promote"]!;
    assert.equal(verifyVersioned.needs?.includes("release"), true, "the read-only same-release verification still follows the release job");
    assert.equal(promote.needs?.includes("verify-versioned"), true, "pointer activation is still gated on the published-release verification");
    assert.match(runBlocks(promote).join("\n"), /git\/tags[\s\S]*git\/refs/s, "the activation still creates the annotated pointer tag object and moves the ref");
  });

  test("the rehearsal mirrors the draft-first sequence (parity with production)", () => {
    const rawRehearsal = readFileSync(".github/workflows/rehearsal-publication.yml", "utf8");
    const strippedRehearsal = rawRehearsal.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    assert.match(strippedRehearsal, /--draft/, "the rehearsal creates versioned releases as DRAFTS like production");
    assert.match(strippedRehearsal, /uploads\.github\.com\/repos\/\$REPO\/releases\/\$DRAFT_RELEASE_ID\/assets/, "the rehearsal uploads assets by release id like production");
    assert.match(strippedRehearsal, /-F draft=false -f make_latest=false/, "the rehearsal publishes with draft=false + make_latest=false like production");
    assert.match(strippedRehearsal, /the incomplete release remains an un-published DRAFT/, "the partial-upload scenario proves an incomplete draft is NEVER published");
    assert.match(strippedRehearsal, /SAFETY FAILURE: the incomplete release was PUBLISHED/, "publishing an incomplete asset set fails the rehearsal loudly");
  });
});

// ─── Thirteenth round — failure-path draft cleanup ───────────────────────────
//
// The task-required residue bound: a failed publication run must not leave
// an orphaned draft behind. The failure-path cleanup step deletes ONLY the
// draft of THIS run, and ONLY after a release-by-ID read-back proves BOTH
// that the release is still a draft AND that it carries this run's exact
// tag. These tests EXECUTE the actual cleanup script extracted from the
// workflow against a stateful mock `gh` binary — so the deletion
// authorization logic (and every refusal path) is proven against the real
// workflow script, not against a transcription of it.
describe("publish-console-snapshot workflow — failure-path draft cleanup (thirteenth round)", () => {
  const TAG = "console-snapshot-prod-20260101T000000Z-" + "c".repeat(40);
  const FOREIGN_TAG = "console-snapshot-prod-20251231T000000Z-" + "d".repeat(40);
  const DRAFT_ID = "1234567";

  const wf = loadWorkflow();
  const release = wf.jobs["release"]!;
  const cleanupStep = release.steps.find((s) => s["id"] === "draft-cleanup")!;
  const cleanupRun = cleanupStep["run"] as string;

  // Mock gh: stateful — a state file represents the draft's existence on
  // the server. `--method DELETE` removes it (and is recorded); a GET
  // against an existing state serves the canned JSON (through real jq when
  // --jq is passed); a GET against a missing state fails with "Not Found"
  // exactly like gh api does for an absent release. It cannot reach GitHub.
  const mockGh = [
    "#!/usr/bin/env bash",
    "# test-harness mock: stateful gh api against a canned draft",
    'log="$MOCK_GH_LOG"; state="$MOCK_STATE_FILE"',
    'printf \'%s\\n\' "gh $*" >> "$log"',
    '[ "$1" = "api" ] || exit 0',
    'method=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "--method" ]; then method="$a"; fi; prev="$a"; done',
    'if [ "$method" = "DELETE" ]; then rm -f "$state"; exit 0; fi',
    'prev=""',
    'list=""',
    'for a in "$@"; do',
    '  case "$a" in */releases) list="$a" ;; esac',
    '  prev="$a"',
    'done',
    'url=""',
    'for a in "$@"; do case "$a" in repos/*) url="$a" ;; esac; done',
    'if [ -n "$url" ] && [ "${url##*/}" = "releases" ]; then',
    '  printf \'%s\\n\' "${MOCK_LIST_BODY:-[]}"',
    '  exit 0',
    'fi',
    'if [ -f "$state" ]; then',
    '  body=$(cat "$state")',
    '  jqexpr=""; prev=""',
    '  for a in "$@"; do if [ "$prev" = "--jq" ]; then jqexpr="$a"; fi; prev="$a"; done',
    '  if [ -n "$jqexpr" ]; then printf \'%s\' "$body" | jq -r "$jqexpr"; else printf \'%s\\n\' "$body"; fi',
    '  exit 0',
    'fi',
    'printf \'Not Found\\n\' >&2',
    'exit 1',
  ].join("\n");

  // Mock curl: the post-DELETE read-back classifies the EXACT HTTP status.
  // Default behavior mirrors the stateful server above: the release exists
  // (state file present) → 200; absent → a genuine 404. MOCK_READBACK_STATUS
  // forces any other status (401/403/429/5xx/...); MOCK_CURL_TRANSPORT_ERROR
  // makes curl itself fail (network failure). It cannot reach GitHub.
  const mockCurl = [
    "#!/usr/bin/env bash",
    "# test-harness mock: status-only release read-back",
    'url=""',
    'for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done',
    'case "$url" in',
    '  */releases/$MOCK_RELEASE_ID_URL) ;;',
    '  *) if [ -n "$MOCK_CURL_ALLOWED_PREFIX" ] && [ "${url#$MOCK_CURL_ALLOWED_PREFIX}" = "$url" ]; then echo "unexpected url: $url" >&2; exit 1; fi ;;',
    'esac',
    'if [ -n "${MOCK_CURL_TRANSPORT_ERROR:-}" ]; then echo "curl: (7) connection refused (mock)" >&2; exit 7; fi',
    'state="$MOCK_STATE_FILE"',
    'if [ -n "${MOCK_READBACK_STATUS:-}" ]; then printf \'%s\' "$MOCK_READBACK_STATUS"; exit 0; fi',
    'if [ -f "$state" ]; then printf \'%s\' "200"; else printf \'%s\' "404"; fi',
    'exit 0',
  ].join("\n");

  interface CleanupResult {
    status: number;
    stdout: string;
    ghCalls: string[];
    deleted: boolean; // whether a --method DELETE was invoked at all
  }

  function runCleanup(env: Record<string, string>): CleanupResult {
    const dir = mkdtempSync(join(tmpdir(), "wf-draftcleanup-sim-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), mockGh, { mode: 0o755 });
    writeFileSync(join(bin, "curl"), mockCurl, { mode: 0o755 });
    const ghLogPath = join(dir, "gh.log");
    const statePath = join(dir, "draft-state.json");
    writeFileSync(ghLogPath, "");
    if (env.MOCK_DRAFT_BODY) writeFileSync(statePath, env.MOCK_DRAFT_BODY);
    const scriptPath = join(dir, "step.sh");
    writeFileSync(scriptPath, cleanupRun);
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
        encoding: "utf8",
        cwd: dir,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME ?? dir,
          MOCK_GH_LOG: ghLogPath,
          MOCK_STATE_FILE: statePath,
          MOCK_RELEASE_ID_URL: DRAFT_ID,
          ...env,
        },
      });
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string };
      status = e.status ?? 1;
      stdout = String(e.stdout ?? "");
    }
    const ghCalls = readFileSync(ghLogPath, "utf8").split("\n").filter((l) => l.startsWith("gh "));
    const result: CleanupResult = {
      status,
      stdout,
      ghCalls,
      deleted: ghCalls.some((l) => l.includes("--method DELETE")),
    };
    rmSync(dir, { recursive: true, force: true });
    return result;
  }

  const draftBody = (draft: boolean, tag: string) => JSON.stringify({ id: Number(DRAFT_ID), draft, tag_name: tag });

  function baseEnv(overrides: Record<string, string>): Record<string, string> {
    return {
      REPO: "GraveYield/grave-indexer",
      TAG,
      DRAFT_RELEASE_ID: DRAFT_ID,
      MOCK_DRAFT_BODY: draftBody(true, TAG),
      ...overrides,
    };
  }

  // ── structural pins ──
  test("the cleanup step exists behind `if: failure()`, carries the step-scoped PAT, and runs AFTER the verify+publish step", () => {
    assert.ok(cleanupStep, "the draft-cleanup step exists in the release job");
    assert.equal(cleanupStep["if"], "failure()", "the cleanup runs ONLY on job failure");
    assert.equal(((cleanupStep["env"] ?? {}) as Record<string, string>)["GH_TOKEN"], "${{ secrets.GY_RELEASE_PAT }}", "the cleanup carries the PAT as step-level env (deleting a draft requires push access)");
    const stepsWithRun = release.steps.filter((s) => typeof s["run"] === "string");
    const publishIdx = stepsWithRun.findIndex((s) => (s["run"] as string).includes("draft assets verified and release published"));
    const cleanupIdx = stepsWithRun.indexOf(cleanupStep as unknown as Record<string, string>);
    assert.ok(publishIdx > -1 && cleanupIdx > publishIdx, "the cleanup step is positioned after the publish step");
  });

  test("the cleanup deletes ONLY after a by-ID read-back proves draft==true AND this run's exact tag", () => {
    assert.match(cleanupRun, /draft_state=\$\(gh api "repos\/\$REPO\/releases\/\$DRAFT_RELEASE_ID"/, "the draft state is read back BY ID before any deletion");
    assert.match(cleanupRun, /is_draft=\$\(printf '%s' "\$draft_state" \| jq -r '\.draft'\)/, "the draft flag is checked from the read-back");
    assert.match(cleanupRun, /draft_tag=\$\(printf '%s' "\$draft_state" \| jq -r '\.tag'\)/, "the tag is checked from the read-back");
    const verifyIdx = cleanupRun.indexOf('if [ "$is_draft" != "true" ]');
    const deleteIdx = cleanupRun.indexOf("--method DELETE");
    assert.ok(verifyIdx > -1 && deleteIdx > -1 && verifyIdx < deleteIdx, "the draft-flag verification precedes the DELETE");
    assert.match(cleanupRun, /refusing to delete a foreign release/, "a tag mismatch refuses the deletion");
    assert.match(cleanupRun, /a published release is NEVER deleted/, "a published release is never deleted");
  });

  // ── executed behavior ──
  test("happy cleanup: the verified draft of this run is deleted and the deletion is proven by read-back", () => {
    const res = runCleanup(baseEnv({}));
    assert.equal(res.status, 0, "the cleanup succeeds");
    assert.equal(res.deleted, true, "the DELETE is invoked");
    const deletes = res.ghCalls.filter((l) => l.includes("--method DELETE"));
    assert.equal(deletes.length, 1, "exactly ONE deletion is issued (against the mock, never GitHub)");
    assert.match(deletes[0]!, /releases\/1234567/, "the deletion addresses the release BY ID");
    assert.match(res.stdout, /verified: the un-published draft 1234567/, "the deletion is proven by read-back (the mock now serves 404)");
  });

  test("a PUBLISHED release (draft=false at read-back) is NEVER deleted — operator intervention is required", () => {
    const res = runCleanup(baseEnv({ MOCK_DRAFT_BODY: draftBody(false, TAG) }));
    assert.notEqual(res.status, 0, "the cleanup refuses");
    assert.equal(res.deleted, false, "NO deletion is invoked against a published release");
    assert.match(res.stdout, /a published release is NEVER deleted/, "the refusal is explicit");
    assert.match(res.stdout, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });

  test("a FOREIGN tag at read-back refuses the deletion", () => {
    const res = runCleanup(baseEnv({ MOCK_DRAFT_BODY: draftBody(true, FOREIGN_TAG) }));
    assert.notEqual(res.status, 0, "the cleanup refuses a foreign tag");
    assert.equal(res.deleted, false, "NO deletion is invoked against a foreign release");
    assert.match(res.stdout, /refusing to delete a foreign release/, "the refusal is explicit");
  });

  test("an UNREADABLE release at read-back refuses the deletion (nothing unverifiable is deleted)", () => {
    const res = runCleanup(baseEnv({ MOCK_DRAFT_BODY: "" })); // no state file → the by-ID GET fails
    assert.notEqual(res.status, 0, "the cleanup refuses an unreadable release");
    assert.equal(res.deleted, false, "NO deletion is invoked when the release cannot be verified");
    assert.match(res.stdout, /refusing to delete an unverifiable release/, "the refusal is explicit");
    assert.match(res.stdout, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
  });

  test("no captured draft id AND no matching draft in the list → exit 0, zero deletions (failure happened before the draft existed)", () => {
    const res = runCleanup(baseEnv({ DRAFT_RELEASE_ID: "", MOCK_DRAFT_BODY: "", MOCK_LIST_BODY: "[]" }));
    assert.equal(res.status, 0, "nothing to clean up is a clean outcome");
    assert.equal(res.deleted, false, "NO deletion is issued");
    assert.match(res.stdout, /nothing to clean up/, "the outcome is explicit");
  });

  test("no captured draft id BUT the list holds this run's draft → the fallback resolves, verifies and deletes it", () => {
    const res = runCleanup(baseEnv({ DRAFT_RELEASE_ID: "", MOCK_DRAFT_BODY: draftBody(true, TAG), MOCK_LIST_BODY: `[{"id": ${DRAFT_ID}, "draft": true, "tag_name": "${TAG}"}]` }));
    assert.equal(res.status, 0, "the fallback completes the cleanup");
    assert.equal(res.deleted, true, "the resolved draft is deleted");
    assert.match(res.stdout, /verified: the un-published draft 1234567/, "the deletion is proven by read-back");
  });

  test("an unusable captured draft id fails closed without deletion", () => {
    const res = runCleanup(baseEnv({ DRAFT_RELEASE_ID: "not-a-number" }));
    assert.notEqual(res.status, 0, "an unusable id refuses");
    assert.equal(res.deleted, false, "NO deletion is issued");
    assert.match(res.stdout, /refusing to delete anything/, "the refusal is explicit");
  });

  // ── SIXTEENTH ROUND (P2): explicit post-DELETE read-back classification ──
  // The former read-back treated ANY failed release lookup after the DELETE
  // as proof of deletion. The script now classifies the exact HTTP outcome:
  // 404 = deletion confirmed; 200 = still exists (cleanup FAILED); every
  // auth/permission/rate-limit/outage/transport/unexpected outcome = the
  // deletion status is UNKNOWN. All of these EXECUTE the actual cleanup
  // script against mocked HTTP responses.
  test("STRUCTURAL: the read-back classifies the exact HTTP status and only 404 claims success", () => {
    assert.match(cleanupRun, /curl -sS -o \/dev\/null -w '%\{http_code\}'/, "the read-back captures the EXACT HTTP status code");
    assert.match(cleanupRun, /case "\$code" in/, "the status is classified explicitly");
    const idx404 = cleanupRun.indexOf('404) echo "verified: the un-published draft');
    const idx200 = cleanupRun.indexOf('200) echo "draft cleanup read-back FAILED');
    const idxOther = cleanupRun.indexOf('*) echo "draft cleanup read-back INCONCLUSIVE');
    assert.ok(idx404 > -1 && idx200 > -1 && idxOther > -1, "all three classification branches exist");
    assert.ok(idx404 < idx200 && idx200 < idxOther, "404 = confirmed, 200 = still exists, everything else = UNKNOWN");
    assert.match(cleanupRun, /the deletion status of release \$DRAFT_RELEASE_ID is UNKNOWN/, "a transport failure is classified UNKNOWN");
    assert.ok(!/if gh api "repos\/\$REPO\/releases\/\$DRAFT_RELEASE_ID" > \/dev\/null 2>&1/.test(cleanupRun), "the old any-failure-means-deleted pattern is GONE");
  });

  test("HTTP 200 at read-back: the release still EXISTS — cleanup FAILED, operator intervention required", () => {
    const res = runCleanup(baseEnv({ MOCK_READBACK_STATUS: "200" }));
    assert.notEqual(res.status, 0, "the cleanup does NOT claim success");
    assert.equal(res.deleted, true, "the DELETE was attempted (the failure is at read-back)");
    assert.match(res.stdout, /still EXISTS \(HTTP 200\)/, "the still-exists outcome is explicit");
    assert.match(res.stdout, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
    assert.ok(!res.stdout.includes("was deleted (read-back HTTP 404"), "successful deletion is NEVER claimed");
  });

  for (const status of ["401", "403", "429", "500", "503", "418"]) {
    test(`HTTP ${status} at read-back: the deletion status is UNKNOWN — never claimed successful`, () => {
      const res = runCleanup(baseEnv({ MOCK_READBACK_STATUS: status }));
      assert.notEqual(res.status, 0, "an inconclusive read-back never exits zero");
      assert.match(res.stdout, /the deletion status is UNKNOWN/, "the UNKNOWN classification is explicit");
      assert.match(res.stdout, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
      assert.ok(!res.stdout.includes("was deleted (read-back HTTP 404"), "successful deletion is NEVER claimed");
    });
  }

  test("a curl TRANSPORT failure at read-back: the deletion status is UNKNOWN — never claimed successful", () => {
    const res = runCleanup(baseEnv({ MOCK_CURL_TRANSPORT_ERROR: "1" }));
    assert.notEqual(res.status, 0, "a transport failure never exits zero");
    assert.match(res.stdout, /curl transport error/, "the transport failure is explicit");
    assert.match(res.stdout, /the deletion status of release 1234567 is UNKNOWN/, "the UNKNOWN classification is explicit");
    assert.match(res.stdout, /OPERATOR INTERVENTION REQUIRED/, "operator intervention is required");
    assert.ok(!res.stdout.includes("was deleted (read-back HTTP 404"), "successful deletion is NEVER claimed");
  });

  test("HTTP 404 at read-back is the ONLY verdict that claims the deletion succeeded", () => {
    const res = runCleanup(baseEnv({}));
    assert.equal(res.status, 0, "a genuine 404 confirms the deletion");
    assert.match(res.stdout, /was deleted \(read-back HTTP 404 — deletion confirmed\)/, "the success verdict names the confirming 404");
  });
});

// ─── Sixteenth round (P1) — complete draft verification before publication ──
//
// The former draft belt checked only presence, byte lengths, digests and the
// provenance tag on the DRAFT; the FULL schema-v2 + completeness verification
// happened only AFTER publication (verify-versioned). The corrected sequence
// retrieves the exact draft bytes with the PAT (retrieval ONLY — zero custom
// code), then runs the FULL existing release-ops verification core
// (`verify-local-release-assets` → `verifyArtifactTriple`) over those exact
// bytes in a step that carries NO credential, and only then publishes. These
// tests pin the structure AND execute the actual retrieval script against a
// stateful mock `gh` (the mock cannot reach GitHub; no mutation command can
// be issued against a real release).
describe("publish-console-snapshot workflow — complete draft verification before publication (sixteenth round, P1)", () => {
  const TAG = "console-snapshot-prod-20260101T000000Z-" + "c".repeat(40);
  const FOREIGN_TAG = "console-snapshot-prod-20251231T000000Z-" + "d".repeat(40);
  const DRAFT_ID = "1234567";

  const wf = loadWorkflow();
  const release = wf.jobs["release"]!;
  const stepsWithRun = release.steps.filter((s) => typeof s["run"] === "string") as Array<Record<string, string>>;

  const retrievalStep = stepsWithRun.find((s) => (s["run"] as string).includes("the exact draft bytes are retrieved"))!;
  const retrievalRun = retrievalStep["run"] as string;
  const fullVerifyStep = stepsWithRun.find((s) => (s["run"] as string).includes("verify-local-release-assets"))!;
  const fullVerifyRun = fullVerifyStep["run"] as string;
  const publishStep = stepsWithRun.find((s) => (s["run"] as string).includes("draft assets verified and release published"))!;

  // ── structural pins ──
  test("STRUCTURAL: the release sequence is create → retrieve → verify(full, credential-free) → publish → cleanup", () => {
    const order = stepsWithRun.map((s) => s["run"] as string);
    const createIdx = order.findIndex((r) => r.includes("draft release created and uploaded"));
    const retrieveIdx = order.indexOf(retrievalRun);
    const verifyIdx = order.indexOf(fullVerifyRun);
    const publishIdx = order.indexOf(publishStep["run"] as string);
    const cleanupIdx = order.findIndex((r) => r.includes("--method DELETE \"repos/$REPO/releases/$DRAFT_RELEASE_ID\""));
    assert.ok(createIdx > -1 && retrieveIdx > -1 && verifyIdx > -1 && publishIdx > -1 && cleanupIdx > -1, "all five steps exist");
    assert.ok(createIdx < retrieveIdx && retrieveIdx < verifyIdx && verifyIdx < publishIdx && publishIdx < cleanupIdx, "retrieve → FULL verify → publish ordering (the full verification gates the publish)");
  });

  test("STRUCTURAL: the full verification step carries NO credential and performs zero API calls (pure local verification)", () => {
    const env = stepEnv(fullVerifyStep);
    assert.ok(!("GH_TOKEN" in env) && !("GITHUB_TOKEN" in env) && !("GY_RELEASE_PAT" in env), "the verification step has NO token in its env — the write credential never coexists with repository-built code");
    assert.match(fullVerifyRun, /node ops\/release-ops\.mjs verify-local-release-assets --dir dl --expected-tag "\$TAG"/, "the FULL existing release-ops verification core runs over the exact downloaded bytes");
    assert.ok(!fullVerifyRun.includes("gh api") && !fullVerifyRun.includes("gh release") && !fullVerifyRun.includes("curl"), "the verification performs ZERO network/API calls (it verifies the bytes already retrieved)");
    assert.ok(!fullVerifyRun.includes("Authorization: Bearer"), "the verification never authenticates");
  });

  test("STRUCTURAL: the retrieval step carries the PAT, issues ONLY reads, and downloads by release ID", () => {
    assert.equal(stepEnv(retrievalStep)["GH_TOKEN"], "${{ secrets.GY_RELEASE_PAT }}", "the retrieval is the PAT-bearing step (a draft is only readable with push access)");
    assert.ok(!/gh api --method (POST|PATCH|DELETE)|gh release (create|upload|edit|delete)|curl -X (POST|PATCH|DELETE)/.test(retrievalRun), "the retrieval step issues NO mutation commands");
    assert.match(retrievalRun, /releases\/\$DRAFT_RELEASE_ID\/assets/, "assets are addressed by RELEASE ID (never by tag — drafts are unaddressable by tag)");
    assert.match(retrievalRun, /Accept: application\/octet-stream" "repos\/\$REPO\/releases\/assets\/\$asset_id"/, "each asset is downloaded by ASSET ID from that release");
  });

  test("STRUCTURAL: the verification rejects every required failure class before publication", () => {
    // The verification is the EXISTING release-ops core (verifyArtifactTriple —
    // shared with verify-release-assets), whose rejection matrix is pinned by
    // test/releaseOps.test.ts. Here we pin that the workflow invokes THAT
    // command with this run's expected tag, so no weaker parallel validator
    // exists at the workflow layer.
    assert.match(retrievalRun, /sha256sum -c console-snapshot\.sha256/, "the checksum belt still runs over the downloaded bytes in the retrieval step");
    assert.match(fullVerifyRun, /--expected-tag "\$TAG"/, "the verifier must check the provenance names THIS run's tag");
    assert.ok(!stepsWithRun.some((s) => (s["run"] as string).includes("verify-local-release-assets") && (s["run"] as string) !== fullVerifyRun), "EXACTLY ONE step runs the local verifier");
  });

  // ── executed retrieval behavior ──
  // Mock gh: stateful against a canned draft release + asset set. A GET of
  // the release record serves the canned JSON; a GET of the assets list
  // serves the canned array (through real jq when --jq is passed); a GET of
  // an asset id streams the canned bytes. It cannot reach GitHub, and every
  // invocation is logged so absence of mutation commands is PROVEN.
  function mockGhFor(body: string, assetsById: Record<string, string>): string {
    return [
      "#!/usr/bin/env bash",
      "# test-harness mock: stateful draft release + assets",
      'printf \'%s\\n\' "gh $*" >> "$MOCK_GH_LOG"',
      '[ "$1" = "api" ] || exit 0',
      'url=""; prev=""',
      'for a in "$@"; do case "$a" in repos/*|http://*|https://*) url="$a" ;; esac; prev="$a"; done',
      'if [ -n "$MOCK_REFUSE" ]; then echo "gh: mock refusal" >&2; exit 1; fi',
      'case "$url" in',
      '  */releases) printf \'%s\\n\' "${MOCK_LIST_BODY:-[]}" ;;',
      '  */assets)',
      '    body=$(cat "$MOCK_ASSETS_FILE")',
      '    jqexpr=""; prev=""',
      '    for a in "$@"; do if [ "$prev" = "--jq" ]; then jqexpr="$a"; fi; prev="$a"; done',
      '    if [ -n "$jqexpr" ]; then printf \'%s\' "$body" | jq -r "$jqexpr"; else printf \'%s\\n\' "$body"; fi ;;',
      `  */releases/${DRAFT_ID})`,
      '    body=$(cat "$MOCK_RELEASE_FILE")',
      '    jqexpr=""; prev=""',
      '    for a in "$@"; do if [ "$prev" = "--jq" ]; then jqexpr="$a"; fi; prev="$a"; done',
      '    if [ -n "$jqexpr" ]; then printf \'%s\' "$body" | jq -r "$jqexpr"; else printf \'%s\\n\' "$body"; fi ;;',
      '  */releases/assets/*)',
      '    id="${url##*/}"',
      '    file="$MOCK_ASSET_DIR/$id"',
      '    [ -f "$file" ] || { echo "asset $id not found" >&2; exit 1; }',
      '    cat "$file" ;;',
      '  *) echo "unexpected url: $url" >&2; exit 1 ;;',
      'esac',
    ].join("\n");
  }
  void mockGhFor;

  interface RetrievalResult {
    status: number;
    stdout: string;
    ghCalls: string[];
    files: Record<string, string>;
  }

  function runRetrieval(env: Record<string, string>): RetrievalResult {
    const dir = mkdtempSync(join(tmpdir(), "wf-draftretrieval-sim-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), env.MOCK_GH_SCRIPT!, { mode: 0o755 });
    const ghLogPath = join(dir, "gh.log");
    writeFileSync(ghLogPath, "");
    const scriptPath = join(dir, "step.sh");
    writeFileSync(scriptPath, retrievalRun);
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
        encoding: "utf8",
        cwd: dir,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME ?? dir,
          MOCK_GH_LOG: ghLogPath,
          REPO: "GraveYield/grave-indexer",
          TAG,
          DRAFT_RELEASE_ID: DRAFT_ID,
          ...env,
        },
      });
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string };
      status = e.status ?? 1;
      stdout = String(e.stdout ?? "");
    }
    const ghCalls = readFileSync(ghLogPath, "utf8").split("\n").filter((l) => l.startsWith("gh "));
    const files: Record<string, string> = {};
    const dl = join(dir, "dl");
    try {
      for (const name of ["console-snapshot.json", "console-snapshot-provenance.json", "console-snapshot.sha256"]) {
        const p = join(dl, name);
        if (existsSync(p)) files[name] = readFileSync(p, "utf8");
      }
    } catch { /* dl absent on refusal */ }
    rmSync(dir, { recursive: true, force: true });
    return { status, stdout, ghCalls, files };
  }

  // Server-side canned state: a valid artifact triple held by the "draft".
  const SNAPSHOT_BYTES = JSON.stringify({ schemaVersion: 2, pools: [], counts: { enriched: 0 }, failures: [] });
  const SNAPSHOT_SHA = createHash("sha256").update(SNAPSHOT_BYTES).digest("hex");
  const PROVENANCE_BYTES = JSON.stringify({ versionedTag: TAG, counts: { enriched: 0 } });
  const CHECKSUM_BYTES = `${SNAPSHOT_SHA}  console-snapshot.json\n`;

  function serverState(opts: { draft?: boolean; tag?: string; assetNames?: string[] }): Record<string, string> {
    const draft = opts.draft ?? true;
    const tag = opts.tag ?? TAG;
    const names = opts.assetNames ?? ["console-snapshot.json", "console-snapshot-provenance.json", "console-snapshot.sha256"];
    const assets = names.map((n, i) => ({ id: 11 + i, name: n }));
    const assetDir = mkdtempSync(join(tmpdir(), "wf-draftretrieval-assets-"));
    const releaseFile = join(assetDir, "release.json");
    const assetsFile = join(assetDir, "assets.json");
    writeFileSync(releaseFile, JSON.stringify({ id: Number(DRAFT_ID), draft, tag_name: tag }));
    writeFileSync(assetsFile, JSON.stringify(assets));
    // Asset 11 = snapshot, 12 = provenance, 13 = checksum (by position).
    const bytesFor = (i: number): string => (i === 0 ? SNAPSHOT_BYTES : i === 1 ? PROVENANCE_BYTES : CHECKSUM_BYTES);
    for (const [i] of names.entries()) writeFileSync(join(assetDir, String(11 + i)), bytesFor(i));
    dirsToClean.push(assetDir);
    return {
      MOCK_RELEASE_FILE: releaseFile,
      MOCK_ASSETS_FILE: assetsFile,
      MOCK_ASSET_DIR: assetDir,
    };
  }
  const dirsToClean: string[] = [];

  test("happy retrieval: the draft identity is re-proven, all three exact bytes are downloaded by ID, and ZERO mutation commands are issued", () => {
    const state = serverState({});
    const res = runRetrieval({ ...state, MOCK_GH_SCRIPT: mockGhFor("", {}) });
    assert.equal(res.status, 0, "the retrieval succeeds for this run's own draft");
    assert.equal(res.files["console-snapshot.json"], SNAPSHOT_BYTES, "the exact snapshot bytes are downloaded");
    assert.equal(res.files["console-snapshot-provenance.json"], PROVENANCE_BYTES, "the exact provenance bytes are downloaded");
    assert.equal(res.files["console-snapshot.sha256"], CHECKSUM_BYTES, "the exact checksum bytes are downloaded");
    assert.equal(res.ghCalls.filter((l) => /--method (POST|PATCH|DELETE)|gh release (create|upload|edit|delete)/.test(l)).length, 0, "NO mutation command was invoked");
    assert.match(res.stdout, /the exact draft bytes are retrieved/, "the completion is explicit");
  });

  test("a draft=false release at retrieval refuses — nothing is downloaded, ZERO mutation commands", () => {
    const state = serverState({ draft: false });
    const res = runRetrieval({ ...state, MOCK_GH_SCRIPT: mockGhFor("", {}) });
    assert.notEqual(res.status, 0, "a published release is never retrieved as a draft");
    assert.equal(Object.keys(res.files).length, 0, "NO bytes are downloaded from a published release");
    assert.match(res.stdout, /is NOT a draft/, "the refusal is explicit");
    assert.equal(res.ghCalls.filter((l) => /--method (POST|PATCH|DELETE)/.test(l)).length, 0, "NO mutation command was invoked");
  });

  test("a FOREIGN tag at retrieval refuses — nothing is downloaded, ZERO mutation commands", () => {
    const state = serverState({ tag: FOREIGN_TAG });
    const res = runRetrieval({ ...state, MOCK_GH_SCRIPT: mockGhFor("", {}) });
    assert.notEqual(res.status, 0, "a foreign release is never retrieved");
    assert.equal(Object.keys(res.files).length, 0, "NO bytes are downloaded from a foreign release");
    assert.match(res.stdout, /refusing to retrieve a foreign release/, "the refusal is explicit");
    assert.equal(res.ghCalls.filter((l) => /--method (POST|PATCH|DELETE)/.test(l)).length, 0, "NO mutation command was invoked");
  });

  test("an INCOMPLETE asset set on the draft fails the presence check before any full verification", () => {
    const state = serverState({ assetNames: ["console-snapshot.json", "console-snapshot.sha256"] });
    const res = runRetrieval({ ...state, MOCK_GH_SCRIPT: mockGhFor("", {}) });
    assert.notEqual(res.status, 0, "an incomplete draft cannot pass");
    assert.match(res.stdout, /draft asset presence check FAILED/, "the presence check is the gate");
    assert.equal(res.ghCalls.filter((l) => /--method (POST|PATCH|DELETE)/.test(l)).length, 0, "NO mutation command was invoked");
  });

  test("an unreadable release record fails closed before any download", () => {
    const state = serverState({});
    const res = runRetrieval({ ...state, MOCK_GH_SCRIPT: mockGhFor("", {}), MOCK_REFUSE: "1" });
    assert.notEqual(res.status, 0, "an unreadable release refuses");
    assert.match(res.stdout, /refusing to retrieve from an unverifiable release/, "the refusal is explicit");
    assert.equal(res.ghCalls.filter((l) => /--method (POST|PATCH|DELETE)/.test(l)).length, 0, "NO mutation command was invoked");
  });
});
