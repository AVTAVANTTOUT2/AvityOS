# Backup and restore

All durable state lives in one SQLite database (default
`~/.avity/avity.sqlite`, WAL mode).

## Backup

```sh
# consistent online backup (checkpoints WAL into the copy)
sqlite3 ~/.avity/avity.sqlite ".backup '/backups/avity-$(date +%F).sqlite'"
```

Cold copy also works if the control plane is stopped: copy the `.sqlite`
file (plus `-wal`/`-shm` if present).

## Restore

1. Stop the control plane.
2. Replace the database file with the backup.
3. Start the control plane — startup migrations apply anything missing and
   the reconciler fails orphaned runs exactly once and resumes missions
   through the normal bounded retry path.

## Integrity check after restore

```sh
sqlite3 avity.sqlite "PRAGMA integrity_check;"
curl -s localhost:7717/v1/audit | jq .chainValid   # audit hash chain intact
```

Worker tokens survive restore (only hashes are stored). Any workers
enrolled after the backup was taken must re-enroll.
