# GraveYield/grave-indexer

Phase 2 — Raydium V4 pool discovery and evidence pipeline for GraveScanner.

Enumerates the Raydium V4 AMM corpus (mainnet-beta, read-only), preserves
provenance and timestamps end to end, handles duplicate ingestion, detects
stale and conflicting data, exposes operational health, and produces oracle
evidence that is byte-compatible with the on-chain GraveScanner attestation
contract (ORACLE-002) — verified against the live devnet deployment.

**Read `docs/ORACLE_PIPELINE.md` first** — it documents the as-implemented
on-chain oracle interface (inspected from `graveyield-protocol` source, not
invented), the live verification matrix, and the key custody / rotation /
revocation / monitoring / downtime runbook.

## Layout

```
vendor/protocol/     git submodule → GraveYield/graveyield-protocol @ 5b84440
                     (the SDK inside it is the single source of truth for
                      every wire format; this repo never forks one)
src/
  provenance.ts      fingerprints, endpoint redaction, freshness policy
  config.ts          env-driven config, two-cluster wiring, key-file parsing
  discovery.ts       Raydium V4 enumeration (raw JSON-RPC gPA + dataSlice)
  ingest.ts          durable ledger: dedupe / change / conflict / staleness
  activityLive.ts    last-swap derivation (SDK) + cache + regression rule
  evidence.ts        secret-free evidence bundles, malformed-input rejection
  issue.ts           issuance on the destination cluster (slot-hash binding)
  sign.ts            Ed25519 signing, key custody rules
  verify.ts          off-chain mirror of the on-chain check order (6024–6031)
  journal.ts         operator-side replay guard (JSONL, append-only)
  evidencePath.ts    the live verification matrix vs the deployed scanner
  health.ts          per-stage health registry (ok/degraded/failing)
  cli.ts             discover | collect | verify-path | health
test/                49 offline tests + DEVNET_RPC_URL-gated live smoke
examples/            live artifacts (secret-free by construction)
```

## Quick start

```bash
pnpm install                 # workspace includes vendor/protocol/sdk
pnpm test                    # build SDK + offline battery (49 tests)
pnpm run cli discover        # one Raydium V4 discovery cycle (mainnet)
pnpm run cli collect --use-ephemeral-oracle   # issue + verify evidence
pnpm run cli verify-path     # full devnet evidence-path matrix
```

Configuration is env-driven with safe defaults (`DISCOVERY_RPC_URL`,
`DEVNET_RPC_URL`, `ORACLE_KEY_FILE`, …). Key material is never logged,
echoed, committed, or serialized — see docs §6.

## License

Apache-2.0, same as the rest of GraveYield.
