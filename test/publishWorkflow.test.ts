// SPDX-License-Identifier: Apache-2.0
//
// publish-console-snapshot.yml — workflow-level validation (GY-M1-INT-001
// correction §5). YAML parsing alone proves nothing about behavior, so
// these tests pin the SECURITY-CRITICAL structure of the real workflow
// file: trigger restrictions, least-privilege permissions, job
// separation, artifact integrity handling, release behavior (latest
// promotion, no clobber), concurrency, and explicit failure paths. The
// behavioral sequence itself is exercised end-to-end by
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
  const publish = wf.jobs["publish"];
  assert.ok(generate, "the generate job exists");
  assert.ok(publish, "the publish job exists");
  if (!generate || !publish) throw new Error("workflow jobs missing");

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
    assert.deepEqual(publish.permissions, { contents: "write" });
    assert.ok(publish.needs?.includes("generate"), "publish depends on generate (job separation)");
  });

  test("concurrency: one publication at a time, never cancelled mid-run", () => {
    assert.equal(wf.concurrency.group, "publish-console-snapshot");
    assert.equal(wf.concurrency["cancel-in-progress"], false);
  });

  test("actions are pinned to full commit SHAs", () => {
    for (const job of [generate, publish]) {
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
    const down = publish.steps.find((s) => s["uses"]?.toString().startsWith("actions/download-artifact"));
    assert.equal((down?.["with"] as Record<string, unknown> | undefined)?.["name"], "snapshot-publication-bundle");
  });

  test("integrity is recalculated against downloaded bytes at every gate: pre-publication, same-release roundtrip, post-activation", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /verify-snapshot[\s\\]+bundle\//, "re-verification BEFORE any publication");
    // The roundtrip and stable gates recompute the checksum over the exact
    // downloaded bytes inside verifyReleaseAssetSet (verifyChecksumFile),
    // exercised by test/releaseOps.test.ts; here we pin that the workflow
    // invokes them at both scopes.
    assert.match(runs, /--scope versioned/, "same-release roundtrip gate");
    assert.match(runs, /--scope latest/, "post-activation stable gate");
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
    const stableIdx = runs.findIndex((r) => r.includes("--scope latest"));
    assert.ok(uploadIdx > -1 && roundtripIdx > uploadIdx, "same-release verification follows upload");
    assert.ok(activateIdx > -1 && activateIdx > roundtripIdx, "activation follows verification");
    assert.ok(stableIdx > activateIdx, "post-activation verification follows activation");
    assert.match(runs.join("\n"), /--expected-tag "\$TAG"/, "the provenance tag is cross-checked in both gates");
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
    const allRuns = [...runBlocks(generate), ...runBlocks(publish)].join("\n");
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
  const publish = wf.jobs["publish"]!;
  const raw = readFileSync(".github/workflows/publish-console-snapshot.yml", "utf8");

  test("BOTH jobs carry the job-level main-only guard (`if: github.ref == 'refs/heads/main'`)", () => {
    for (const job of [generate, publish]) {
      assert.equal(
        job["if"],
        "github.ref == 'refs/heads/main'",
        "a dispatch against any other ref must skip the job entirely (release-writing steps unreachable)",
      );
    }
  });

  test("BOTH jobs carry an explicit in-step ref guard that rejects anything but refs/heads/main", () => {
    for (const job of [generate, publish]) {
      const guards = job.steps.filter(
        (s) => typeof s["run"] === "string" && (s["run"] as string).includes("refs/heads/main") && (s["run"] as string).includes("GITHUB_REF"),
      );
      assert.ok(
        guards.length > 0,
        "defense-in-depth: an explicit guard step must re-check GITHUB_REF == refs/heads/main before anything else",
      );
      const guardRun = guards[0]!["run"] as string;
      assert.ok(guardRun.includes('!= "refs/heads/main"') || guardRun.includes("!= \"refs/heads/main\""), "the guard REJECTS non-main refs");
    }
  });

  test("the workflow cannot reach release-writing steps from an arbitrary branch or tag (layered)", () => {
    // Layer 1: job-level if. Layer 2: guard steps. Layer 3: dispatch-only trigger.
    assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"], "dispatch-only trigger: no push/PR/schedule context can run it");
    const publishRuns = runBlocks(publish).join("\n");
    assert.ok(publishRuns.includes("refusing to publish"), "the release job's guard names its refusal explicitly");
  });

  test("checkout is pinned to the selected commit; the workflow asserts HEAD equals it", () => {
    for (const job of [generate, publish]) {
      const checkout = job.steps.find((s) => typeof s["uses"] === "string" && (s["uses"] as string).startsWith("actions/checkout"));
      assert.ok(checkout, "checkout step exists");
      const withRef = ((checkout?.["with"] ?? {}) as Record<string, unknown>)["ref"];
      assert.equal(withRef, "${{ github.sha }}", "checkout must be the EXACT commit Actions selected, never a moving branch head");
      const assertStep = job.steps.find(
        (s) => typeof s["run"] === "string" && (s["run"] as string).includes("git rev-parse HEAD"),
      );
      assert.ok(assertStep, "a step asserts git rev-parse HEAD equals the selected commit");
      assert.match((assertStep?.["run"] as string) ?? "", /checkout mismatch|!= "\$CHECKOUT_SHA"/, "the assertion FAILS the job on mismatch");
    }
  });

  test("the write-capable GH_TOKEN is NOT set at job level and never reaches install/build/verify steps", () => {
    for (const job of [generate, publish]) {
      assert.ok(!("GH_TOKEN" in (job.env ?? {})), "no job-level GH_TOKEN (it would leak to every step)");
    }
    // The generate job must not receive a write token anywhere at all.
    const generateSteps = generate.steps.filter((s) => typeof s["env"] === "object" && s["env"] !== null);
    assert.ok(
      !generateSteps.some((s) => "GH_TOKEN" in ((s["env"] ?? {}) as Record<string, unknown>)),
      "generation receives no GitHub token — it only needs the RPC secrets and the checkout",
    );
    // In the publish job, only steps that call gh/API carry the token.
    const publishTokenSteps = publish.steps.filter(
      (s) => typeof s["env"] === "object" && s["env"] !== null && "GH_TOKEN" in ((s["env"] ?? {}) as Record<string, unknown>),
    );
    assert.ok(publishTokenSteps.length > 0, "release API/CLI steps carry the token");
    for (const step of publishTokenSteps) {
      const run = (step["run"] as string) ?? "";
      assert.ok(
        run.includes("gh release") || run.includes("git ls-remote") || run.includes("release-latest") || run.includes("verify-release-assets"),
        "token steps are exactly the GitHub API/CLI steps",
      );
    }
    for (const step of publish.steps) {
      const run = (step["run"] as string) ?? "";
      const hasToken = typeof step["env"] === "object" && step["env"] !== null && "GH_TOKEN" in ((step["env"] ?? {}) as Record<string, unknown>);
      if (hasToken) {
        assert.ok(
          !run.includes("pnpm install") && !run.includes("pnpm run build"),
          "dependency installation and builds never receive the write-capable token",
        );
      } else {
        // Only actual command lines count (summary echo text merely
        // documents the rollback procedure and carries no authority).
        assert.ok(
          !/^\s*gh release (create|upload|edit|view) /m.test(run),
          "steps without the token never call the GitHub release API",
        );
      }
    }
  });

  test("permissions stay least-privilege: read-only generation, contents:write only on the release job", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    assert.equal(generate.permissions, undefined);
    assert.deepEqual(publish.permissions, { contents: "write" });
    assert.ok(!publish.permissions || Object.keys(publish.permissions).every((k) => k === "contents"));
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
    assert.match(runs, /gh release view "\$TAG"/, "an existing RELEASE for the tag is also a fail-closed collision");
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

  test("roundtrip verification is tag-scoped (--scope versioned) — all three assets from ONE exact release", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /verify-release-assets[\s\S]*--scope versioned/, "versioned verification uses the same-release CLI gate");
  });

  test("post-activation verification requires BOTH the designation match AND the stable-URL artifact check", () => {
    const runs = runBlocks(publish).join("\n");
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
    const promoteIdx = runs.findIndex((r) => r.includes("gh release edit \"$TAG\" --repo \"$REPO\" --latest"));
    const stableVerifyIdx = runs.findIndex((r) => r.includes("--scope latest"));
    assert.ok(uploadIdx > -1 && versionedVerifyIdx > uploadIdx, "same-release verification follows upload");
    assert.ok(promoteIdx > versionedVerifyIdx, "promotion follows verification");
    assert.ok(stableVerifyIdx > promoteIdx, "post-activation verification follows promotion");
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
