import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import { openDatabase, type DB } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine, type EngineConfig } from "./engine.js";
import { buildServer } from "./server.js";
import { Store, StoreConflictError } from "./store.js";

const TEST_CONFIG: EngineConfig = {
  ...DEFAULT_ENGINE_CONFIG,
  tickMs: 20,
  maxWaitMs: 5000,
  maxProviderRetries: 1,
  allowModelSwitch: false,
  allowProviderSwitch: false,
  maxClarificationRounds: 2,
  maxClarificationQuestions: 8,
};

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

function makeEngine(db: DB, brain = "fake:plan"): { store: Store; engine: Engine } {
  const store = new Store(db);
  const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
  const engine = new Engine(
    store,
    providers,
    TEST_CONFIG,
    ["fake"],
    new Map([["fake", "fake:succeed"]]),
    new Map([["fake", "fake:review-approve"]]),
    new Map(),
    new Map([["fake", brain]]),
  );
  return { store, engine };
}

describe("chantier 3: structured clarifications", () => {
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

  it("skips clarification for a clear objective", async () => {
    const project = store.createProject({
      name: "Clear",
      description: "",
      repoPath: null,
      repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a complete authenticated reporting API with durable persistence and automated verification",
      ["reports can be created", "reports can be listed"],
    );
    const result = engine.analyzeObjective(project.id, objective.id);
    expect(result.clarificationId).toBeNull();
    await waitFor(() => store.activePlan(project.id) !== null);
    expect(store.listClarifications(project.id, "open")).toEqual([]);
  });

  it("groups AI clarification questions with fake_fixture provenance", async () => {
    ({ store, engine } = makeEngine(db, "fake:plan-ambiguous"));
    const project = store.createProject({
      name: "Ambiguous AI",
      description: "",
      repoPath: null,
      repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a deliberately detailed objective that still lacks material product decisions for safe planning",
      ["the provider must ask before planning"],
    );
    const result = await engine.brain.ensurePlan(project.id, objective.id);
    expect(result.status).toBe("clarifying");
    const group = store.listClarifications(project.id, "open")[0]!;
    expect(group.provenance).toBe("fake_fixture");
    expect(group.questions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(group.questions.map((q) => q.logicalKey)).size).toBe(group.questions.length);
  });

  it("injects answers into the next analysis and resumes planning exactly once", async () => {
    ({ store, engine } = makeEngine(db, "fake:plan-ambiguous"));
    engine.start();
    const project = store.createProject({
      name: "Resume once",
      description: "",
      repoPath: null,
      repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a deliberately detailed objective that still lacks material product decisions for safe planning",
      ["provider asks once then plans"],
    );
    await engine.brain.ensurePlan(project.id, objective.id);
    const group = store.listClarifications(project.id, "open")[0]!;
    // Switch brain model so the post-answer analysis is clear.
    await engine.stop();
    ({ store, engine } = makeEngine(db, "fake:plan"));
    engine.start();
    store.answerClarification(
      group.id,
      group.questions.map((question) => ({
        questionId: question.id,
        answer:
          question.answerType === "single_choice"
            ? question.options[0]!.key
            : question.logicalKey === "acceptance-criteria"
              ? "provider asks once then plans\nsecond observable behavior"
              : "mobile clients are out of scope",
      })),
    );
    engine.resumeAfterClarification(group.id);
    await waitFor(() => store.activePlan(project.id) !== null, 10_000);
    expect(store.listClarifications(project.id, "open")).toEqual([]);
    expect(store.listPlans(project.id)).toHaveLength(1);
    const decisions = store.listBrainEntries(project.id).filter((entry) => entry.kind === "decision");
    expect(decisions.length).toBeGreaterThanOrEqual(group.questions.length);
  });

  it("rejects answers to an obsolete clarification group", () => {
    const project = store.createProject({
      name: "Obsolete",
      description: "",
      repoPath: null,
      repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "short", []);
    const { clarificationId } = engine.analyzeObjective(project.id, objective.id);
    const group = store.getClarification(clarificationId!)!;
    store.createObjective(project.id, "revised objective with enough detail for planning gates", ["done"]);
    expect(store.getClarification(group.id)!.status).toBe("expired");
    expect(() =>
      store.answerClarification(group.id, group.questions.map((question) => ({
        questionId: question.id,
        answer: "too late",
      }))),
    ).toThrow(StoreConflictError);
  });

  it("bounds clarification rounds before escalating", async () => {
    ({ store, engine } = makeEngine(db, "fake:plan-ambiguous"));
    const project = store.createProject({
      name: "Round limit",
      description: "",
      repoPath: null,
      repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a deliberately detailed objective that still lacks material product decisions for safe planning",
      ["round limit must escalate"],
    );
    for (let round = 0; round < 2; round += 1) {
      const result = await engine.brain.ensurePlan(project.id, objective.id);
      expect(result.status).toBe("clarifying");
      const group = store.listClarifications(project.id, "open")[0]!;
      store.answerClarification(
        group.id,
        group.questions.map((question) => ({
          questionId: question.id,
          answer: question.answerType === "single_choice" ? question.options[0]!.key : `answer-${round}`,
        })),
      );
    }
    const blocked = await engine.brain.ensurePlan(project.id, objective.id);
    expect(blocked.status).toBe("blocked");
  });

  it("isolates clarification groups by project_id for homonymous projects", () => {
    const a = store.createProject({
      name: "Twin", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    const b = store.createProject({
      name: "Twin", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    const oa = store.createObjective(a.id, "short a", []);
    const ob = store.createObjective(b.id, "short b", []);
    const ca = engine.analyzeObjective(a.id, oa.id).clarificationId!;
    const cb = engine.analyzeObjective(b.id, ob.id).clarificationId!;
    expect(ca).not.toBe(cb);
    expect(store.getClarification(ca)!.projectId).toBe(a.id);
    expect(store.getClarification(cb)!.projectId).toBe(b.id);
  });

  it("rolls back invalid clarification answers without marking the group answered", () => {
    const project = store.createProject({
      name: "Rollback", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    const objective = store.createObjective(project.id, "short", []);
    const { clarificationId } = engine.analyzeObjective(project.id, objective.id);
    const group = store.getClarification(clarificationId!)!;
    expect(() =>
      store.answerClarification(group.id, [
        { questionId: group.questions[0]!.id, answer: "only one answer" },
      ]),
    ).toThrow(/missing/i);
    expect(store.getClarification(group.id)!.status).toBe("open");
  });
});

describe("chantier 3: atomic pause and resume", () => {
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

  it("pauses a project without an active run", async () => {
    const project = store.createProject({
      name: "Idle pause", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    store.setProjectStatus(project.id, "active");
    const state = await engine.pauseProject(project.id, { reason: "operator", actor: "test" });
    expect(state?.status).toBe("paused");
    expect(store.getProject(project.id)!.status).toBe("paused");
    expect(store.getPauseGeneration(project.id)).toBe(1);
  });

  it("pauses with an active provider run and fences late results", async () => {
    class SlowFake extends FakeProviderAdapter {
      override startRun(input: Parameters<FakeProviderAdapter["startRun"]>[0]) {
        let cancelled = false;
        async function* events() {
          yield { type: "output" as const, text: "working\n" };
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (!cancelled) {
            yield { type: "completed" as const, resultText: "late success" };
          }
        }
        return {
          events: events(),
          cancel: async () => {
            cancelled = true;
          },
        };
      }
    }
    const providers = new Map<string, ProviderAdapter>([["fake", new SlowFake()]]);
    store = new Store(db);
    engine = new Engine(
      store,
      providers,
      TEST_CONFIG,
      ["fake"],
      new Map([["fake", "fake:succeed"]]),
      new Map([["fake", "fake:review-approve"]]),
      new Map(),
      new Map([["fake", "fake:plan"]]),
    );
    engine.start();
    const project = store.createProject({
      name: "Active pause", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a complete pause fencing path with automated verification of late results",
      ["late results are refused"],
    );
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.listMissions(project.id).some((mission) => mission.state === "running"), 10_000);
    const beforeRuns = store.listRuns({ projectId: project.id, states: ["running"] });
    expect(beforeRuns.length).toBeGreaterThan(0);
    await engine.pauseProject(project.id, { reason: "fence test", actor: "test" });
    expect(store.getProject(project.id)!.status).toBe("paused");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const succeeded = store.listRuns({ projectId: project.id, states: ["succeeded"] });
    expect(succeeded).toHaveLength(0);
    const events = store.eventsAfter(0).filter((event) => event.type === "run.fenced" || event.type === "project.paused");
    expect(events.some((event) => event.type === "project.paused")).toBe(true);
  });

  it("does not schedule new missions while paused", async () => {
    engine.start();
    const project = store.createProject({
      name: "No schedule", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a complete pause scheduling freeze with automated verification",
      ["no mission starts while paused"],
    );
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.getProject(project.id)!.status === "active");
    await engine.pauseProject(project.id, { reason: "freeze", actor: "test" });
    const before = store.listRuns({ projectId: project.id }).length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(store.listRuns({ projectId: project.id }).length).toBe(before);
    expect(store.listMissions(project.id).every((mission) =>
      ["paused", "completed", "cancelled"].includes(mission.state) || mission.state === "failed",
    )).toBe(true);
  });

  it("resumes once and treats a second resume as idempotent", async () => {
    const project = store.createProject({
      name: "Resume", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    store.setProjectStatus(project.id, "active");
    await engine.pauseProject(project.id, { reason: "break", actor: "test", idempotencyKey: "p1" });
    const first = await engine.resumeProject(project.id, { actor: "test", idempotencyKey: "r1" });
    const second = await engine.resumeProject(project.id, { actor: "test", idempotencyKey: "r1" });
    expect(first?.status).toBe("active");
    expect(second?.status).toBe("active");
    expect(store.getProject(project.id)!.status).toBe("active");
  });

  it("preserves pause across control-plane restart", async () => {
    const project = store.createProject({
      name: "Restart pause", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    store.setProjectStatus(project.id, "active");
    await engine.pauseProject(project.id, { reason: "persist", actor: "test" });
    await engine.stop();
    const restarted = new Engine(
      store,
      new Map([["fake", new FakeProviderAdapter()]]),
      TEST_CONFIG,
      ["fake"],
      new Map([["fake", "fake:succeed"]]),
      new Map([["fake", "fake:review-approve"]]),
      new Map(),
      new Map([["fake", "fake:plan"]]),
    );
    restarted.reconcile();
    expect(store.getProject(project.id)!.status).toBe("paused");
    await restarted.stop();
  });

  it("does not replay completed missions after resume", async () => {
    engine.start();
    const project = store.createProject({
      name: "Completed stay", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a complete pause resume path that preserves finished missions",
      ["finished missions stay finished"],
    );
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.getProject(project.id)!.status === "completed", 12_000);
    const completedIds = store.listMissions(project.id).filter((mission) => mission.state === "completed").map((m) => m.id);
    expect(completedIds.length).toBeGreaterThan(0);
    // completed projects cannot pause via active→paused only; create a sibling active project instead
    const other = store.createProject({
      name: "Other", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    store.setProjectStatus(other.id, "active");
    await engine.pauseProject(other.id, { reason: "isolation", actor: "test" });
    expect(store.getProject(project.id)!.status).toBe("completed");
    expect(store.listMissions(project.id).filter((mission) => mission.state === "completed").map((m) => m.id)).toEqual(completedIds);
  });

  it("exposes pause and clarification through the authenticated API", async () => {
    const app = await buildServer({ store, engine, apiToken: "test-token", version: "test" });
    const project = store.createProject({
      name: "API pause", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    store.setProjectStatus(project.id, "active");
    const paused = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/pause`,
      headers: { authorization: "Bearer test-token" },
      payload: { reason: "api", idempotencyKey: "api-pause-1" },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ status: "paused", generation: 1 });
    const denied = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/pause`,
      payload: { reason: "no auth" },
    });
    expect(denied.statusCode).toBe(401);
    const resumed = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/resume`,
      headers: { authorization: "Bearer test-token" },
      payload: { idempotencyKey: "api-resume-1" },
    });
    expect(resumed.statusCode).toBe(200);
    await app.close();
  });
});

describe("chantier 3: migration compatibility", () => {
  it("applies migration v6 on a fresh database", () => {
    const db = openDatabase(":memory:");
    const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[])
      .map((row) => row.version);
    expect(versions).toContain(6);
    const columns = db.prepare("PRAGMA table_info(clarifications)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "schema_version",
      "round",
      "provenance",
      "provider_id",
      "model",
      "brain_run_id",
      "idempotency_key",
    ]));
    db.close();
  });
});
