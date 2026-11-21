// SPDX-License-Identifier: Apache-2.0
//
// publish-console-snapshot.yml — workflow-level validation (GY-M1-INT-001
// correction §5; PR #5 remediation — review Tasks 1-5, Task 1 corrected
// twice). YAML parsing alone proves nothing about behavior, so these
// tests pin the SECURITY-CRITICAL structure of the real workflow file:
// trigger restrictions, least-privilege permissions, job separation
// (read-only preparation/verification vs the MINIMAL privileged release
// job), artifact integrity handling, release behavior (latest promotion,
// no clobber), concurrency, and explicit failure paths. The behavioral
// sequence itself is exercised end-to-end by
// test/snapshotPublicationSequence.test.ts.
//
// Parsing uses PyYAML via a thin synchronous bridge (no YAML dependency
// is added to the package manifest for a test-only concern).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
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

describe("publish-console-snapshot workflow — security-critical structure", () => {
  const wf = loadWorkflow();
  const generate = wf.jobs["generate"];
  const verify = wf.jobs["verify"];
  const publish = wf.jobs["publish"];
  const verifyStable = wf.jobs["verify-stable"];
  assert.ok(generate && verify && publish && verifyStable, "all four jobs exist");
  if (!generate || !verify || !publish || !verifyStable) throw new Error("workflow jobs missing");

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

  test("top-level permissions are read-only; ONLY the publish job gets contents:write", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    assert.equal(generate.permissions, undefined, "generate inherits the read-only default");
    assert.equal(verify.permissions, undefined, "verify inherits the read-only default");
    assert.deepEqual(publish.permissions, { contents: "write" });
    assert.equal(verifyStable.permissions, undefined, "verify-stable inherits the read-only default");
    assert.ok(publish.needs?.includes("generate") && publish.needs?.includes("verify"), "publish depends on BOTH read-only preparation jobs (job separation)");
    assert.ok(verify.needs?.includes("generate"), "verify depends on generate");
    assert.ok(verifyStable.needs?.includes("publish"), "verify-stable runs after publish");
  });

  test("concurrency: one publication at a time, never cancelled mid-run", () => {
    assert.equal(wf.concurrency.group, "publish-console-snapshot");
    assert.equal(wf.concurrency["cancel-in-progress"], false);
  });

  test("actions are pinned to full commit SHAs", () => {
    for (const job of [generate, verify, publish, verifyStable]) {
      for (const step of job.steps) {
        if (typeof step["uses"] === "string") {
          const ref = step["uses"].split("@")[1] ?? "";
          assert.match(ref, /^[0-9a-f]{40}/, `${step["uses"]} must be pinned to a full commit SHA`);
        }
      }
    }
  });

  test("dispatch inputs reach the CLI through env indirection and are validated as positive integers", () => {
    const runs = runBlocks(generate).join("\n");
    assert.ok(runs.includes("MAX_POOLS") && runs.includes("ENRICH"), "inputs are consumed from env, not inline interpolation");
    assert.ok(runs.includes("must be a positive integer"), "a numeric validation gate exists");
    assert.ok(
      !generate.steps.some(
        (s) => typeof s["run"] === "string" && (s["run"] as string).includes("${{ inputs."),
        "no direct ${{ inputs.* }} interpolation inside run blocks",
      ),
    );
  });

  test("the staged bundle passes between jobs through a named workflow artifact with fail-closed upload", () => {
    const up = generate.steps.find((s) => s["uses"]?.toString().startsWith("actions/upload-artifact"));
    assert.ok(up, "generate uploads the bundle");
    const upWith = (up?.["with"] ?? {}) as Record<string, unknown>;
    assert.equal(upWith["if-no-files-found"], "error");
    assert.equal(upWith["name"], "snapshot-publication-bundle");
    const down = verify.steps.find((s) => s["uses"]?.toString().startsWith("actions/download-artifact"));
    assert.equal((down?.["with"] as Record<string, unknown> | undefined)?.["name"], "snapshot-publication-bundle");
    const pubDown = publish.steps.find((s) => s["uses"]?.toString().startsWith("actions/download-artifact") && JSON.stringify(s["with"]).includes("snapshot-publication-bundle"));
    assert.ok(pubDown, "publish downloads the verified publication bundle");
  });

  test("integrity is recalculated against downloaded bytes at every gate: independent re-verification, same-release roundtrip, post-activation", () => {
    // Gate 1 (read-only verify job): strict schema-v2 + integrity re-check
    // of the DOWNLOADED bundle, independent of the generate job.
    const verifyRuns = runBlocks(verify).join("\n");
    assert.match(verifyRuns, /verify-snapshot[\s\\]+bundle\//, "independent re-verification BEFORE any publication");
    // Gate 2 (privileged publish job): pure-shell checksum over the exact
    // downloaded bytes before anything is uploaded.
    const publishRuns = runBlocks(publish).join("\n");
    assert.match(publishRuns, /sha256sum -c console-snapshot\.sha256/, "the privileged job re-checks the checksum over the downloaded bytes");
    // The roundtrip and stable gates recompute the checksum over the exact
    // downloaded bytes inside verifyReleaseAssetSet (verifyChecksumFile),
    // exercised by test/releaseOps.test.ts; here we pin that the workflow
    // invokes them at both scopes.
    assert.match(publishRuns, /--scope versioned/, "same-release roundtrip gate (privileged job)");
    const stableRuns = runBlocks(verifyStable).join("\n");
    assert.match(stableRuns, /--scope latest/, "post-activation stable gate (read-only job)");
  });

  test("duplicate versioned tags abort before creation; releases are created explicitly NOT latest", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /git ls-remote --exit-code --tags/, "duplicate-tag gate");
    assert.match(runs, /--latest=false/, "versioned releases never become latest on creation");
    assert.ok(!runs.includes("--clobber"), "no asset clobbering anywhere");
    assert.match(runs, /gh release edit .* --latest/, "the stable reference is activated by a single promotion");
  });

  test("the stable reference is activated only AFTER same-release verification, then re-verified through the stable gate", () => {
    const runs = runBlocks(publish);
    const uploadIdx = runs.findIndex((r) => r.includes("gh release upload"));
    const roundtripIdx = runs.findIndex((r) => r.includes("--scope versioned"));
    // The rollback-discovery step MENTIONS `gh release edit <prev>` in its
    // summary text, so the activation step is matched precisely.
    const activateIdx = runs.findIndex((r) => r.includes('gh release edit "$TAG" --repo "$REPO" --latest'));
    assert.ok(uploadIdx > -1 && roundtripIdx > uploadIdx, "same-release verification follows upload");
    assert.ok(activateIdx > -1 && activateIdx > roundtripIdx, "activation follows verification");
    // The post-activation stable gate runs in the SEPARATE read-only job.
    const stableRuns = runBlocks(verifyStable).join("\n");
    assert.match(stableRuns, /--scope latest --expected-tag "\$TAG"/, "the stable gate cross-checks the activated tag");
    assert.match(stableRuns, /verify-release-assets/, "the stable gate runs the same-release verification CLI");
  });

  test("the workflow records the previous latest tag as a rollback pointer", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /release-latest/, "the current latest designation is read through the hardened gate before activation");
    assert.match(runs, /previous_latest_tag/, "the rollback pointer is captured for the summary");
    assert.match(runs, /rollback/, "the rollback pointer is surfaced in the summary");
  });

  test("no secret material is echoed; authenticated URLs never reach provenance or step summaries", () => {
    const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
    const summaryBlocks = raw.split("GITHUB_STEP_SUMMARY").slice(1).join("");
    assert.ok(!summaryBlocks.includes("${{ secrets."), "no secrets interpolate into the summary");
    const allRuns = [...runBlocks(generate), ...runBlocks(verify), ...runBlocks(publish), ...runBlocks(verifyStable)].join("\n");
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
  const verifyStable = wf.jobs["verify-stable"]!;
  const readOnlyJobs = [generate, verify, verifyStable];
  const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");

  test("ALL FOUR jobs carry the job-level main-only guard (`if: github.ref == 'refs/heads/main'`)", () => {
    for (const job of [generate, verify, publish, verifyStable]) {
      assert.equal(
        job["if"],
        "github.ref == 'refs/heads/main'",
        "a dispatch against any other ref must skip the job entirely (release-writing steps unreachable)",
      );
    }
  });

  test("ALL FOUR jobs carry an explicit in-step ref guard that rejects anything but refs/heads/main", () => {
    for (const job of [generate, verify, publish, verifyStable]) {
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
    const publishRuns = runBlocks(publish).join("\n");
    assert.ok(publishRuns.includes("refusing to publish"), "the release job's guard names its refusal explicitly");
  });

  test("every repository checkout is pinned to the selected commit; the workflow asserts HEAD equals it", () => {
    for (const job of readOnlyJobs) {
      const checkout = job.steps.find((s) => typeof s["uses"] === "string" && (s["uses"] as string).startsWith("actions/checkout"));
      assert.ok(checkout, "checkout step exists in the read-only job");
      const withRef = ((checkout?.["with"] ?? {}) as Record<string, unknown>)["ref"];
      assert.equal(withRef, "${{ github.sha }}", "checkout must be the EXACT commit Actions selected, never a moving branch head");
      const assertStep = job.steps.find(
        (s) => typeof s["run"] === "string" && (s["run"] as string).includes("git rev-parse HEAD"),
      );
      assert.ok(assertStep, "a step asserts git rev-parse HEAD equals the selected commit");
      assert.match((assertStep?.["run"] as string) ?? "", /checkout mismatch|!= "\$CHECKOUT_SHA"/, "the assertion FAILS the job on mismatch");
    }
  });

  // ── SECOND-ROUND CORRECTION (review follow-up): the first remediation
  // attached GH_TOKEN per-step but kept `permissions: contents: write` at
  // the JOB level on a job that also ran checkout, setup-node, pnpm and
  // dependency installation. The job-level grant makes `github.token`
  // write-capable for the whole job, and first-party actions consume it
  // BY DEFAULT (actions/checkout's `token` input, actions/setup-node's
  // `token` input). These tests pin the corrected structure. ──────────────

  test("the privileged publish job is MINIMAL: no checkout, no setup-node, no pnpm, no dependency installation, no repository code", () => {
    const usesSteps = publish.steps.filter((s) => typeof s["uses"] === "string").map((s) => s["uses"] as string);
    assert.ok(usesSteps.length > 0, "the publish job downloads its artifacts through actions");
    for (const uses of usesSteps) {
      assert.match(uses, /^actions\/download-artifact@/, `the privileged job's only allowed action is download-artifact (found: ${uses}) — checkout and setup-node both consume github.token by default`);
    }
    const runs = runBlocks(publish).join("\n");
    assert.ok(!runs.includes("pnpm "), "no pnpm commands in the privileged job (no dependency installation with the write token present)");
    assert.ok(!runs.includes("npm "), "no npm commands in the privileged job");
    assert.ok(!runs.includes("node --import tsx"), "no repository TypeScript runs in the privileged job (only the prebuilt zero-dependency bundle)");
    assert.ok(!runs.includes("src/cli.ts"), "no repository CLI runs in the privileged job");
    assert.ok(!runs.includes("tsc "), "no compilation runs in the privileged job");
    assert.ok(!runs.includes("build:sdk"), "no SDK build runs in the privileged job");
    assert.ok(!publish.steps.some((s) => (s["uses"] as string | undefined)?.startsWith("actions/checkout")), "the privileged job NEVER checks out the repository");
    assert.ok(!publish.steps.some((s) => (s["uses"] as string | undefined)?.startsWith("actions/setup-node")), "the privileged job NEVER runs setup-node (its token input defaults to github.token)");
  });

  test("the privileged job runs the prebuilt zero-dependency release-ops bundle and preinstalled tooling only", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /node ops\/release-ops\.mjs release-latest/, "rollback discovery runs the prebuilt bundle");
    assert.match(runs, /node ops\/release-ops\.mjs verify-release-assets/, "same-release verification runs the prebuilt bundle");
    assert.match(runs, /sha256sum -c/, "the pre-upload checksum belt uses preinstalled shell tooling");
    assert.match(runs, /git ls-remote/, "the tag-collision gate uses preinstalled git");
    // The bundle is built by the read-only verify job from the asserted commit.
    const verifyRuns = runBlocks(verify).join("\n");
    assert.match(verifyRuns, /bundle:release-ops/, "the read-only verify job builds the zero-dependency release-ops bundle");
    const up = verify.steps.find((s) => JSON.stringify(s["with"] ?? {}).includes("release-ops-cli"));
    assert.ok(up, "the verify job uploads the release-ops bundle as a named artifact");
    assert.equal(((up?.["with"] ?? {}) as Record<string, unknown>)["if-no-files-found"], "error", "the bundle upload is fail-closed");
  });

  test("the write-capable GH_TOKEN is NOT set at job level and never reaches any non-API step", () => {
    for (const job of [generate, verify, publish, verifyStable]) {
      assert.ok(!("GH_TOKEN" in (job.env ?? {})), "no job-level GH_TOKEN (it would leak to every step)");
      assert.ok(!("GITHUB_TOKEN" in (job.env ?? {})), "no job-level GITHUB_TOKEN");
    }
    // No read-only job receives a token anywhere at all (verify-stable's
    // post-activation gate uses the READ-ONLY workflow token — it has no
    // write permission, so it is not a leak).
    for (const job of [generate, verify]) {
      assert.ok(
        !job.steps.some((s) => typeof s["env"] === "object" && s["env"] !== null && ("GH_TOKEN" in ((s["env"] ?? {}) as Record<string, unknown>) || "GITHUB_TOKEN" in ((s["env"] ?? {}) as Record<string, unknown>))),
        "preparation jobs receive no GitHub token",
      );
    }
    // In the publish job, ONLY the four GitHub release API steps carry the token.
    const publishTokenSteps = publish.steps.filter(
      (s) => typeof s["env"] === "object" && s["env"] !== null && "GH_TOKEN" in ((s["env"] ?? {}) as Record<string, unknown>),
    );
    assert.ok(publishTokenSteps.length > 0, "release API steps carry the token");
    for (const step of publishTokenSteps) {
      const run = (step["run"] as string) ?? "";
      assert.ok(
        run.includes("gh release") || run.includes("curl -sS"),
        "token steps are exactly the GitHub release API steps (gh CLI or the authenticated release-collision curl belt)",
      );
    }
    const expectedTokenSteps = ["release-collision", "rollback", "Publish the immutable versioned release", "Activate the stable reference"];
    assert.equal(publishTokenSteps.length, expectedTokenSteps.length, "exactly the four release-API steps carry the write token");
    for (const step of publish.steps) {
      const run = (step["run"] as string) ?? "";
      const hasToken = typeof step["env"] === "object" && step["env"] !== null && "GH_TOKEN" in ((step["env"] ?? {}) as Record<string, unknown>);
      if (hasToken) {
        assert.ok(
          !run.includes("pnpm install") && !run.includes("pnpm run") && !run.includes("verify-snapshot"),
          "dependency installation, builds and verification never receive the write-capable token",
        );
      } else {
        // Only actual command lines count (summary echo text merely
        // documents the rollback procedure and carries no authority).
        assert.ok(
          !/^\s*gh release (create|upload|edit|view) /m.test(run),
          "steps without the token never call the GitHub release API",
        );
        assert.ok(
          !/Authorization: Bearer/m.test(run),
          "steps without the token never make authenticated API calls",
        );
      }
    }
  });

  test("the same-release versioned verification step in the privileged job receives NO token (public tag URLs)", () => {
    const step = publish.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("--scope versioned")));
    assert.ok(step, "the versioned verification step exists");
    assert.equal(typeof step!["env"], "undefined", "the versioned verification step receives no token — the tag URLs are public");
  });

  test("permissions stay least-privilege: read-only preparation/verification, contents:write only on the minimal release job", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    assert.equal(generate.permissions, undefined);
    assert.equal(verify.permissions, undefined);
    assert.equal(verifyStable.permissions, undefined);
    assert.deepEqual(publish.permissions, { contents: "write" });
    assert.ok(!publish.permissions || Object.keys(publish.permissions).every((k) => k === "contents"));
  });

  test("the post-activation gate is a READ-ONLY job using the read-only workflow token", () => {
    assert.equal(verifyStable.permissions, undefined, "verify-stable has no elevated permissions");
    const step = verifyStable.steps.find((s) => typeof s["run"] === "string" && ((s["run"] as string).includes("--scope latest")));
    assert.ok(step, "the stable gate step exists");
    assert.equal(((step!["env"] ?? {}) as Record<string, unknown>)["GH_TOKEN"], "${{ github.token }}", "the stable gate authenticates with the READ-ONLY workflow token");
    assert.ok(!runBlocks(verifyStable).join("\n").includes("gh release"), "the stable gate performs NO release-mutating operations");
  });
});

// ─── Review Task 4 — hardened rollback-pointer discovery ────────────────────

describe("publish-console-snapshot workflow — rollback discovery hardening (review Task 4)", () => {
  const wf = loadWorkflow();
  const publish = wf.jobs["publish"]!;

  test("rollback discovery uses the typed `release-latest` gate, not error-suppressed gh api", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /release-latest/, "the hardened discovery CLI is used");
    assert.ok(!runs.includes("2>/dev/null || echo"), "the old suppress-all-errors pattern is GONE");
    assert.ok(!runs.includes('--jq ".tag_name" 2>/dev/null'), "no raw gh api latest query that can silently fail into 'none'");
  });

  test("the tag-collision gate distinguishes absent / exists / gate-failure (never treats an API failure as 'absent')", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /case "\$status" in/, "explicit three-way exit-status handling");
    assert.match(runs, /status=\$\?/, "the gate captures the real exit status");
    assert.match(runs, /refusing to treat this as 'tag absent'/, "a failing gate aborts the run");
  });

  test("the release-collision belt check is ALSO three-way (404 absent / 200 exists / anything else aborts)", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /releases\/tags\/\$TAG/, "the belt check queries the release-by-tag endpoint");
    assert.match(runs, /case "\$code" in/, "explicit three-way HTTP-status handling");
    assert.match(runs, /404\) echo "no release exists/, "HTTP 404 is the ONLY 'absent' verdict");
    assert.match(runs, /200\) echo "a release for tag \$TAG already exists/, "HTTP 200 is an aborting collision");
    assert.match(runs, /refusing to treat this as 'no release'/, "a transport failure or unexpected status aborts the run");
    assert.ok(!runs.includes('if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then\n            echo "a release'), "the old suppression-shaped belt check is GONE");
  });

  test("the rollback pointer is recorded BEFORE any release operation and surfaced even on failure", () => {
    const steps = publish.steps;
    const runs = steps.map((s) => (typeof s["run"] === "string" ? (s["run"] as string) : ""));
    const rollbackIdx = runs.findIndex((r) => r.includes("previous_latest_tag"));
    const createIdx = runs.findIndex((r) => r.includes("gh release create"));
    assert.ok(rollbackIdx > -1 && createIdx > -1 && rollbackIdx < createIdx, "rollback discovery precedes release creation");
    const rollbackRun = runs[rollbackIdx] ?? "";
    assert.match(rollbackRun, /GITHUB_STEP_SUMMARY/, "the pointer is written to the run summary at discovery time");
  });
});

// ─── Review Task 5 — same-release verification, no cross-release mixtures ──

describe("publish-console-snapshot workflow — same-release verification (review Task 5)", () => {
  const wf = loadWorkflow();
  const publish = wf.jobs["publish"]!;
  const verifyStable = wf.jobs["verify-stable"]!;

  test("roundtrip verification is tag-scoped (--scope versioned) — all three assets from ONE exact release", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /verify-release-assets[\s\S]*--scope versioned/, "versioned verification uses the same-release CLI gate");
  });

  test("post-activation verification requires BOTH the designation match AND the stable-URL artifact check", () => {
    const runs = runBlocks(verifyStable).join("\n");
    assert.match(runs, /verify-release-assets[\s\S]*--scope latest/, "the stable gate checks the latest designation");
    const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");
    assert.ok(!raw.includes("latest/download/console-snapshot.json\""), "raw curl of separate latest URLs is no longer the verification mechanism");
    assert.ok(!/curl[\s\S]*stable-check/.test(raw), "the three-separate-curl stable check is replaced by the same-release gate");
  });

  test("verification steps run AFTER upload and promotion in the required order", () => {
    const runs = runBlocks(publish);
    const uploadIdx = runs.findIndex((r) => r.includes("gh release upload"));
    const versionedVerifyIdx = runs.findIndex((r) => r.includes("--scope versioned"));
    // The promotion STEP (the rollback-discovery step only MENTIONS the edit
    // command in its summary text, so match the activation step explicitly).
    const promoteIdx = runs.findIndex((r) => r.includes('gh release edit "$TAG" --repo "$REPO" --latest'));
    assert.ok(uploadIdx > -1 && versionedVerifyIdx > uploadIdx, "same-release verification follows upload");
    assert.ok(promoteIdx > versionedVerifyIdx, "promotion follows verification");
    // The post-activation stable gate runs in the read-only verify-stable job.
    assert.equal(verifyStable.needs?.includes("publish"), true, "post-activation verification is a separate job that runs after publish");
  });

  test("the activated tag crosses the job boundary through a validated output and is re-checked for shape", () => {
    assert.equal(publish.outputs?.["versioned_tag"], "${{ steps.facts.outputs.tag }}", "publish exposes the strictly-validated tag as a job output");
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
