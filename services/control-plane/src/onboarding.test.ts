import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ProjectConfiguration } from "@avityos/contracts";
import { commitAll, git, initRepo } from "@avityos/git";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import { openDatabase, type DB } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine } from "./engine.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";

let scratch: string;
let db: DB;
let store: Store;
let engine: Engine;
let app: FastifyInstance;

async function makeRepo(name = "repo", remote = "git@github.com:example/onboarding.git"): Promise<string> {
  const repo = join(scratch, name);
  await git(scratch, "init", "-b", "main", repo);
  await initRepo(repo);
  await writeFile(join(repo, "README.md"), `# ${name}\n`);
  await commitAll(repo, "chore: initial commit");
  await git(repo, "remote", "add", "origin", remote);
  return repo;
}

async function createProject(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/projects", payload });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "avity-onboarding-"));
  db = openDatabase(":memory:");
  store = new Store(db);
  const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
  engine = new Engine(store, providers, { ...DEFAULT_ENGINE_CONFIG, tickMs: 25 });
  app = await buildServer({ store, engine, version: "test" });
});

afterEach(async () => {
  await engine.stop();
  await app.close();
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("project onboarding API", () => {
  it("creates a project from a validated Git repository and persists its GitHub remote", async () => {
    const repo = await makeRepo();
    const response = await createProject({
      name: "Imported",
      repoPath: join(repo, "."),
      repoRemoteUrl: "https://github.com/example/onboarding.git",
      defaultBranch: "main",
      objective: "Deliver repository-aware onboarding with objective evidence",
      acceptanceCriteria: ["repository is validated", "remote is persisted"],
      autonomyProfile: "maximum_autonomy",
      budgetUsd: 80,
      budgetWarnAtFraction: 0.7,
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as { id: string };
    const configuration = store.getProjectConfiguration(created.id)!;
    expect(configuration.project.repoPath).toBe(realpathSync(repo));
    expect(configuration.project.repoRemoteUrl).toBe("git@github.com:example/onboarding.git");
    expect(configuration.project.defaultBranch).toBe("main");
    expect(configuration.objective?.acceptanceCriteria).toEqual(["repository is validated", "remote is persisted"]);
    expect(configuration.budget).toMatchObject({ limitUsd: 80, warnAtFraction: 0.7 });
  });

  it("creates a project without a repository", async () => {
    const response = await createProject({
      name: "Greenfield",
      objective: "Define a greenfield product before a repository exists",
      acceptanceCriteria: ["project configuration is durable"],
    });
    expect(response.statusCode).toBe(201);
    const configuration = store.getProjectConfiguration((response.json() as { id: string }).id)!;
    expect(configuration.project.repoPath).toBeNull();
    expect(configuration.project.repoRemoteUrl).toBeNull();
    expect(configuration.objective?.text).toContain("greenfield");
  });

  it("rejects missing, non-Git and inaccessible repository paths clearly", async () => {
    const missing = await createProject({ name: "Missing", repoPath: join(scratch, "missing") });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain("does not exist or is not accessible");

    const plain = join(scratch, "plain");
    await writeFile(plain, "not a directory");
    const nonGit = await createProject({ name: "NonGit", repoPath: scratch, defaultBranch: "main" });
    expect(nonGit.statusCode).toBe(400);
    expect(nonGit.json().error.message).toContain("not an accessible Git working tree");
  });

  it("validates the local default branch and configured remote", async () => {
    const repo = await makeRepo();
    const branch = await createProject({ name: "BadBranch", repoPath: repo, defaultBranch: "missing" });
    expect(branch.statusCode).toBe(400);
    expect(branch.json().error.message).toContain("does not exist locally");

    const remote = await createProject({
      name: "BadRemote",
      repoPath: repo,
      repoRemoteUrl: "https://github.com/example/another.git",
      defaultBranch: "main",
    });
    expect(remote.statusCode).toBe(400);
    expect(remote.json().error.message).toContain("is not configured");
  });

  it("updates idempotently without duplicate objective revisions", async () => {
    const repo = await makeRepo();
    const created = await createProject({
      name: "Before",
      repoPath: repo,
      repoRemoteUrl: "git@github.com:example/onboarding.git",
      objective: "Initial objective with enough detail for durable project planning",
      acceptanceCriteria: ["initial"],
    });
    const id = (created.json() as { id: string }).id;
    const update = {
      name: "After",
      objective: "Updated objective with enough detail for durable project planning",
      acceptanceCriteria: ["updated one", "updated two"],
      budgetUsd: 150,
      budgetWarnAtFraction: 0.65,
    };
    const first = await app.inject({ method: "PATCH", url: `/v1/projects/${id}`, payload: update });
    const second = await app.inject({ method: "PATCH", url: `/v1/projects/${id}`, payload: update });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((second.json() as ProjectConfiguration).objective?.revision).toBe(2);
    const revisions = store.db.prepare("SELECT COUNT(*) AS count FROM objectives WHERE project_id = ?").get(id) as { count: number };
    expect(revisions.count).toBe(2);
    expect(store.eventsAfter(0, id).filter((event) => event.type === "project.updated")).toHaveLength(1);
  });

  it("applies the persisted budget to mission execution", async () => {
    const created = await createProject({
      name: "Budgeted",
      objective: "Deliver a budget-constrained onboarding result with evidence",
      acceptanceCriteria: ["budget gate is enforced"],
      budgetUsd: 0,
      budgetWarnAtFraction: 0.8,
    });
    const id = (created.json() as { id: string }).id;
    const mission = store.listMissions(id)[0]!;
    expect(mission.contract.budgetUsd).toBe(0);
    store.transitionMission(mission.id, "ready", "test");
    store.transitionMission(mission.id, "assigned", "test");
    await engine.executeMission(mission.id);
    expect(store.getMission(mission.id)?.state).toBe("blocked");
    expect(store.eventsAfter(0, id).some((event) => event.type === "budget.threshold")).toBe(true);
  });

  it("keeps homonymous projects isolated by projectId", async () => {
    const first = await createProject({
      name: "Same name",
      objective: "First isolated objective with complete acceptance evidence",
      acceptanceCriteria: ["first only"],
      budgetUsd: 10,
    });
    const second = await createProject({
      name: "Same name",
      objective: "Second isolated objective with different acceptance evidence",
      acceptanceCriteria: ["second only"],
      budgetUsd: 20,
    });
    const firstId = (first.json() as { id: string }).id;
    const secondId = (second.json() as { id: string }).id;
    const firstConfig = store.getProjectConfiguration(firstId)!;
    const secondConfig = store.getProjectConfiguration(secondId)!;
    expect(firstConfig.objective?.acceptanceCriteria).toEqual(["first only"]);
    expect(secondConfig.objective?.acceptanceCriteria).toEqual(["second only"]);
    expect(firstConfig.budget?.limitUsd).toBe(10);
    expect(secondConfig.budget?.limitUsd).toBe(20);
  });
});
