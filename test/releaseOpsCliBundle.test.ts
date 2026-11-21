// SPDX-License-Identifier: Apache-2.0
//
// PR #5 remediation — review Task 1 SECOND-ROUND CORRECTION: the
// privileged publication job must run the smallest trusted execution
// boundary possible. It executes the prebuilt release-ops bundle
// (src/releaseOpsCli.ts → dist/release-ops.mjs) with the runner's plain
// `node` — no checkout, no node_modules, no dependency installation
// inside the write-token job. That promise is only as good as the
// bundle, so these tests PIN it:
//
//   1. the bundle builds from the current sources;
//   2. every static import specifier in the release-ops source graph is
//      `node:` or relative — no npm package can silently enter the
//      write-token execution boundary through a new import;
//   3. the BUILT bundle's every import is a `node:` builtin — the file
//      runs on a bare runner with zero node_modules;
//   4. the bundle contains none of the heavy indexer dependencies
//      (@solana/web3.js, tweetnacl, bs58) — the release-ops graph stays
//      decoupled from the discovery/CLI dependency tree;
//   5. the bundle behaves correctly when invoked standalone (usage +
//      exit codes).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ENTRY = "src/releaseOpsCli.ts";
const GRAPH = [
  "src/releaseOpsCli.ts",
  "src/releaseOps.ts",
  "src/snapshotPublication.ts",
  "src/consoleSnapshotVersion.ts",
];
const BUNDLE = "dist/release-ops.mjs";

describe("release-ops bundle — zero-dependency execution boundary for the privileged publish job", () => {
  test("every static import in the release-ops source graph is `node:` or relative", () => {
    for (const file of GRAPH) {
      const src = readFileSync(file, "utf8");
      // import ... from "spec"  |  export ... from "spec"  |  import "spec"
      const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of specs) {
        assert.ok(
          spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"),
          `${file} imports '${spec}' — the release-ops graph must stay limited to node builtins and relative modules (a new npm dependency would enter the privileged job's execution boundary)`,
        );
      }
    }
  });

  test("the bundle builds from the current sources", () => {
    execFileSync("pnpm", ["run", "bundle:release-ops"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const stat = readFileSync(BUNDLE);
    assert.ok(stat.length > 1000, "the bundle is built and non-trivial");
    assert.ok(stat.length < 1_000_000, `the bundle is small (${stat.length} bytes) — a size explosion indicates heavy dependencies were pulled in`);
  });

  test("every import in the BUILT bundle is a node: builtin (runs with zero node_modules)", () => {
    const bundle = readFileSync(BUNDLE, "utf8");
    // esbuild keeps node builtins external: they appear as
    // `import ... from "node:x"` (ESM) or `require("node:x")` shims.
    const specs = new Set<string>();
    for (const m of bundle.matchAll(/(?:from\s*|require\()\s*["']([^"']+)["']/g)) {
      specs.add(m[1]!);
    }
    assert.ok(specs.size > 0, "the bundle references at least one module specifier");
    for (const spec of specs) {
      assert.ok(
        spec.startsWith("node:"),
        `the built bundle imports '${spec}' — only node: builtins may remain external (the privileged runner has no node_modules)`,
      );
    }
  });

  test("the bundle contains none of the heavy indexer dependencies", () => {
    const bundle = readFileSync(BUNDLE, "utf8");
    for (const banned of ["@solana/web3.js", "tweetnacl", "bs58", "node_modules", "@graveyield/sdk"]) {
      assert.ok(!bundle.includes(banned), `the bundle must not contain '${banned}' — the release-ops graph is decoupled from the indexer dependency tree`);
    }
  });

  test("the standalone bundle prints usage and exits 1 when called without a command", () => {
    const res = spawnSync("node", [BUNDLE], { encoding: "utf8" });
    assert.equal(res.status, 1, "usage errors exit non-zero");
    const out = `${res.stdout}${res.stderr}`;
    assert.match(out, /release-latest/, "usage names the release-latest command");
    assert.match(out, /verify-release-assets/, "usage names the verify-release-assets command");
  });

  test("the standalone bundle rejects malformed verify-release-assets invocations", () => {
    for (const argv of [["verify-release-assets"], ["verify-release-assets", "o/r", "--scope", "bogus", "--tag", "t", "--expected-tag", "t"]]) {
      const res = spawnSync("node", [BUNDLE, ...argv], { encoding: "utf8" });
      assert.equal(res.status, 1, `usage validation fails closed for: ${argv.join(" ")}`);
      assert.match(`${res.stdout}${res.stderr}`, /verify-release-assets/, "the usage text identifies the failing command");
    }
  });
});
