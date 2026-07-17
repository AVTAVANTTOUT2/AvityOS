# ADR-0001: pnpm monorepo with apps/services/packages layout

Status: accepted
Date: 2026-07-17

## Context

AvityOS spans a web client, a native macOS client, a CLI, a control-plane
service, a worker service, and several shared domain libraries. The repository
started as a single-package Figma export. pnpm was already the package manager
in use (lockfile, workspace file present).

## Decision

Use a single pnpm workspace monorepo:

```
apps/web        apps/macos       apps/cli
services/control-plane           services/worker
packages/contracts  packages/orchestration  packages/providers
packages/git        packages/policy         packages/observability
```

- The existing frontend moved to `apps/web` with `git mv` so history survives.
- Shared TypeScript config lives in `tsconfig.base.json`; each package extends it.
- Workspace protocol (`workspace:*`) links internal dependencies.
- The macOS app is a Swift package inside `apps/macos`; it participates in the
  repo but not in the pnpm graph.

## Consequences

- One `pnpm install`, one `pnpm verify` for the whole platform.
- Contracts are shared by import, not by copy, so clients cannot drift from
  the control plane silently.
- Node-version and toolchain pinning happens once at the root
  (`engines`, `packageManager`).
