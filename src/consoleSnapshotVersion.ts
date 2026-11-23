// SPDX-License-Identifier: Apache-2.0
//
// Leaf module holding the ConsoleSnapshot schema version constant.
//
// WHY A SEPARATE LEAF (PR #5 remediation — review Task 1 correction,
// second round): the privileged publication job runs a ZERO-DEPENDENCY
// bundle of the release-ops module graph (src/releaseOpsCli.ts). That
// graph needs `CONSOLE_SNAPSHOT_SCHEMA_VERSION` (the provenance sidecar
// carries it), but importing it from `consoleSnapshot.ts` would drag in
// the builder's whole dependency tree (@solana/web3.js, the workspace
// SDK, discovery) into the write-token execution boundary. Defining the
// constant here — the single source of truth, re-exported by
// `consoleSnapshot.ts` so every existing import site keeps working —
// keeps the release-ops graph limited to `node:` builtins and pure
// verification logic. The value is pinned by test so a drift between
// this leaf and the builder is impossible to miss.

/** The only accepted ConsoleSnapshot schema version (v2). */
export const CONSOLE_SNAPSHOT_SCHEMA_VERSION = 2;
