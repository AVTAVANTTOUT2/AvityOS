# Live E2E Operator Readiness Design

## Status and scope

This design implements the preparation layer for a real-provider campaign. It
does not execute a live provider, push a project branch, create a project pull
request, or claim that a live scenario passed. The work starts from
`origin/main` at `69cd87b` and includes the already-green PR #41 commits through
`416ed10`; those contract and sandbox changes are reused rather than duplicated.

The product remains local-first. The web application is the primary UI, the
existing public REST API remains the only campaign control surface, and the CLI
becomes the operator entry point for setup, diagnostics, service lifecycle,
fixture generation, campaign preparation, campaign execution, and evidence
reporting.

## Considered approaches

### Recommended: typed CLI operator modules over existing public APIs

Add focused modules under `apps/cli/src/operator/` for filesystem setup,
service lifecycle, diagnostics, provider inspection, fixture generation, and
campaign reporting. Extend shared contracts and the control-plane preflight
only where host truth or effective engine routing must be exposed. This keeps
secrets and local process management on the operator host while preserving one
source of truth for routing and project state.

### Rejected: a privileged control-plane operations API

An API that installs services, reads host credential locations, or starts local
processes would blur local and remote trust boundaries. A remotely reachable
control plane must not gain general host-management authority merely to make
local alpha setup convenient.

### Rejected: shell-only setup and campaign scripts

Shell scripts fit launchd/systemd wrappers but are a poor source of truth for
versioned JSON, cross-platform diagnostics, redaction, idempotent configuration,
and API-driven reports. They would duplicate TypeScript validation and make
Windows-like or nonstandard Unix environments harder to diagnose honestly.

## Bounded contexts and dependencies

1. **Operator configuration** owns paths, restrictive permissions, env-file
   parsing, API-token creation, and idempotent setup. It depends only on Node
   filesystem/process primitives.
2. **Host diagnostics** owns runtime/tool/sandbox/provider detection. It may
   invoke version and authentication-presence probes, but never a provider
   mission or vendor HTTP request.
3. **Service lifecycle** owns control-plane, worker, and web process PID files,
   bounded startup health checks, logs, restart recovery, and clean shutdown.
   It consumes operator configuration; it does not inspect SQLite directly.
4. **Provider readiness** combines local binary/auth/sandbox observations with
   the control plane's registered adapters and effective routing snapshot. It
   never returns secret values.
5. **Project preflight** remains control-plane-owned because only the engine can
   provide effective routing and canonical project configuration. Shared
   contracts enforce the ten scenarios and report coherence.
6. **Fixture generation** creates an external, dependency-light Git repository
   with deterministic checks and campaign instructions. It has no GitHub name
   dependency and never configures publication without an explicit remote.
7. **Campaign orchestration** calls doctor and public REST endpoints, records
   redacted evidence, and distinguishes `ready` from `passed`. `prepare` is
   read-only with respect to remotes; `run` requires an explicit confirmation
   before objective submission can trigger any Git mutation.
8. **Web readiness** renders existing project/provider/run evidence and the
   project preflight. It does not manage host credentials.

The dependency direction is:

```text
contracts
  ↑
providers/policy/git
  ↑
control-plane public API
  ↑
CLI operator modules and Web client
```

No operator module is imported by the control plane, and no web component
accesses local files or credentials.

## Golden-path data flow

`avity setup` creates owner-only state outside the repository, preserves
existing configuration, builds the workspace, and records executable paths
without credentials. `avity start` loads the protected environment, starts the
control plane, waits for health, starts the local worker with persisted
owner-only enrollment credentials, then starts the built web application.

`avity doctor` checks the host and services. `avity providers status` reports
binary, sandbox, auth channel, registration, models, roles, reviewer
separation, and fallback without contacting vendors. `avity e2e preflight`
asks the control plane to evaluate the canonical project against the exact
engine routing.

`avity e2e live prepare` refuses unknown projects, calls doctor and preflight,
generates a redacted report, and performs no remote mutation. `run` repeats
those checks, requires the operator to confirm the project identifier before
submitting the fixture objective, observes only public API resources, helps
surface clarifications/interventions, and stops after recording a draft or
ready-for-review PR state. It contains no merge operation.

## Failure and honesty model

Readiness states are `ready`, `blocked_operator_configuration`,
`blocked_missing_tool`, `blocked_missing_credentials`, and
`blocked_product_gap`. Campaign result states are separately `passed`,
`failed`, `blocked`, and `not_attempted`. Contract refinements reject unknown
or missing scenarios, duplicate providers, incoherent counters/global status,
unregistered routing, text-only editors, impossible reviewer separation, and
single-provider fallback claims.

Every command failure names the failed boundary and remediation without command
output that could contain credentials. Service crashes leave bounded logs and
stale PID files are recovered. A missing OS sandbox is always a hard failure;
there is no unsandboxed fallback.

## Safe fallback and correction scenarios

The normal campaign uses the configured real provider chain. A controlled
fallback test may opt into an explicit campaign-only one-shot normalized
failure for a named registered provider. This mode is rejected in production,
never registers `fake`, is visible in provider/preflight/report output, and
exercises the real engine fallback policy before a different real provider is
selected.

Correction evidence comes from the real validation/review loop. The fixture
provides a deterministic acceptance check and a documented rejection objective.
The operator can also reject a public approval/review intervention; correction
attempts remain bounded by the mission contract. No test-specific rejection
branch is added to the engine.

## Security decisions

Secrets are accepted from protected files, environment variables, Keychain, or
stdin, never command arguments. Setup uses mode `0700` directories and `0600`
sensitive files and never overwrites an existing operator file without an
explicit force flag. Output and reports pass through recursive key/name and
token-pattern redaction. Provider probes disclose only presence/accessibility.

The fixture remote is validated as GitHub before publication readiness is
reported. `prepare` cannot call push or PR mutation commands. `run` confirms
before objective submission, publication remains the existing hardened
`git push` plus `gh pr create --draft` path, and no merge command or API exists
in the campaign runner.

## Verification strategy

Pure configuration, redaction, diagnostics, preflight, fixture, and report
logic receive hermetic unit tests. Process, filesystem, public API, and
control-plane boundaries receive integration tests with injected runners and
temporary directories. A Playwright test starts a real fixture-only control
plane and web server, imports a generated local repository, creates a project,
and verifies honest credential blocking without vendor calls.

Full validation runs the repository build, typecheck, unit/integration suites,
browser E2E, Swift tests, audit, license policy, diff checks, secret scanning,
no-merge scanning, fake-production guards, and prepare non-mutation tests.
