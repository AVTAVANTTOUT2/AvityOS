import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll, git, initRepo, listWorktrees } from "@avityos/git";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import { openDatabase, type DB } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine } from "./engine.js";
import { Store } from "./store.js";

/** node script used as a real check: AVITY.md must exist and be defect-free. */
const CHECK_AVITY_MD = [
  "node",
  "-e",
  "const s=require('fs').readFileSync('AVITY.md','utf8'); if(/DEFECT/.test(s)){console.error('defect marker found');process.exit(1)}",
];

async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avity-fixture-"));
  const repo = join(dir, "repo");
  await git(dir, "init", "-b", "main", repo);
  await initRepo(repo);
  await writeFile(join(repo, "README.md"), "# fixture\n");
  await commitAll(repo, "chore: initial commit");
  return repo;
}

function repoMissionContract(objective: string) {
  return {
    objective,
    rationale: "",
    context: [],
    allowedPaths: [],
    forbiddenPaths: ["**/.env", "**/secrets/**"],
    acceptanceCriteria: [objective],
    requiredChecks: ["test" as const],
    checkCommands: { test: CHECK_AVITY_MD },
    budgetUsd: null,
    timeoutSeconds: 120,
    expectedArtifacts: ["AVITY.md"],
  };
}

const TEST_CONFIG = {
  ...DEFAULT_ENGINE_CONFIG,
  tickMs: 20,
  maxWaitMs: 5000,
  maxProviderRetries: 1,
  allowModelSwitch: false,
  allowProviderSwitch: false,
};

function makeEngine(db: DB, model = "fake:succeed", reviewModel = "fake:review-approve"): { store: Store; engine: Engine } {
  const store = new Store(db);
  const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
  const engine = new Engine(
    store,
    providers,
    TEST_CONFIG,
    ["fake"],
    new Map([["fake", model]]),
    new Map([["fake", reviewModel]]),
  );
  return { store, engine };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

let db: DB;
let store: Store;
let engine: Engine;

beforeEach(() => {
  db = openDatabase(":memory:");
  ({ store, engine } = makeEngine(db));
});

afterEach(async () => {
  await engine.stop();
  db.close();
});

describe("scenario 1: clear objective reaches completion via fake provider", () => {
  it("runs the full lifecycle to completed with evidence", async () => {
    engine.start();
    const project = store.createProject({
      name: "Demo",
      description: "",
      repoPath: null,
      repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Build a REST endpoint that returns the service health status as JSON, with tests.",
      ["GET /health returns 200 with status json", "unit tests cover the endpoint"],
    );
    engine.analyzeObjective(project.id, objective.id);

    await waitFor(() => store.getProject(project.id)!.status === "completed", 8000);

    const missions = store.listMissions(project.id);
    expect(missions.length).toBe(2); // one impl mission per criterion
    expect(missions.every((m) => m.state === "completed")).toBe(true);

    // evidence: every mission passed an explicit independent review run
    for (const m of missions) {
      const checkpoints = store.listCheckpoints(m.id);
      expect(checkpoints.some((c) => c.kind === "review" && c.status === "passed")).toBe(true);
      // author run + reviewer run
      expect(store.listRuns({ missionId: m.id, states: ["succeeded"] }).length).toBeGreaterThanOrEqual(2);
    }
    const events = store.eventsAfter(0, project.id);
    expect(events.some((e) => e.type === "mission.state_changed")).toBe(true);
    expect(store.verifyAuditChain()).toBe(true);
  });
});

describe("scenario 2: ambiguous objective triggers grouped clarification and resumes", () => {
  it("asks once, resumes automatically after the answer", async () => {
    engine.start();
    const project = store.createProject({
      name: "Vague",
      description: "",
      repoPath: null,
      repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Make an app, maybe with accounts", []);
    const { clarificationId } = engine.analyzeObjective(project.id, objective.id);
    expect(clarificationId).not.toBeNull();
    expect(store.getProject(project.id)!.status).toBe("clarifying");

    const clarification = store.getClarification(clarificationId!)!;
    expect(clarification.questions.length).toBeGreaterThanOrEqual(2); // grouped
    expect(clarification.provenance).toBe("deterministic_policy");

    store.answerClarification(clarificationId!, clarification.questions.map((question) => ({
      questionId: question.id,
      answer:
        question.logicalKey === "acceptance-criteria"
          ? "Users can register; users can log in"
          : "No mobile app",
    })));
    engine.resumeAfterClarification(clarificationId!);

    await waitFor(() => store.getProject(project.id)!.status === "completed", 8000);
    const brain = store.listBrainEntries(project.id);
    expect(brain.some((b) => b.kind === "decision")).toBe(true);
  });
});

describe("scenario 3: two projects run concurrently in isolation", () => {
  it("keeps missions, events, usage and budgets separated", async () => {
    engine.start();
    const p1 = store.createProject({ name: "P1", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    const p2 = store.createProject({ name: "P2", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    store.setBudget(p1.id, 100);
    store.setBudget(p2.id, 200);

    const o1 = store.createObjective(p1.id, "Deliver feature A with automated verification of the API surface", ["A works"]);
    const o2 = store.createObjective(p2.id, "Deliver feature B with automated verification of the API surface", ["B works"]);
    engine.analyzeObjective(p1.id, o1.id);
    engine.analyzeObjective(p2.id, o2.id);

    await waitFor(
      () => store.getProject(p1.id)!.status === "completed" && store.getProject(p2.id)!.status === "completed",
      10_000,
    );

    const m1 = store.listMissions(p1.id);
    const m2 = store.listMissions(p2.id);
    expect(m1.every((m) => m.projectId === p1.id)).toBe(true);
    expect(m2.every((m) => m.projectId === p2.id)).toBe(true);

    const e1 = store.eventsAfter(0, p1.id);
    expect(e1.every((e) => e.projectId === p1.id)).toBe(true);

    expect(store.getBudget(p1.id)!.limitUsd).toBe(100);
    expect(store.getBudget(p2.id)!.limitUsd).toBe(200);
  });
});

describe("scenario 4: provider rate limit applies fallback policy", () => {
  it("waits for reset then succeeds", async () => {
    ({ store, engine } = makeEngine(db, "fake:rate-limit-once"));
    engine.start();
    const project = store.createProject({ name: "RL", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    const objective = store.createObjective(project.id, "Deliver the rate-limited feature end to end", ["works"]);
    engine.analyzeObjective(project.id, objective.id);

    await waitFor(() => store.getProject(project.id)!.status === "completed", 8000);

    const events = store.eventsAfter(0, project.id);
    const fallback = events.find((e) => e.type === "provider.fallback");
    expect(fallback).toBeDefined();
    expect(fallback!.payload.action).toBe("wait_for_reset");
    // one failed run then a successful one
    const runs = store.listRuns({ projectId: project.id });
    expect(runs.some((r) => r.state === "failed" && r.errorCategory === "rate_limited")).toBe(true);
    expect(runs.some((r) => r.state === "succeeded")).toBe(true);
  });
});

describe("scenario 5: failures go through bounded loops and escalate", () => {
  it("persistent provider failure blocks the mission with an approval", async () => {
    ({ store, engine } = makeEngine(db, "fake:fail-agent_crash"));
    engine.start();
    const project = store.createProject({ name: "Fail", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    const objective = store.createObjective(project.id, "Deliver something the agent always crashes on", ["never passes"]);
    engine.analyzeObjective(project.id, objective.id);

    // agent_crash retries once (maxProviderRetries=1), no model/provider
    // switch allowed → blocked with an approval.
    await waitFor(() => store.listApprovals("open", project.id).length > 0, 10_000);
    const missions = store.listMissions(project.id);
    expect(missions.some((m) => ["blocked", "failed"].includes(m.state))).toBe(true);
    expect(store.listApprovals("open", project.id)[0]!.title).toMatch(/blocked|Correction/i);
  }, 15_000);

  it("unfulfillable required check loops within the bound then escalates", async () => {
    const project = store.createProject({ name: "Corr", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    const mission = store.createMission({
      projectId: project.id,
      planId: null,
      milestoneId: null,
      title: "correction loop mission",
      role: "backend",
      contract: {
        objective: "x", rationale: "", context: [], allowedPaths: [], forbiddenPaths: [],
        acceptanceCriteria: [], requiredChecks: ["test"], checkCommands: {},
        budgetUsd: null, timeoutSeconds: 60, expectedArtifacts: [],
      },
      priority: 50,
      dependsOn: [],
    });
    store.setProjectStatus(project.id, "active");
    store.transitionMission(mission.id, "ready", "");
    store.transitionMission(mission.id, "assigned", "");
    await engine.executeMission(mission.id);

    // a required check with no command can never pass: bounded retries
    // (3 attempts) then failed + approval, never an infinite loop
    await waitFor(() => store.getMission(mission.id)!.state === "failed", 8000);
    const updated = store.getMission(mission.id)!;
    expect(updated.correctionAttempts).toBe(updated.maxCorrectionAttempts);
    const events = store.eventsAfter(0, project.id);
    expect(events.filter((e) => e.type === "mission.correction_loop").length).toBe(updated.maxCorrectionAttempts);
    expect(store.listApprovals("open", project.id).some((a) => a.title.includes("Correction"))).toBe(true);
  });
});

describe("scenario 6: restart recovery without duplicate side effects", () => {
  it("reconciles orphan runs and completes after restart", async () => {
    ({ store, engine } = makeEngine(db, "fake:slow"));
    engine.start();
    const project = store.createProject({ name: "Crash", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    const objective = store.createObjective(project.id, "Deliver a long-running feature that survives restarts", ["done"]);
    engine.analyzeObjective(project.id, objective.id);

    await waitFor(() => store.listRuns({ projectId: project.id, states: ["running"] }).length > 0, 5000);
    // simulate crash: stop without cleanup semantics of graceful shutdown
    await engine.stop();

    // new control plane process over the same database, faster model this time
    const store2 = new Store(db);
    const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
    const engine2 = new Engine(store2, providers, TEST_CONFIG, ["fake"], new Map([["fake", "fake:succeed"]]), new Map([["fake", "fake:review-approve"]]));
    engine2.start();
    try {
      await waitFor(() => store2.getProject(project.id)!.status === "completed", 10_000);
      const runs = store2.listRuns({ projectId: project.id });
      // the orphaned run is failed exactly once, then a fresh run succeeds
      expect(runs.filter((r) => r.exitReason?.includes("restarted")).length).toBe(1);
      const missionIds = new Set(runs.map((r) => r.missionId));
      for (const id of missionIds) {
        // exactly one successful AUTHOR run; the reviewer run is separate
        const succeeded = runs.filter(
          (r) => r.missionId === id && r.state === "succeeded" && !r.model?.startsWith("fake:review"),
        );
        expect(succeeded.length).toBeLessThanOrEqual(1); // no duplicate side effects
      }
    } finally {
      await engine2.stop();
    }
  });
});

describe("scenario 8: cancellation cleans up runs", () => {
  it("cancels the mission and its active runs", async () => {
    ({ store, engine } = makeEngine(db, "fake:slow"));
    engine.start();
    const project = store.createProject({ name: "Cancel", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    const objective = store.createObjective(project.id, "Deliver a long-running mission we will cancel midway", ["n/a"]);
    engine.analyzeObjective(project.id, objective.id);

    await waitFor(() => store.listRuns({ projectId: project.id, states: ["running"] }).length > 0, 5000);
    const mission = store.listMissions(project.id).find((m) => m.state === "running")!;
    await engine.cancelMission(mission.id);

    expect(store.getMission(mission.id)!.state).toBe("cancelled");
    const runs = store.listRuns({ missionId: mission.id });
    expect(runs.every((r) => ["cancelled", "failed"].includes(r.state))).toBe(true);
    const audit = store.verifyAuditChain();
    expect(audit).toBe(true);
  });
});

describe("illegal transitions are refused and audited state stays consistent", () => {
  it("scenario 7 analog: forbidden transition is denied", () => {
    const project = store.createProject({ name: "Deny", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised" });
    const mission = store.createMission({
      projectId: project.id,
      planId: null,
      milestoneId: null,
      title: "t",
      role: "backend",
      contract: {
        objective: "x", rationale: "", context: [], allowedPaths: [], forbiddenPaths: [],
        acceptanceCriteria: [], requiredChecks: [], checkCommands: {}, budgetUsd: null, timeoutSeconds: null, expectedArtifacts: [],
      },
      priority: 50,
      dependsOn: [],
    });
    expect(() => store.transitionMission(mission.id, "completed", "cheating")).toThrow();
    expect(store.getMission(mission.id)!.state).toBe("proposed");
  });
});

describe("e2e fixture repo: real worktree, real checks, commit, PR, review", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeFixtureRepo();
  });

  afterEach(async () => {
    await rm(join(repo, ".."), { recursive: true, force: true });
  });

  it("delivers a defective first attempt through correction to a reviewed commit", async () => {
    ({ store, engine } = makeEngine(db, "fake:code-defect-once"));
    const project = store.createProject({
      name: "Fixture", description: "", repoPath: repo, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    store.setProjectStatus(project.id, "active");
    const mission = store.createMission({
      projectId: project.id, planId: null, milestoneId: null,
      title: "Write AVITY.md result file", role: "backend",
      contract: repoMissionContract("Create AVITY.md describing the delivered feature"),
      priority: 50, dependsOn: [],
    });
    store.transitionMission(mission.id, "ready", "");
    store.transitionMission(mission.id, "assigned", "");
    await engine.executeMission(mission.id);
    await waitFor(() => store.getMission(mission.id)!.state === "completed", 15_000);

    const done = store.getMission(mission.id)!;
    // worktree + branch were real and persisted
    expect(done.branchName).toMatch(/^mission\//);
    expect(done.worktreePath).toContain(".avity/worktrees");
    // forced defect went through exactly one correction loop
    expect(done.correctionAttempts).toBe(1);
    const events = store.eventsAfter(0, project.id);
    expect(events.some((e) => e.type === "mission.correction_loop")).toBe(true);

    // the check ran the real command (defect run failed it, clean run passed)
    const checkpoints = store.listCheckpoints(mission.id);
    const testCheck = checkpoints.find((c) => c.kind === "test")!;
    expect(testCheck.status).toBe("passed");
    expect(testCheck.detail).toContain("exit 0");

    // a real commit exists on the mission branch with AVITY.md
    const files = (await git(repo, "show", "--name-only", "--format=", done.branchName!)).trim().split("\n");
    expect(files).toContain("AVITY.md");
    const content = await git(repo, "show", `${done.branchName}:AVITY.md`);
    expect(content).not.toContain("DEFECT");
    expect(events.some((e) => e.type === "git.commit_created")).toBe(true);

    // PR recorded exactly once, review checkpoint passed, worktree cleaned
    const prs = store.listPullRequests(project.id).filter((pr) => pr.missionId === mission.id);
    expect(prs.length).toBe(1);
    expect(checkpoints.find((c) => c.kind === "review")!.status).toBe("passed");
    expect(existsSync(done.worktreePath!)).toBe(false);
    expect((await listWorktrees(repo)).some((w) => w.branch === done.branchName)).toBe(false);
    expect(store.verifyAuditChain()).toBe(true);
  });

  it("blocks a mission whose .avity/worktrees is redirected outside the repo via a symlink", async () => {
    ({ store, engine } = makeEngine(db, "fake:code"));
    // Redirect <repo>/.avity/worktrees to an external directory before any run.
    const external = await mkdtemp(join(tmpdir(), "avity-evil-wt-"));
    await mkdir(join(repo, ".avity"), { recursive: true });
    await symlink(external, join(repo, ".avity", "worktrees"));

    const project = store.createProject({
      name: "WtConfine", description: "", repoPath: repo, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    store.setProjectStatus(project.id, "active");
    const mission = store.createMission({
      projectId: project.id, planId: null, milestoneId: null,
      title: "Redirected worktree", role: "backend",
      contract: repoMissionContract("Create AVITY.md"),
      priority: 50, dependsOn: [],
    });
    store.transitionMission(mission.id, "ready", "");
    store.transitionMission(mission.id, "assigned", "");
    await engine.executeMission(mission.id);
    await waitFor(() => store.getMission(mission.id)!.state === "blocked", 10_000);

    const done = store.getMission(mission.id)!;
    expect(done.state).toBe("blocked");
    const events = store.eventsAfter(0, project.id);
    expect(
      events.some((e) => JSON.stringify(e).includes("worktree creation failed")),
    ).toBe(true);
    // nothing was written into the redirected external directory
    expect(existsSync(join(external, "AVITY.md"))).toBe(false);
    // ensureConfinedDirectory must not create any new entries outside the repo
    expect((await readdir(external)).length).toBe(0);
    await rm(external, { recursive: true, force: true });
  });

  it("rejects an expected artifact that is a symlink escaping the worktree", async () => {
    ({ store, engine } = makeEngine(db, "fake:code"));
    const project = store.createProject({
      name: "ArtifactConfine", description: "", repoPath: repo, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    store.setProjectStatus(project.id, "active");
    // The plan declares an artifact name that the provider will realise as a
    // symlink pointing at a secret outside the worktree.
    const secret = await mkdtemp(join(tmpdir(), "avity-secret-"));
    await writeFile(join(secret, "leak.txt"), "top secret\n");

    const contract = {
      ...repoMissionContract("Create AVITY.md and a leak artifact"),
      expectedArtifacts: ["AVITY.md", "leak.txt"],
      requiredChecks: [] as const,
      checkCommands: {},
    };
    const mission = store.createMission({
      projectId: project.id, planId: null, milestoneId: null,
      title: "Symlinked artifact", role: "backend",
      contract, priority: 50, dependsOn: [],
    });
    store.transitionMission(mission.id, "ready", "");
    store.transitionMission(mission.id, "assigned", "");

    // Plant the malicious symlink inside the worktree once it exists, before
    // validation reads the expected artifacts.
    const plant = setInterval(() => {
      const wt = store.getMission(mission.id)?.worktreePath;
      if (wt && existsSync(wt) && !existsSync(join(wt, "leak.txt"))) {
        try {
          symlinkSync(join(secret, "leak.txt"), join(wt, "leak.txt"));
        } catch {
          /* already planted or racing cleanup */
        }
      }
    }, 15);

    try {
      await engine.executeMission(mission.id);
      await waitFor(() => {
        const s = store.getMission(mission.id)!.state;
        return s === "blocked" || s === "failed" || s === "completed";
      }, 12_000);
    } finally {
      clearInterval(plant);
    }

    const done = store.getMission(mission.id)!;
    // The mission must never complete with an escaping symlinked artifact.
    expect(done.state).not.toBe("completed");
    await rm(secret, { recursive: true, force: true });
  });

  it("review rejection sends the mission through a corrective loop, then approves", async () => {
    ({ store, engine } = makeEngine(db, "fake:code", "fake:review-reject-once"));
    const project = store.createProject({
      name: "ReviewLoop", description: "", repoPath: repo, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    store.setProjectStatus(project.id, "active");
    const mission = store.createMission({
      projectId: project.id, planId: null, milestoneId: null,
      title: "Reviewed delivery", role: "backend",
      contract: repoMissionContract("Create AVITY.md for the reviewed delivery"),
      priority: 50, dependsOn: [],
    });
    store.transitionMission(mission.id, "ready", "");
    store.transitionMission(mission.id, "assigned", "");
    await engine.executeMission(mission.id);
    await waitFor(() => store.getMission(mission.id)!.state === "completed", 15_000);

    const done = store.getMission(mission.id)!;
    expect(done.correctionAttempts).toBe(1); // one rejection, one approval
    const reviewRuns = store.listRuns({ missionId: mission.id }).filter((r) => r.model?.startsWith("fake:review"));
    expect(reviewRuns.length).toBe(2); // reject then approve — never auto-approved
    const reviewCheck = store.listCheckpoints(mission.id).find((c) => c.kind === "review")!;
    expect(reviewCheck.status).toBe("passed");
    const brain = store.listBrainEntries(project.id);
    expect(brain.some((b) => b.title.startsWith("Independent review: rejected"))).toBe(true);
    expect(brain.some((b) => b.title.startsWith("Independent review: approved"))).toBe(true);

    // idempotency across the replayed validation (correction after review
    // rejection re-validates the same tree): no duplicate commit, no
    // duplicate PR record
    const commits = (await git(repo, "rev-list", "--count", `main..${done.branchName}`)).trim();
    expect(commits).toBe("1");
    expect(store.listPullRequests(project.id).filter((pr) => pr.missionId === mission.id).length).toBe(1);
  });

});

describe("cross-provider fallback", () => {
  it("switches to the next provider in the chain when rate limits exhaust retries", async () => {
    const limited = new FakeProviderAdapter("limited");
    const healthy = new FakeProviderAdapter("fake");
    store = new Store(db);
    engine = new Engine(
      store,
      new Map<string, ProviderAdapter>([["limited", limited], ["fake", healthy]]),
      { ...TEST_CONFIG, allowProviderSwitch: true },
      ["limited", "fake"],
      new Map([["limited", "fake:fail-rate_limited"], ["fake", "fake:succeed"]]),
      new Map([["limited", "fake:review-approve"], ["fake", "fake:review-approve"]]),
    );
    const project = store.createProject({ name: "XProv", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    store.setProjectStatus(project.id, "active");
    const mission = store.createMission({
      projectId: project.id, planId: null, milestoneId: null,
      title: "cross-provider mission", role: "backend",
      contract: {
        objective: "x", rationale: "", context: [], allowedPaths: [], forbiddenPaths: [],
        acceptanceCriteria: [], requiredChecks: [], checkCommands: {}, budgetUsd: null, timeoutSeconds: 60, expectedArtifacts: [],
      },
      priority: 50, dependsOn: [],
    });
    store.transitionMission(mission.id, "ready", "");
    store.transitionMission(mission.id, "assigned", "");
    await engine.executeMission(mission.id);
    await waitFor(() => store.getMission(mission.id)!.state === "completed", 10_000);

    const events = store.eventsAfter(0, project.id);
    const switchEvent = events.find((e) => e.type === "provider.fallback" && e.payload.action === "switch_provider");
    expect(switchEvent).toBeDefined();
    expect(switchEvent!.payload.provider).toBe("limited");
    const runs = store.listRuns({ projectId: project.id });
    expect(runs.some((r) => r.providerId === "limited" && r.state === "failed")).toBe(true);
    expect(runs.some((r) => r.providerId === "fake" && r.state === "succeeded")).toBe(true);
  });
});

describe("repository-aware planning and provider capability gates", () => {
  let repo: string;

  beforeEach(async () => { repo = await makeFixtureRepo(); });
  afterEach(async () => { await rm(join(repo, ".."), { recursive: true, force: true }); });

  it("detects deterministic repository checks and requires a real diff", async () => {
    ({ store, engine } = makeEngine(db, "fake:code"));
    const project = store.createProject({
      name: "AutoContract", description: "", repoPath: repo, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Create a durable project delivery report in the repository", ["delivery report exists"]);
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.listMissions(project.id).length > 0);
    const mission = store.listMissions(project.id)[0]!;
    expect(mission.contract.workspaceChangesRequired).toBe(true);
    expect(mission.contract.allowedPaths).toEqual(["**"]);
    expect(mission.contract.requiredChecks).toContain("architecture_rule");
    expect(mission.contract.checkCommands.architecture_rule).toEqual(["git", "diff", "--check", "HEAD"]);

    engine.start();
    await waitFor(() => {
      const state = store.getMission(mission.id)!.state;
      return store.getProject(project.id)!.status === "completed" || ["blocked", "failed", "cancelled"].includes(state);
    }, 10_000);
    const finalMission = store.getMission(mission.id)!;
    expect(
      store.getProject(project.id)!.status,
      JSON.stringify({
        missionState: finalMission.state,
        stateReason: finalMission.stateReason,
        checkpoints: store.listCheckpoints(mission.id),
      }),
    ).toBe("completed");
    expect(store.listCheckpoints(mission.id).find((checkpoint) => checkpoint.kind === "architecture_rule")?.status).toBe("passed");
  }, 15_000);

  it("serializes a project's generated missions while preserving cross-project concurrency", async () => {
    ({ store, engine } = makeEngine(db, "fake:code"));
    const project = store.createProject({
      name: "Ordered", description: "", repoPath: repo, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver the ordered product stages with deterministic verification",
      ["architecture baseline exists", "backend implementation exists", "QA evidence exists"],
    );
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.listMissions(project.id).length === 3);
    const missions = store.listMissions(project.id);
    const dependencies = store.listDependencies(project.id);
    expect(missions).toHaveLength(3);
    expect(dependencies).toEqual([
      { missionId: missions[1]!.id, dependsOnMissionId: missions[0]!.id },
      { missionId: missions[2]!.id, dependsOnMissionId: missions[1]!.id },
    ]);
  });

  it("blocks a repository mission before execution when the provider cannot edit workspaces", async () => {
    class TextOnlyFakeProvider extends FakeProviderAdapter {
      override capabilities() { return { ...super.capabilities(), workspaceEdits: false }; }
    }
    store = new Store(db);
    engine = new Engine(
      store,
      new Map<string, ProviderAdapter>([["text-only", new TextOnlyFakeProvider("text-only")]]),
      TEST_CONFIG,
      ["text-only"],
      new Map([["text-only", "fake:succeed"]]),
      new Map([["text-only", "fake:review-approve"]]),
    );
    const project = store.createProject({
      name: "CapabilityGate", description: "", repoPath: repo, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const mission = store.createMission({
      projectId: project.id, planId: null, milestoneId: null,
      title: "Must edit files", role: "backend", contract: repoMissionContract("edit a file"), priority: 50, dependsOn: [],
    });
    store.transitionMission(mission.id, "ready", "");
    store.transitionMission(mission.id, "assigned", "");
    await engine.executeMission(mission.id);

    expect(store.getMission(mission.id)!.state).toBe("blocked");
    expect(store.listRuns({ missionId: mission.id })).toHaveLength(0);
    expect(store.listApprovals("open", project.id)[0]?.title).toContain("capable coding provider");
  });
});

describe("durable project brain context", () => {
  it("injects project-specific decisions into author prompts", async () => {
    class RecordingFake extends FakeProviderAdapter {
      readonly prompts: string[] = [];
      override startRun(input: Parameters<FakeProviderAdapter["startRun"]>[0]) {
        this.prompts.push(input.systemPrompt);
        return super.startRun(input);
      }
    }
    const recording = new RecordingFake();
    store = new Store(db);
    engine = new Engine(
      store,
      new Map<string, ProviderAdapter>([["fake", recording]]),
      TEST_CONFIG,
      ["fake"],
      new Map([["fake", "fake:succeed"]]),
      new Map([["fake", "fake:review-approve"]]),
    );
    const project = store.createProject({
      name: "Brain", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    store.addBrainEntry(project.id, "decision", "Architecture boundary", "Use ports and adapters; never couple UI to SQLite.", ["user"]);
    store.setProjectStatus(project.id, "active");
    const mission = store.createMission({
      projectId: project.id, planId: null, milestoneId: null,
      title: "Respect architecture", role: "architecture",
      contract: {
        objective: "document the boundary", rationale: "", context: [], allowedPaths: [], forbiddenPaths: [],
        acceptanceCriteria: [], requiredChecks: [], checkCommands: {}, budgetUsd: null, timeoutSeconds: 60,
        expectedArtifacts: [], workspaceChangesRequired: false,
      },
      priority: 50, dependsOn: [],
    });
    store.transitionMission(mission.id, "ready", "");
    store.transitionMission(mission.id, "assigned", "");
    await engine.executeMission(mission.id);
    expect(recording.prompts[0]).toContain("Use ports and adapters; never couple UI to SQLite.");
  });
});
