# Backup and restore

Core orchestration state lives in one SQLite database (default
`~/.avity/avity.sqlite`, WAL mode). Operator credentials live separately in
the encrypted vault `~/.avity/operator/config/credentials.vault`; remote bridge
and relay deployments also have their documented SQLite/Keychain state.

## Backup

```sh
# consistent online backup (checkpoints WAL into the copy)
sqlite3 ~/.avity/avity.sqlite ".backup '/backups/avity-$(date +%F).sqlite'"
```

Cold copy also works if the control plane is stopped: copy the `.sqlite`
file (plus `-wal`/`-shm` if present).

The encrypted credential vault may be copied with the state backup, but its
master key must follow a separate recovery policy. On macOS the key is the
`com.avityos.operator-vault` Keychain item. On Linux
`AVITY_VAULT_KEY_FILE` must point outside the repository and operator state;
back it up separately with tighter access. Never place key and encrypted vault
in the same archive. Portable escrow and master-key rotation are not yet
implemented, so losing the key makes the vault unrecoverable.

## Restore

1. Stop the control plane.
2. Replace the database file with the backup.
3. Restore `credentials.vault` with mode `0600` and make its original Keychain
   item or external key file available. Run `avity vault status`; do not start
   if authentication fails.
4. Start the control plane — startup migrations apply anything missing and
   the reconciler fails orphaned runs exactly once and resumes missions
   through the normal bounded retry path.

## Integrity check after restore

```sh
sqlite3 avity.sqlite "PRAGMA integrity_check;"
curl -s localhost:7717/v1/audit | jq .chainValid   # audit hash chain intact
```

Worker tokens survive restore (only hashes are stored). Any workers
enrolled after the backup was taken must re-enroll.
