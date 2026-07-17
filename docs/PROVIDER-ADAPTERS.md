# Provider adapters

All AI execution flows through `ProviderAdapter` v1
(`packages/providers/src/types.ts`): capabilities, model discovery,
`startRun` returning a streamed `RunEvent` generator plus `cancel()`,
usage reporting, and a **closed** set of normalized error categories:

`auth · quota_exhausted · rate_limited · transient_network ·
invalid_request · context_overflow · tool_failure · agent_crash ·
policy_denied · unknown` (with optional `retryAfterMs`).

## Shipped adapters

| Adapter | Class | Notes |
| --- | --- | --- |
| `fake` | `FakeProviderAdapter` | Deterministic, scripted by model name (`fake:succeed`, `fake:fail-<category>`, `fake:rate-limit-once`, `fake:slow`, `fake:checkpoint`). Test/demo backbone; zero credentials. |
| `command` | `CommandProviderAdapter` | Runs any CLI agent non-interactively (argv only, `{prompt}`/`{model}` placeholders, detached process group, timeout). Integrates **Claude Code** (`claude -p "{prompt}"`) and **Cursor CLI** through their supported non-interactive modes — no TUI scraping. |
| OpenAI-compatible | `OpenAICompatibleAdapter` | Chat-completions APIs: OpenAI and **DeepSeek** purely via `baseUrl`/`apiKey`/`models` config. Live model discovery merged with configured list. |
| Anthropic | `AnthropicAdapter` | Messages API with content-block extraction and usage. |

Model names, base URLs and keys are configuration, never code. API-key auth
and CLI-session auth are distinct `AuthMethod`s on the provider account.
Pricing is configuration (adapters report tokens; `costUsd` is 0 unless a
pricing table is configured) — the architecture is not tied to any vendor's
current price list or model alias.

## Fallback policy

`decideFallback` (packages/orchestration) implements: wait-for-reset (within
the policy wait budget) → retry with capped exponential backoff → switch
model (if allowed) → switch provider (if allowed) → escalate to the user.
`auth`, `policy_denied` and `invalid_request` never retry. The engine emits
a `provider.fallback` event for every decision.

## Adding a provider

1. Implement `ProviderAdapter` in `packages/providers/src/<name>.ts`.
2. Map every failure to a category (`normalizeHttpStatus` helps for HTTP).
3. Register it in the control plane's provider map (`main.ts`).
4. Add contract tests with an injected `fetchImpl` (see
   `providers.test.ts`) — no network in tests.

## Credentials status

The OpenAI, Anthropic and DeepSeek adapters are implemented and
contract-tested against injected responses. Final live verification
requires real API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`DEEPSEEK_API_KEY`) — set them and register the adapters in
`services/control-plane/src/main.ts`; nothing else changes.
