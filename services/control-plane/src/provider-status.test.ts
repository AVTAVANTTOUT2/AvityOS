import { describe, expect, it } from "vitest";
import { TeamRole } from "@avityos/contracts";
import {
  ADAPTER_CONTRACT_VERSION,
  type ProviderAdapter,
  type ProviderCapabilities,
} from "@avityos/providers";
import { buildProviderStatus } from "./provider-status.js";

class ExplodingAdapter implements ProviderAdapter {
  readonly name = "codex";
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      structuredOutput: false,
      toolCalls: false,
      workspaceEdits: true,
      resumption: false,
      checkpointRequests: false,
    };
  }

  async listModels(): Promise<string[]> {
    throw new Error("listModels must not be called by readiness status");
  }

  async healthy(): Promise<boolean> {
    throw new Error("healthy must not be called by readiness status");
  }

  startRun(): ReturnType<ProviderAdapter["startRun"]> {
    throw new Error("not used");
  }
}

function routingInput(globalChain: string[], backendChain: string[]): {
  providerChain: readonly string[];
  roleProviderChains: ReadonlyMap<string, readonly string[]>;
  missionRoles: readonly string[];
} {
  return {
    providerChain: globalChain,
    roleProviderChains: new Map([["backend", backendChain]]),
    missionRoles: TeamRole.options,
  };
}

describe("buildProviderStatus", () => {
  it("fails codex mission readiness when binary, auth, model and routing are all absent", () => {
    const report = buildProviderStatus({
      env: {},
      executionMode: "production",
      providers: new Map(),
      defaultModels: new Map(),
      reviewModels: new Map(),
      routing: routingInput([], []),
      campaignFault: null,
    });

    const codex = report.providers.find((provider) => provider.name === "codex");
    expect(codex?.status).toBe("blocked_missing_tool");
    expect(codex?.reasons.some((reason) => reason.code === "binary_missing")).toBe(true);
    expect(codex?.reasons.some((reason) => reason.code === "auth_missing")).toBe(true);
    expect(codex?.reasons.some((reason) => reason.code === "model_missing")).toBe(true);
    expect(codex?.reasons.some((reason) => reason.code === "routing_missing")).toBe(true);
  });

  it("reports no mission editor when no real workspace editor is routable", () => {
    const report = buildProviderStatus({
      env: {},
      executionMode: "production",
      providers: new Map(),
      defaultModels: new Map(),
      reviewModels: new Map(),
      routing: routingInput([], []),
      campaignFault: null,
    });

    const check = report.checks.find((item) => item.key === "mission_editor");
    expect(check?.status).toBe("blocked_product_gap");
  });

  it("reports missing distinct reviewer when only one real provider is review-ready", () => {
    const providers = new Map<string, ProviderAdapter>([["codex", new ExplodingAdapter()]]);
    const report = buildProviderStatus({
      env: {
        AVITY_CODEX_BIN: "codex",
        CODEX_API_KEY: "present",
        AVITY_DEFAULT_MODELS: "codex=gpt-5.6-sol-high",
      },
      executionMode: "production",
      providers,
      defaultModels: new Map([["codex", "gpt-5.6-sol-high"]]),
      reviewModels: new Map(),
      routing: routingInput(["codex"], ["codex"]),
      campaignFault: null,
    });

    const check = report.checks.find((item) => item.key === "distinct_reviewer");
    expect(check?.status).toBe("blocked_operator_configuration");
  });

  it("reports missing fallback when only one real mission editor is reachable", () => {
    const providers = new Map<string, ProviderAdapter>([["codex", new ExplodingAdapter()]]);
    const report = buildProviderStatus({
      env: {
        AVITY_CODEX_BIN: "codex",
        CODEX_API_KEY: "present",
        AVITY_DEFAULT_MODELS: "codex=gpt-5.6-sol-high",
      },
      executionMode: "production",
      providers,
      defaultModels: new Map([["codex", "gpt-5.6-sol-high"]]),
      reviewModels: new Map(),
      routing: routingInput(["codex"], ["codex"]),
      campaignFault: null,
    });

    const check = report.checks.find((item) => item.key === "cross_provider_fallback");
    expect(check?.status).toBe("blocked_operator_configuration");
  });

  it("stays secret-free and never triggers vendor health/model probes", () => {
    const providers = new Map<string, ProviderAdapter>([["codex", new ExplodingAdapter()]]);
    const report = buildProviderStatus({
      env: {
        AVITY_CODEX_BIN: "codex",
        CODEX_API_KEY: "sensitive-value",
        AVITY_DEFAULT_MODELS: "codex=gpt-5.6-sol-high",
      },
      executionMode: "production",
      providers,
      defaultModels: new Map([["codex", "gpt-5.6-sol-high"]]),
      reviewModels: new Map(),
      routing: routingInput(["codex"], ["codex"]),
      campaignFault: null,
    });

    expect(JSON.stringify(report)).not.toContain("sensitive-value");
  });
});
