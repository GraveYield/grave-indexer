// SPDX-License-Identifier: Apache-2.0
//
// Claims-artifact publication CLI (D4 review finding: production wiring).
// Runs the draft-first sequence (claimsPublication.ts) against the real
// GitHub adapter (claimsGitHubStore.ts). Intended for the dedicated
// claims-publication workflow ONLY — never run manually against
// production without the owner gate.
//
// Usage:
//   tsx src/claimsPublishCli.ts --repo owner/repo --artifact <file> \
//     --source-commit <40-hex> --producer-identity <id> --producer-version <v>
//
// The GitHub token is read from GY_CLAIMS_GITHUB_TOKEN (or GITHUB_TOKEN)
// and is NEVER printed, echoed, or included in error output.

import { readFileSync } from "node:fs";
import { GitHubClaimsReleaseStore } from "./claimsGitHubStore.js";
import { runClaimsPublicationSequence, ClaimsPublicationError } from "./claimsPublication.js";

interface Args {
  repo: string;
  artifact: string;
  sourceCommit: string;
  producerIdentity: string;
  producerVersion: string;
}

function parseArgs(argv: string[]): Args {
  const argOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const missing = (name: string): never => {
    throw new ClaimsPublicationError(`required argument ${name} is missing`);
  };
  return {
    repo: argOf("--repo") ?? missing("--repo"),
    artifact: argOf("--artifact") ?? missing("--artifact"),
    sourceCommit: argOf("--source-commit") ?? missing("--source-commit"),
    producerIdentity: argOf("--producer-identity") ?? missing("--producer-identity"),
    producerVersion: argOf("--producer-version") ?? missing("--producer-version"),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env["GY_CLAIMS_GITHUB_TOKEN"] ?? process.env["GITHUB_TOKEN"] ?? "";
  const store = new GitHubClaimsReleaseStore({ repo: args.repo, token });
  const result = await runClaimsPublicationSequence({
    store,
    input: {
      artifactBytes: readFileSync(args.artifact),
      sourceCommit: args.sourceCommit,
      producer: { identity: args.producerIdentity, version: args.producerVersion },
      publishedAtUnixMs: Date.now(),
    },
  });
  // Result JSON carries NO secret material (digests, tags, pointers only).
  process.stdout.write(
    `${JSON.stringify({ ok: true, activatedTag: result.activatedTag, artifactSha256: result.artifactSha256, artifactByteLength: result.artifactByteLength, executed: result.executed })}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`claims publication FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
