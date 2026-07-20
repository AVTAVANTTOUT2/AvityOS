import { describe, expect, it } from "vitest";
import { E2EPreflightReport, type E2EScenarioKey } from "@avityos/contracts";
import {
  ADAPTER_CONTRACT_VERSION,
  type ProviderAdapter,
  type ProviderCapabilities,
} from "@avityos/providers";
import { buildE2EPreflight, type E2EPreflightInputs } from "./e2e-preflight.js";

/** Minimal adapter stub — the preflight only inspects capabilities/presence. */
function stubAdapter(name: string, workspaceEdits: boolean): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    streaming: false,
    structuredOutput: false,
    toolCalls: false,
    workspaceEdits,
    resumption: false,
    checkpointRequests: false,
  };
  return {
    name,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    capabilities: () => capabilities,
    listModels: async () => [],
    healthy: async () => true,
    startRun: () => {
      throw new Error("not used in preflight");
    },
  };
}

function providersFrom(entries: [string, boolean][]): Map<string, ProviderAdapter> {
  return new Map(entries.map(([name, edits]) => [name, stubAdapter(name, edits)]));
}

const FIXED_NOW = () => new Date("2026-07-19T12:00:00.000Z");

function inputs(overrides: Partial<E2EPreflightInputs> = {}): E2EPreflightInputs {
  return {
    providers: providersFrom([["fake", true]]),
    providerChain: ["fake"],
    roleProviderChains: new Map(),
    git: false,
    gh: false,
    githubCredential: false,
    now: FIXED_NOW,
    ...overrides,
  };
}

function statusOf(report: ReturnType<typeof buildE2EPreflight>, key: E2EScenarioKey): string {
  return report.scenarios.find((s) => s.key === key)!.status;
}

describe("buildE2EPreflight", () => {
  it("produces a schema-valid report with all ten mandatory scenarios", () => {
    const report = buildE2EPreflight(inputs());
    expect(() => E2EPreflightReport.parse(report)).not.toThrow();
    expect(report.scenarios).toHaveLength(10);
    const keys = report.scenarios.map((s) => s.key).sort();
    expect(keys).toEqual(
      [
        "branch_push",
        "bounded_correction_after_rejection",
        "claude_code_mission",
        "codex_mission",
        "cross_provider_fallback",
        "cursor_mission",
        "draft_pull_request",
        "no_autonomous_merge",
        "real_planning",
        "reviewer_distinct_from_author",
      ].sort(),
    );
  });

  it("marks a fixture-only environment incomplete and blocked on credentials", () => {
    const report = buildE2EPreflight(inputs());
    expect(report.readiness).toBe("incomplete");
    expect(report.usesFakeFixtureOnly).toBe(true);
    expect(report.realProviderCount).toBe(0);
    expect(statusOf(report, "real_planning")).toBe("blocked_missing_credentials");
    expect(statusOf(report, "codex_mission")).toBe("blocked_missing_credentials");
    expect(statusOf(report, "reviewer_distinct_from_author")).toBe("blocked_missing_credentials");
  });

  it("never asserts a passed scenario: statuses stay within the runnability vocabulary", () => {
    const report = buildE2EPreflight(inputs({ providers: providersFrom([["fake", true], ["codex", true]]) }));
    for (const scenario of report.scenarios) {
      expect(["ready", "blocked_missing_credentials", "blocked_configuration"]).toContain(scenario.status);
    }
    expect(report.note).toMatch(/never asserts/i);
  });

  it("guarantees no-autonomous-merge structurally, independent of credentials", () => {
    const report = buildE2EPreflight(inputs());
    expect(statusOf(report, "no_autonomous_merge")).toBe("ready");
  });

  it("readies a mission scenario only when its adapter is registered with workspace edits", () => {
    const withCodex = buildE2EPreflight(inputs({ providers: providersFrom([["fake", true], ["codex", true]]) }));
    expect(statusOf(withCodex, "codex_mission")).toBe("ready");
    expect(statusOf(withCodex, "claude_code_mission")).toBe("blocked_missing_credentials");

    const codexNoEdits = buildE2EPreflight(inputs({ providers: providersFrom([["fake", true], ["codex", false]]) }));
    expect(statusOf(codexNoEdits, "codex_mission")).toBe("blocked_configuration");
  });

  it("requires two real providers for a distinct reviewer and real fallback", () => {
    const single = buildE2EPreflight(
      inputs({ providers: providersFrom([["fake", true], ["codex", true]]), providerChain: ["codex", "fake"] }),
    );
    expect(statusOf(single, "reviewer_distinct_from_author")).toBe("blocked_configuration");
    expect(statusOf(single, "cross_provider_fallback")).toBe("blocked_configuration");

    const dual = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["codex", true], ["anthropic", false]]),
        providerChain: ["codex", "anthropic", "fake"],
      }),
    );
    expect(statusOf(dual, "reviewer_distinct_from_author")).toBe("ready");
    expect(statusOf(dual, "cross_provider_fallback")).toBe("ready");
  });

  it("treats a text-only real provider as a valid planner but not a mission author", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["anthropic", false]]),
        providerChain: ["anthropic", "fake"],
      }),
    );
    expect(statusOf(report, "real_planning")).toBe("ready");
    expect(statusOf(report, "bounded_correction_after_rejection")).toBe("blocked_missing_credentials");
  });

  it("uses the orchestrator role chain to satisfy real planning", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["anthropic", false]]),
        providerChain: ["fake"],
        roleProviderChains: new Map([["orchestrator", ["anthropic"]]]),
      }),
    );
    expect(statusOf(report, "real_planning")).toBe("ready");
  });

  it("gates branch push and draft PR on git/gh tooling and a credential channel", () => {
    const noTooling = buildE2EPreflight(inputs());
    expect(statusOf(noTooling, "branch_push")).toBe("blocked_missing_credentials");
    expect(statusOf(noTooling, "draft_pull_request")).toBe("blocked_missing_credentials");
    const pushBlocked = noTooling.scenarios.find((s) => s.key === "branch_push")!;
    expect(pushBlocked.requires).toContain("git");

    const gitOnly = buildE2EPreflight(inputs({ git: true, githubCredential: true }));
    expect(statusOf(gitOnly, "branch_push")).toBe("ready");
    expect(statusOf(gitOnly, "draft_pull_request")).toBe("blocked_missing_credentials");

    const full = buildE2EPreflight(inputs({ git: true, gh: true, githubCredential: true }));
    expect(statusOf(full, "branch_push")).toBe("ready");
    expect(statusOf(full, "draft_pull_request")).toBe("ready");
  });

  it("reports fully ready when every real provider and channel is present", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([
          ["fake", true],
          ["codex", true],
          ["claude-code", true],
          ["cursor", true],
          ["anthropic", false],
        ]),
        providerChain: ["codex", "claude-code", "cursor", "anthropic", "fake"],
        git: true,
        gh: true,
        githubCredential: true,
      }),
    );
    expect(report.readiness).toBe("ready");
    expect(report.blockedCount).toBe(0);
    expect(report.readyCount).toBe(10);
    expect(report.usesFakeFixtureOnly).toBe(false);
  });

  it("never surfaces a credential value — only names, booleans and env-var identifiers", () => {
    const report = buildE2EPreflight(
      inputs({ providers: providersFrom([["fake", true], ["codex", true]]), providerChain: ["codex", "fake"] }),
    );
    const serialized = JSON.stringify(report);
    // requires arrays must only reference env-var / tooling names, never values.
    for (const scenario of report.scenarios) {
      for (const requirement of scenario.requires) {
        expect(requirement).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      }
    }
    expect(serialized).not.toMatch(/sk-|api[_-]?key=|token=/i);
  });
});
