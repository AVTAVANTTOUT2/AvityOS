import { describe, expect, it } from "vitest";
import type { ProviderErrorCategory } from "@avityos/contracts";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import {
  applyCampaignFaultInjection,
  resolveCampaignFault,
} from "./campaign-fault.js";
import { ExecutionModeError } from "./provider-policy.js";

async function firstErrorCategory(
  providers: Map<string, ProviderAdapter>,
  providerName: string,
): Promise<ProviderErrorCategory | null> {
  const adapter = providers.get(providerName);
  if (!adapter) return null;
  const handle = adapter.startRun({
    runId: "run_1",
    model: "fake:succeed",
    systemPrompt: "system",
    userPrompt: "prompt",
    timeoutMs: 2000,
  });
  for await (const event of handle.events) {
    if (event.type === "error") return event.category;
    if (event.type === "completed") return null;
  }
  return null;
}

describe("campaign fault injection", () => {
  it("rejects fault injection in production mode", () => {
    expect(() =>
      resolveCampaignFault(
        {
          AVITY_CAMPAIGN_FAULT_PROVIDER: "codex",
          AVITY_CAMPAIGN_FAULT_CATEGORY: "rate_limited",
        },
        "production",
        new Set(["codex"]),
      ),
    ).toThrow(ExecutionModeError);
  });

  it("requires explicit provider and category together", () => {
    expect(() =>
      resolveCampaignFault(
        { AVITY_CAMPAIGN_FAULT_PROVIDER: "codex" },
        "campaign",
        new Set(["codex"]),
      ),
    ).toThrow(/must be set together/i);
  });

  it("rejects fake provider fault injection even in campaign mode", () => {
    expect(() =>
      resolveCampaignFault(
        {
          AVITY_CAMPAIGN_FAULT_PROVIDER: "fake",
          AVITY_CAMPAIGN_FAULT_CATEGORY: "rate_limited",
        },
        "campaign",
        new Set(["fake"]),
      ),
    ).toThrow(/fake/i);
  });

  it("injects exactly one normalized error, then delegates subsequent runs", async () => {
    const baseProviders = new Map<string, ProviderAdapter>([
      ["codex", new FakeProviderAdapter("codex")],
      ["claude-code", new FakeProviderAdapter("claude-code")],
    ]);
    const fault = resolveCampaignFault(
      {
        AVITY_CAMPAIGN_FAULT_PROVIDER: "codex",
        AVITY_CAMPAIGN_FAULT_CATEGORY: "rate_limited",
      },
      "campaign",
      new Set(baseProviders.keys()),
    );
    const wrapped = applyCampaignFaultInjection(baseProviders, fault);

    expect(await firstErrorCategory(wrapped, "codex")).toBe("rate_limited");
    expect(await firstErrorCategory(wrapped, "codex")).toBe(null);
    expect(await firstErrorCategory(wrapped, "claude-code")).toBe(null);
  });
});
