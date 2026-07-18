# AvityOS

> Give one software objective. Receive a clean, tested, reviewed and documented
> deliverable.

AvityOS is a local-first operating system for autonomous software delivery. It
centralizes the work that would otherwise be scattered across projects,
computers, servers, terminals, coding agents and AI-provider sessions.

The user should not have to supervise ten projects or coordinate dozens of
agents manually. They state the intended outcome, answer a grouped set of
questions only when a material decision is genuinely ambiguous, then AvityOS
plans, delegates, executes, validates and prepares the result for integration.

The product supports multiple isolated projects in parallel through the web,
a native macOS application and the `avity` CLI. Its visual identity comes from
the original [Figma design](https://www.figma.com/design/MnTdZbrH4OHTHD8NbZC6iz/Start-project):
a calm white/cream interface, restrained indigo accents and a clean macOS
Liquid Glass influence.

## Why AvityOS

Using several AI coding tools can increase output, but it also creates a new
coordination problem: duplicated work, contradictory architecture, dirty Git
history, forgotten sessions, unverified claims, provider limits and constant
human context switching.

AvityOS provides one durable control point for that entire workflow:

- one objective instead of continuous micromanagement;
- one independent project brain for every repository;
- specialized product, architecture, frontend, backend, infrastructure,
  cybersecurity, QA, review and documentation missions;
- interchangeable Codex, Claude Code, Cursor, OpenAI, Anthropic and DeepSeek
  execution paths;
- isolated terminals, branches and worktrees for concurrent work;
- automatic checkpoints, bounded correction loops and provider fallback;
- evidence-backed Git commits and pull requests instead of unverified AI
  completion messages;
- a complete audit trail that survives restarts.

The priority is quality, not speed. AvityOS deliberately works in dependency
order within a project and only parallelizes work whose interfaces are stable.
Separate projects can continue concurrently without sharing state.

## Product contract

The intended interaction is:

1. The user creates or imports a project and submits an objective with optional
   acceptance criteria.
2. AvityOS analyzes clarity, feasibility, risks and missing information.
3. If the result would materially change, AvityOS asks one concise, grouped set
   of questions. Otherwise it proceeds without interruption.
4. The answers become durable, source-linked project decisions and execution
   resumes automatically.
5. A versioned plan and mission dependency graph are created and continuously
   revised from verified repository state.
6. Structured missions are delegated to specialized teams and suitable AI
   providers.
7. Agents execute in scoped worktrees or workers, while the control plane
   enforces permissions, budgets, timeouts and legal state transitions.
8. Real builds, tests, type checks, security scans and acceptance checks provide
   objective evidence.
9. Validated changes are committed and published as draft pull requests for an
   independent review. Rejected work enters a bounded correction loop.
10. The user receives a delivery report mapped to the acceptance criteria, or
    an intervention only when no safe autonomous path remains.

AvityOS does not silently purchase infrastructure, deploy to production,
expand credential access, override policy or merge protected branches.

## Non-negotiable principles

### Deterministic control plane

The central brain is not one long, fragile chat session. AI models reason,
plan, implement and review; a conventional orchestration engine owns durable
state transitions, scheduling, dependencies, permissions, retries, quotas,
budgets, checkpoints, Git operations, cancellation, recovery and audit.

### One durable brain per project

Each project keeps its own objective, clarified requirements, acceptance
criteria, plan versions, architecture decisions, mission results, constraints,
risks and verified repository state. Entries distinguish facts, assumptions,
proposals and decisions and retain provenance. Hidden conversational memory is
never the source of truth.

### Strict project isolation

Every project is scoped independently across persistence, policies, repository,
worktrees, processes, terminals, environment, provider usage, budgets, logs,
artifacts and events. There is no arbitrary product-wide terminal limit;
configurable host capacity, project policy, provider quotas and safety limits
control concurrency.

### Evidence before completion

A mission is not complete because an agent says it is. Completion requires the
expected diff and artifacts, successful required checks, clean Git state and an
independent review. Fake providers and demo fixtures are clearly identified and
never presented as real implementation evidence.

### Provider independence

All AI execution passes through versioned adapters with explicit capabilities
and normalized errors. The system can wait for a quota reset, retry with
backoff, switch model, switch provider or escalate according to project policy.
It never changes provider silently when privacy, capability or budget rules
would be violated.

### Git as the delivery ledger

Each coding mission uses an isolated branch and worktree. Changes remain scoped,
commits are atomic, checks are mandatory and protected branches are never
force-pushed. AvityOS can prepare and mark an approved draft PR ready, but it
does not self-merge.

## Specialized teams and mission contracts

AvityOS routes work by role: product and requirements, architecture, frontend,
backend, infrastructure and platform, cybersecurity, QA, independent code
review, documentation and release.

Delegation is structured rather than prompt-only. Every mission carries an
immutable identity, objective, rationale, dependencies, allowed and forbidden
paths/actions, acceptance criteria, required checks, budget, timeout, expected
artifacts and escalation conditions. The author of a change is not its sole
reviewer.

## User surfaces

- **Web Mission Control** — projects, plans, mission Kanban, agents, live
  executions and terminals, interventions, GitHub state, providers, usage,
  quality, security, project memory, activity and policies. Connection state is
  always explicit: `Live`, `Hors ligne`, `Reconnexion` or `Démo`.
- **Native macOS app** — SwiftUI client using Keychain-backed authentication,
  REST/SSE state, multiple project views, terminal logs, interventions, deep
  links, notifications, Dock badge and a menu-bar companion.
- **CLI** — headless access to the complete lifecycle with human-readable and
  machine-readable JSON output for scripts and remote workflows.

## Architecture

```text
 React/Vite web        SwiftUI macOS app        avity CLI
       \                      |                    /
        +---------------- REST + SSE -------------+
                              |
                    Durable control plane
              Fastify + state engine + SQLite/WAL
                   /            |             \
          project brains   policies/Git    scheduler
                 |              |             |
       provider adapters   checkpoints    worker leases
                 \              |             /
          isolated worktrees, sandboxes and terminals
```

The control plane is local-first: one pnpm workspace and one SQLite database
are enough for the complete deterministic fake-provider lifecycle. Registered
workers can extend execution to other machines using authenticated,
revocable, capacity-fenced leases.

### Technology stack

| Area | Technologies |
| --- | --- |
| Web | React 18, TypeScript, Vite 6, Material UI, Radix UI, Tailwind CSS, REST and SSE |
| macOS | Swift 5.9, SwiftUI, Security/Keychain, native notifications and menu-bar integration |
| CLI | TypeScript/Node.js, shared runtime contracts, JSON output |
| Control plane | Node.js 22+, Fastify 5, built-in `node:sqlite`, WAL and transactional migrations |
| Contracts | Zod schemas shared across API, events, services and TypeScript clients |
| Orchestration | Explicit state machines, dependency DAG, deterministic scheduler, retries and fallback |
| Providers | Codex CLI, Claude Code, Cursor CLI, OpenAI Responses, Anthropic, DeepSeek, generic command and deterministic fake adapters |
| Execution | Git worktrees, scoped subprocesses, macOS `sandbox-exec`, Linux Bubblewrap and remote workers |
| Quality | Vitest, Playwright, Swift XCTest, strict TypeScript, dependency audit, license policy, Gitleaks and SPDX SBOM |
| Delivery | GitHub branches, conventional commits, draft PRs, independent review and macOS/Linux CI |

See [Architecture](docs/ARCHITECTURE.md),
[Provider adapters](docs/PROVIDER-ADAPTERS.md) and
[Security](docs/SECURITY.md) for the implemented boundaries.

## Security and autonomy

AvityOS treats provider output, repository content, terminal output, web
content and downloaded material as untrusted input. Important controls include:

- runtime validation using shared contracts;
- server-resolved worktree paths and symlink-escape protection;
- argv-based command execution without unsafe shell construction;
- fail-closed OS sandboxing and process-group cleanup;
- scoped provider environments and secret redaction before persistence;
- authenticated and revocable workers with short, fenced leases;
- policy-controlled dangerous actions and human approvals;
- hash-chained audit records, dependency scanning, secret scanning and SBOMs.

Projects choose one of three autonomy profiles: `supervised`,
`autonomous_with_checkpoints` or `maximum_autonomy`. Even maximum autonomy
remains bounded by explicit policies; destructive or irreversible actions
require approval by default.

## Current status

AvityOS is an active `0.1.0` implementation, not a claim that every production
integration is finished.

Implemented and covered by automated tests:

- complete project onboarding and idempotent updates across Web, CLI and the
  public API, with server-canonicalized Git paths, branches and GitHub remotes;
- a durable central AI brain: bounded secret-free repository snapshots,
  structured analysis, architecture proposals and validated plan/DAG versions
  produced through provider adapters, with bounded repair of invalid output,
  explicit fixture provenance and evidence-based bounded replanning;
- durable objective, clarification, planning, mission and intervention flows;
- restart recovery, transactional events and a hash-chained audit trail;
- concurrent project isolation and ordered per-project execution;
- real worktree changes, validation commands, commits, correction and
  independent review in deterministic fixture repositories;
- provider routing and cross-provider fallback;
- authenticated worker enrollment, capacity leases, revocation and sandboxed
  execution;
- live web state, native macOS client and first-class CLI;
- macOS and Linux CI with build, tests, type checking, browser tests,
  dependency/license checks, secret scanning and SBOM generation.

Known remaining proof or product work:

- the central AI brain is fully exercised offline through the deterministic
  fixture provider (labelled `fake_fixture`, never real planning evidence);
  a planning run with a live reasoning provider requires operator-owned API
  credentials and is deliberately part of the live-validation chantier;
- grouped clarifications remain heuristic and atomic pause/resume of an
  active run is not implemented yet (next chantier);
- live-provider smoke tests require operator-owned API credentials;
- autonomous push and draft-PR creation still need a dedicated external
  fixture repository and GitHub credentials for end-to-end proof;
- the Figma-derived web application still contains a large component that
  should be split further and some secondary controls remain presentational;
- signed and notarized macOS packaging and broader native UI tests remain;
- remote production exposure still requires operator-managed TLS termination,
  and a general encrypted cross-platform provider-key vault is not bundled.

The exact evidence and limitations are maintained in
[docs/TRACEABILITY.md](docs/TRACEABILITY.md).

## Repository layout

```text
apps/web               React/Vite Mission Control client
apps/macos             Native SwiftUI app and menu-bar companion
apps/cli               avity command-line client
services/control-plane Durable orchestration API, engine and SQLite store
services/worker        Local/remote execution worker
packages/contracts     Domain, API and event schemas — source of truth
packages/orchestration State machines, DAG, scheduler and fallback policy
packages/providers     AI/CLI provider adapters
packages/git           Injection-safe Git and worktree operations
packages/policy        Permissions, command/path policy and secret redaction
docs/                  Architecture, security, lifecycle, ADRs and runbooks
deploy/                launchd and systemd deployment templates
```

## Requirements

- macOS 14+ for the complete stack, or Linux for the TypeScript services;
- Node.js **22.5 or newer** (`node:sqlite` is required);
- pnpm 11;
- Git;
- Xcode 15+ for the native macOS application;
- optional authenticated provider CLIs or API keys for live AI execution.

## Quick start

```sh
pnpm install
pnpm verify
```

Start the local platform in separate terminals:

```sh
# Control plane — http://127.0.0.1:7717
pnpm --filter @avityos/control-plane start

# Web Mission Control — http://localhost:5173
pnpm --filter @avityos/web dev

# Optional execution worker
pnpm --filter @avityos/worker start

# Optional native macOS app
cd apps/macos && swift run AvityOS
```

Drive the same control plane from the CLI:

```sh
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js project create "My project" \
  --repo /absolute/path/to/repository \
  --remote git@github.com:owner/repository.git \
  --branch main \
  --objective "Build the requested product" \
  --criterion "All acceptance criteria pass" \
  --criterion "Documentation is current" \
  --autonomy autonomous_with_checkpoints \
  --budget 100 --warn-at 80

# A greenfield project can be created without --repo/--remote.
node apps/cli/dist/main.js project update <project-id> --budget 150 --warn-at 70
```

Repository paths are never trusted from clients. The control plane resolves
the path on its own host, requires an accessible Git working tree, verifies the
local default branch and confirms that the requested GitHub repository matches
a configured Git remote before persisting canonical values.

No paid credentials are required to test the orchestration engine. The
deterministic fake provider exercises the isolated worktree, checks, correction,
commit and review lifecycle. Web fixtures are available only when explicitly
enabled with `VITE_AVITY_DEMO=1` and are visibly labelled `Démo`.

## Verification

```sh
pnpm verify             # TypeScript builds, tests and strict type checking
pnpm verify:full        # Above + Playwright browser E2E + Swift tests
pnpm licenses:check     # Dependency license inventory and policy
pnpm audit --audit-level high
```

## Documentation

- [Product](docs/PRODUCT.md) — implemented product behavior and quality bar
- [Architecture](docs/ARCHITECTURE.md) — components, state machines and recovery
- [Project lifecycle](docs/PROJECT-LIFECYCLE.md) — objective to reviewed delivery
- [Provider adapters](docs/PROVIDER-ADAPTERS.md) — integrations and fallback
- [Policies](docs/POLICIES.md) — autonomy, budgets and checkpoints
- [Git workflow](docs/GIT-WORKFLOW.md) — branch, worktree and PR discipline
- [Security](docs/SECURITY.md) — trust model, controls and limitations
- [Local development](docs/LOCAL-DEVELOPMENT.md) — environment and commands
- [Deployment](docs/DEPLOYMENT.md) and
  [backup/restore](docs/BACKUP-RESTORE.md) — operations
- [Runbooks](docs/RUNBOOKS.md) — failure handling
- [ADRs](docs/adr/) — versioned architecture decisions
- [Traceability](docs/TRACEABILITY.md) — definition-of-done evidence map
- [Roadmap](docs/ROADMAP.md) — mandatory product dependency order

## Delivery discipline

Changes to AvityOS follow the same rules AvityOS applies to user projects:
small scoped branches, conventional commits, mandatory CI, independent review,
clean working trees and no self-merge. Major dependency upgrades are handled as
dedicated migrations rather than automatic bulk merges.
