# Backup and restore

Core orchestration state lives in one SQLite database (default
`~/.avity/avity.sqlite`, WAL mode). Operator credentials live separately in
the encrypted vault `~/.avity/operator/config/credentials.vault`. Checkpoint
7.2 provides a certified online bundle for these two files and a separate,
passphrase-encrypted recovery escrow for the vault master key.

Remote bridge/relay databases, macOS Keychain identities and public release
signing material are different trust domains and keep their own documented
backup policies.

## One-time recovery escrow

Choose a private directory outside both the repository and operator state.
The passphrase is accepted only from non-TTY stdin, must be at least 16 UTF-8
bytes and is never included in command output:

```sh
install -d -m 0700 /offline/avity-recovery
read -r -s AVITY_RECOVERY_PASSPHRASE
printf '%s\n' "$AVITY_RECOVERY_PASSPHRASE" |
  avity vault recovery-export \
    --output /offline/avity-recovery/vault.recovery.json \
    --passphrase-stdin
unset AVITY_RECOVERY_PASSPHRASE
```

The `0600` recovery file uses scrypt plus AES-256-GCM and contains an encrypted
copy of the master key, never vault values. Store its passphrase separately.
Do not place the recovery file in the backup bundle.

## Certified online backup

The control plane may remain running. `VACUUM INTO` captures one consistent
SQLite snapshot, including committed WAL state. The command then checks
`integrity_check`, foreign keys, contiguous migrations and the complete audit
hash chain. It authenticates the copied credential vault with the separate
recovery escrow, hashes both files and writes a strict manifest:

```sh
install -d -m 0700 /backups/avity
read -r -s AVITY_RECOVERY_PASSPHRASE
printf '%s\n' "$AVITY_RECOVERY_PASSPHRASE" |
  avity backup create \
    --database "$HOME/.avity/avity.sqlite" \
    --output "/backups/avity/checkpoint-$(date +%F)" \
    --recovery /offline/avity-recovery/vault.recovery.json \
    --passphrase-stdin
unset AVITY_RECOVERY_PASSPHRASE
```

The destination must not exist and its parent must already be private. The
result is a `0700` directory containing only `0600` files:

- `avity.sqlite`;
- `credentials.vault`;
- `backup-manifest.json`.

The manifest contains hashes, counts, migration/generation numbers, audit head
and key identifier, but no secret value or raw key. Verify stored media
periodically with the same separately held recovery escrow:

```sh
read -r -s AVITY_RECOVERY_PASSPHRASE
printf '%s\n' "$AVITY_RECOVERY_PASSPHRASE" |
  avity backup verify \
    --bundle /backups/avity/checkpoint-2026-07-24 \
    --recovery /offline/avity-recovery/vault.recovery.json \
    --passphrase-stdin
unset AVITY_RECOVERY_PASSPHRASE
```

## Certified restore rehearsal

Restore always targets a new external directory and refuses to replace live
state. First read the bundle ID from `backup verify`, then confirm that exact
identifier:

```sh
install -d -m 0700 /restore-rehearsal
read -r -s AVITY_RECOVERY_PASSPHRASE
printf '%s\n' "$AVITY_RECOVERY_PASSPHRASE" |
  avity backup restore \
    --bundle /backups/avity/checkpoint-2026-07-24 \
    --destination /restore-rehearsal/avity \
    --recovery /offline/avity-recovery/vault.recovery.json \
    --confirm-bundle-id bkp_REPLACE_WITH_VERIFIED_ID \
    --passphrase-stdin
unset AVITY_RECOVERY_PASSPHRASE
```

The CLI re-runs the full database, audit, hash and vault certification on the
restored bytes before publishing the directory. It returns:

- `/restore-rehearsal/avity/avity.sqlite`;
- `/restore-rehearsal/avity/operator/config/credentials.vault`.

For a rehearsal on a machine that already has the production Keychain item,
restore the recovered key to a new external file rather than replacing that
item:

```sh
install -d -m 0700 /restore-rehearsal/key
read -r -s AVITY_RECOVERY_PASSPHRASE
printf '%s\n' "$AVITY_RECOVERY_PASSPHRASE" |
  AVITY_OPERATOR_HOME=/restore-rehearsal/avity/operator \
  avity vault recovery-restore \
    --input /offline/avity-recovery/vault.recovery.json \
    --confirm-key-id REPLACE_WITH_VERIFIED_SHA256_KEY_ID \
    --key-file /restore-rehearsal/key/operator-vault.key \
    --passphrase-stdin
unset AVITY_RECOVERY_PASSPHRASE
```

Open the restored database and vault only after both commands succeed. A real
disaster cutover still requires explicit supervisor paths
(`AVITY_DB_PATH`, `AVITY_OPERATOR_HOME` and, on Linux,
`AVITY_VAULT_KEY_FILE`). Workers enrolled after the snapshot must re-enroll.

## Master-key rotation

Keep a verified recovery escrow before rotating:

```sh
read -r -s AVITY_RECOVERY_PASSPHRASE
printf '%s\n' "$AVITY_RECOVERY_PASSPHRASE" |
  avity vault recovery-verify \
    --input /offline/avity-recovery/vault.recovery.json \
    --passphrase-stdin
printf '%s\n' "$AVITY_RECOVERY_PASSPHRASE" |
  avity vault key-rotate \
    --recovery /offline/avity-recovery/vault.recovery.json \
    --passphrase-stdin
unset AVITY_RECOVERY_PASSPHRASE
avity restart --service control-plane
avity restart --service worker
```

Rotation stages the next encrypted recovery file before changing the key
store, re-encrypts the vault under a process lock, atomically promotes the
recovery escrow and verifies all three views. A pre-commit failure rolls the
key store back. If the CLI reports a post-rotation promotion failure, preserve
both the named recovery file and its `.next` sibling; do not retry or delete
either until their key IDs have been inspected.
