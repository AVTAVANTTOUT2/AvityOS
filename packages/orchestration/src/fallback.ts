import type { FallbackAction, ProviderErrorCategory } from "@avityos/contracts";

export interface FallbackContext {
  category: ProviderErrorCategory;
  attempt: number;
  maxRetries: number;
  /** Milliseconds until the provider says the limit resets, if known. */
  retryAfterMs: number | null;
  /** Longest the policy allows waiting for a reset before falling back. */
  maxWaitMs: number;
  alternateModelsAvailable: boolean;
  alternateProvidersAllowed: boolean;
}

export interface FallbackDecision {
  action: FallbackAction;
  waitMs: number;
  reason: string;
}

/**
 * Deterministic, policy-driven fallback. Order of preference mirrors ADR-0005:
 * wait -> retry -> switch model -> switch provider -> escalate. Auth, policy
 * and invalid-request failures never retry silently.
 */
export function decideFallback(ctx: FallbackContext): FallbackDecision {
  switch (ctx.category) {
    case "auth":
    case "policy_denied":
    case "sandbox_unavailable":
    case "invalid_request":
      return {
        action: "escalate_user",
        waitMs: 0,
        reason: `${ctx.category} errors are not retryable`,
      };
    case "rate_limited":
      if (
        ctx.retryAfterMs !== null &&
        ctx.retryAfterMs <= ctx.maxWaitMs &&
        ctx.attempt < ctx.maxRetries
      ) {
        return {
          action: "wait_for_reset",
          waitMs: ctx.retryAfterMs,
          reason: `rate limit resets in ${ctx.retryAfterMs}ms (within policy wait budget)`,
        };
      }
      return switchOrEscalate(
        ctx,
        ctx.attempt >= ctx.maxRetries
          ? "rate limited and retry budget exhausted"
          : "rate limit reset exceeds policy wait budget",
      );
    case "quota_exhausted":
      return switchOrEscalate(ctx, "provider quota exhausted");
    case "context_overflow":
      if (ctx.alternateModelsAvailable) {
        return { action: "switch_model", waitMs: 0, reason: "context overflow; larger-context model allowed" };
      }
      return { action: "escalate_user", waitMs: 0, reason: "context overflow and no larger model allowed" };
    case "transient_network":
    case "tool_failure":
    case "agent_crash":
    case "unknown":
      if (ctx.attempt < ctx.maxRetries) {
        return {
          action: "retry_backoff",
          waitMs: backoffMs(ctx.attempt),
          reason: `transient failure, retry ${ctx.attempt + 1}/${ctx.maxRetries}`,
        };
      }
      return switchOrEscalate(ctx, "retry budget exhausted");
  }
}

function switchOrEscalate(ctx: FallbackContext, reason: string): FallbackDecision {
  if (ctx.alternateModelsAvailable) {
    return { action: "switch_model", waitMs: 0, reason: `${reason}; switching model` };
  }
  if (ctx.alternateProvidersAllowed) {
    return { action: "switch_provider", waitMs: 0, reason: `${reason}; switching provider` };
  }
  return { action: "escalate_user", waitMs: 0, reason: `${reason}; no allowed alternative` };
}

/** Exponential backoff with deterministic jitter-free steps: 1s, 2s, 4s… capped at 60s. */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 60_000);
}
