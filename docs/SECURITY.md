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
- **OS containment** — check processes receive argv (never shell strings), a
  minimal environment and isolated HOME. macOS uses `sandbox-exec` with only
  the worktree writable, host HOME unreadable and network denied; Linux uses
  Bubblewrap and fails closed if unavailable. Process groups are terminated on
  timeout/cancel.
- **Git boundary** — Git/GitHub receive only PATH/HOME and explicit auth
  channels. Automated commits use `--no-verify`, so repository-controlled hooks
  cannot run with control-plane authority.
- **Paths/evidence** — actual changed files are realpath/glob checked against
  allowed and forbidden paths. Coding missions require a diff and real command
  exit evidence; missing checks cannot pass.
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
  dependency audit, 446-package license policy, Gitleaks and SPDX SBOM creation.

Security tests cover malicious origins, missing auth, SSE query-token denial,
client cwd injection, symlink escape, interpreter bypass, environment leakage,
host-home secret reads, writes outside the worktree, Git hooks, incompatible or
over-capacity workers, stale lease tokens, revoked leases and plaintext remote
transport.

## Remaining limitations

- Provider API keys are supplied by the deployment environment; AvityOS does
  not yet provide a general encrypted cross-platform credential vault. The
  native user token is protected by Keychain.
- HTTPS termination and certificate lifecycle for a remote control plane are a
  deployment responsibility; the worker enforces HTTPS but mTLS is not bundled.
- CLI vendor processes rely on their documented sandbox/permission modes. A
  stronger container/VM boundary is recommended for hostile repositories.
- The local HttpOnly session cookie is not marked `Secure` over loopback HTTP;
  remote browser deployments must terminate HTTPS and should set/forward a
  secure-cookie deployment policy.
