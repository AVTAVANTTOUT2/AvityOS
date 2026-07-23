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
  category `auth` — there is no fallback to the real HOME.
  - **Read boundary is fail-closed** (not merely "read-only"). Reads are
    **denied by default** and re-granted only by an explicit allowlist:
    - **Readable:** the workspace, the throwaway HOME, the resolved executable
      and its detected runtime (its directory, its safe install root, and the
      shared-library directories reported by bounded `otool -L` / `ldd` scans —
      exact executable dir, exact package/formula root, and exact library dirs,
      **never** all of `/opt/homebrew` or `/usr/local`), a minimal set of system
      trees needed to start (see below), device nodes, CA trust, and any paths a
      **trusted policy** declares via `readablePaths`/`runtimePaths`. Path
      arguments are validated (absolute + must exist) and canonicalised, and are
      supplied by control-plane code only — they cannot be widened from the
      prompt or the untrusted repository. Deterministic checks additionally get
      read on the **server-validated project repo path** so `git` in a worktree
      can reach the main git common dir (the worktree's own `.git` file, which
      the untrusted repo controls, is never parsed to decide grants).
    - **Not readable:** the real host HOME, another repository, `/tmp` (and its
      canonical `/private/tmp` / per-user temp), `/opt`, `/Applications`,
      `/Volumes`, `/mnt`, `/media`, `/srv`, and other providers' credentials.
      A secret placed in any of these is unreadable — proven by canary tests
      that assert the **content** is not returned, not merely a non-zero exit.
    - **Writable:** only the workspace and the throwaway HOME (plus `/dev`).
    - **Reserved env:** `HOME`, `TMPDIR` and `PATH` are owned exclusively by the
      sandbox; `options.env` and `AVITY_COMMAND_ENV_ALLOWLIST` that name them are
      rejected before launch.
    - **Credential staging:** sources are `lstat`'d, must be regular files (no
      symlinks), must stay under the real HOME, and must match the provider
      policy path exactly — a symlink trap from `~/.codex/auth.json` to another
      provider's secret is refused and never copied.
  - **macOS** uses `sandbox-exec` with `(deny default)` + an explicit
    `file-read*` allowlist. Global `file-read-metadata` lets the loader traverse
    path components (to reach a CLI installed under the host HOME) without
    exposing file **contents**. System read roots: `/usr/lib`, `/usr/bin`,
    `/usr/share`, `/usr/libexec`, `/System`, `/Library`, `/private/etc`,
    `/private/var/db`, `/dev`, and the root node itself. Mach IPC is **not**
    `(allow mach-lookup)` wholesale: SecurityServer/securityd/Keychain,
    pasteboard, WindowServer and AppleEvents are denied first; only a validated
    allowlist of bootstrap services (logging, OpenDirectory, prefs, DNS) remains.
    A Keychain canary test asserts the secret value is never returned from inside
    the sandbox.
  - **Linux** uses Bubblewrap with a **minimal file namespace** (no
    `--ro-bind / /`): only `/usr`, `/bin`, `/sbin`, `/lib*`, `/etc`, the
    executable's runtime, the workspace (rw) and throwaway HOME (rw) are bound;
    a fresh `tmpfs` hides host `/tmp`, a private `/proc` (from the `--unshare-all`
    PID namespace) and a minimal `--dev /dev` avoid leaking host process/device
    state, and `/run`, `/sys`, `/srv`, `/opt`, `/mnt`, `/media` are not mounted.
    When network is allowed, the resolved `/etc/resolv.conf` target is bound for
    DNS. **Fails closed** if Bubblewrap is unavailable.

  Generic isolation and the read boundary are covered by tests using local
  probes such as `printenv`/`node`/`git`; those probes prove the sandbox
  boundary, **not** that Claude/Codex/Cursor completed an authenticated vendor
  call. Separate smoke tests may run `--version` when a binary is installed.
  Command-adapter **unit** tests inject a hermetic `SandboxLauncher` /
  `ProcessSpawner` so exit-code, env-filtering, timeout, cancel and
  `sandbox_unavailable` behaviour stay deterministic without Bubblewrap or
  `sandbox-exec`. OS isolation remains an **integration** suite that skips with
  an explicit reason when the host primitive is absent — never a silent
  unsandboxed green path. Missing sandbox in production wiring yields
  `ProviderErrorCategory.sandbox_unavailable` (non-retryable escalate), never
  `unknown` and never an ambient spawn.
  Process groups and the sandbox temp HOME are torn down on completion, timeout
  and cancel. Cancel currently sends `SIGTERM` only; escalation to `SIGKILL`
  after a grace period is **not** implemented.
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
  repo) all flow through it. The runtime directory is added only to the local
  `.git/info/exclude` (never the tracked `.gitignore`); symlinked Git metadata
  is rejected before that private ignore is appended.
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
environment leakage, writes outside the worktree, the fail-closed sandbox read
boundary (workspace/HOME reads allowed with content verified; real-HOME, `/tmp`,
second-repository, external-file and cross-provider-credential reads all denied
by asserting the secret content is not returned; declared `readablePaths`
granted while an adjacent undeclared sibling stays denied),
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
  unless the provider opts in, worktree-only writes, and a **fail-closed read
  boundary** — no general host-filesystem read access) in addition to their own
  documented sandbox/permission modes. **Proven today:** generic isolation, the
  read boundary (real-HOME/`/tmp`/second-repo/external-file/cross-provider-cred
  reads denied by content on both `sandbox-exec` and Bubblewrap) and (when
  installed) non-mutating binary start (`--version`). **Not proven by CI:**
  vendor authentication, paid model calls, or full missions under sandbox.
  Claude macOS Keychain / Cursor's default Keychain login do not transfer into a
  throwaway HOME; sandboxed runs require the explicit env/file policy for that
  provider. Supported portable alternatives are Claude's official
  `CLAUDE_CODE_OAUTH_TOKEN` and Cursor's owner-only `.cursor/auth.json` file
  store; only that single provider credential is staged read-only.
  The OS sandbox is not an absolute guarantee: it depends on the host primitive
  (`sandbox-exec` / Bubblewrap) and its policy grants. **Residual read exposure:**
  the system read roots (`/usr`, `/System`, `/Library`, `/etc`, …) are granted
  wholesale — they hold no user secrets but are not individually minimised; on
  macOS file **metadata** (names/sizes/existence, not contents) remains globally
  observable so the loader can traverse to CLIs installed under the host HOME.
  Runtime-dependency detection covers bounded recursive `otool`/`ldd` scans of
  declared libraries and exact package/formula roots — never auto-granting
  `/opt/homebrew` or `/usr/local` wholesale. A CLI that `dlopen`s a library from an
  undeclared location needs that path added to its policy's `readablePaths`.
  On macOS, Mach lookup is allowlisted after explicit denies of Keychain and
  other sensitive IPC; residual metadata visibility and system read roots remain.
  Forced termination escalation (`SIGTERM` → delay → `SIGKILL`) is still
  unimplemented. A stronger container/VM boundary is recommended for hostile
  repositories. The `core.hooksPath=/dev/null` neutralisation targets the POSIX
  platforms AvityOS officially supports (macOS, Linux).
- The local HttpOnly session cookie is not marked `Secure` over loopback HTTP;
  remote browser deployments must terminate HTTPS and should set/forward a
  secure-cookie deployment policy.
