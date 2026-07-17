# Runbooks

## Control plane won't start

1. `node --version` — must be ≥ 22.5 (`node:sqlite`).
2. Check the DB path is writable; `AVITY_DB_PATH` overrides.
3. Port conflict: `lsof -i :7717`; change `AVITY_PORT`.

## Mission stuck in `blocked`

1. `avity intervention list` — a blocking approval almost certainly exists
   (provider failure, budget, correction limit).
2. `avity intervention answer <apr_id> --decision approved` to retry, or
   `--decision rejected` to cancel the mission.
3. Inspect why: `avity run list --project <id>`, then
   `avity run logs <run_id>`; `GET /v1/events?projectId=` has the full
   fallback trail (`provider.fallback` events).

## Provider rate-limited or down

Nothing to do within policy: the engine waits for reset when the reset fits
the wait budget, retries with backoff, switches models/providers when allowed,
and escalates an approval otherwise. To change behavior, adjust engine config
(`AVITY_MAX_*`, `allowModelSwitch`) and the provider's configured models.

## Worker offline / compromised

- Offline: it reconnects and resumes polling automatically; leased
  terminals it was running are marked by their exit reports — cancel any
  stuck session via `POST /v1/terminals/:id/cancel`.
- Compromised: `avity worker revoke <id>` immediately invalidates its
  token (hash comparison fails on next call). Re-enroll a clean host.

## Web UI shows "Hors ligne"

The control plane is unreachable from the browser. Check it is running,
`VITE_AVITY_API` points at the right URL, the browser origin is present in
`AVITY_ALLOWED_ORIGINS`, and the API token/session is valid. `Démo` appears
only when `VITE_AVITY_DEMO=1`.

## Restart during active work

Restart the process. The reconciler fails each orphaned run once and routes the
mission through bounded correction. Clean-tree commit checks and unique PR rows
avoid duplicate local Git/DB side effects. A vendor request interrupted before
its result was persisted can be retried and may be billed again; inspect usage.

## Database corruption suspected

Follow BACKUP-RESTORE.md restore, then `PRAGMA integrity_check` and the
audit `chainValid` check.
