import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E2ECampaignReport,
  E2EScenarioKey,
  type E2EPreflightReport,
} from "@avityos/contracts";
import { describe, expect, it, vi } from "vitest";
import type { DoctorReport } from "./diagnostics.js";
import {
  prepareLiveCampaign,
  runLiveCampaign,
  type PublicCampaignApi,
} from "./campaign.js";
import {
  createCampaignReportWriter,
  createCampaignStateStore,
} from "./campaign-report.js";
import { main } from "../main.js";
import { Client } from "../client.js";
import { redactValue } from "./redact.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");

function readyDoctor(): DoctorReport {
  return {
    version: 1,
    readiness: "ready",
    checks: [{ id: "control_plane", ok: true, detail: "reachable" }],
  };
}

function preflight(
  blockedKey?: (typeof E2EScenarioKey.options)[number],
): E2EPreflightReport {
  const scenarios = E2EScenarioKey.options.map((key) => {
    const blocked = key === blockedKey;
    return {
      key,
      title: key,
      status: blocked ? "blocked_missing_credentials" as const : "ready" as const,
      detail: blocked ? "credential channel is absent" : "runnable",
      reasons: blocked
        ? [{
            code: "auth_missing",
            category: "blocked_missing_credentials" as const,
            message: "credential channel is absent",
            tools: [],
            environmentVariables: ["AVITY_PROVIDER_AUTH"],
            remediation: ["Configure the protected provider credential channel."],
          }]
        : [],
    };
  });
  const blockedCount = blockedKey ? 1 : 0;
  return {
    schemaVersion: 2,
    generatedAt: NOW.toISOString(),
    readiness: blockedKey ? "blocked_missing_credentials" : "ready",
    usesFakeFixtureOnly: false,
    realProviderCount: 3,
    realWorkspaceEditorCount: 3,
    providers: [
      { name: "codex", real: true, workspaceEdits: true, inGlobalChain: true, routedRoles: ["backend", "reviewer", "frontend"] },
      { name: "claude-code", real: true, workspaceEdits: true, inGlobalChain: true, routedRoles: ["backend", "reviewer"] },
      { name: "cursor", real: true, workspaceEdits: true, inGlobalChain: true, routedRoles: ["frontend"] },
    ],
    effectiveRouting: {
      globalChain: ["codex", "claude-code", "cursor"],
      brainChain: ["codex", "claude-code"],
      reviewerChain: ["codex", "claude-code"],
      missionRoleChains: [
        { role: "backend", providers: ["codex", "claude-code"] },
        { role: "reviewer", providers: ["claude-code", "codex"] },
        { role: "frontend", providers: ["cursor", "codex"] },
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
    readyCount: scenarios.length - blockedCount,
    blockedCount,
    note: "Readiness is not execution proof.",
  };
}

function providerStatus(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    executionMode: "campaign",
    campaign: {
      faultInjection: { enabled: false, provider: null, category: null },
    },
    providers: [],
    checks: [],
    note: "Configuration snapshot only.",
  };
}

function apiFor(options: {
  readonly readiness?: E2EPreflightReport;
  readonly pullRequestState?: "draft" | "open" | "merged" | "closed";
} = {}): PublicCampaignApi & {
  readonly calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    async get<T>(path: string): Promise<T> {
      calls.push({ method: "GET", path });
      if (path === "/v1/providers/status") return providerStatus() as T;
      if (path.startsWith("/v1/e2e/preflight")) return (options.readiness ?? preflight()) as T;
      if (path === "/v1/projects/project-1/configuration") {
        return {
          project: { id: "project-1", name: "Live fixture", status: "active" },
          budget: null,
          providerOverrides: [],
        } as T;
      }
      if (path === "/v1/projects/project-1/brain/state") {
        return { status: "planned", runs: [] } as T;
      }
      if (path === "/v1/projects/project-1/missions") return { items: [] } as T;
      if (path === "/v1/runs?projectId=project-1") return { items: [] } as T;
      if (path.startsWith("/v1/events?")) return { items: [] } as T;
      if (path === "/v1/approvals?projectId=project-1") return { items: [] } as T;
      if (path === "/v1/projects/project-1/clarifications?status=open") return { items: [] } as T;
      if (path === "/v1/prs?projectId=project-1") {
        return {
          items: options.pullRequestState
            ? [{
                id: "pr-1",
                projectId: "project-1",
                missionId: null,
                number: 42,
                url: "https://github.com/example/live-fixture/pull/42",
                branch: "avity/live-campaign",
                title: "Live campaign",
                state: options.pullRequestState,
              }]
            : [],
        } as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: "POST", path, body });
      if (path === "/v1/projects/project-1/objectives") {
        return { objective: { id: "objective-1" } } as T;
      }
      throw new Error(`unexpected POST ${path}`);
    },
  };
}

function dependencies(api: PublicCampaignApi) {
  return {
    api,
    collectDoctor: async () => readyDoctor(),
    now: () => NOW,
    sleep: async () => undefined,
    configuration: {
      cliVersion: "0.1.0",
      controlPlaneUrl: "http://127.0.0.1:7717",
      environment: {
        AVITY_API_TOKEN: "ghp_should_never_be_persisted",
        AVITY_EXECUTION_MODE: "campaign",
      },
    },
  };
}

describe("live campaign operator", () => {
  it("advertises the prepare and run CLI surface", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await main(["help"]);

    expect(code).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain(
      "e2e live prepare|run --project <id>",
    );
  });

  it("bounds public Client requests with an abort timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("missing abort signal");
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    }));
    const client = new Client({
      controlPlaneUrl: "http://127.0.0.1:7717",
      requestTimeoutMs: 5,
    });

    await expect(client.get("/v1/providers/status")).rejects.toThrow(/timed out after 5ms/);
    vi.unstubAllGlobals();
  });

  it("prepare performs GET-only calls and records readiness as not attempted", async () => {
    const api = apiFor();

    const result = await prepareLiveCampaign(
      { projectId: "project-1" },
      dependencies(api),
    );

    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
    expect(result.report.readiness.status).toBe("ready");
    expect(result.report.campaign.result).toBe("not_attempted");
    expect(result.report.campaign.results.every((item) => item.status === "not_attempted")).toBe(true);
    expect(E2ECampaignReport.safeParse(result.report.campaign).success).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain("ghp_should_never_be_persisted");
  });

  it("run refuses blocked prerequisites before objective submission", async () => {
    const api = apiFor({ readiness: preflight("codex_mission") });

    const result = await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      dependencies(api),
    );

    expect(result.report.readiness.status).toBe("blocked_missing_credentials");
    expect(result.report.campaign.result).toBe("blocked");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("run requires an exact explicit project confirmation outside a TTY", async () => {
    const api = apiFor();

    await expect(runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-other",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      dependencies(api),
    )).rejects.toThrow(/--confirm-project project-1/);

    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("requests interactive confirmation only after readiness checks", async () => {
    const api = apiFor({ pullRequestState: "merged" });
    const confirmProject = vi.fn(async () => {
      expect(api.calls.some((call) => call.path.startsWith("/v1/e2e/preflight"))).toBe(true);
      expect(api.calls.some((call) => call.method === "POST")).toBe(false);
      return "project-1";
    });

    await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: true,
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      { ...dependencies(api), confirmProject },
    );

    expect(confirmProject).toHaveBeenCalledWith("project-1");
  });

  it("treats a merged pull request as campaign failure and never calls merge", async () => {
    const base = apiFor();
    let submitted = false;
    const api = {
      ...base,
      async get<T>(path: string): Promise<T> {
        if (path === "/v1/prs?projectId=project-1") {
          return {
            items: submitted
              ? [{
                  id: "pr-new-merged",
                  projectId: "project-1",
                  missionId: null,
                  number: 42,
                  url: "https://github.com/example/live-fixture/pull/42",
                  branch: "campaign",
                  title: "New merged PR",
                  state: "merged",
                }]
              : [],
          } as T;
        }
        return base.get<T>(path);
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        submitted = true;
        return base.post<T>(path, body);
      },
    };

    const result = await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      dependencies(api),
    );

    expect(result.report.campaign.result).toBe("failed");
    expect(result.report.campaign.results.find((item) => item.key === "no_autonomous_merge")?.status).toBe("failed");
    expect(api.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/v1/projects/project-1/objectives",
    ]);
  });

  it("ignores a merged pull request from the pre-campaign baseline", async () => {
    const base = apiFor();
    let submitted = false;
    const oldMerged = {
      id: "pr-old",
      projectId: "project-1",
      missionId: null,
      number: 1,
      url: "https://github.com/example/live-fixture/pull/1",
      branch: "old",
      title: "Old merged PR",
      state: "merged",
    };
    const freshDraft = {
      ...oldMerged,
      id: "pr-fresh",
      number: 42,
      url: "https://github.com/example/live-fixture/pull/42",
      branch: "fresh",
      title: "Fresh campaign PR",
      state: "draft",
    };
    const api: PublicCampaignApi = {
      async get<T>(path: string): Promise<T> {
        if (path === "/v1/prs?projectId=project-1") {
          return { items: submitted ? [oldMerged, freshDraft] : [oldMerged] } as T;
        }
        return base.get<T>(path);
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        submitted = true;
        return base.post<T>(path, body);
      },
    };

    const result = await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      dependencies(api),
    );

    expect(result.report.campaign.results.find((item) => item.key === "no_autonomous_merge")?.status).not.toBe("failed");
    expect(result.report.evidence.pullRequests.map((pullRequest) => pullRequest.id)).toEqual(["pr-fresh"]);
  });

  it("continues polling after an early draft PR until new missions are terminal", async () => {
    const base = apiFor({ pullRequestState: "draft" });
    let submitted = false;
    let missionReads = 0;
    const api: PublicCampaignApi = {
      async get<T>(path: string): Promise<T> {
        if (path === "/v1/projects/project-1/missions") {
          if (!submitted) return { items: [] } as T;
          missionReads += 1;
          return {
            items: [{
              id: "mission-new",
              projectId: "project-1",
              role: "backend",
              state: missionReads === 1 ? "running" : "completed",
              correctionAttempts: 0,
            }],
          } as T;
        }
        if (path === "/v1/missions/mission-new") {
          return { checkpoints: [] } as T;
        }
        return base.get<T>(path);
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        submitted = true;
        return base.post<T>(path, body);
      },
    };

    await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 2,
        pollIntervalMs: 1,
      },
      dependencies(api),
    );

    expect(missionReads).toBe(2);
  });

  it("excludes baseline events and advances the public event cursor", async () => {
    const base = apiFor({ pullRequestState: "draft" });
    let submitted = false;
    const eventPaths: string[] = [];
    const oldFallback = {
      schemaVersion: 1,
      seq: 5,
      id: "event-old",
      type: "provider.fallback",
      projectId: "project-1",
      missionId: "mission-old",
      runId: "run-old",
      createdAt: NOW.toISOString(),
      payload: { provider: "codex", action: "switch_provider" },
    };
    const api: PublicCampaignApi = {
      async get<T>(path: string): Promise<T> {
        if (path.startsWith("/v1/events?")) {
          eventPaths.push(path);
          return { items: submitted && path.includes("afterSeq=5") ? [] : [oldFallback] } as T;
        }
        return base.get<T>(path);
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        submitted = true;
        return base.post<T>(path, body);
      },
    };

    const result = await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      dependencies(api),
    );

    expect(eventPaths.some((path) => path.includes("afterSeq=5"))).toBe(true);
    expect(result.report.campaign.results.find((item) => item.key === "cross_provider_fallback")?.status).not.toBe("passed");
  });

  it("resumes a pending campaign without submitting a second objective", async () => {
    const operatorRoot = mkdtempSync(join(tmpdir(), "avity-campaign-resume-"));
    const reportsDir = join(operatorRoot, "reports");
    const stateStore = createCampaignStateStore({ operatorRoot, reportsDir });
    const base = apiFor();
    let posts = 0;
    let crashOnce = true;
    const idempotencyKeys: string[] = [];
    const api: PublicCampaignApi = {
      async get<T>(path: string): Promise<T> {
        if (
          posts > 0 &&
          crashOnce &&
          path === "/v1/projects/project-1/configuration"
        ) {
          crashOnce = false;
          throw new Error("simulated process interruption");
        }
        return base.get<T>(path);
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        posts += 1;
        idempotencyKeys.push(String((body as { idempotencyKey?: unknown }).idempotencyKey));
        return base.post<T>(path, body);
      },
    };
    const deps = { ...dependencies(api), stateStore };

    await expect(runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      deps,
    )).rejects.toThrow(/simulated process interruption/);

    await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      deps,
    );

    const stateFiles = readdirSync(reportsDir).filter((name) => name.endsWith(".state.json"));
    expect(posts).toBe(1);
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(stateFiles).toHaveLength(1);
    expect(statSync(join(reportsDir, stateFiles[0]!)).mode & 0o777).toBe(0o600);
  });

  it("writes redacted reports with deterministic retention outside the repository", async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), "avity-campaign-reports-"));
    const writer = createCampaignReportWriter({ reportsDir, retentionCount: 2 });
    const api = apiFor();
    const base = await prepareLiveCampaign({ projectId: "project-1" }, dependencies(api));

    await writer.write({ ...base.report, campaignId: "campaign-001" });
    await writer.write({ ...base.report, campaignId: "campaign-002" });
    const latestPath = await writer.write({ ...base.report, campaignId: "campaign-003" });

    expect(readdirSync(reportsDir).sort()).toEqual([
      "2026-07-23T12-00-00.000Z-campaign-002-prepare.json",
      "2026-07-23T12-00-00.000Z-campaign-003-prepare.json",
    ]);
    expect(readFileSync(latestPath, "utf8")).not.toContain("ghp_should_never_be_persisted");
    expect(statSync(reportsDir).mode & 0o777).toBe(0o700);
    expect(statSync(latestPath).mode & 0o777).toBe(0o600);
  });

  it("recursively sanitizes secret-bearing URLs while preserving host and path", () => {
    const redacted = redactValue({
      remote: "https://user:token@github.com/org/repo?token=secret-value&ref=main#auth=hidden",
      nested: {
        controlPlaneUrl: "https://admin:key@control.example.test/v1?project=one&api_key=hidden#session",
      },
    });

    expect(redacted).toEqual({
      remote: "https://github.com/org/repo?ref=main",
      nested: {
        controlPlaneUrl: "https://control.example.test/v1?project=one",
      },
    });
  });

  it("refuses a campaign report directory inside the repository", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "avity-campaign-repository-"));

    expect(() => createCampaignReportWriter({
      reportsDir: join(repositoryRoot, ".reports"),
      repositoryRoot,
      retentionCount: 2,
    })).toThrow(/outside the repository/);
  });

  it("refuses symlinked campaign report directories", async () => {
    const parent = mkdtempSync(join(tmpdir(), "avity-campaign-symlink-"));
    const target = mkdtempSync(join(tmpdir(), "avity-campaign-target-"));
    const reportsDir = join(parent, "reports");
    symlinkSync(target, reportsDir);
    const writer = createCampaignReportWriter({ reportsDir, retentionCount: 2 });
    const report = await prepareLiveCampaign(
      { projectId: "project-1" },
      dependencies(apiFor()),
    );

    await expect(writer.write(report.report)).rejects.toThrow(/symlink/i);
  });

  it("does not turn fake-fixture evidence into a passed live scenario", async () => {
    const api = apiFor({ pullRequestState: "draft" });
    const get = api.get.bind(api);
    vi.spyOn(api, "get").mockImplementation(async <T>(path: string): Promise<T> => {
      if (path === "/v1/runs?projectId=project-1") {
        return {
          items: [{
            id: "run-fake",
            providerId: "fake",
            missionId: "mission-fake",
            state: "succeeded",
          }],
        } as T;
      }
      return get<T>(path);
    });

    const result = await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      dependencies(api),
    );

    expect(result.report.campaign.results.some((item) =>
      item.status === "passed" && item.evidence.some((evidence) => evidence.provider === "fake"),
    )).toBe(false);
  });

  it("does not pass a provider scenario with a failed mission checkpoint", async () => {
    const base = apiFor();
    let submitted = false;
    const api: PublicCampaignApi = {
      async get<T>(path: string): Promise<T> {
      if (path === "/v1/projects/project-1/missions") {
        if (!submitted) return { items: [] } as T;
        return {
          items: [{
            id: "mission-codex",
            projectId: "project-1",
            role: "backend",
            state: "completed",
            correctionAttempts: 0,
          }],
        } as T;
      }
      if (path === "/v1/missions/mission-codex") {
        return {
          checkpoints: [{
            id: "checkpoint-failed",
            projectId: "project-1",
            missionId: "mission-codex",
            kind: "tests",
            status: "failed",
            detail: "tests failed",
            evidenceRef: null,
          }],
        } as T;
      }
      if (path === "/v1/runs?projectId=project-1") {
        if (!submitted) return { items: [] } as T;
        return {
          items: [{
            id: "run-codex",
            providerId: "codex",
            missionId: "mission-codex",
            state: "succeeded",
          }],
        } as T;
      }
      if (path === "/v1/prs?projectId=project-1") {
        return {
          items: submitted
            ? [{
                id: "pr-checkpoint",
                projectId: "project-1",
                missionId: "mission-codex",
                number: 42,
                url: "https://github.com/example/live-fixture/pull/42",
                branch: "checkpoint",
                title: "Checkpoint campaign",
                state: "draft",
              }]
            : [],
        } as T;
      }
      return base.get<T>(path);
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        submitted = true;
        return base.post<T>(path, body);
      },
    };

    const result = await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      dependencies(api),
    );

    expect(result.report.campaign.results.find((item) => item.key === "codex_mission")?.status).toBe("failed");
  });

  it("does not treat a local pull-request record as GitHub publication evidence", async () => {
    const base = apiFor();
    let submitted = false;
    const api: PublicCampaignApi = {
      async get<T>(path: string): Promise<T> {
      if (path === "/v1/prs?projectId=project-1") {
        return {
          items: submitted ? [{
            id: "pr-local",
            projectId: "project-1",
            missionId: null,
            number: null,
            url: null,
            branch: "avity/local-only",
            title: "Local campaign record",
            state: "draft",
          }] : [],
        } as T;
      }
      return base.get<T>(path);
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        submitted = true;
        return base.post<T>(path, body);
      },
    };

    const result = await runLiveCampaign(
      {
        projectId: "project-1",
        isTTY: false,
        confirmedProjectId: "project-1",
        maxPolls: 1,
        pollIntervalMs: 1,
      },
      dependencies(api),
    );

    expect(result.report.campaign.results.find((item) => item.key === "branch_push")?.status).toBe("failed");
    expect(result.report.campaign.results.find((item) => item.key === "draft_pull_request")?.status).toBe("failed");
  });
});
