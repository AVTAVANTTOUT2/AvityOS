# Architecture

## Principles

1. **Deterministic control plane** (ADR-0002). LLMs plan and implement;
   a conventional engine owns every durable state change: transitions,
   scheduling, retries, budgets, checkpoints, audit, recovery. No project
   depends on hidden conversational memory.
2. **Local-first** (ADR-0003). One `pnpm install`, one SQLite file, zero
   external daemons; the fake provider makes the whole platform work offline.
3. **Contracts as source of truth** (ADR-0004). Every entity, request and
   event is a zod schema in `packages/contracts`; services validate all input
   at runtime and clients import the same types.
4. **Provider independence** (ADR-0005). All AI execution flows through the
   versioned `ProviderAdapter` interface with a closed set of normalized
   error categories.

## Components

```
 web (React)   macOS (SwiftUI)   cli (avity)
      \              |              /
       ─────── REST + SSE ─────────
                   |
        services/control-plane
        ┌───────────────────────────────┐
        │ Fastify API  (server.ts)      │  contract validation, error codes,
        │ Engine       (engine.ts)      │  idempotency keys, SSE stream
        │ Store        (store.ts)       │  transactions + event append
        │ SQLite       (db.ts)          │  node:sqlite, WAL, migrations
        └───────────────────────────────┘
                   |  lease/output/exit (authenticated per worker)
            services/worker            argv-only subprocess runner,
                                       process-group cleanup
```

`packages/orchestration` is pure logic (no I/O): mission/run transition
tables, dependency DAG resolution, correction-loop decisions, fallback
policy, deterministic scheduler. `services/control-plane` composes it with
persistence and providers.

## State machines

Mission: `proposed → ready → assigned → running → result_submitted →
validating → review_required → approved → integrated → completed`, plus
`paused`, `blocked`, `retrying`, `cancelled`, `failed` with explicit legal
transitions (see `packages/orchestration/src/machines.ts`). Property tests
enforce full state coverage, sealed terminal states and reachability.
The store refuses any transition not in the table, atomically with the
event append — state and audit history cannot diverge.

## Events and recovery

Every durable mutation appends to the `events` table (monotonic `seq`) in
the same transaction. Clients resume streams with `?afterSeq=`; SSE replays
missed events then streams live. On startup the engine reconciles: orphaned
active runs are failed once (never replayed), their missions re-enter the
bounded correction path, and stuck transient states are re-queued —
restart produces no duplicate side effects (covered by scenario-6 test).

## Data

Single SQLite database per instance (`~/.avity/avity.sqlite`), WAL mode,
ordered transactional migrations in `services/control-plane/src/db.ts`.
Every table carries `project_id` scoping. The audit log is a SHA-256 hash
chain verified by `verifyAuditChain()`.

## Isolation model

Projects are isolated by id at every query; missions get isolated git
worktrees and branches (`packages/git`); workers run commands in their own
detached process groups with scoped environments; budgets, usage and events
are all per-project. Concurrency is bounded by configurable host limits
(global and per-project), not a fixed product limit.
