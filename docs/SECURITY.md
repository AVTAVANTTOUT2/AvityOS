# Security

## Trust model

Untrusted input includes: agent/provider output, repository content, issue
text, web pages, logs, and anything a subprocess prints. The user at the
local console is trusted; remote workers are semi-trusted (authenticated,
revocable, least-privilege).

```
trusted:      user ── CLI/web/macOS ──┐
boundary:                        REST API (validation, optional bearer token)
control:      engine + store (all permission checks server-side)
semi-trusted: workers (per-worker token, hashed at rest, revocable)
untrusted:    provider output, subprocess output, repo content
```

## Controls implemented

- **Input validation**: every API body/query parses through the shared zod
  contracts; unknown states/enums are rejected.
- **Command policy**: terminal commands are argv arrays only — there is no
  API accepting a shell string anywhere (`packages/policy`, `packages/git`,
  worker runner all use `execFile`/`spawn`). Executables are checked against
  an allowlist/denylist; denials are refused with HTTP 403, evented
  (`policy.decision`) and written to the audit chain (tested).
- **Path scoping**: `isPathAllowed` confines missions to their worktree
  minus forbidden globs (`**/.env`, `**/secrets/**` by default).
- **Secret redaction**: `redactSecrets` runs before any run log, terminal
  log, event payload or audit detail is persisted (API keys, GitHub/Slack/
  AWS tokens, private keys, password assignments).
- **Worker enrollment**: tokens are returned exactly once and stored only
  as SHA-256 hashes; every worker call re-authenticates; revoked workers
  are rejected. Leases bind a terminal to one worker; another worker's
  token cannot post output to it.
- **Process containment**: workers spawn detached process groups and kill
  the whole group on cancel/timeout (SIGTERM, then SIGKILL escalation);
  verified by test that the child PID is gone.
- **Audit**: hash-chained `audit_entries` (each entry hashes its
  predecessor); `GET /v1/audit` reports chain validity.
- **API access**: binds to 127.0.0.1 by default; optional bearer token via
  `AVITY_API_TOKEN` enforced in a server hook (never in the UI).
- **Budgets**: per-project spend gates block mission starts and escalate to
  an approval instead of silently continuing.
- **Approval defaults**: dangerous action classes (force push, protected
  merge, production deploy, paid infra, secret read, policy override,
  worker revoke) require approval when no explicit rule matches — even at
  maximum autonomy.

## Known gaps (tracked, not hidden)

- No macOS Keychain integration yet in the native app (dev builds connect
  tokenless to loopback only; see apps/macos/README.md).
- Provider API keys are supplied via environment variables, not an
  encrypted store.
- Dependency/SBOM scanning runs in CI (gitleaks); osv/SBOM generation is
  not yet wired.
- Remote worker transport is HTTP + bearer token; TLS termination must be
  provided by the deployment (see DEPLOYMENT.md).
