import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { E2EPreflightReport } from "@avityos/contracts";
import { commitAll, git, initRepo } from "@avityos/git";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import { openDatabase } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine } from "./engine.js";
import { clearGitHubReadinessCache, getCachedGitHubReadiness } from "./github-readiness.js";
import { buildProviderStatus } from "./provider-status.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";

const TOKEN = "test-secret-token";

let app: FastifyInstance;
let store: Store;
let engine: Engine;
let baseUrl: string;
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "avity-sec-"));
  const db = openDatabase(":memory:");
  store = new Store(db);
  const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
  engine = new Engine(store, providers, { ...DEFAULT_ENGINE_CONFIG, tickMs: 50 });
  app = await buildServer({
    store,
    engine,
    version: "test",
    apiToken: TOKEN,
    allowedOrigins: ["http://allowed.example"],
    providerStatus: buildProviderStatus({
      env: {},
      executionMode: "test",
      providers,
      defaultModels: new Map([["fake", "fake:succeed"]]),
      reviewModels: new Map([["fake", "fake:review-approve"]]),
      routing: engine.getProviderRoutingSnapshot(),
      campaignFault: null,
    }),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await engine.stop();
  await app.close();
  await rm(scratch, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function makeRepoProject(): Promise<{ projectId: string; repo: string }> {
  const repo = join(scratch, "repo");
  await git(scratch, "init", "-b", "main", repo);
  await initRepo(repo);
  await writeFile(join(repo, "README.md"), "# sec\n");
  await commitAll(repo, "chore: init");
  const project = store.createProject({
    name: "sec",
    description: "",
    repoPath: repo,
    repoRemoteUrl: null,
    autonomyProfile: "autonomous_with_checkpoints",
  });
  return { projectId: project.id, repo };
}

describe("API authentication", () => {
  it("rejects requests without the bearer token", async () => {
    expect((await fetch(`${baseUrl}/v1/projects`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/projects`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/projects`, { headers: auth })).status).toBe(200);
  });

  it("health stays reachable and SSE uses an HttpOnly session instead of a URL token", async () => {
    expect((await fetch(`${baseUrl}/v1/health`)).status).toBe(200);
    const login = await fetch(`${baseUrl}/v1/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/v1/events/stream?afterSeq=0`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();
    await res.body?.cancel().catch(() => undefined);
    const denied = await fetch(`${baseUrl}/v1/events/stream?afterSeq=0&token=${TOKEN}`);
    expect(denied.status).toBe(401);
  });

  it("protects provider status with the same bearer token", async () => {
    expect((await fetch(`${baseUrl}/v1/providers/status`)).status).toBe(401);
    const ok = await fetch(`${baseUrl}/v1/providers/status`, { headers: auth });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { note: string };
    expect(body.note).toMatch(/never runs provider health checks/i);
  });
});

describe("CORS origin allowlist", () => {
  it("grants only allowlisted origins", async () => {
    const allowed = await fetch(`${baseUrl}/v1/health`, { headers: { origin: "http://allowed.example" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://allowed.example");

    const malicious = await fetch(`${baseUrl}/v1/health`, { headers: { origin: "http://evil.example" } });
    expect(malicious.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("terminal execution boundary", () => {
  it("ignores client-supplied cwd and binds to the project repository", async () => {
    const { projectId, repo } = await makeRepoProject();
    const res = await fetch(`${baseUrl}/v1/projects/${projectId}/terminals`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ command: ["pwd"], cwd: "/tmp" }), // cwd must be ignored
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const terminal = store.getTerminal(id)!;
    expect(terminal.cwd).not.toBe("/tmp");
    expect(terminal.cwd.endsWith("/repo") || terminal.cwd.includes(repo)).toBe(true);
  });

  it("refuses terminals for projects without a repository", async () => {
    const project = store.createProject({
      name: "norepo", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const res = await fetch(`${baseUrl}/v1/projects/${project.id}/terminals`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ command: ["pwd"] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects mission worktrees that symlink outside the repository", async () => {
    const { projectId } = await makeRepoProject();
    const outside = join(scratch, "outside");
    mkdirSync(outside, { recursive: true });
    const link = join(scratch, "repo", ".avity", "escape");
    mkdirSync(join(scratch, "repo", ".avity"), { recursive: true });
    await symlink(outside, link);

    const mission = store.createMission({
      projectId, planId: null, milestoneId: null, title: "escape", role: "backend",
      contract: {
        objective: "x", rationale: "", context: [], allowedPaths: [], forbiddenPaths: [],
        acceptanceCriteria: [], requiredChecks: [], checkCommands: {}, budgetUsd: null,
        timeoutSeconds: null, expectedArtifacts: [],
      },
      priority: 50, dependsOn: [],
    });
    store.updateMissionMeta(mission.id, { worktreePath: link });

    const res = await fetch(`${baseUrl}/v1/projects/${projectId}/terminals`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ command: ["pwd"], missionId: mission.id }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("escapes");
  });

  it("treats interpreters as arbitrary-code capability: denied on project terminals", async () => {
    const { projectId } = await makeRepoProject();
    for (const command of [["node", "-e", "1"], ["npm", "run", "x"], ["pnpm", "dlx", "x"], ["bash", "-c", "id"]]) {
      const res = await fetch(`${baseUrl}/v1/projects/${projectId}/terminals`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ command }),
      });
      expect(res.status).toBe(403);
    }
    // observation commands remain fine
    const ok = await fetch(`${baseUrl}/v1/projects/${projectId}/terminals`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ command: ["ls"] }),
    });
    expect(ok.status).toBe(201);
  });
});

describe("E2E preflight endpoint", () => {
  beforeEach(async () => {
    // Avoid host `gh`/`git` latency in the HTTP path: seed the TTL cache with a
    // deterministic stub runner so the handler stays non-blocking and offline.
    clearGitHubReadinessCache();
    await getCachedGitHubReadiness(undefined, () => Date.now(), async () => ({
      success: false,
      stdout: "",
    }));
  });

  afterEach(() => {
    clearGitHubReadinessCache();
  });

  it("requires the same bearer auth as other administrative endpoints", async () => {
    expect((await fetch(`${baseUrl}/v1/e2e/preflight`)).status).toBe(401);
  });

  it("returns a contract-valid readiness report without secrets", async () => {
    const res = await fetch(`${baseUrl}/v1/e2e/preflight`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(E2EPreflightReport.safeParse(body).success).toBe(true);
    const serialized = JSON.stringify(body);
    expect(JSON.stringify(body)).not.toMatch(
      /repositoryPushVerified|pullRequestCreationVerified|stdout|stderr|remoteUrl|repoRemoteUrl|ghp_|github_pat_|sk-|https:\/\/[^ ]+:[^ ]+@/i,
    );
  });

  it("returns 404 for an unknown projectId", async () => {
    const res = await fetch(`${baseUrl}/v1/e2e/preflight?projectId=missing`, { headers: auth });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("passes the configured project remote into GitHub readiness detection", async () => {
    clearGitHubReadinessCache();
    const repo = join(scratch, "remote-repo");
    await git(scratch, "init", "-b", "main", repo);
    await initRepo(repo);
    await writeFile(join(repo, "README.md"), "# remote\n");
    await commitAll(repo, "chore: init");
    const remoteUrl = "git@github.com:acme/preflight-target.git";
    const project = store.createProject({
      name: "with-remote",
      description: "",
      repoPath: repo,
      repoRemoteUrl: remoteUrl,
      autonomyProfile: "autonomous_with_checkpoints",
    });

    await getCachedGitHubReadiness(
      { repoPath: repo, remoteUrl },
      () => Date.now(),
      async (command, args) => {
        if (command === "git" && args[0] === "--version") {
          return { success: true, stdout: "git version" };
        }
        if (command === "gh" && args[0] === "--version") {
          return { success: true, stdout: "gh version" };
        }
        if (command === "gh" && args[0] === "auth") {
          return { success: true, stdout: "" };
        }
        if (command === "git" && args.includes("push")) {
          // Automated push must carry the hook-neutralising hardening flags.
          expect(args).toContain("core.hooksPath=/dev/null");
          expect(args).toContain(remoteUrl);
          expect(args).not.toContain("origin");
          return { success: true, stdout: "" };
        }
        if (
          command === "gh" &&
          args.slice(0, 3).join(" ") === "repo view acme/preflight-target"
        ) {
          if (args.includes("viewerPermission")) {
            return { success: true, stdout: "WRITE\n" };
          }
          return { success: true, stdout: "acme/preflight-target" };
        }
        return { success: false, stdout: "" };
      },
    );

    const res = await fetch(`${baseUrl}/v1/e2e/preflight?projectId=${encodeURIComponent(project.id)}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      github: {
        repositoryPushDryRunSucceeded: boolean;
        repositoryWriteRoleObserved: boolean;
      };
      scenarios: { key: string; status: string }[];
    };
    expect(body.github.repositoryPushDryRunSucceeded).toBe(true);
    expect(body.github.repositoryWriteRoleObserved).toBe(true);
    expect(body.scenarios.find((s) => s.key === "branch_push")?.status).toBe("ready");
    expect(body.scenarios.find((s) => s.key === "draft_pull_request")?.status).toBe("ready");
    expect(JSON.stringify(body)).not.toMatch(/acme\/preflight-target\.git|repoRemoteUrl|remoteUrl/i);
  });

  it("blocks push readiness when the project has a path but no configured remote", async () => {
    clearGitHubReadinessCache();
    await getCachedGitHubReadiness(undefined, () => Date.now(), async (command, args) => {
      if (command === "git" && args[0] === "--version") {
        return { success: true, stdout: "git version" };
      }
      if (command === "gh" && args[0] === "--version") {
        return { success: true, stdout: "gh version" };
      }
      if (command === "gh" && args[0] === "auth") {
        return { success: true, stdout: "" };
      }
      return { success: false, stdout: "" };
    });
    const { projectId } = await makeRepoProject();

    const res = await fetch(`${baseUrl}/v1/e2e/preflight?projectId=${encodeURIComponent(projectId)}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      github: { repositoryPushDryRunSucceeded: boolean; repositoryWriteRoleObserved: boolean };
      scenarios: { key: string; status: string }[];
    };
    expect(body.github.repositoryPushDryRunSucceeded).toBe(false);
    expect(body.scenarios.find((s) => s.key === "branch_push")?.status).toBe(
      "blocked_operator_configuration",
    );
    expect(body.scenarios.find((s) => s.key === "draft_pull_request")?.status).not.toBe("ready");
  });
});
