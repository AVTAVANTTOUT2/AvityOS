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
  repositoryPushVerified: false,
  pullRequestCreationVerified: false,
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
    const report = buildE2EPreflight(
      inputs({ providers: providersFrom([["fake", true], ["codex", true]]), providerChain: ["codex", "fake"] }),
    );
    for (const scenario of report.scenarios) {
      expect(["ready", "blocked_missing_credentials", "blocked_configuration"]).toContain(scenario.status);
    }
    expect(report.note).toMatch(/never asserts/i);
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
    expect(statusOf(report, "codex_mission")).toBe("blocked_configuration");
    expect(statusOf(report, "bounded_correction_after_rejection")).toBe("blocked_configuration");
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
    expect(statusOf(report, "reviewer_distinct_from_author")).toBe("blocked_configuration");
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
          repositoryPushVerified: false,
          pullRequestCreationVerified: false,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("blocked_configuration");
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
          repositoryPushVerified: false,
          pullRequestCreationVerified: false,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("blocked_configuration");
    expect(statusOf(report, "draft_pull_request")).toBe("blocked_configuration");
    expect(report.scenarios.find((s) => s.key === "branch_push")!.detail).toMatch(
      /dry-run push could not be verified/,
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
          repositoryPushVerified: true,
          pullRequestCreationVerified: false,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("ready");
    expect(statusOf(report, "draft_pull_request")).toBe("blocked_missing_credentials");
  });

  it("readies draft_pull_request from WRITE permission even when push fails", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: true,
          ghAuthenticated: true,
          repositoryReadable: true,
          repositoryPushVerified: false,
          pullRequestCreationVerified: true,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("blocked_configuration");
    expect(statusOf(report, "draft_pull_request")).toBe("ready");
  });

  it("readies GitHub scenarios when push and PR permissions are both verified", () => {
    const report = buildE2EPreflight(
      inputs({
        github: {
          gitAvailable: true,
          ghAvailable: true,
          credentialHintAvailable: false,
          ghAuthenticated: true,
          repositoryReadable: true,
          repositoryPushVerified: true,
          pullRequestCreationVerified: true,
        },
      }),
    );
    expect(statusOf(report, "branch_push")).toBe("ready");
    expect(statusOf(report, "draft_pull_request")).toBe("ready");
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
          repositoryPushVerified: false,
          pullRequestCreationVerified: false,
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
          repositoryPushVerified: true,
          pullRequestCreationVerified: true,
        },
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
    for (const scenario of report.scenarios) {
      for (const requirement of scenario.requires) {
        expect(requirement).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      }
    }
    expect(serialized).not.toMatch(/sk-|api[_-]?key=|token=/i);
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

describe("E2EPreflightReport invariants", () => {
  const baseGithub = {
    gitAvailable: false,
    ghAvailable: false,
    credentialHintAvailable: false,
    ghAuthenticated: false,
    repositoryReadable: false,
    repositoryPushVerified: false,
    pullRequestCreationVerified: false,
  };

  function scenario(key: ScenarioKey, status: "ready" | "blocked_configuration" = "ready") {
    return {
      key,
      title: key,
      status,
      detail: "test",
      requires: [] as string[],
    };
  }

  function fullScenarios(status: "ready" | "blocked_configuration" = "ready") {
    return E2EScenarioKey.options.map((key) => scenario(key, status));
  }

  it("rejects reports with the wrong number of scenarios or duplicate keys", () => {
    const nine = {
      schemaVersion: 1 as const,
      generatedAt: "2026-07-19T12:00:00.000Z",
      readiness: "incomplete" as const,
      usesFakeFixtureOnly: true,
      realProviderCount: 0,
      realWorkspaceEditorCount: 0,
      providers: [] as { name: string; real: boolean; workspaceEdits: boolean; inGlobalChain: boolean; routedRoles: string[] }[],
      github: baseGithub,
      scenarios: fullScenarios().slice(0, 9),
      readyCount: 9,
      blockedCount: 0,
      note: "note",
    };
    expect(E2EPreflightReport.safeParse(nine).success).toBe(false);

    const eleven = {
      ...nine,
      scenarios: [...fullScenarios(), scenario("real_planning")],
      readyCount: 11,
    };
    expect(E2EPreflightReport.safeParse(eleven).success).toBe(false);

    const dup = {
      ...nine,
      scenarios: [...fullScenarios().slice(0, 9), scenario("real_planning")],
      readyCount: 10,
    };
    expect(E2EPreflightReport.safeParse(dup).success).toBe(false);
  });

  it("rejects inconsistent counters and readiness", () => {
    const scenarios = fullScenarios("blocked_configuration");
    scenarios[0] = scenario("real_planning", "ready");
    const badCounts = {
      schemaVersion: 1 as const,
      generatedAt: "2026-07-19T12:00:00.000Z",
      readiness: "incomplete" as const,
      usesFakeFixtureOnly: true,
      realProviderCount: 0,
      realWorkspaceEditorCount: 0,
      providers: [],
      github: baseGithub,
      scenarios,
      readyCount: 0,
      blockedCount: 10,
      note: "note",
    };
    expect(E2EPreflightReport.safeParse(badCounts).success).toBe(false);

    const badBlocked = { ...badCounts, readyCount: 1, blockedCount: 0 };
    expect(E2EPreflightReport.safeParse(badBlocked).success).toBe(false);

    const badReady = {
      ...badCounts,
      readyCount: 1,
      blockedCount: 9,
      readiness: "ready" as const,
    };
    expect(E2EPreflightReport.safeParse(badReady).success).toBe(false);
  });
});
