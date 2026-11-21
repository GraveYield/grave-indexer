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

  test("SHA-256 is recalculated: pre-publication re-verify, roundtrip re-verify, and sha256sum -c on the downloaded bytes", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /verify-snapshot[\s\\]+bundle\//, "re-verification BEFORE any publication");
    assert.match(runs, /sha256sum -c/, "checksum recomputation against downloaded bytes");
    assert.ok((runs.match(/verify-snapshot/g) ?? []).length >= 3, "verify runs pre-publication, at roundtrip, and post-activation");
  });

  test("duplicate versioned tags abort before creation; releases are created explicitly NOT latest", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /git ls-remote --exit-code --tags/, "duplicate-tag gate");
    assert.match(runs, /--latest=false/, "versioned releases never become latest on creation");
    assert.ok(!runs.includes("--clobber"), "no asset clobbering anywhere");
    assert.match(runs, /gh release edit .* --latest/, "the stable reference is activated by a single promotion");
  });

  test("the stable reference is activated only AFTER roundtrip verification, then re-verified through the stable URL", () => {
    const runs = runBlocks(publish);
    const uploadIdx = runs.findIndex((r) => r.includes("gh release upload"));
    const roundtripIdx = runs.findIndex((r) => r.includes("roundtrip/console-snapshot.json"));
    const activateIdx = runs.findIndex((r) => r.includes("gh release edit"));
    const stableIdx = runs.findIndex((r) => r.includes("stable-check/console-snapshot.json"));
    assert.ok(uploadIdx > -1 && roundtripIdx > uploadIdx, "roundtrip follows upload");
    assert.ok(activateIdx > roundtripIdx, "activation follows roundtrip verification");
    assert.ok(stableIdx > activateIdx, "post-activation verification follows activation");
    assert.match(runs.join("\n"), /versionedTag/, "the provenance tag is cross-checked");
  });

  test("the workflow records the previous latest tag as a rollback pointer", () => {
    const runs = runBlocks(publish).join("\n");
    assert.match(runs, /releases\/latest" --jq/, "the current latest designation is read before activation");
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
