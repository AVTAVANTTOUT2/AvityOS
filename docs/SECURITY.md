# Security

## Trust model

Repository content, provider output, subprocess output, issue/web text and
worker hosts are untrusted or semi-trusted. The deterministic control plane is
the authority for state transitions, worktree paths, commands, leases,
budgets, checkpoints and audit records. UI permission checks are never trusted.

## Implemented controls

- **API/session** — first run generates a 48-hex bearer token stored mode 0600.
  Browser login exchanges it for an HttpOnly, SameSite=Strict cookie; SSE never
  accepts tokens in URLs. CORS uses an explicit origin allowlist and the server
  binds loopback by default.
- **Validation** — shared zod schemas validate bodies/enums. Project onboarding
  resolves repository paths with `realpath`, requires a readable/writable Git
  working tree, verifies the local default branch and matches GitHub identity
  against a configured remote before persisting server-observed values.
  Terminal `cwd` is ignored from clients and resolved server-side to a real
  project repository or mission worktree; symlink escapes are rejected.
- **Command classes** — ad-hoc terminals are observation-only. Interpreters,
  package managers and shells are treated as arbitrary-code capability and are
  available only to mission-scoped execution after policy checks.
- **OS containment** — check processes **and every CLI coding agent**
  (`CommandProviderAdapter`: Claude Code, Cursor, Codex, generic command) run
  through the same `sandboxCommand` primitive. They receive argv (never shell
  strings), an explicit **per-provider** environment allowlist (never
  `process.env`), a throwaway HOME/TMPDIR, and only the credential files that
  provider's policy lists (never the full host HOME, never `~/.ssh`, never
  another provider's secrets). Network is **denied by default**; each provider
  opts in via `allowNetwork`. Missing required auth material fails closed with
  category `auth` — there is no fallback to the real HOME. Generic isolation
  (throwaway HOME, env allowlist, host-HOME denial) is covered by tests using
  local probes such as `printenv`/`node`; those probes prove the sandbox
  boundary, **not** that Claude/Codex/Cursor completed an authenticated vendor
  call. Separate smoke tests may run `--version` when a binary is installed.
  macOS uses `sandbox-exec`; Linux uses Bubblewrap and **fails closed** if
  unavailable. Process groups and the sandbox temp HOME are torn down on
  completion, timeout and cancel. Cancel currently sends `SIGTERM` only;
  escalation to `SIGKILL` after a grace period is **not** implemented.
- **Git boundary** — every automated Git command runs through one hardened
  runner that forces `-c core.hooksPath=/dev/null` (plus `commit.gpgsign`,
  `core.fsmonitor`, `core.untrackedCache` off). This neutralises **all**
  repository-controlled hooks — `pre-commit`, `post-checkout` on `worktree
  add`, `pre-push` — and overrides any dangerous local/global hook config, so
  it does not depend on `--no-verify` alone. Automated pushes additionally pass
  `--no-verify` as defence in depth. Git/GitHub receive only PATH/HOME and
  explicit auth channels. The hardening is centralised so a future Git call
  cannot silently forget it; the same flags are shared with the readiness
  preflight push (`hardenedGitArgs`).
- **Provider authorization** — the deterministic `fake` fixture provider is
  registered **only** in `test`/`demo` execution modes (`AVITY_EXECUTION_MODE`,
  defaulting fail-closed to `production`). In production it is never registered
  and never appended to a chain; an explicit production `AVITY_PROVIDER_CHAIN`
  naming `fake` is a hard startup error, not a silent drop. A real mission can
  therefore never fall back to fixtures, fabricate a plan, or auto-approve a
  review.
- **Paths/evidence** — path membership is decided on **canonical** paths by the
  central `resolveAndAssertInside(root, candidate, policy)` primitive: it
  rejects absolute paths and `..` where the contract forbids them, resolves
  symlinks in every existing component, treats a sibling sharing only a textual
  prefix (`<wt>-evil`) as outside, and handles not-yet-created paths. Changed
  files, `expectedArtifacts` (fail-closed: must exist and not be a symlink),
  and the mission worktree location (confined to `<repo>/.avity/worktrees` via
  `ensureConfinedDirectory`, which inspects every existing component with
  `lstat` and refuses outbound symlinks **before** creating any missing
  directory — so a redirected `.avity` cannot materialise paths outside the
  repo) all flow through it.
  Coding missions require a diff and real command exit evidence; missing checks
  cannot pass.
- **Brain snapshot boundary** — the AI planning snapshot is built only from
  the server-validated persisted repository path (never model- or
  client-supplied paths), reads only Git-tracked files whose realpath stays
  inside the repository, excludes secret-shaped paths (`.env*`, `secrets/`,
  key material) and binary content, applies secret redaction and hard
  size/count limits before anything reaches a prompt, an event or
  persistence, and records the snapshot hash for provenance. Manifest and
  check discovery uses the same tracked-file realpath confinement, including
  symlink rejection. AI-proposed mission paths and check commands are validated
  against the same command/path policies and must match every check and argv
  detected in the snapshot before any mission is created. Provider-produced
  analysis, memory, plans, mission contracts and replan evidence are redacted
  again before durable persistence.
- **Workers** — enrollment requires the admin bearer when auth is enabled.
  Worker tokens are shown once and hashed at rest. Capability/capacity matching,
  short leases, per-lease opaque tokens, expiry, heartbeat and revocation fence
  stale results. Non-loopback worker transport requires HTTPS unless an explicit
  development escape hatch is set.
- **Secrets/audit** — persisted logs/events/audit details are redacted. Audit
  entries form a verifiable SHA-256 chain. Provider/CLI environments are scoped;
  the macOS app and macOS CLI store their API token in Keychain. Non-macOS CLI
  fallback storage is owner-only mode 0600 and may be replaced by a host vault.
- **Supply chain** — CI blocks on tests, typechecks, browser/Swift tests,
  dependency audit, 508-package license policy, Gitleaks and SPDX SBOM creation.

Security tests cover malicious origins, missing auth, SSE query-token denial,
client cwd injection, symlink escape (including symlinked artifacts, worktree
redirection and canonical `..`/prefix confinement), interpreter bypass,
environment leakage, host-home secret reads, writes outside the worktree,
sandboxed CLI-provider isolation and network denial, Git hooks (`pre-commit`,
`post-checkout` on worktree add, `pre-push`, and repository-configured
`core.hooksPath`), fixture-provider gating per execution mode, incompatible or
over-capacity workers, stale lease tokens, revoked leases and plaintext remote
transport.

## Remaining limitations

- Provider API keys are supplied by the deployment environment; AvityOS does
  not yet provide a general encrypted cross-platform credential vault. The
  native user token is protected by Keychain.
- HTTPS termination and certificate lifecycle for a remote control plane are a
  deployment responsibility; the worker enforces HTTPS but mTLS is not bundled.
- CLI coding agents run inside the AvityOS OS sandbox (isolated HOME, no network
  unless the provider opts in, worktree-only writes) in addition to their own
  documented sandbox/permission modes. **Proven today:** generic isolation and
  (when installed) non-mutating binary start (`--version`). **Not proven by CI:**
  vendor authentication, paid model calls, or full missions under sandbox.
  Claude macOS Keychain / Cursor Keychain login do not transfer into a throwaway
  HOME; sandboxed runs require the explicit env/file policy for that provider.
  The OS sandbox is not an absolute guarantee: it depends on the host primitive
  (`sandbox-exec` / Bubblewrap) and its policy grants. Forced termination
  escalation (`SIGTERM` → delay → `SIGKILL`) is still unimplemented. A stronger
  container/VM boundary is recommended for hostile repositories. The
  `core.hooksPath=/dev/null` neutralisation targets the POSIX platforms AvityOS
  officially supports (macOS, Linux).
- The local HttpOnly session cookie is not marked `Secure` over loopback HTTP;
  remote browser deployments must terminate HTTPS and should set/forward a
  secure-cookie deployment policy.
