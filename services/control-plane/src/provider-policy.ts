/**
 * Environment-scoped provider authorization.
 *
 * The deterministic `fake` fixture provider is invaluable in tests and the
 * offline demo, but catastrophic in production: it fabricates plans, writes
 * fixture artifacts into real repositories and auto-approves reviews. It must
 * therefore be *impossible to use implicitly in production* — never registered,
 * never silently appended to a real chain, and any explicit request for it in a
 * production configuration is a hard, fail-closed error rather than a silent
 * drop.
 */

/** The deterministic fixture provider id. Real evidence never comes from it. */
export const FIXTURE_PROVIDER_ID = "fake";

export type ExecutionMode = "test" | "demo" | "campaign" | "production";

export class ExecutionModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionModeError";
  }
}

/**
 * Resolve the execution mode fail-closed. An explicit `AVITY_EXECUTION_MODE`
 * always wins; otherwise a test runner (`NODE_ENV=test` / `VITEST`) is treated
 * as `test`, and everything else defaults to `production`.
 */
export function resolveExecutionMode(env: NodeJS.ProcessEnv): ExecutionMode {
  const raw = env.AVITY_EXECUTION_MODE?.trim().toLowerCase();
  if (raw) {
    if (raw === "test" || raw === "demo" || raw === "campaign" || raw === "production") return raw;
    throw new ExecutionModeError(
      `invalid AVITY_EXECUTION_MODE=${raw}; expected one of: test, demo, campaign, production`,
    );
  }
  if (env.NODE_ENV === "test" || env.VITEST) return "test";
  return "production";
}

/** The fixture provider is only permitted in test and (explicitly enabled) demo. */
export function fakeProviderAllowed(mode: ExecutionMode): boolean {
  return mode === "test" || mode === "demo";
}

/**
 * Fail-closed guard for an *explicitly requested* provider chain. Throws when
 * the chain names the fixture provider in a mode that forbids it, so a
 * production deployment can never silently route real work to `fake`.
 */
export function assertProviderChainAllowed(mode: ExecutionMode, chain: readonly string[]): void {
  if (fakeProviderAllowed(mode)) return;
  if (chain.includes(FIXTURE_PROVIDER_ID)) {
    throw new ExecutionModeError(
      `provider chain requests the '${FIXTURE_PROVIDER_ID}' fixture provider, which is forbidden in ` +
        `'${mode}' execution mode. Remove it from AVITY_PROVIDER_CHAIN, or set ` +
        `AVITY_EXECUTION_MODE=test|demo to explicitly enable fixtures.`,
    );
  }
}
