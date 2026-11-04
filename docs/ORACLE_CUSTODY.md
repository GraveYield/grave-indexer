# Oracle-Custody Registration (Phase 2 item 9.5) — NS-3 edition

Register the indexer's oracle pubkey with the deployed devnet GraveScanner so
canonical attestations verify. Until then every attestation fails closed with
`6026 AttestationOracleMismatch` (check order in `attestation.rs`: sig/pk pin
6025 → oracle equality 6026 → message-span pin 6025).

- Program: GraveScanner `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL`
  (NS-3, assigned per DR-002 — **deployment pending**; this runbook applies
  once the owner has executed the deployment recorded in
  `graveyield-protocol/docs/DEVNET.md`. The NS-2 deployment
  `CuQZes…Ao54` is a preserved legacy record — never re-point at it.)
- Config: PDA `["protocol_config"]` (NS-3 derivation:
  `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe`, bump 255), fields
  `launch_price_oracle` (C2) and `activity_oracle` (C1)
- Authority: the NS-3 GOVERNANCE authority
  `BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5` (initial and permanent
  ProtocolConfig authority; `has_one = authority` on
  `update_protocol_config`). NS-3 separates the roles: the deployer
  `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` pays fees and holds the
  upgrade authority but is NOT the config authority. Devnet registration
  tooling: `graveyield-protocol/scripts/devnet/protocol_admin.mjs
  register-oracle --authority <governance KP> --fee-payer <deployer KP>`.
  The mainnet posture remains multisig-only with 72h timelocks.
- NS-3 dedicated oracle signers (public keys only; keypairs are
  owner-held custody):
  - activity oracle (C1): `2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o`
  - launch-price oracle (C2): `97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee`
  `initialize` starts BOTH oracle fields at the governance authority, so
  these registrations are mandatory post-initialization steps before any
  attestation can verify on devnet.

## 1. Generate the oracle keypair (offline)

> **NS-3 note:** the NS-3 oracle keypairs are ALREADY generated and held in
> owner custody (public keys above). This section remains as the procedure
> template for a FUTURE rotation — it does not apply to the NS-3 launch,
> whose keys already exist. Never regenerate or replace the NS-3 oracle
> keys as part of this registration.

```sh
solana-keygen new --no-bip39-passphrase --outfile /home/z/my-project/keys/grave-oracle.json --silent
chmod 600 /home/z/my-project/keys/grave-oracle.json
solana-keygen pubkey /home/z/my-project/keys/grave-oracle.json   # only artifact that leaves the machine
```

Hard red lines:

- Key file stays in `keys/`, **outside any git repo**, mode `0600`.
- Never print, paste, commit, or back up the seed anywhere.
- The key never needs funding — it signs messages offline
  (`nacl.sign.detached`); the payer covers tx fees.

## 2. Register the pubkey on-chain

Submit `update_protocol_config` with `launch_price_oracle: Some(<pubkey>)`
(and `activity_oracle: Some(<pubkey>)` if C1 signing is enabled) as a Squads
vault transaction from the ProtocolConfig authority. The SDK deliberately has
no client method for this — it is a governance action, not a pipeline action.

Rotation semantics: setting a new oracle affects only future attestations;
recorded LaunchPrice PDAs are init-once and untouched.

## 3. Point the indexer at the key

```sh
export ORACLE_KEY_FILE=/home/z/my-project/keys/grave-oracle.json
```

The loader (`src/config.ts`) accepts solana-keygen JSON (64-byte secret array)
or a 32-byte seed array; `ACTIVITY_ORACLE_KEY=<base58 seed>` is the env-only
alternative.

## 4. Verify the gate flipped

```sh
PAYER_KEY_FILE=/home/z/my-project/keys/devnet-payer.json bin/grave-indexer.mjs verify-path
```

Expected: the canonical positive case flips `6026` → accepted, matrix goes
13/13 PASS with 0 skipped. Definitive confirmation; optional read-back is
`decodeScannerProtocolConfig(data).launchPriceOracle` on the `["protocol_config"]` PDA.

## Rotation / rollback

Re-run step 2 with the new (or old) pubkey and update `ORACLE_KEY_FILE`.
On key compromise: generate a replacement (step 1), register it (step 2),
rotate the env var (step 3), re-verify (step 4).

## Full illustrated guide

The complete walkthrough volume (executive summary, Route A vs Route B
decision tree, borsh-exact `register_oracle.mjs` listing with dry-run and
read-back verification, rotation/rollback) is preserved alongside this
document: [`GraveYield_Oracle-Custody_Registration_Guide_2026-10-26.docx`](GraveYield_Oracle-Custody_Registration_Guide_2026-10-26.docx).
This markdown is the operational quick path; the docx is the full guide.
