# Live E2E Operator Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AvityOS reproducibly installable, diagnosable, and ready to run an honest real-provider E2E campaign without executing that campaign during preparation.

**Architecture:** Local host management lives in typed CLI operator modules. Effective routing and project preflight remain control-plane responsibilities exposed through versioned contracts and public REST APIs. Fixture and campaign evidence are generated outside repositories and all remote mutation is gated by the live runner.

**Tech Stack:** Node.js 22, TypeScript strict, pnpm workspaces, Fastify, Zod, SQLite, Vitest, Playwright, Git, GitHub CLI, macOS sandbox-exec, Linux Bubblewrap.

## Global Constraints

- Never execute a real provider or vendor HTTP request during implementation or tests.
- Never print or persist an unredacted secret in logs, CLI output, reports, fixtures, or Git.
- `fake` is rejected outside explicit test/demo mode and is never evidence of live readiness.
- Missing sandbox primitives fail closed; no unsandboxed fallback exists.
- `prepare` performs no remote mutation; `run` requires explicit confirmation before objective submission.
- The campaign runner has no merge operation and stops after draft/ready-for-review evidence.
- Preserve existing public commands where safe; reject legacy secret arguments with an actionable stdin/file alternative.

---

### Task 1: Versioned readiness and campaign contracts

**Files:**
- Modify: `packages/contracts/src/e2e.ts`
- Modify: `packages/contracts/src/contracts.test.ts`
- Modify: `services/control-plane/src/e2e-preflight.ts`
- Modify: `services/control-plane/src/e2e-preflight.test.ts`

**Interfaces:**
- Produces: five readiness states, structured reasons/tools/env/remediation, effective routing evidence, and separate campaign result schemas.
- Consumes: existing ten `E2EScenarioKey` values and engine routing snapshot.

- [ ] Write failing contract tests for every incoherent report and the five readiness states.
- [ ] Run `pnpm --filter @avityos/contracts test` and verify the new tests fail for missing schema fields.
- [ ] Extend schemas with strict versioned diagnostics and campaign result contracts.
- [ ] Extend `buildE2EPreflight` to populate structured reasons from the effective routing.
- [ ] Run contract and control-plane preflight tests; refactor duplicated scenario builders.
- [ ] Commit as `feat(contracts): version live readiness evidence`.

### Task 2: Provider status and controlled fallback

**Files:**
- Create: `services/control-plane/src/provider-status.ts`
- Create: `services/control-plane/src/provider-status.test.ts`
- Create: `services/control-plane/src/campaign-fault.ts`
- Create: `services/control-plane/src/campaign-fault.test.ts`
- Modify: `services/control-plane/src/provider-policy.ts`
- Modify: `services/control-plane/src/provider-policy.test.ts`
- Modify: `services/control-plane/src/providers.ts`
- Modify: `services/control-plane/src/main.ts`
- Modify: `services/control-plane/src/server.ts`
- Modify: `services/control-plane/src/index.ts`

**Interfaces:**
- Produces: `GET /v1/providers/status`, `campaign` execution mode, and an explicit one-shot normalized failure wrapper.
- Consumes: registered adapters, model maps, role/global chains, CLI auth resolvers, and execution mode.

- [ ] Write failing tests for absent binary/auth/model/routing, no editor, no distinct reviewer, no fallback, and production fault-injection rejection.
- [ ] Verify failures with targeted control-plane tests.
- [ ] Build secret-free provider status from startup configuration and engine routing.
- [ ] Add campaign mode that disallows fake and permits only explicit named one-shot fault injection.
- [ ] Expose status through the authenticated public API without vendor health/model calls.
- [ ] Run provider, policy, routing, and server tests.
- [ ] Commit as `feat(providers): expose live-safe readiness status`.

### Task 3: Secure operator setup and service lifecycle

**Files:**
- Create: `apps/cli/src/operator/paths.ts`
- Create: `apps/cli/src/operator/env.ts`
- Create: `apps/cli/src/operator/redact.ts`
- Create: `apps/cli/src/operator/setup.ts`
- Create: `apps/cli/src/operator/diagnostics.ts`
- Create: `apps/cli/src/operator/services.ts`
- Create: `apps/cli/src/operator/operator.test.ts`
- Modify: `apps/cli/src/client.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/package.json`
- Modify: `apps/web/package.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `avity setup|start|stop|restart|status|logs|doctor`, owner-only config/state, stable JSON diagnostics, detached local services.
- Consumes: repository root, protected env files, public health/providers/workers APIs, built service entrypoints.

- [ ] Write failing tests for idempotency, preservation, permissions, missing tools/sandbox/auth, stale PIDs, log redaction, and JSON stability.
- [ ] Verify targeted CLI tests fail.
- [ ] Implement strict env parsing/writing and recursive redaction.
- [ ] Implement setup with injected command runner, Node >=22.5, pnpm/Git/gh/sandbox/provider binary detection, token preservation, and builds.
- [ ] Implement bounded start/stop/restart/status/log access with PID recovery and bounded log files.
- [ ] Replace secret CLI arguments with stdin/protected-file channels and keep non-secret command compatibility.
- [ ] Run CLI tests, build, and typecheck.
- [ ] Commit as `feat(cli): add secure local operator lifecycle`.

### Task 4: Persistent worker enrollment without token disclosure

**Files:**
- Modify: `services/worker/src/main.ts`
- Modify: `services/worker/src/agent.ts`
- Modify: `services/worker/src/worker.test.ts`
- Modify: `deploy/launchd/env.example`
- Modify: `deploy/systemd/worker.env.example`

**Interfaces:**
- Produces: owner-only worker credential file selected by `AVITY_WORKER_CREDENTIALS_PATH`.
- Consumes: existing enrollment API and in-memory WorkerAgent credentials.

- [ ] Write failing tests proving first enrollment persists mode 0600, restart reuses it, and output never contains the token.
- [ ] Implement load/create credential flow with atomic restrictive writes.
- [ ] Remove token/export output and return only worker identity.
- [ ] Run worker tests and typecheck.
- [ ] Commit as `fix(worker): persist enrollment credentials securely`.

### Task 5: External live fixture generator

**Files:**
- Create: `apps/cli/src/operator/fixture.ts`
- Create: `apps/cli/src/operator/fixture.test.ts`
- Create: `docs/live-fixture-spec.md`
- Modify: `apps/cli/src/main.ts`

**Interfaces:**
- Produces: `avity e2e fixture create --path <path> [--remote <url>]` and a clean Git repository with zero package dependencies.
- Consumes: hardened argv-based Git runner and a caller-selected external path.

- [ ] Write failing tests for generated source/tests/typecheck, clean main branch, optional validated remote, idempotent refusal, and no publish scripts.
- [ ] Generate complete fixture files with deterministic normal and correction objectives.
- [ ] Initialize and commit locally with hooks/signing disabled; never push.
- [ ] Run fixture checks inside a temporary generated repository.
- [ ] Commit as `feat(e2e): add external live fixture generator`.

### Task 6: Public-API campaign prepare/run/report

**Files:**
- Create: `apps/cli/src/operator/campaign.ts`
- Create: `apps/cli/src/operator/campaign-report.ts`
- Create: `apps/cli/src/operator/campaign.test.ts`
- Modify: `apps/cli/src/main.ts`

**Interfaces:**
- Produces: `avity e2e live prepare|run --project <id> [--json]`, schema-versioned redacted reports under the operator report directory.
- Consumes: doctor, providers status, project preflight, project/brain/mission/run/event/approval/PR public endpoints.

- [ ] Write failing tests proving prepare performs GET-only calls, blocked prerequisites refuse run, non-TTY mutation requires an explicit flag, reports distinguish ready/passed, and merged PR is failure.
- [ ] Implement campaign metadata, redacted configuration/version capture, and deterministic report retention.
- [ ] Implement prepare as read-only diagnostics plus fixture/project recommendations.
- [ ] Implement run confirmation, objective submission, bounded polling, clarification/intervention surfacing, evidence collection, and stop at draft/open PR.
- [ ] Verify there is no merge command/API and no direct SQLite access.
- [ ] Run campaign tests and CLI integration tests.
- [ ] Commit as `feat(e2e): add live campaign operator runner`.

### Task 7: Web readiness view and real-control-plane preparation E2E

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/data.tsx`
- Modify: `apps/web/src/app/screens/ProvidersScreen.tsx`
- Modify: `apps/web/src/app/screens/ProjectDetailScreen.tsx`
- Modify: `apps/web/src/app/screens.test.tsx`
- Create: `apps/web/e2e/live-preparation.spec.ts`
- Modify: `apps/web/playwright.config.ts`

**Interfaces:**
- Produces: honest provider/preflight blocking UI and one browser flow against a real fixture-only control plane.
- Consumes: `/v1/providers/status`, `/v1/e2e/preflight?projectId=...`, existing project onboarding APIs.

- [ ] Write failing component tests for blocked credentials, reviewer/fallback warnings, and disabled decorative configuration controls.
- [ ] Render readiness without redesigning screens.
- [ ] Add a Playwright project that starts real control-plane and web processes with isolated temp state and creates a project from a local generated fixture.
- [ ] Assert Live auth, project creation, preflight display, and honest credential blocking; make no vendor call.
- [ ] Run web unit and E2E tests.
- [ ] Commit as `feat(web): surface live campaign readiness`.

### Task 8: Operator documentation and service templates

**Files:**
- Create: `docs/LIVE-E2E-CAMPAIGN.md`
- Modify: `README.md`
- Modify: `docs/LOCAL-DEVELOPMENT.md`
- Modify: `docs/PROVIDER-ADAPTERS.md`
- Modify: `docs/RUNBOOKS.md`
- Modify: `deploy/launchd/README.md`
- Create: `deploy/launchd/install-user-services.mjs`
- Create: `deploy/launchd/install-user-services.test.mjs`

**Interfaces:**
- Produces: one complete runbook, short golden-path matrix, copyable checklist, generated launchd templates without manual placeholders.
- Consumes: final CLI commands and exact environment names.

- [ ] Document every golden-path stage, state, prerequisite, event, error, test, and remaining operator block.
- [ ] Document provider credentials, sandbox HOME portability, routing/models/reviewer/fallback, fixture, campaign, and troubleshooting.
- [ ] Add safe launchd template generation with XML escaping and no secrets in plist files.
- [ ] Test placeholder replacement and permissions.
- [ ] Commit as `docs(e2e): add live campaign operator runbook`.

### Task 9: Final security, regression, and delivery gates

**Files:**
- Modify only files required by concrete failures.

**Interfaces:**
- Produces: green repository validation and a draft AvityOS PR.
- Consumes: all prior tasks.

- [ ] Run targeted setup/doctor/provider/preflight/campaign/control-plane/provider/policy/sandbox tests.
- [ ] Run `pnpm install --frozen-lockfile`, recursive build/typecheck/test, Playwright, Swift, audit, licenses, and `git diff --check`.
- [ ] Scan the diff for secret patterns, merge commands, fake production paths, and prepare remote mutations.
- [ ] Run an independent whole-branch review and fix every critical/important finding.
- [ ] Push only the AvityOS feature branch and create a draft PR to `main`.
- [ ] Record exact command outcomes, final SHA, synchronization state, and remaining operator-only blocks.
