# AvityOS

A local-first, multi-project operating system for autonomous software
delivery: you give an objective, a deterministic control plane plans it,
delegates missions to AI providers, validates every result with evidence,
and returns a verified deliverable — interrupting you only when a decision
genuinely requires you.

The visual identity comes from the original
[Figma design](https://www.figma.com/design/MnTdZbrH4OHTHD8NbZC6iz/Start-project).

## Repository layout

```
apps/web               React/Vite client (Figma-derived UI, live backend data)
apps/macos             Native SwiftUI macOS app + menu-bar companion
apps/cli               `avity` command line client
services/control-plane Durable orchestration service (Fastify + SQLite)
services/worker        Terminal/subprocess execution worker
packages/contracts     zod schemas: domain model, API, events (source of truth)
packages/orchestration Deterministic state machines, DAG, scheduler, fallback
packages/providers     Fake, Codex/Claude/Cursor CLI, OpenAI Responses, Anthropic, DeepSeek
packages/git           Injection-safe git/worktree operations
packages/policy        Policy engine, command/path allowlists, secret redaction
docs/                  Architecture, security, lifecycle, ADRs, runbooks
```

## Requirements

- macOS (or Linux for the TypeScript stack)
- **Node ≥ 22.5** (the control plane uses the built-in `node:sqlite`)
- pnpm 11 (`corepack enable` or `brew install pnpm`)
- git
- Xcode 15+ (only for the macOS app)

## Quick start

```sh
pnpm install                 # bootstrap everything
pnpm verify                  # typecheck + test + build all packages

# 1. start the control plane (SQLite in ~/.avity by default)
pnpm --filter @avityos/control-plane start

# 2. start the web client (http://localhost:5173)
pnpm --filter @avityos/web dev

# 3. optional: start a worker for terminal sessions
pnpm --filter @avityos/worker start

# 4. or drive everything from the CLI
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js project create "My project"
node apps/cli/dist/main.js objective submit <project-id> "Build X with tests" "criterion 1"
```

No paid credentials are needed to verify the orchestration: the deterministic
**fake provider** edits an isolated fixture repository and exercises the full
worktree → checks → commit → review → correction lifecycle. Real software
delivery uses a configured coding CLI (Codex, Claude Code, Cursor, or a trusted
command adapter). The web UI shows **Live**, **Hors ligne**, or the explicit
**Démo** mode enabled only with `VITE_AVITY_DEMO=1`.

## macOS app

```sh
cd apps/macos && swift run AvityOS
```

## Documentation

- [docs/PRODUCT.md](docs/PRODUCT.md) — what AvityOS is and does today
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and boundaries
- [docs/PROJECT-LIFECYCLE.md](docs/PROJECT-LIFECYCLE.md) — objective → delivery
- [docs/PROVIDER-ADAPTERS.md](docs/PROVIDER-ADAPTERS.md) — adding providers
- [docs/POLICIES.md](docs/POLICIES.md) — policy and checkpoint engine
- [docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md) — branch/worktree/PR discipline
- [docs/LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md) — dev environment
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md), [docs/RUNBOOKS.md](docs/RUNBOOKS.md)
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/TRACEABILITY.md](docs/TRACEABILITY.md) — definition-of-done evidence map

## Testing

```sh
pnpm verify             # builds, 99 tests, strict typechecks
pnpm verify:full        # above + Playwright browser E2E + Swift tests
pnpm licenses:check     # dependency license policy + JSON evidence
pnpm audit --audit-level high
```
