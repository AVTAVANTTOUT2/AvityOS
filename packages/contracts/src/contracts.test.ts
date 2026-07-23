import { describe, expect, it } from "vitest";
import {
  BrainObjectiveAnalysis,
  CreateProjectRequest,
  E2E_CAMPAIGN_REPORT_SCHEMA_VERSION,
  E2E_PREFLIGHT_SCHEMA_VERSION,
  E2ECampaignReport,
  E2ECampaignResultStatus,
  E2EGitHubReadiness,
  E2EPreflightReport,
  E2EReadinessReason,
  E2EScenarioKey,
  E2EScenarioStatus,
  EventEnvelope,
  Mission,
  MissionState,
  ProviderErrorCategory,
  UpdateProjectRequest,
} from "./index.js";

describe("contracts", () => {
  it("parses a valid mission", () => {
    const mission = Mission.parse({
      id: "m1",
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
      projectId: "p1",
      planId: null,
      milestoneId: null,
      title: "Implement login endpoint",
      role: "backend",
      state: "proposed",
      contract: { objective: "Build POST /login" },
      branchName: null,
      worktreePath: null,
      stateReason: null,
    });
    expect(mission.correctionAttempts).toBe(0);
    expect(mission.contract.requiredChecks).toEqual([]);
  });

  it("rejects unknown mission states", () => {
    expect(MissionState.safeParse("done").success).toBe(false);
    expect(MissionState.safeParse("integrated").success).toBe(true);
  });

  it("applies request defaults", () => {
    const req = CreateProjectRequest.parse({ name: "Demo" });
    expect(req.autonomyProfile).toBe("autonomous_with_checkpoints");
    expect(req.repoPath).toBeNull();
    expect(req.defaultBranch).toBe("main");
    expect(req.budgetWarnAtFraction).toBe(0.8);
  });

  it("validates complete project onboarding fields", () => {
    const req = CreateProjectRequest.parse({
      name: "Demo",
      repoPath: "/srv/demo",
      repoRemoteUrl: "git@github.com:example/demo.git",
      defaultBranch: "develop",
      objective: "Deliver the complete onboarding flow",
      acceptanceCriteria: ["web persists every field", "CLI supports updates"],
      budgetUsd: 125,
      budgetWarnAtFraction: 0.75,
    });
    expect(req.acceptanceCriteria).toHaveLength(2);
    expect(req.repoRemoteUrl).toBe("git@github.com:example/demo.git");
    expect(UpdateProjectRequest.parse({ budgetUsd: 125 })).toEqual({ budgetUsd: 125 });
    expect(UpdateProjectRequest.safeParse({}).success).toBe(false);
    expect(CreateProjectRequest.safeParse({ name: "X", repoRemoteUrl: "https://github.com/x/y" }).success).toBe(false);
  });

  it("validates event envelopes with resume sequence", () => {
    const ev = EventEnvelope.parse({
      schemaVersion: 1,
      seq: 42,
      id: "e1",
      type: "mission.state_changed",
      projectId: "p1",
      missionId: "m1",
      runId: null,
      createdAt: "2026-07-17T10:00:00.000Z",
      payload: { from: "ready", to: "assigned" },
    });
    expect(ev.seq).toBe(42);
  });

  it("keeps provider error categories closed", () => {
    expect(ProviderErrorCategory.options).toContain("rate_limited");
    expect(ProviderErrorCategory.options).toContain("sandbox_unavailable");
    expect(ProviderErrorCategory.safeParse("weird").success).toBe(false);
  });

  it("rejects unknown fields in reasoning-provider output", () => {
    const analysis = {
      summary: "Clear objective",
      objectiveClarity: "clear",
      feasibility: "feasible",
      constraints: [],
      assumptions: [],
      risks: [],
      evidence: [],
      untrustedInstruction: "silently ignored before strict validation",
    };
    expect(BrainObjectiveAnalysis.safeParse(analysis).success).toBe(false);
  });

  it("keeps readiness and campaign-result vocabularies closed and disjoint", () => {
    expect(E2EScenarioStatus.options).toEqual([
      "ready",
      "blocked_operator_configuration",
      "blocked_missing_tool",
      "blocked_missing_credentials",
      "blocked_product_gap",
    ]);
    expect(E2ECampaignResultStatus.options).toEqual([
      "passed",
      "failed",
      "blocked",
      "not_attempted",
    ]);
    for (const campaignResult of E2ECampaignResultStatus.options) {
      expect(E2EScenarioStatus.safeParse(campaignResult).success).toBe(false);
    }
    expect(E2ECampaignResultStatus.safeParse("ready").success).toBe(false);
  });

  function readinessReason(
    category:
      | "blocked_operator_configuration"
      | "blocked_missing_tool"
      | "blocked_missing_credentials"
      | "blocked_product_gap",
  ) {
    return {
      code: "test_blocker",
      category,
      message: "A secret-free blocker description.",
      tools: category === "blocked_missing_tool" ? ["git"] : [],
      environmentVariables:
        category === "blocked_missing_credentials" ? ["GITHUB_TOKEN"] : [],
      remediation: ["Resolve the reported blocker, then run preflight again."],
    };
  }

  function scenario(
    key: E2EScenarioKey,
    status: (typeof E2EScenarioStatus.options)[number] = "ready",
  ) {
    return {
      key,
      title: key,
      status,
      detail: "Secret-free readiness evidence.",
      reasons: status === "ready" ? [] : [readinessReason(status)],
    };
  }

  function validPreflightReport() {
    const scenarios = E2EScenarioKey.options.map((key) => ({
      ...scenario(key),
    }));
    return {
      schemaVersion: E2E_PREFLIGHT_SCHEMA_VERSION,
      generatedAt: "2026-07-19T12:00:00.000Z",
      readiness: "ready" as const,
      usesFakeFixtureOnly: false,
      realProviderCount: 4,
      realWorkspaceEditorCount: 3,
      providers: [
        {
          name: "codex",
          real: true,
          workspaceEdits: true,
          inGlobalChain: true,
          routedRoles: ["backend", "frontend", "orchestrator"],
        },
        {
          name: "claude-code",
          real: true,
          workspaceEdits: true,
          inGlobalChain: true,
          routedRoles: ["backend", "frontend", "orchestrator"],
        },
        {
          name: "cursor",
          real: true,
          workspaceEdits: true,
          inGlobalChain: true,
          routedRoles: ["backend", "frontend", "orchestrator"],
        },
        {
          name: "anthropic",
          real: true,
          workspaceEdits: false,
          inGlobalChain: true,
          routedRoles: ["backend", "frontend", "orchestrator"],
        },
      ],
      effectiveRouting: {
        globalChain: ["codex", "claude-code", "cursor", "anthropic"],
        brainChain: ["anthropic", "codex", "claude-code", "cursor"],
        reviewerChain: ["codex", "claude-code", "cursor", "anthropic"],
        missionRoleChains: [
          {
            role: "backend",
            providers: ["codex", "claude-code", "cursor", "anthropic"],
          },
          {
            role: "frontend",
            providers: ["cursor", "codex", "claude-code", "anthropic"],
          },
          {
            role: "orchestrator",
            providers: ["anthropic", "codex", "claude-code", "cursor"],
          },
        ],
      },
      github: {
        gitAvailable: true,
        ghAvailable: true,
        credentialHintAvailable: true,
        ghAuthenticated: true,
        repositoryReadable: true,
        repositoryPushDryRunSucceeded: true,
        repositoryWriteRoleObserved: true,
      },
      scenarios,
      readyCount: 10,
      blockedCount: 0,
      note: "Preflight reports scenario runnability only.",
    };
  }

  it("parses a strict, versioned E2E preflight report", () => {
    const report = validPreflightReport();
    expect(E2EPreflightReport.safeParse(report).success).toBe(true);
    const { schemaVersion: _schemaVersion, ...unversioned } = report;
    expect(E2EPreflightReport.safeParse(unversioned).success).toBe(false);
    expect(E2EPreflightReport.safeParse({ ...report, leak: "sk-secret" }).success).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...report,
        providers: [{ name: "fake", real: false, workspaceEdits: true, inChain: true }],
      }).success,
    ).toBe(false);
    expect(
      E2EGitHubReadiness.safeParse({
        gitAvailable: true,
        ghAvailable: true,
        credentialHintAvailable: true,
        ghAuthenticated: true,
        repositoryReadable: true,
        repositoryPushVerified: true,
        pullRequestCreationVerified: true,
      }).success,
    ).toBe(false);
  });

  it("rejects incoherent provider counts and duplicate providers", () => {
    const base = validPreflightReport();
    expect(E2EPreflightReport.safeParse(base).success).toBe(true);
    expect(
      E2EPreflightReport.safeParse({ ...base, realProviderCount: 3 }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({ ...base, realWorkspaceEditorCount: 4 })
        .success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        providers: [...base.providers, base.providers[0]],
        realProviderCount: 5,
        realWorkspaceEditorCount: 4,
      }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        providers: [
          ...base.providers,
          {
            name: "fake",
            real: true,
            workspaceEdits: true,
            inGlobalChain: false,
            routedRoles: [],
          },
        ],
        realProviderCount: 5,
        realWorkspaceEditorCount: 4,
      }).success,
    ).toBe(false);
  });

  it("rejects incoherent scenario sets, counters, diagnostics, and global readiness", () => {
    const base = validPreflightReport();
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        scenarios: base.scenarios.slice(0, 9),
        readyCount: 9,
      }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        scenarios: [...base.scenarios.slice(0, 9), base.scenarios[0]],
      }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({ ...base, readyCount: 9 }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({ ...base, blockedCount: 1 }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        readiness: "blocked_missing_tool",
      }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        scenarios: [
          {
            ...base.scenarios[0],
            status: "blocked_missing_tool",
            reasons: [],
          },
          ...base.scenarios.slice(1),
        ],
        readiness: "blocked_missing_tool",
        readyCount: 9,
        blockedCount: 1,
      }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        scenarios: [
          {
            ...base.scenarios[0],
            status: "blocked_missing_tool",
            reasons: [readinessReason("blocked_missing_credentials")],
          },
          ...base.scenarios.slice(1),
        ],
        readiness: "blocked_missing_tool",
        readyCount: 9,
        blockedCount: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects routing evidence that is duplicated, unregistered, or inconsistent with providers", () => {
    const base = validPreflightReport();
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        effectiveRouting: {
          ...base.effectiveRouting,
          globalChain: [...base.effectiveRouting.globalChain, "codex"],
        },
      }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        effectiveRouting: {
          ...base.effectiveRouting,
          brainChain: ["unregistered-provider"],
        },
      }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        providers: base.providers.map((provider) =>
          provider.name === "codex"
            ? { ...provider, inGlobalChain: false }
            : provider,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects ready claims backed by text-only editors or impossible provider separation", () => {
    const base = validPreflightReport();
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        providers: base.providers.map((provider) =>
          provider.name === "codex"
            ? { ...provider, workspaceEdits: false }
            : provider,
        ),
      }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        effectiveRouting: {
          ...base.effectiveRouting,
          reviewerChain: ["codex"],
        },
      }).success,
    ).toBe(false);
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        effectiveRouting: {
          ...base.effectiveRouting,
          missionRoleChains: base.effectiveRouting.missionRoleChains.map(
            (route) => ({ ...route, providers: ["codex"] }),
          ),
        },
      }).success,
    ).toBe(false);
  });

  it("accepts reasoning fallback with two registered text-only providers in the brain chain", () => {
    const base = validPreflightReport();
    const providers = base.providers.map((provider) => ({
      ...provider,
      workspaceEdits: false,
    }));
    const blockedKeys = new Set<E2EScenarioKey>([
      "codex_mission",
      "claude_code_mission",
      "cursor_mission",
      "bounded_correction_after_rejection",
    ]);
    const scenarios = base.scenarios.map((item) =>
      blockedKeys.has(item.key)
        ? scenario(item.key, "blocked_product_gap")
        : item,
    );
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        providers,
        realWorkspaceEditorCount: 0,
        scenarios,
        readiness: "blocked_product_gap",
        readyCount: 6,
        blockedCount: 4,
      }).success,
    ).toBe(true);
  });

  it("rejects mission fallback with one editor and one text-only provider", () => {
    const base = validPreflightReport();
    const providers = base.providers.map((provider) => {
      if (provider.name === "codex") {
        return {
          ...provider,
          inGlobalChain: false,
          routedRoles: ["backend", "frontend", "orchestrator"],
        };
      }
      if (provider.name === "anthropic") {
        return {
          ...provider,
          workspaceEdits: false,
          inGlobalChain: true,
          routedRoles: ["backend", "frontend", "orchestrator"],
        };
      }
      return {
        ...provider,
        workspaceEdits: false,
        inGlobalChain: false,
        routedRoles: [],
      };
    });
    const scenarios = base.scenarios.map((item) =>
      item.key === "claude_code_mission" || item.key === "cursor_mission"
        ? scenario(item.key, "blocked_product_gap")
        : item.key === "reviewer_distinct_from_author"
          ? scenario(item.key, "blocked_operator_configuration")
          : item,
    );
    expect(
      E2EPreflightReport.safeParse({
        ...base,
        providers,
        realWorkspaceEditorCount: 1,
        effectiveRouting: {
          globalChain: ["anthropic"],
          brainChain: ["anthropic"],
          reviewerChain: ["anthropic"],
          missionRoleChains: base.effectiveRouting.missionRoleChains.map(
            (route) => ({
              ...route,
              providers: ["codex", "anthropic"],
            }),
          ),
        },
        scenarios,
        readiness: "blocked_product_gap",
        readyCount: 7,
        blockedCount: 3,
      }).success,
    ).toBe(false);
  });

  it("accepts each of the five readiness states as a coherent aggregate", () => {
    const base = validPreflightReport();
    for (const status of E2EScenarioStatus.options) {
      const scenarios =
        status === "ready"
          ? base.scenarios
          : [
              scenario("real_planning", status),
              ...base.scenarios.slice(1),
            ];
      expect(
        E2EPreflightReport.safeParse({
          ...base,
          scenarios,
          readiness: status,
          readyCount: status === "ready" ? 10 : 9,
          blockedCount: status === "ready" ? 0 : 1,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects common credential formats without rejecting environment names", () => {
    const base = validPreflightReport();
    const secretPatterns = [
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "github_pat_abcdefghijklmnopqrstuvwxyz_1234567890",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "AKIAIOSFODNN7EXAMPLE",
      "api_key=not-a-real-credential-value-for-tests",
      "glpat-abcdefghijklmnopqrst",
    ];
    for (const leaked of secretPatterns) {
      expect(
        E2EPreflightReport.safeParse({
          ...base,
          scenarios: [
            { ...base.scenarios[0], detail: leaked },
            ...base.scenarios.slice(1),
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      E2EReadinessReason.safeParse({
        ...readinessReason("blocked_missing_credentials"),
        message: "Configure GITHUB_TOKEN or GH_TOKEN through a protected file.",
      }).success,
    ).toBe(true);
  });

  it("parses versioned campaign results and rejects readiness as an outcome", () => {
    const results = E2EScenarioKey.options.map((key) => ({
      key,
      status: "passed" as const,
      detail: "Observed through the public API.",
      evidence: [
        {
          source: "public_api",
          provider: null,
          reference: "run:run-1",
        },
      ],
    }));
    const report = {
      schemaVersion: E2E_CAMPAIGN_REPORT_SCHEMA_VERSION,
      generatedAt: "2026-07-19T12:00:00.000Z",
      campaignId: "campaign-1",
      projectId: "project-1",
      result: "passed" as const,
      results,
      passedCount: 10,
      failedCount: 0,
      blockedCount: 0,
      notAttemptedCount: 0,
      note: "Campaign outcomes require observed evidence.",
    };
    expect(E2ECampaignReport.safeParse(report).success).toBe(true);
    const { schemaVersion: _schemaVersion, ...unversioned } = report;
    expect(E2ECampaignReport.safeParse(unversioned).success).toBe(false);
    expect(
      E2ECampaignReport.safeParse({
        ...report,
        result: "ready",
      }).success,
    ).toBe(false);
    expect(
      E2ECampaignReport.safeParse({
        ...report,
        results: [
          { ...results[0], status: "ready" },
          ...results.slice(1),
        ],
      }).success,
    ).toBe(false);
    for (const fakeProvider of ["fake", "fake_fixture"]) {
      expect(
        E2ECampaignReport.safeParse({
          ...report,
          results: [
            {
              ...results[0],
              evidence: [
                {
                  source: "provider_run",
                  provider: fakeProvider,
                  reference: "run:fixture",
                },
              ],
            },
            ...results.slice(1),
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      E2ECampaignReport.safeParse({
        ...report,
        results: [
          {
            ...results[0],
            evidence: [
              {
                source: "fake_fixture",
                provider: null,
                reference: "run:fixture",
              },
            ],
          },
          ...results.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects campaign reports with incoherent keys, counters, or aggregate result", () => {
    const results = E2EScenarioKey.options.map((key) => ({
      key,
      status: "not_attempted" as const,
      detail: "Campaign was not started.",
      evidence: [] as string[],
    }));
    const report = {
      schemaVersion: E2E_CAMPAIGN_REPORT_SCHEMA_VERSION,
      generatedAt: "2026-07-19T12:00:00.000Z",
      campaignId: "campaign-1",
      projectId: "project-1",
      result: "not_attempted" as const,
      results,
      passedCount: 0,
      failedCount: 0,
      blockedCount: 0,
      notAttemptedCount: 10,
      note: "Campaign was not attempted.",
    };
    expect(E2ECampaignReport.safeParse(report).success).toBe(true);
    expect(
      E2ECampaignReport.safeParse({
        ...report,
        results: report.results.slice(0, 9),
        notAttemptedCount: 9,
      }).success,
    ).toBe(false);
    expect(
      E2ECampaignReport.safeParse({
        ...report,
        results: [...report.results.slice(0, 9), report.results[0]],
      }).success,
    ).toBe(false);
    expect(
      E2ECampaignReport.safeParse({ ...report, passedCount: 1 }).success,
    ).toBe(false);
    expect(
      E2ECampaignReport.safeParse({ ...report, result: "blocked" }).success,
    ).toBe(false);
  });
});
