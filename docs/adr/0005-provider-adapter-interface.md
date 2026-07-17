# ADR-0005: Versioned provider adapter interface with a deterministic fake

Status: accepted
Date: 2026-07-17

## Context

OpenAI/Codex, Anthropic/Claude Code, Cursor CLI, DeepSeek and future providers
must be interchangeable. The platform must be demonstrable and testable with
zero paid credentials. Provider failures (quota, rate limit, auth, crash) must
be normalized so fallback policy is provider-agnostic.

## Decision

- `packages/providers` defines `ProviderAdapter` (versioned): capability
  discovery, model listing, `startRun`, streamed `RunEvent`s, checkpoint
  requests, cancellation, artifact collection, usage reporting.
- All failures map to a closed set of `ProviderErrorCategory` values
  (`auth`, `quota_exhausted`, `rate_limited`, `transient_network`,
  `invalid_request`, `context_overflow`, `tool_failure`, `agent_crash`,
  `policy_denied`, `unknown`), with optional `retryAfterMs`.
- Adapters shipped: `fake` (deterministic, scriptable — the test/demo
  backbone), `command` (generic subprocess adapter that runs any CLI agent,
  including Claude Code and Cursor CLI in non-interactive mode), and HTTP API
  adapters for OpenAI-compatible endpoints (OpenAI, DeepSeek) and Anthropic.
- Model names, base URLs and API keys are configuration, never code. API-key
  auth and CLI sign-in auth are represented as distinct `AuthMethod`s on the
  provider account.
- Fallback is policy-driven in the orchestration engine: wait-for-reset,
  retry-with-backoff, switch-model, switch-provider, pause-lower-priority,
  escalate-to-user — never silently when policy forbids the alternative.

## Consequences

- The whole lifecycle is testable and demoable offline via the fake adapter.
- Adding a provider is a new adapter file plus configuration, not an
  architecture change.
- TUI scraping is explicitly out of scope; CLI agents are integrated through
  their supported non-interactive/programmatic modes via the command adapter.
