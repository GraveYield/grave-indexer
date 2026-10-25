#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// grave-indexer CLI shim — runs the TypeScript CLI through tsx.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../src/cli.ts");
const result = spawnSync("npx", ["--no-install", "tsx", cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
