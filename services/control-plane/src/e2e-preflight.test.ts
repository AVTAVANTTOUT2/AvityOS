import { describe, expect, it } from "vitest";
import { E2EPreflightReport, E2EScenarioKey, type E2EScenarioKey as ScenarioKey } from "@avityos/contracts";
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

const GITHUB_NONE = {
  gitAvailable: false,
  ghAvailable: false,
  credentialHintAvailable: false,
  ghAuthenticated: false,
  repositoryReadable: false,
  repositoryPushDryRunSucceeded: false,
  repositoryWriteRoleObserved: false,
};

function inputs(overrides: Partial<E2EPreflightInputs> = {}): E2EPreflightInputs {
  return {
    providers: providersFrom([["fake", true]]),
    providerChain: ["fake"],
    roleProviderChains: new Map(),
    missionRoles: ["backend", "frontend", "orchestrator"],
    github: GITHUB_NONE,
    now: FIXED_NOW,
    ...overrides,
  };
}

function statusOf(report: ReturnType<typeof buildE2EPreflight>, key: ScenarioKey): string {
  return report.scenarios.find((s) => s.key === key)!.status;
}

describe("buildE2EPreflight", () => {
  it("produces a schema-valid report with all ten mandatory scenarios", () => {
    const report = buildE2EPreflight(inputs());
    expect(() => E2EPreflightReport.parse(report)).not.toThrow();
    expect(report.scenarios).toHaveLength(10);
    expect(report.scenarios.map((s) => s.key).sort()).toEqual([...E2EScenarioKey.options].sort());
  });

  it("marks a fixture-only environment blocked without treating fake as live evidence", () => {
    const report = buildE2EPreflight(inputs());
    expect(report.readiness).not.toBe("ready");
    expect(report.usesFakeFixtureOnly).toBe(true);
    expect(report.realProviderCount).toBe(0);
    expect(statusOf(report, "real_planning")).toBe("blocked_missing_credentials");
    expect(statusOf(report, "codex_mission")).toBe("blocked_missing_tool");
    expect(statusOf(report, "reviewer_distinct_from_author")).toBe("blocked_missing_credentials");
  });

  it("never asserts a passed scenario: statuses stay within the runnability vocabulary", () => {
    const report = buildE2EPreflight(
      inputs({ providers: providersFrom([["fake", true], ["codex", true]]), providerChain: ["codex", "fake"] }),
    );
    for (const scenario of report.scenarios) {
      expect([
        "ready",
        "blocked_operator_configuration",
        "blocked_missing_tool",
        "blocked_missing_credentials",
        "blocked_product_gap",
      ]).toContain(scenario.status);
    }
    expect(report.note).toMatch(/never guarantees/i);
  });

  it("guarantees no-autonomous-merge structurally, independent of credentials", () => {
    expect(statusOf(buildE2EPreflight(inputs()), "no_autonomous_merge")).toBe("ready");
  });

  it("blocks a registered mission adapter that is not reachable through effective routing", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["codex", true]]),
        providerChain: ["fake"],
        roleProviderChains: new Map(),
        missionRoles: ["backend"],
      }),
    );
    expect(statusOf(report, "codex_mission")).toBe("blocked_operator_configuration");
    expect(statusOf(report, "bounded_correction_after_rejection")).toBe("blocked_operator_configuration");
    expect(report.scenarios.find((s) => s.key === "codex_mission")!.detail).toMatch(
      /not reachable through any effective mission-role/,
    );
  });

  it("blocks distinct-reviewer when a second real provider is registered but outside the chain", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["codex", true], ["anthropic", false]]),
        providerChain: ["codex", "fake"],
      }),
    );
    expect(statusOf(report, "reviewer_distinct_from_author")).toBe("blocked_operator_configuration");
  });

  it("readies distinct-reviewer when the engine reviewer chain has two real providers", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["codex", true], ["anthropic", false]]),
        providerChain: ["codex", "anthropic", "fake"],
      }),
    );
    expect(statusOf(report, "reviewer_distinct_from_author")).toBe("ready");
  });

  it("detects cross-provider fallback via a role chain even when the global chain is fixture-only", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["codex", true], ["claude-code", true]]),
        providerChain: ["fake"],
        roleProviderChains: new Map([["backend", ["codex", "claude-code"]]]),
        missionRoles: ["backend"],
      }),
    );
    expect(statusOf(report, "cross_provider_fallback")).toBe("ready");
  });

  it("readies a mission adapter when it is reachable through a role chain", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["codex", true]]),
        providerChain: ["fake"],
        roleProviderChains: new Map([["backend", ["codex"]]]),
        missionRoles: ["backend"],
      }),
    );
    expect(statusOf(report, "codex_mission")).toBe("ready");
    expect(statusOf(report, "bounded_correction_after_rejection")).toBe("ready");
  });

  it("blocks GitHub scenarios when only a credential hint is present", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: true,
          ghAuthenticated: false,
          repositoryReadable: false,
          repositoryPushDryRunSucceeded: false,
          repositoryWriteRoleObserved: false,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("blocked_operator_configuration");
    expect(statusOf(report, "draft_pull_request")).toBe("blocked_missing_credentials");
  });

  it("blocks GitHub write scenarios when the repository is only readable", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: true,
          ghAuthenticated: true,
          repositoryReadable: true,
          repositoryPushDryRunSucceeded: false,
          repositoryWriteRoleObserved: false,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("blocked_operator_configuration");
    expect(statusOf(report, "draft_pull_request")).toBe("blocked_operator_configuration");
    expect(report.scenarios.find((s) => s.key === "branch_push")!.detail).toMatch(
      /non-mutating dry-run push preflight/,
    );
  });

  it("readies branch_push from a verified dry-run push without requiring gh", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: false,
          credentialHintAvailable: false,
          ghAuthenticated: false,
          repositoryReadable: false,
          repositoryPushDryRunSucceeded: true,
          repositoryWriteRoleObserved: false,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("ready");
    expect(statusOf(report, "draft_pull_request")).toBe("blocked_missing_tool");
  });

  it("blocks draft PR readiness when GitHub permission exists but the configured remote cannot be pushed", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: true,
          ghAuthenticated: true,
          repositoryReadable: true,
          repositoryPushDryRunSucceeded: false,
          repositoryWriteRoleObserved: true,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("blocked_operator_configuration");
    expect(statusOf(report, "draft_pull_request")).toBe("blocked_operator_configuration");
    expect(report.scenarios.find((s) => s.key === "draft_pull_request")!.detail).toMatch(
      /non-mutating dry-run push required before attempting a Pull Request/,
    );
  });

  it("readies GitHub scenarios when push dry-run and write role are both observed", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: false,
          ghAuthenticated: true,
          repositoryReadable: true,
          repositoryPushDryRunSucceeded: true,
          repositoryWriteRoleObserved: true,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("ready");
    expect(statusOf(report, "draft_pull_request")).toBe("ready");
  });

  it("does not describe dry-run push success as a guaranteed real push", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: false,
          ghAuthenticated: true,
          repositoryReadable: true,
          repositoryPushDryRunSucceeded: true,
          repositoryWriteRoleObserved: true,
        },
      }),
    );

    const scenario = report.scenarios.find((item) => item.key === "branch_push")!;

    expect(scenario.status).toBe("ready");
    expect(scenario.detail).toMatch(/dry-run/i);
    expect(scenario.detail).toMatch(/does not prove|does not guarantee/i);
    expect(scenario.detail).not.toMatch(
      /push permission verified|guaranteed to succeed/i,
    );
  });

  it("does not describe WRITE viewerPermission as verified PR creation", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: false,
          ghAuthenticated: true,
          repositoryReadable: true,
          repositoryPushDryRunSucceeded: true,
          repositoryWriteRoleObserved: true,
        },
      }),
    );

    const scenario = report.scenarios.find((item) => item.key === "draft_pull_request")!;

    expect(scenario.status).toBe("ready");
    expect(scenario.detail).toMatch(/WRITE, MAINTAIN or ADMIN|repository role/i);
    expect(scenario.detail).toMatch(/does not prove|does not guarantee/i);
    expect(scenario.detail).not.toMatch(
      /PR creation permission verified|guaranteed/i,
    );
  });

  it("never readies write scenarios from repositoryReadable alone", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: false,
          ghAuthenticated: true,
          repositoryReadable: true,
          repositoryPushDryRunSucceeded: false,
          repositoryWriteRoleObserved: false,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).not.toBe("ready");
    expect(statusOf(report, "draft_pull_request")).not.toBe("ready");
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

  it("classifies a registered text-only mission adapter as a product gap", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["codex", false]]),
        providerChain: ["codex", "fake"],
        missionRoles: ["backend"],
      }),
    );
    const mission = report.scenarios.find(
      (item) => item.key === "codex_mission",
    )!;
    expect(mission.status).toBe("blocked_product_gap");
    expect(mission.reasons[0]?.category).toBe("blocked_product_gap");
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

  it("reports fully ready when every real provider, route and GitHub channel is present", () => {
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
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: false,
          ghAuthenticated: true,
          repositoryReadable: true,
          repositoryPushDryRunSucceeded: true,
          repositoryWriteRoleObserved: true,
        },
      }),
    );
    expect(report.readiness).toBe("ready");
    expect(report.blockedCount).toBe(0);
    expect(report.readyCount).toBe(10);
    expect(report.usesFakeFixtureOnly).toBe(false);
  });

  it("returns structured, secret-free tools, environment channels, and remediation", () => {
    const report = buildE2EPreflight(
      inputs({ providers: providersFrom([["fake", true], ["codex", true]]), providerChain: ["codex", "fake"] }),
    );
    const serialized = JSON.stringify(report);
    for (const scenario of report.scenarios) {
      for (const reason of scenario.reasons) {
        expect(reason.category).toBe(scenario.status);
        expect(reason.remediation.length).toBeGreaterThan(0);
        for (const environmentVariable of reason.environmentVariables) {
          expect(environmentVariable).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
      }
    }
    expect(serialized).not.toMatch(/sk-|api[_-]?key=|token=/i);
  });

  it("reports only registered providers in effective engine routing", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["codex", true]]),
        providerChain: ["missing", "codex", "fake"],
        roleProviderChains: new Map([
          ["backend", ["missing-role-provider", "codex"]],
        ]),
        missionRoles: ["backend"],
      }),
    );
    expect(report.effectiveRouting.globalChain).toEqual(["codex", "fake"]);
    expect(report.effectiveRouting.brainChain).toEqual(["codex", "fake"]);
    expect(report.effectiveRouting.missionRoleChains).toEqual([
      { role: "backend", providers: ["codex", "fake"] },
    ]);
    expect(JSON.stringify(report.effectiveRouting)).not.toContain("missing");
  });

  it("always returns a report that re-parses through E2EPreflightReport", () => {
    const report = buildE2EPreflight(
      inputs({
        providers: providersFrom([["fake", true], ["codex", true], ["claude-code", true]]),
        providerChain: ["fake"],
        roleProviderChains: new Map([["backend", ["codex", "claude-code"]]]),
        missionRoles: ["backend"],
      }),
    );
    expect(E2EPreflightReport.parse(report)).toEqual(report);
  });
});
