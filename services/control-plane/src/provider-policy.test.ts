import { describe, expect, it } from "vitest";
import {
  assertProviderChainAllowed,
  ExecutionModeError,
  fakeProviderAllowed,
  FIXTURE_PROVIDER_ID,
  resolveExecutionMode,
} from "./provider-policy.js";
import { buildProviders } from "./providers.js";

describe("execution mode resolution", () => {
  it("honours an explicit AVITY_EXECUTION_MODE", () => {
    expect(resolveExecutionMode({ AVITY_EXECUTION_MODE: "test" })).toBe("test");
    expect(resolveExecutionMode({ AVITY_EXECUTION_MODE: "demo" })).toBe("demo");
    expect(resolveExecutionMode({ AVITY_EXECUTION_MODE: "production" })).toBe("production");
  });

  it("treats a test runner env as test mode", () => {
    expect(resolveExecutionMode({ NODE_ENV: "test" })).toBe("test");
    expect(resolveExecutionMode({ VITEST: "true" })).toBe("test");
  });

  it("defaults to production fail-closed when nothing is set", () => {
    expect(resolveExecutionMode({})).toBe("production");
    expect(resolveExecutionMode({ NODE_ENV: "development" })).toBe("production");
  });

  it("rejects an invalid mode string", () => {
    expect(() => resolveExecutionMode({ AVITY_EXECUTION_MODE: "staging" })).toThrow(ExecutionModeError);
  });
});

describe("fake provider authorization", () => {
  it("permits the fixture only in test and demo", () => {
    expect(fakeProviderAllowed("test")).toBe(true);
    expect(fakeProviderAllowed("demo")).toBe(true);
    expect(fakeProviderAllowed("production")).toBe(false);
  });

  it("rejects an explicit production chain that requests fake, with a clear error", () => {
    expect(() => assertProviderChainAllowed("production", ["codex", FIXTURE_PROVIDER_ID])).toThrow(
      /forbidden in 'production'/,
    );
  });

  it("allows a fake-containing chain in test and demo modes", () => {
    expect(() => assertProviderChainAllowed("test", ["codex", "fake"])).not.toThrow();
    expect(() => assertProviderChainAllowed("demo", ["fake"])).not.toThrow();
  });
});

describe("buildProviders fixture gating", () => {
  it("registers fake when explicitly in test mode (fixtures remain usable)", () => {
    const providers = buildProviders({ AVITY_EXECUTION_MODE: "test" });
    expect(providers.has(FIXTURE_PROVIDER_ID)).toBe(true);
  });

  it("registers fake when demo mode is explicitly enabled", () => {
    const providers = buildProviders({ AVITY_EXECUTION_MODE: "demo" });
    expect(providers.has(FIXTURE_PROVIDER_ID)).toBe(true);
  });

  it("never registers fake in production, so a real chain cannot fall back to it", () => {
    const providers = buildProviders({
      AVITY_EXECUTION_MODE: "production",
      AVITY_CODEX_BIN: "codex",
    });
    expect(providers.has(FIXTURE_PROVIDER_ID)).toBe(false);
    expect(providers.has("codex")).toBe(true);
    // Even after a real provider "fails", there is no fixture in the registry
    // to route to — the fallback surface simply does not contain it.
    expect([...providers.keys()]).not.toContain(FIXTURE_PROVIDER_ID);
  });

  it("does not register fake by default (unset env → production)", () => {
    expect(buildProviders({}).has(FIXTURE_PROVIDER_ID)).toBe(false);
  });
});
