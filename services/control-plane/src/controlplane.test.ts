import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import { openDatabase, type DB } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine } from "./engine.js";
import { Store } from "./store.js";

const TEST_CONFIG = {
  ...DEFAULT_ENGINE_CONFIG,
  tickMs: 20,
  maxWaitMs: 5000,
  maxProviderRetries: 1,
  allowModelSwitch: false,
};

function makeEngine(db: DB, model = "fake:succeed"): { store: Store; engine: Engine } {
  const store = new Store(db);
  const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
  const engine = new Engine(store, providers, TEST_CONFIG, "fake", model);
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
    expect(missions.length).toBe(3); // 2 impl + 1 review
    expect(missions.every((m) => m.state === "completed")).toBe(true);

    // evidence: checkpoints passed, runs succeeded, events recorded
    for (const m of missions.filter((x) => x.contract.requiredChecks.length > 0)) {
      const checkpoints = store.listCheckpoints(m.id);
      expect(checkpoints.some((c) => c.kind === "build" && c.status === "passed")).toBe(true);
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

    store.answerClarification(clarificationId!, [
      { questionId: "q_acceptance", answer: "Users can register; users can log in" },
      { questionId: "q_scope", answer: "No mobile app" },
    ]);
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

  it("failed validation retries within the correction limit then succeeds", async () => {
    const project = store.createProject({ name: "Corr", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    const mission = store.createMission({
      projectId: project.id,
      planId: null,
      milestoneId: null,
      title: "correction loop mission",
      role: "backend",
      contract: {
        objective: "x", rationale: "", context: [], allowedPaths: [], forbiddenPaths: [],
        acceptanceCriteria: [], requiredChecks: ["test"], budgetUsd: null, timeoutSeconds: 60, expectedArtifacts: [],
      },
      priority: 50,
      dependsOn: [],
    });
    store.setProjectStatus(project.id, "active");
    // force the mission into validating with no successful run behind it
    store.transitionMission(mission.id, "ready", "");
    store.transitionMission(mission.id, "assigned", "");
    store.transitionMission(mission.id, "running", "");
    store.transitionMission(mission.id, "result_submitted", "");
    store.transitionMission(mission.id, "validating", "");
    engine.validateMission(mission.id);

    // correction loop kicks in: retry via a real (fake:succeed) run
    await waitFor(() => store.getMission(mission.id)!.state === "completed", 8000);
    const updated = store.getMission(mission.id)!;
    expect(updated.correctionAttempts).toBe(1);
    const events = store.eventsAfter(0, project.id);
    expect(events.some((e) => e.type === "mission.correction_loop")).toBe(true);
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
    const engine2 = new Engine(store2, providers, TEST_CONFIG, "fake", "fake:succeed");
    engine2.start();
    try {
      await waitFor(() => store2.getProject(project.id)!.status === "completed", 10_000);
      const runs = store2.listRuns({ projectId: project.id });
      // the orphaned run is failed exactly once, then a fresh run succeeds
      expect(runs.filter((r) => r.exitReason?.includes("restarted")).length).toBe(1);
      const missionIds = new Set(runs.map((r) => r.missionId));
      for (const id of missionIds) {
        const succeeded = runs.filter((r) => r.missionId === id && r.state === "succeeded");
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
        acceptanceCriteria: [], requiredChecks: [], budgetUsd: null, timeoutSeconds: null, expectedArtifacts: [],
      },
      priority: 50,
      dependsOn: [],
    });
    expect(() => store.transitionMission(mission.id, "completed", "cheating")).toThrow();
    expect(store.getMission(mission.id)!.state).toBe("proposed");
  });
});
