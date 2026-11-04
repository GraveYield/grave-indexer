# Oracle-Custody Registration (Phase 2 item 9.5) — NS-3 edition

Register the indexer's oracle pubkeys with the deployed devnet GraveScanner so
canonical attestations verify. Until then every attestation fails closed with
`6026 AttestationOracleMismatch` (check order in `attestation.rs`: sig/pk pin
6025 → oracle equality 6026 → message-span pin 6025).

> **Two environments, two procedures.** This document covers BOTH, and they
> must not be conflated:
>
> * **NS-3 Devnet (current, operational)** — the GOVERNANCE authority signs
>   `update_protocol_config`; the DEPLOYER pays the transaction fee; the two
>   oracle identities are registered INDEPENDENTLY (each is a plain public
>   key argument — the dedicated oracle keys are NOT required to sign their
>   own registration, and no keypair beyond the governance authority and the
>   fee payer ever touches the transaction). The actual registration
>   procedure is `graveyield-protocol/scripts/devnet/protocol_admin.mjs
>   register-oracle` (§2A below). No Squads vault is involved on devnet.
> * **Future Mainnet architecture (planned, NOT implemented by the current
>   programs)** — a Squads multisig holds the ProtocolConfig authority and
>   changes flow through vault transactions. The current program
>   implementation does NOT enforce a 72-hour timelock or a functional
>   ProtocolConfig authority-transfer mechanism: the `pending_authority` /
>   `pending_authority_eta` fields exist in the config layout but are
>   reserved/write-only as of the NS-3 build — no instruction acts on them.
>   Do not treat the mainnet posture as existing functionality; §2B
>   describes intent only.

## NS-3 Devnet identities and roles (public keys only)

| Role | Public key | Role in `register-oracle` |
| --- | --- | --- |
| GraveScanner program | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` | target of `update_protocol_config` (NS-3, DR-002 — **deployment pending**; this runbook applies once the owner executes the deployment recorded in `graveyield-protocol/docs/DEVNET.md`. The NS-2 deployment `CuQZes…Ao54` is a preserved legacy record — never re-point at it.) |
| ProtocolConfig PDA | `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe` (`["protocol_config"]`, bump 255) | account updated by the instruction |
| Governance authority | `BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5` | initial and permanent ProtocolConfig authority (`has_one = authority`); the ONLY instruction-level signer |
| Deployer | `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` | transaction FEE PAYER only; holds the program upgrade authority but is NOT the config authority |
| Activity oracle (C1) | `2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o` | registered VALUE (public key) for `activity_oracle`; never a signer |
| Launch-price oracle (C2) | `97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee` | registered VALUE (public key) for `launch_price_oracle`; never a signer |

`initialize` starts BOTH oracle fields at the governance authority, so these
registrations are mandatory post-initialization steps before any attestation
can verify on devnet. Each field is registered independently — one
`register-oracle` call may set either or both (`Option` arguments).

No private keys or keypair contents appear anywhere in this repository or in
this document; the keypairs live exclusively in owner custody, outside any
repo, mode `0600`.

## 1. Oracle keys (offline)

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
- The oracle key never needs funding — it signs messages offline
  (`nacl.sign.detached`); the payer covers tx fees. It does not sign the
  registration transaction either (§2A).

## 2A. Register on NS-3 devnet — `protocol_admin.mjs register-oracle`

The authoritative procedure (run by the owner after the NS-3 deployment and
`init-all`):

```sh
cd graveyield-protocol/scripts/devnet

# Both oracle fields in one call (they may also be set in separate calls):
node protocol_admin.mjs register-oracle \
  --url https://api.devnet.solana.com \
  --authority <governance KP file> \
  --fee-payer <deployer KP file> \
  --activity-oracle 2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o \
  --launch-price-oracle 97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee

# Or one field at a time (independent registration):
node protocol_admin.mjs register-oracle --url <U> --authority <governance KP> \
  --fee-payer <deployer KP> --activity-oracle 2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o
```

Semantics (as implemented in `protocol_admin.mjs`):

- The transaction is a single `update_protocol_config` instruction on
  GraveScanner; the GOVERNANCE authority is the instruction signer
  (`has_one = authority`).
- `--fee-payer` keeps the governance key OFF the fee-paying path: the fee is
  paid by the separate deployer keypair (both sign the TRANSACTION; only the
  authority is an instruction-level signer).
- `--activity-oracle` / `--launch-price-oracle` take PUBLIC keys only — the
  dedicated oracle keypairs are not loaded, not required, and never sign.
- The command asserts the read-back: `assertConfig` re-decodes the
  ProtocolConfig PDA and verifies the registered values landed.

Rotation semantics: setting a new oracle affects only future attestations;
recorded LaunchPrice PDAs are init-once and untouched.

## 2B. Future Mainnet architecture (planned — NOT implemented)

On mainnet the ProtocolConfig authority is intended to sit behind a Squads
multisig, and config changes flow as vault transactions proposed, approved by
the quorum, and executed after a delay. That is the future security
architecture — the CURRENT programs do not enforce a 72-hour timelock and
have NO functional authority-transfer path (`pending_authority` /
`pending_authority_eta` are reserved fields in the config layout; no
instruction consumes them). When the mainnet architecture is implemented it
will be documented as a program change with its own review; until then:

- Devnet procedure = §2A (direct keypair signing by the governance authority).
- Mainnet procedure = does not exist yet; do not run devnet registration
  through any Squads flow, and do not describe the timelock as active.

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

Re-run step 2A with the new (or old) pubkey and update `ORACLE_KEY_FILE`.
On key compromise: generate a replacement (step 1), register it (step 2A),
rotate the env var (step 3), re-verify (step 4).

## Full illustrated guide (HISTORICAL — NS-2 era)

The complete walkthrough volume
([`GraveYield_Oracle-Custody_Registration_Guide_2026-10-26.docx`](GraveYield_Oracle-Custody_Registration_Guide_2026-10-26.docx))
predates the NS-3 arrangement and describes the NS-2-era Squads vault
transaction flow. It is preserved as a historical record only — for the
current NS-3 devnet procedure use §2A of this markdown; do not follow the
docx for NS-3 registrations.
