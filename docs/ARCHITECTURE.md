# Architecture

## Principles

1. **Deterministic control plane** (ADR-0002). LLMs plan and implement;
   a conventional engine owns every durable state change: transitions,
   scheduling, retries, budgets, checkpoints, audit, recovery. No project
   depends on hidden conversational memory.
2. **Local-first** (ADR-0003). One `pnpm install`, one SQLite file, zero
   required external daemons; the fake provider verifies orchestration offline.
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
        │ Engine       (engine.ts)      │  worktrees, routing, checks, review
        │ Brain        (brain.ts)       │  AI planning pipeline + replanning
        │ Snapshot     (snapshot.ts)    │  bounded secret-free repo snapshot
        │ Store        (store.ts)       │  transactions + event append
        │ SQLite       (db.ts)          │  node:sqlite, WAL, migrations
        └───────────────────────────────┘
                   |  lease/output/exit (authenticated per worker)
            services/worker            capabilities/capacity leases,
                                       OS sandbox + process-group cleanup
```

`packages/orchestration` is pure logic (no I/O): mission/run transition
tables, dependency DAG resolution, correction-loop decisions, fallback
policy, deterministic scheduler. `services/control-plane` composes it with
persistence and providers.

## Central AI brain

`BrainPipeline` (`services/control-plane/src/brain.ts`) owns the durable,
asynchronous planning pipeline: objective → bounded repository snapshot →
structured analysis → architecture proposal → plan/DAG proposal →
deterministic validation → transactional persistence → scheduling. Models
reason and propose against versioned zod contracts (`packages/contracts/src/
brain.ts`); the control plane mints every durable identifier, validates every
proposal (known acyclic dependencies, full acceptance-criteria coverage,
policy-conformant paths and check commands, budgets/timeouts, no logical
duplicates) and persists the plan version, its missions and their DAG in one
transaction that deactivates the previous version and cancels only legally
cancellable missions. Each step is a durable `brain_runs` row carrying
provider, model, redacted input/output, usage and provenance — the fake
provider's output is explicitly `fake_fixture` and never real planning
evidence. Invalid structured output goes through a bounded repair loop, then
the project is blocked with an intervention; a heuristic plan is never
silently substituted. Evidence-based replanning (objective revision, mission
failure after the correction loop) is bounded, idempotent per cause, never
touches in-flight missions and preserves plan history. On restart, orphan
brain runs are failed exactly once and planning resumes without duplicating
an already-persisted plan.

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
missed events then streams live. On startup the engine marks orphaned active
runs failed once, routes their missions through bounded correction and resumes
validation/review states. Commits are skipped for clean trees and PR rows are
unique per mission. A crashed provider call may be retried; external provider
billing cannot be proven exactly-once without vendor idempotency support.

## Data

Single SQLite database per instance (`~/.avity/avity.sqlite`), WAL mode,
ordered transactional migrations in `services/control-plane/src/db.ts`.
Every table carries `project_id` scoping. The audit log is a SHA-256 hash
chain verified by `verifyAuditChain()`.

## Isolation model

Projects are isolated by id at every query and each has a durable brain whose
decisions/risks/evidence are injected into author and reviewer prompts.
Missions get isolated git worktrees and branches; CLI agents use vendor
non-interactive sandbox controls; checks use macOS `sandbox-exec` or Linux
Bubblewrap and workers use fenced leases. Concurrency is bounded by host
configuration globally/per project/worker, not by a product-wide fixed limit.
