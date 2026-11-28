// SPDX-License-Identifier: Apache-2.0
//
// Claims-artifact publication CLI (D4 review finding: production wiring;
// I-06: real D3→D4 producer-run handoff).
//
// The artifact is NEVER taken from a local filesystem path — a dispatch
// starts a fresh runner and a path is not proof of producer origin.
// Instead the CLI resolves the EXPLICIT producer run (validated run ID),
// checks it against the EXPECTED producer workflow identity, retrieves
// the named artifact from that exact run via the authenticated Actions
// artifacts API, and verifies its byte length, CRC32, claims-grade
// integrity, and identity expectations BEFORE any publication side
// effect. See src/claimsProducerHandoff.ts.
//
// Usage:
//   tsx src/claimsPublishCli.ts --repo owner/repo \
//     --producer-run-id <decimal run id> \
//     --producer-repo <owner/name> \
//     --producer-workflow <expected workflow name> \
//     --artifact-name <name> \
//     --source-commit <40-hex> --producer-identity <id> --producer-version <v> \
//     [--expected-pool <pool>] [--expected-lp-mint <mint>] [--expected-amm-program-id <id>] \
//     [--handoff-only]
//
// `--handoff-only` runs the verification pipeline and exits WITHOUT any
// publication side effect (used by the workflow's pre-flight step).
//
// P125-01: --producer-repo and --producer-workflow are DECLARATIONS, not
// trust inputs. The consumer enforces the trusted producer identity
// itself (repository, trusted branch `main`, workflow path/id — see the
// TRUSTED_CLAIMS_PRODUCER_* pins in src/claimsProducerHandoff.ts) and
// rejects any declaration that disagrees with it before any network call.
//
// The GitHub token is read from GY_CLAIMS_GITHUB_TOKEN (or GITHUB_TOKEN)
// and is NEVER printed, echoed, or included in error output.
//
// I-06 CROSS-REPO AUTH (explicit, documented): the producer run lives in
// GraveYield/graveyield-protocol, and the automatic GITHUB_TOKEN of the
// grave-indexer workflow CANNOT read another repository's Actions runs or
// artifacts. The handoff therefore uses GY_CLAIMS_PRODUCER_GITHUB_TOKEN
// (a fine-grained token scoped to actions:read on the producer repo),
// falling back to the publication token only when the two coincide (e.g.
// a same-repo rehearsal). The two concerns are never swapped silently:

import { GitHubClaimsReleaseStore } from "./claimsGitHubStore.js";
import { runClaimsPublicationSequence, ClaimsPublicationError } from "./claimsPublication.js";
import {
  CLAIMS_PRODUCER_ARTIFACT_NAME,
  DEFAULT_CLAIMS_PRODUCER_REPO,
  PINNED_CLAIMS_PRODUCER_IDENTITY,
  TRUSTED_CLAIMS_PRODUCER_REPO,
  TRUSTED_CLAIMS_PRODUCER_WORKFLOW_NAME,
  fetchVerifiedClaimsArtifact,
  publishVerifiedProducerArtifact,
  type ClaimsProducerExpectations,
} from "./claimsProducerHandoff.js";

interface Args {
  repo: string;
  producerRunId: number;
  producerRepo: string;
  producerWorkflowName: string;
  artifactName: string;
  sourceCommit: string;
  producerIdentity: string;
  producerVersion: string;
  expectedPool?: string | undefined;
  expectedLpMint?: string | undefined;
  expectedAmmProgramId?: string | undefined;
  handoffOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const argOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const missing = (name: string): never => {
    throw new ClaimsPublicationError(`required argument ${name} is missing`);
  };
  const runIdRaw = argOf("--producer-run-id") ?? missing("--producer-run-id");
  if (!/^[0-9]+$/.test(runIdRaw)) {
    throw new ClaimsPublicationError("--producer-run-id must be a decimal run number");
  }
  const producerRunId = Number(runIdRaw);
  if (!Number.isSafeInteger(producerRunId) || producerRunId < 1) {
    throw new ClaimsPublicationError("--producer-run-id is not a representable run number (safe-integer subset enforced)");
  }
  const producerIdentity = argOf("--producer-identity") ?? missing("--producer-identity");
  if (producerIdentity !== PINNED_CLAIMS_PRODUCER_IDENTITY) {
    throw new ClaimsPublicationError(
      `--producer-identity ${JSON.stringify(producerIdentity)} does not match the pinned producer identity ${JSON.stringify(PINNED_CLAIMS_PRODUCER_IDENTITY)}`,
    );
  }
  const producerRepo = argOf("--producer-repo") ?? DEFAULT_CLAIMS_PRODUCER_REPO;
  // P125-01: declaration only — the consumer enforces the trusted repo.
  if (producerRepo !== TRUSTED_CLAIMS_PRODUCER_REPO) {
    throw new ClaimsPublicationError(
      `--producer-repo ${JSON.stringify(producerRepo)} is not the trusted producer repository ${JSON.stringify(TRUSTED_CLAIMS_PRODUCER_REPO)}`,
    );
  }
  const producerWorkflowName = argOf("--producer-workflow") ?? missing("--producer-workflow");
  // P125-01: declaration only — the consumer enforces the pinned identity.
  if (producerWorkflowName !== TRUSTED_CLAIMS_PRODUCER_WORKFLOW_NAME) {
    throw new ClaimsPublicationError(
      `--producer-workflow ${JSON.stringify(producerWorkflowName)} is not the pinned producer workflow ${JSON.stringify(TRUSTED_CLAIMS_PRODUCER_WORKFLOW_NAME)}`,
    );
  }
  return {
    repo: argOf("--repo") ?? missing("--repo"),
    producerRunId,
    producerRepo,
    producerWorkflowName,
    artifactName: argOf("--artifact-name") ?? CLAIMS_PRODUCER_ARTIFACT_NAME,
    sourceCommit: argOf("--source-commit") ?? missing("--source-commit"),
    producerIdentity,
    producerVersion: argOf("--producer-version") ?? missing("--producer-version"),
    expectedPool: argOf("--expected-pool"),
    expectedLpMint: argOf("--expected-lp-mint"),
    expectedAmmProgramId: argOf("--expected-amm-program-id"),
    handoffOnly: argv.includes("--handoff-only"),
  };
}

function expectationsFromArgs(args: Args): ClaimsProducerExpectations {
  return {
    producerRepo: args.producerRepo,
    producerRunId: args.producerRunId,
    producerWorkflowName: args.producerWorkflowName,
    artifactName: args.artifactName,
    sourceCommit: args.sourceCommit,
    producerIdentity: args.producerIdentity,
    expectedPool: args.expectedPool,
    expectedLpMint: args.expectedLpMint,
    expectedAmmProgramId: args.expectedAmmProgramId,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env["GY_CLAIMS_GITHUB_TOKEN"] ?? process.env["GITHUB_TOKEN"] ?? "";
  // The PRODUCER-side token (Actions runs/artifacts of the producer repo).
  // Falls back to the publication token only when no dedicated one is set
  // (same-repo rehearsal); cross-repo retrieval REQUIRES the dedicated one.
  const producerToken = process.env["GY_CLAIMS_PRODUCER_GITHUB_TOKEN"] ?? token;
  const expectations = expectationsFromArgs(args);

  if (args.handoffOnly) {
    // Pre-flight: READ-ONLY (GET requests only) — verifies the producer
    // run identity, provenance, and artifact bytes WITHOUT any
    // publication side effect. Result JSON carries no secret material.
    const handoff = await fetchVerifiedClaimsArtifact({ token: producerToken, expectations });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        handoffOnly: true,
        producerRepo: expectations.producerRepo,
        producerRunId: expectations.producerRunId,
        artifactId: handoff.artifactId,
        artifactName: handoff.artifactName,
        artifactSha256: handoff.artifactSha256Hex,
        artifactZipByteLength: handoff.artifactZipByteLength,
        runHeadSha: handoff.runHeadSha,
        trustedProducer: handoff.trustedProducer,
      })}\n`,
    );
    return 0;
  }

  const store = new GitHubClaimsReleaseStore({ repo: args.repo, token });
  const result = await publishVerifiedProducerArtifact({
    token: producerToken,
    expectations,
    publish: (artifactBytes) =>
      runClaimsPublicationSequence({
        store,
        input: {
          artifactBytes,
          sourceCommit: args.sourceCommit,
          producer: { identity: args.producerIdentity, version: args.producerVersion },
          publishedAtUnixMs: Date.now(),
        },
      }),
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
