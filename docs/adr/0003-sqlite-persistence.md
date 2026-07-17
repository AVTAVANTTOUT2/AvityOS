# ADR-0003: SQLite (node:sqlite) persistence with in-repo migrations

Status: accepted
Date: 2026-07-17

## Context

AvityOS is local-first: one user, many isolated projects, durable state that
must survive restarts. Persistence must be trivial to set up (no external
daemon), transactional, and recoverable.

## Decision

- Use SQLite via the built-in `node:sqlite` module (synchronous,
  transactional, zero-config, **zero native dependencies** — Node ≥ 22.5 ships
  it; the repo pins Node ≥ 20 for tooling but the control plane requires the
  sqlite-capable runtime).
- One database file per AvityOS instance under `~/.avity/` (configurable);
  every table carries `project_id` scoping enforced in the data layer.
- Migrations are ordered SQL files applied transactionally at startup by a
  small in-repo runner; the `schema_migrations` table records applied versions.
- State transitions are performed inside transactions that also append the
  corresponding event to the append-only `events` table, so state and audit
  history can never diverge.
- WAL mode for concurrent readers (event streaming) with a single writer.

## Alternatives considered

- **Postgres**: better for multi-node deployment, but breaks the "clone and
  run" local-first requirement. The data layer is kept behind a repository
  interface so a Postgres driver can be added when remote/multi-user
  deployment becomes real.
- **Drizzle/Prisma ORM**: convenient but adds codegen and magic between the
  deterministic engine and its storage; hand-written SQL keeps transitions
  auditable.

## Consequences

- `pnpm dev:platform` needs no external services.
- Backup/restore is file copy plus WAL checkpoint (documented in
  BACKUP-RESTORE).
- Multi-machine scale-out requires a future driver, accepted consciously.
