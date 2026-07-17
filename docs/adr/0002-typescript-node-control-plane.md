# ADR-0002: TypeScript/Node control plane with deterministic orchestration core

Status: accepted
Date: 2026-07-17

## Context

The control plane owns state transitions, scheduling, retries, budgets,
checkpoints, Git operations and crash recovery. It must be deterministic:
LLMs plan and implement, but a conventional engine owns every durable state
change. The rest of the stack (web, CLI, contracts) is TypeScript.

## Decision

- Implement the control plane and worker as Node 20+ TypeScript services.
- Orchestration logic (state machines, DAG resolution, retry/fallback policy)
  lives in `packages/orchestration` as **pure functions over explicit
  transition tables** — no I/O, fully unit-testable.
- The control-plane service (`services/control-plane`) composes: HTTP API
  (Fastify), SQLite persistence, event log, and the orchestration package.
- No LLM call is ever required to make a state transition legal; providers are
  invoked *by* missions, never the other way around.

## Alternatives considered

- **Temporal/other workflow engines**: powerful but heavyweight for a
  local-first product; adds an external dependency users must run. Durable
  recovery is implemented instead via transactional SQLite state + startup
  reconciliation.
- **Go/Rust control plane**: better raw performance, but splits the codebase
  across languages and slows contract sharing with the clients; unnecessary at
  this scale (single-user, local-first).

## Consequences

- One language across contracts, services, CLI and web.
- The scheduler and state machines are testable without a database or network.
- Determinism boundary is explicit: `packages/orchestration` may not import
  provider adapters.
