# Provider adapters

All AI execution flows through `ProviderAdapter` v1
(`packages/providers/src/types.ts`): honest capabilities, model discovery,
streamed run events, cancellation, usage, and a closed set of normalized
failures (`auth`, quota/rate limit, network, invalid request, context,
tool/agent/policy failure, `sandbox_unavailable`, unknown).

## Runtime adapters

| Name | Interface | Workspace edits | Runtime safety |
| --- | --- | ---: | --- |
| `codex` | official `codex exec` | yes | OS sandbox + `workspace-write`, no approvals, ephemeral, no inherited shell env; **network allowed**; auth: `CODEX_API_KEY` or staged `~/.codex/auth.json` |
| `claude-code` | `claude -p` | yes | OS sandbox + safe mode, no persistence, explicit tools/permission mode; **network allowed**; auth: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or staged `~/.claude/.credentials.json` |
| `cursor` | `cursor-agent -p` | yes | OS sandbox + built-in sandbox, trusted explicit workspace, setup scripts disabled; **network allowed**; auth: `CURSOR_API_KEY` or staged `~/.cursor/auth.json` file store |
| `command` | configured argv template | opt-in only | OS sandbox; reviewer-only unless `AVITY_COMMAND_WORKSPACE_EDITS=1`; **network denied** unless `AVITY_COMMAND_ALLOW_NETWORK=1`; env names from `AVITY_COMMAND_ENV_ALLOWLIST` only |
| `openai` | OpenAI Responses API | no | text/review runs; `store:false`; key scoped to HTTP adapter |
| `anthropic` | Anthropic Messages API | no | text/review runs |
| `deepseek` | OpenAI-compatible chat API | no | text/review runs |
| `fake` | deterministic in-process fixture | fixture edits | **test/demo modes only** (see below); tests correction, review, fallback, worktrees and checks offline |

HTTP adapters intentionally advertise `workspaceEdits:false`: returning text is
not equivalent to editing a repository. CLI adapters combine the architecture
system prompt and mission prompt, and **every CLI adapter is launched inside the
AvityOS OS sandbox** (`sandboxCommand`), whose boundary is **fail-closed**:

- **Writable paths:** the persisted worktree and one private, short-lived
  throwaway HOME under `/tmp` only (plus `/dev`). The short path keeps
  provider-derived Unix socket/project paths under OS limits; random `mkdtemp`
  ownership and the sandbox profile still deny every adjacent `/tmp` path.
  Nothing else on the host can be written.
- **Readable paths:** the worktree, the throwaway HOME, the resolved executable
  and its detected runtime, a minimal set of system trees needed to start, CA
  trust, device nodes, and any extra paths a provider policy declares via
  `readablePaths`. **Reads are denied by default** — the real host HOME, its SSH
  keys and Git config, unrelated repositories, `/tmp`, `/opt`, `/Applications`,
  `/Volumes`, `/mnt`, `/media`, and other providers' credentials are **not
  readable** (not merely mounted read-only).
- **System runtime exposed:** the executable's directory, its safe install root,
  and the exact shared-library / package roots discovered by bounded `otool`/
  `ldd` scans (**never** all of `/opt/homebrew` or `/usr/local`); plus the
  platform system read roots (`/usr`, `/System`, `/Library`, `/etc`, … on macOS;
  `/usr`, `/bin`, `/lib*`, `/etc`, … bound read-only on Linux).
- **Network:** **denied by default** — a provider must declare
  `allowNetwork: true` to reach its vendor API. When allowed, CA trust (and, on
  Linux, the resolved `/etc/resolv.conf` for DNS) is available.
- **Credentials:** only the **minimal** files a provider's policy lists, copied
  read-only into the throwaway HOME after `lstat` (regular file, no symlink,
  canonical path under the real HOME, exact policy path). `process.env` is never
  inherited; each provider receives only its explicit environment allowlist.
  `HOME`/`TMPDIR`/`PATH` are reserved by the sandbox. The generic `command`
  adapter forwards only the variables named in `AVITY_COMMAND_ENV_ALLOWLIST`
  (which may not list those reserved names).
- **macOS Mach IPC:** sensitive services (SecurityServer/securityd/Keychain,
  pasteboard, WindowServer, AppleEvents) are denied; a minimal validated
  allowlist covers logging, OpenDirectory, prefs and DNS only.
- **Residual limits:** system read roots are granted wholesale (they hold no
  user secrets); on macOS file *metadata* (names/sizes, not contents) stays
  globally observable for loader path traversal; a CLI that `dlopen`s a library
  from an undeclared path must add it to its policy's `readablePaths`.

### CLI auth policies (fail-closed)

| Provider | Allowed env | Allowed credential files (relative to real HOME) | Notes |
| --- | --- | --- | --- |
| `codex` | `CODEX_API_KEY` | `.codex/auth.json` | Env preferred; file staged only when env absent. Full `~/.codex` is never copied. |
| `claude-code` | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | `.claude/.credentials.json` | A normal macOS Keychain login is not portable. `claude setup-token` creates the official long-lived inference token for automation. |
| `cursor` | `CURSOR_API_KEY` | `.cursor/auth.json` | The default Keychain login is not mounted. Create the owner-only file store with `AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login`; AvityOS stages only `auth.json` and forces file-store mode inside the throwaway HOME. |
| `command` | names in `AVITY_COMMAND_ENV_ALLOWLIST` | _(none)_ | Operator-defined allowlist only. |

Missing required auth → `healthy() === false` and `startRun` emits
`category: "auth"` with a clear message. Sandbox unavailable →
`category: "sandbox_unavailable"` (fail-closed, not retryable), never ambient
execution and never a silent fallback to an unsandboxed spawn. There is **no**
fallback to the real HOME.

### Unit vs integration tests for the command adapter

| Suite | Depends on Bubblewrap / `sandbox-exec`? | What it proves |
| --- | --- | --- |
| Hermetic unit (`providers.test.ts` — `command adapter (hermetic unit)`) | **No** — injects a test-only `SandboxLauncher` / `ProcessSpawner` | stdout/stderr, exit 0 / non-zero → `agent_crash`, timeout, cancel, env allowlist, credential retention, spawn failure, **no unsandboxed fallback**, deterministic `sandbox_unavailable` |
| OS isolation integration (`command adapter sandbox isolation (integration)`) | **Yes** — skipped with an explicit reason when the primitive is absent | Real throwaway HOME, real-HOME read denial, write confinement, network deny |
| CLI smoke | **Yes** when exercising binaries under sandbox | Binary can *start*; not auth proof |

On Linux CI, Bubblewrap is installed and exercised before `pnpm -r test`
(`.github/workflows/ci-linux.yml`). On macOS CI, `sandbox-exec` is expected from
the runner image. A local Linux host without Bubblewrap must still pass the
hermetic unit suite and must fail closed in production wiring.

### What tests actually prove

| Claim | Evidence |
| --- | --- |
| Generic sandbox isolation (throwaway HOME, env allowlist, write confinement, default no network) | Integration tests using local probes (`printenv`, `sh`, `node`) under the real OS sandbox — **not** a vendor CLI; skipped when the primitive is absent |
| Hermetic command-adapter behaviour (exit codes, env filtering, timeout, cancel, sandbox_unavailable) | Unit tests with an injected sandbox/process double — no Bubblewrap/`sandbox-exec` required |
| Fail-closed read boundary (real-HOME/`/tmp`/second-repo/external-file/cross-provider-cred reads denied by **content**; workspace + HOME reads allowed; declared `readablePaths` granted, adjacent sibling still denied) | `packages/policy` sandbox tests on `sandbox-exec` (macOS) and Bubblewrap (Linux) |
| Per-provider auth policy construction / isolation | `cli-auth` + control-plane provider tests |
| Binary can start under sandbox | Optional smoke: `codex`/`claude`/`cursor-agent`/`node` `--version` when installed; skipped with reason if missing |
| Vendor authentication / paid API call / full mission | **Not** claimed by CI — requires an authenticated operator environment (see below) |

Do not treat a green `printenv` test as proof that Claude Code, Codex or Cursor
completed a real authenticated run.

### Authenticated operator checks (manual, not CI)

With real credentials present, an operator may additionally verify:

1. `CODEX_API_KEY` or `~/.codex/auth.json` → `codex login status` inside a
   throwaway HOME prepared by AvityOS staging (non-mutating).
2. `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` → `claude auth status` /
   a single `-p` probe (costs money — optional).
3. `CURSOR_API_KEY` or file-store `~/.cursor/auth.json` →
   `AGENT_CLI_CREDENTIAL_STORE=file cursor-agent status`.

These checks are intentionally outside credential-free CI.

Forced process-group termination still uses `SIGTERM` only; `SIGTERM` → delay →
`SIGKILL` escalation remains out of scope.
### Fixture-provider gating (`fake`)

The `fake` fixture is only available when the execution mode explicitly permits
it. `AVITY_EXECUTION_MODE` is `test`, `demo` or `production` and defaults
fail-closed to `production` (a test runner — `NODE_ENV=test`/`VITEST` — is
detected as `test`). In `production` the fixture is never registered, never
appended to a default chain, and a `AVITY_PROVIDER_CHAIN` that explicitly names
`fake` is rejected at startup with a clear error. This makes it impossible for a
real mission to silently fall back to the fixture, fabricate a plan, or
auto-approve a review.

Model names and base URLs are configuration. OpenAI uses `/v1/responses` with
`instructions` + `input`; DeepSeek remains chat-compatible. Current claims are
contract-tested with injected HTTP responses; live API smoke tests require the
operator's credentials and are not part of credential-free CI.

## Reasoning (brain) runs

The central brain's analysis/architecture/plan steps run through the same
`ProviderAdapter` interface. Editing capability is **not** required:
text-only HTTP adapters remain valid analysts and planners. Adapters do not
advertise `structuredOutput`, and AvityOS does not pretend otherwise — the
pipeline accepts a textual answer containing one JSON object (fenced or
inline), extracts it and validates it strictly against the versioned zod
contracts, with a bounded repair prompt when it is invalid. After
exhaustion, the project is blocked with an intervention; a heuristic plan is
never silently substituted.

`AVITY_BRAIN_MODELS` selects the reasoning model per provider (for example
`anthropic=claude-sonnet-4-5,fake=fake:plan`). The reasoning chain prefers
`AVITY_ROLE_PROVIDERS`' `orchestrator` entry, then the global chain, with
the standard fallback policy. The fake adapter's `fake:plan*` models are
deterministic fixtures; every brain run and plan they produce is persisted
with `fake_fixture` provenance and is never real planning evidence.

## Routing and fallback

`AVITY_PROVIDER_CHAIN` defines the global order. `AVITY_ROLE_PROVIDERS` can
prefer providers per team, for example:

```text
frontend=cursor|codex,backend=claude-code|codex,cybersecurity=codex|claude-code
```

Only adapters with workspace-edit capability can author repository missions.
The deterministic policy applies wait-for-reset → bounded retry → next model →
next provider → user escalation. An independent reviewer prefers a provider
different from the author when one is configured.

## Live E2E readiness preflight

`GET /v1/e2e/preflight` (CLI: `avity e2e preflight [--json] [--project <id>]`)
reports whether the environment can *run* each of the ten mandatory
chantier-4 live scenarios. It is a deterministic, secret-free diagnostic: it
never runs a provider and never asserts a scenario passed. Each scenario
carries one of three statuses — `ready`, `blocked_missing_credentials` or
`blocked_configuration` — and, when blocked, the names of the env vars or
tooling it still needs (never their values). The report is validated against
the versioned `E2EPreflightReport` contract (`packages/contracts/src/e2e.ts`).

Runnability is derived from the providers the control plane actually
registered, the **same effective provider routing the Engine uses**, and
asynchronous non-interactive GitHub host checks:

| Scenario | Runnable when |
| --- | --- |
| `real_planning` | a registered non-fixture provider is reachable through the effective orchestrator provider chain |
| `codex_mission` / `claude_code_mission` / `cursor_mission` | the matching adapter is registered, supports workspace edits, and is reachable through at least one effective mission-role chain |
| `reviewer_distinct_from_author` | the exact reviewer chain used by the engine contains at least two registered real providers |
| `bounded_correction_after_rejection` | at least one registered real workspace editor is reachable through an effective mission-role chain |
| `cross_provider_fallback` | at least one effective brain or mission-role chain contains two registered real providers |
| `branch_push` | git is available and a non-mutating dry-run push succeeds against the exact remote configured for the project, using the same mission branch naming convention as the real publication workflow |
| `draft_pull_request` | the configured remote passes the non-mutating push dry-run, git and gh are available, gh authentication succeeds, and the observed repository role is `WRITE`, `MAINTAIN` or `ADMIN` |
| `no_autonomous_merge` | always; the engine has no merge operation |

`GH_TOKEN`, `GITHUB_TOKEN` and `SSH_AUTH_SOCK` are only credential hints.
Their presence does not prove that authentication or repository permissions
work. `gh auth status` may succeed via the credential store or the macOS
Keychain without any environment variable. Pass `--project <id>` (or
`?projectId=`) so the preflight can run non-mutating checks against the
exact remote configured for a concrete checkout; without a project,
`branch_push` and `draft_pull_request` stay blocked.

### Limits of the read-only GitHub preflight

The preflight is intentionally non-mutating.

A successful `git push --dry-run` confirms that the push command can be
prepared against the configured remote and that some immediate connectivity,
authentication or configuration failures were not encountered.

It does not perform a real remote ref update and therefore does not prove
that every server-side hook, ruleset, branch-creation restriction or
repository policy will accept the real push.

The `viewerPermission` value returned by GitHub describes the observed
repository role of the authenticated account. A role of `WRITE`, `MAINTAIN`
or `ADMIN` is compatible with attempting the AvityOS Pull Request workflow,
but it does not prove that the active credential has every fine-grained API
permission required to create a Pull Request.

Accordingly, `ready` means that the live scenario appears runnable and may
be attempted. It never guarantees that the remote operation will succeed.

The preflight does not assume that the Git remote named `origin` is the
publication target. It checks the exact remote URL configured on the project.

Pull-request attempt readiness also requires a successful push dry-run
because AvityOS pushes the mission branch before invoking `gh pr create`.

The preflight branch uses the same `mission/*` naming convention as the real
publication workflow so matching repository rules and branch protections are
evaluated consistently.


A fixture-only environment reports `readiness: incomplete` and
`usesFakeFixtureOnly: true`. The preflight is never a substitute for a real
live run — it only tells the operator what a live campaign still needs.
`ready` means the scenario can be attempted, never that it passed.

### Operator campaign commands

End-to-end operator flow (prepare is GET-only; run mutates after confirmation):

```sh
avity doctor
avity provider status
avity e2e preflight --project <id>
avity e2e live prepare --project <id>
avity e2e live run --project <id> [--confirm-project <id>]
```

Full golden-path checklist, troubleshooting, launchd setup, and credential
placement: [LIVE-E2E-CAMPAIGN.md](./LIVE-E2E-CAMPAIGN.md).

## Adding a provider

1. Implement `ProviderAdapter` and declare capabilities conservatively.
2. Normalize every failure; never leak raw credentials in messages/logs.
3. Register it from environment configuration in `providers.ts`.
4. Add contract tests with injected transport/process behavior.
5. Add an optional, separately invoked live smoke test if credentials exist.
