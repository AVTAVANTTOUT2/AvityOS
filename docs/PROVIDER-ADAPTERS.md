# Provider adapters

All AI execution flows through `ProviderAdapter` v1
(`packages/providers/src/types.ts`): honest capabilities, model discovery,
streamed run events, cancellation, usage, and a closed set of normalized
failures (`auth`, quota/rate limit, network, invalid request, context,
tool/agent/policy failure, unknown).

## Runtime adapters

| Name | Interface | Workspace edits | Runtime safety |
| --- | --- | ---: | --- |
| `codex` | official `codex exec` | yes | `workspace-write`, no approvals, ephemeral, no inherited shell environment |
| `claude-code` | `claude -p` | yes | safe mode, no persistence, explicit tools/permission mode |
| `cursor` | `cursor-agent -p` | yes | built-in sandbox, trusted explicit workspace, setup scripts disabled |
| `command` | configured argv template | opt-in only | reviewer-only unless `AVITY_COMMAND_WORKSPACE_EDITS=1` |
| `openai` | OpenAI Responses API | no | text/review runs; `store:false`; key scoped to HTTP adapter |
| `anthropic` | Anthropic Messages API | no | text/review runs |
| `deepseek` | OpenAI-compatible chat API | no | text/review runs |
| `fake` | deterministic in-process fixture | fixture edits | tests correction, review, fallback, worktrees and checks offline |

HTTP adapters intentionally advertise `workspaceEdits:false`: returning text is
not equivalent to editing a repository. CLI adapters combine the architecture
system prompt and mission prompt, execute inside the persisted worktree, and
receive only explicitly scoped environment variables.

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

`GET /v1/e2e/preflight` (CLI: `avity e2e preflight [--json]`) reports whether
the environment can *run* each of the ten mandatory chantier-4 live scenarios.
It is a deterministic, secret-free diagnostic: it never runs a provider and
never asserts a scenario passed. Each scenario carries one of three statuses —
`ready`, `blocked_missing_credentials` or `blocked_configuration` — and, when
blocked, the names of the env vars or tooling it still needs (never their
values). The report is validated against the versioned
`E2EPreflightReport` contract (`packages/contracts/src/e2e.ts`).

Runnability is derived from the providers the control plane actually
registered (which only happens when their credentials/binaries are present),
the active fallback chain, the orchestrator role chain and host GitHub tooling:

| Scenario | Runnable when |
| --- | --- |
| `real_planning` | a non-fixture provider is in the brain (orchestrator/global) chain |
| `codex_mission` / `claude_code_mission` / `cursor_mission` | the matching CLI adapter is registered with workspace-edit capability |
| `reviewer_distinct_from_author` | at least two real providers are registered |
| `bounded_correction_after_rejection` | at least one real workspace-editing provider is registered |
| `cross_provider_fallback` | at least two real providers are in the active chain |
| `branch_push` | `git` plus a credential channel (`GH_TOKEN`/`GITHUB_TOKEN`/`SSH_AUTH_SOCK`) |
| `draft_pull_request` | the above plus the `gh` CLI |
| `no_autonomous_merge` | always: structural guarantee, the engine never merges |

A fixture-only environment reports `readiness: incomplete` and
`usesFakeFixtureOnly: true`. The preflight is fully offline and never a
substitute for a real live run — it only tells the operator what a live
campaign still needs.

## Adding a provider

1. Implement `ProviderAdapter` and declare capabilities conservatively.
2. Normalize every failure; never leak raw credentials in messages/logs.
3. Register it from environment configuration in `providers.ts`.
4. Add contract tests with injected transport/process behavior.
5. Add an optional, separately invoked live smoke test if credentials exist.
