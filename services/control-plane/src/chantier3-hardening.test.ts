import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import { DB, migrate, openDatabase } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine, type EngineConfig } from "./engine.js";
import { buildServer } from "./server.js";
import {
  looksLikeSecret,
  repositoryScopeViolation,
  validateAnswerForQuestion,
} from "./clarification-policy.js";
import { Store, StoreConflictError } from "./store.js";

const TEST_CONFIG: EngineConfig = {
  ...DEFAULT_ENGINE_CONFIG,
  tickMs: 20,
  maxWaitMs: 5000,
  maxProviderRetries: 1,
  allowModelSwitch: false,
  allowProviderSwitch: false,
};

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timed out");
}

function makeEngine(
  db: DB,
  providers: Map<string, ProviderAdapter>,
  brain = "fake:plan",
): { store: Store; engine: Engine } {
  const store = new Store(db);
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

function enrollWorker(store: Store, capabilities: string[] = ["shell"], max = 8): { id: string } {
  const id = `wrk_${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 16)}`;
  const ts = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO workers (id, name, status, capabilities, last_heartbeat_at, max_concurrent_runs, token_hash, created_at, updated_at)
       VALUES (?, 'w', 'online', ?, ?, ?, 'x', ?, ?)`,
    )
    .run(id, JSON.stringify(capabilities), ts, max, ts, ts);
  return { id };
}

// ── BUG 1: project-scoped lease revocation preserves cross-project isolation ──

describe("chantier 3 hardening: worker isolation on pause", () => {
  let db: DB;
  let store: Store;
  let engine: Engine;

  beforeEach(() => {
    db = openDatabase(":memory:");
    ({ store, engine } = makeEngine(db, new Map([["fake", new FakeProviderAdapter()]])));
  });
  afterEach(async () => {
    await engine.stop();
    db.close();
  });

  it("revokes only the paused project's sessions on a shared worker", async () => {
    const worker = enrollWorker(store);
    const projectA = store.createProject({
      name: "A", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    const projectB = store.createProject({
      name: "B", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    store.setProjectStatus(projectA.id, "active");
    store.setProjectStatus(projectB.id, "active");

    const tA = store.createTerminal(projectA.id, ["echo", "a"], "/tmp");
    const tB = store.createTerminal(projectB.id, ["echo", "b"], "/tmp");
    const leaseA = store.leaseTerminal(worker.id)!;
    const leaseB = store.leaseTerminal(worker.id)!;
    expect(new Set([leaseA.id, leaseB.id])).toEqual(new Set([tA.id, tB.id]));
    // Map lease tokens back to their project regardless of lease order.
    const tokenFor = (terminalId: string) => (leaseA.id === terminalId ? leaseA.leaseToken : leaseB.leaseToken);

    await engine.pauseProject(projectA.id, { reason: "isolate", actor: "test" });

    // A's session is revoked and its token fenced; B's session is untouched.
    expect(store.validateTerminalLease(tA.id, worker.id, tokenFor(tA.id))).toBe(false);
    expect(store.validateTerminalLease(tB.id, worker.id, tokenFor(tB.id))).toBe(true);
    const sessionB = store.getTerminal(tB.id)!;
    expect(sessionB.state).toBe("starting");
    expect(sessionB.workerId).toBe(worker.id);
    expect(store.getProject(projectB.id)!.status).toBe("active");
  });

  it("does not lease a queued terminal belonging to a paused project", async () => {
    const worker = enrollWorker(store);
    const project = store.createProject({
      name: "P", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    store.setProjectStatus(project.id, "active");
    store.createTerminal(project.id, ["echo", "hi"], "/tmp");
    await engine.pauseProject(project.id, { reason: "freeze", actor: "test" });
    expect(store.leaseTerminal(worker.id)).toBeNull();
  });
});

// ── BUG 2: worker output/exit endpoints are fenced against a paused project ──

describe("chantier 3 hardening: worker endpoints fenced on pause", () => {
  let db: DB;
  let store: Store;
  let engine: Engine;

  beforeEach(() => {
    db = openDatabase(":memory:");
    ({ store, engine } = makeEngine(db, new Map([["fake", new FakeProviderAdapter()]])));
  });
  afterEach(async () => {
    await engine.stop();
    db.close();
  });

  it("refuses output and exit for a paused project even before revocation", async () => {
    const app = await buildServer({ store, engine, apiToken: "t", version: "test" });
    const enroll = await app.inject({
      method: "POST",
      url: "/v1/workers/enroll",
      headers: { authorization: "Bearer t" },
      payload: { name: "w", capabilities: ["shell"], maxConcurrentRuns: 4 },
    });
    const { id: workerId, token } = enroll.json() as { id: string; token: string };
    const project = store.createProject({
      name: "P", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    store.setProjectStatus(project.id, "active");
    const terminal = store.createTerminal(project.id, ["echo", "hi"], "/tmp");
    const leaseRes = await app.inject({
      method: "POST",
      url: "/v1/workers/lease",
      headers: { "x-worker-id": workerId, "x-worker-token": token },
    });
    const lease = (leaseRes.json() as { lease: { id: string; leaseToken: string } }).lease;
    expect(lease.id).toBe(terminal.id);

    // Simulate the race window: mark the durable pause WITHOUT running the
    // post-commit revocation, proving the endpoints fence on live status.
    store.beginProjectPause({ projectId: project.id, reason: "race", actor: "test" });

    const out = await app.inject({
      method: "POST",
      url: `/v1/terminals/${terminal.id}/output`,
      headers: { "x-worker-id": workerId, "x-worker-token": token },
      payload: { text: "late", leaseToken: lease.leaseToken },
    });
    expect(out.statusCode).toBe(409);
    expect(out.json()).toMatchObject({ error: { code: "project_paused" } });

    const exit = await app.inject({
      method: "POST",
      url: `/v1/terminals/${terminal.id}/exit`,
      headers: { "x-worker-id": workerId, "x-worker-token": token },
      payload: { exitCode: 0, state: "succeeded", leaseToken: lease.leaseToken },
    });
    expect(exit.statusCode).toBe(409);
    expect(exit.json()).toMatchObject({ error: { code: "project_paused" } });
    expect(store.getTerminal(terminal.id)!.state).not.toBe("succeeded");
    expect(store.eventsAfter(0).some((e) => e.type === "run.fenced")).toBe(true);
    await app.close();
  });

  it("refuses new terminals for a paused project", async () => {
    const app = await buildServer({ store, engine, apiToken: "t", version: "test" });
    const project = store.createProject({
      name: "P", description: "", repoPath: "/tmp", repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    store.setProjectStatus(project.id, "active");
    await engine.pauseProject(project.id, { reason: "freeze", actor: "test" });
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/terminals`,
      headers: { authorization: "Bearer t" },
      payload: { command: ["ls"] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "project_paused" } });
    await app.close();
  });
});

// ── BUG 3: durable, exactly-once clarification resume ──

describe("chantier 3 hardening: durable clarification resume", () => {
  let db: DB;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("recovers a resume whose brain kick was lost to a crash", async () => {
    // Round 1: an ambiguous provider produces a clarification group.
    let { store, engine } = makeEngine(db, new Map([["fake", new FakeProviderAdapter()]]), "fake:plan-ambiguous");
    const project = store.createProject({
      name: "Crash resume", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a deliberately detailed objective that still lacks material product decisions for safe planning",
      ["resume must be crash-safe"],
    );
    await engine.brain.ensurePlan(project.id, objective.id);
    const group = store.listClarifications(project.id, "open")[0]!;

    // Answer durably but simulate a crash BEFORE engine.resumeAfterClarification.
    store.answerClarification(
      group.id,
      group.questions.map((q) => ({
        questionId: q.id,
        answer: q.answerType === "single_choice"
          ? q.options[0]!.key
          : q.logicalKey === "acceptance-criteria"
            ? "first behavior\nsecond behavior"
            : "mobile is out of scope",
      })),
    );
    expect(store.listPendingClarificationResumes()).toHaveLength(1);
    expect(store.getProject(project.id)!.status).toBe("clarifying");
    await engine.stop();

    // Restart with a non-ambiguous brain; reconcile must drive the resume.
    ({ store, engine } = makeEngine(db, new Map([["fake", new FakeProviderAdapter()]]), "fake:plan"));
    engine.start();
    await waitFor(() => store.activePlan(project.id) !== null, 12_000);
    expect(store.listPendingClarificationResumes()).toHaveLength(0);
    expect(store.listPlans(project.id)).toHaveLength(1);
    await engine.stop();
  });

  it("is idempotent: a double resume yields exactly one plan and no duplicated decisions", async () => {
    let { store, engine } = makeEngine(db, new Map([["fake", new FakeProviderAdapter()]]), "fake:plan-ambiguous");
    const project = store.createProject({
      name: "Double resume", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a deliberately detailed objective that still lacks material product decisions for safe planning",
      ["exactly one plan"],
    );
    await engine.brain.ensurePlan(project.id, objective.id);
    const group = store.listClarifications(project.id, "open")[0]!;
    await engine.stop();

    ({ store, engine } = makeEngine(db, new Map([["fake", new FakeProviderAdapter()]]), "fake:plan"));
    store.answerClarification(
      group.id,
      group.questions.map((q) => ({
        questionId: q.id,
        answer: q.answerType === "single_choice"
          ? q.options[0]!.key
          : q.logicalKey === "acceptance-criteria"
            ? "first behavior\nsecond behavior"
            : "mobile is out of scope",
      })),
    );
    engine.start();
    // Two concurrent resume calls of the same answered group.
    engine.resumeAfterClarification(group.id);
    engine.resumeAfterClarification(group.id);
    await waitFor(() => store.activePlan(project.id) !== null, 12_000);
    expect(store.listPlans(project.id)).toHaveLength(1);
    const decisions = store
      .listBrainEntries(project.id)
      .filter((e) => e.kind === "decision" && e.sources.some((s) => s === `clarification:${group.id}`));
    expect(decisions).toHaveLength(group.questions.filter((q) => q.answer !== null || true).length);
    // No decision key appears twice.
    const keys = decisions.flatMap((d) => d.sources.filter((s) => s.startsWith("question:")));
    expect(new Set(keys).size).toBe(keys.length);
    await engine.stop();
  });
});

// ── BUG 4: late reviewer verdict fenced after pause ──

describe("chantier 3 hardening: async workflow fencing", () => {
  it("fences a reviewer that finishes after the project was paused", { timeout: 20_000 }, async () => {
    // A controlled gate makes this deterministic regardless of runner speed:
    // the reviewer blocks until the test releases it, so the pause always
    // lands before the (late) verdict is produced.
    let started!: () => void;
    const reviewStarted = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    class GatedReviewFake extends FakeProviderAdapter {
      override startRun(input: Parameters<FakeProviderAdapter["startRun"]>[0]) {
        if (!input.model.startsWith("fake:review")) return super.startRun(input);
        let cancelled = false;
        async function* events() {
          yield { type: "output" as const, text: "reviewing\n" };
          started();
          await gate;
          if (!cancelled) yield { type: "completed" as const, resultText: "VERDICT: APPROVE" };
        }
        return { events: events(), cancel: async () => { cancelled = true; } };
      }
    }
    const db = openDatabase(":memory:");
    const { store, engine } = makeEngine(db, new Map([["fake", new GatedReviewFake()]]), "fake:plan");
    engine.start();
    const project = store.createProject({
      name: "Review fence", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a complete workflow that exercises independent review fencing on pause",
      ["review fencing works"],
    );
    engine.analyzeObjective(project.id, objective.id);
    await reviewStarted; // reviewer is blocked at the gate
    await engine.pauseProject(project.id, { reason: "pause mid-review", actor: "test" });
    release(); // let the late verdict arrive; it must be fenced
    await new Promise((resolve) => setTimeout(resolve, 300));
    // No mission may be approved/integrated/completed by the late verdict.
    const states = store.listMissions(project.id).map((m) => m.state);
    expect(states.every((s) => !["approved", "integrated", "completed"].includes(s))).toBe(true);
    expect(store.getProject(project.id)!.status).toBe("paused");
    const reviewPassed = store
      .listMissions(project.id)
      .flatMap((m) => store.listCheckpoints(m.id))
      .some((c) => c.kind === "review" && c.status === "passed");
    expect(reviewPassed).toBe(false);
    await engine.stop();
    db.close();
  });
});

// ── Pause/resume state-transition coverage ──

describe("chantier 3 hardening: pause/resume transitions", () => {
  let db: DB;
  let store: Store;
  let engine: Engine;

  beforeEach(() => {
    db = openDatabase(":memory:");
    ({ store, engine } = makeEngine(db, new Map([["fake", new FakeProviderAdapter()]])));
  });
  afterEach(async () => {
    await engine.stop();
    db.close();
  });

  // Drive the project to `status` through only legal transitions.
  const ROUTES: Record<string, string[]> = {
    draft: [],
    clarifying: ["clarifying"],
    planning: ["planning"],
    active: ["active"],
    blocked: ["active", "blocked"],
    completed: ["active", "completed"],
    archived: ["active", "completed", "archived"],
  };
  function project(status: string): string {
    const p = store.createProject({
      name: status, description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    for (const step of ROUTES[status] ?? []) store.setProjectStatus(p.id, step as never);
    return p.id;
  }

  it("pauses from draft, planning, active and blocked", async () => {
    for (const status of ["draft", "planning", "active", "blocked"]) {
      const id = project(status);
      const state = await engine.pauseProject(id, { reason: "s", actor: "test" });
      expect(state?.status).toBe("paused");
      expect(store.getProject(id)!.status).toBe("paused");
    }
  });

  it("refuses to pause a completed or archived project", async () => {
    const completed = project("active");
    store.setProjectStatus(completed, "completed");
    await expect(engine.pauseProject(completed, { reason: "no", actor: "test" })).rejects.toThrow();
    expect(store.getProject(completed)!.status).toBe("completed");

    const archived = project("active");
    store.setProjectStatus(archived, "archived");
    await expect(engine.pauseProject(archived, { reason: "no", actor: "test" })).rejects.toThrow();
    expect(store.getProject(archived)!.status).toBe("archived");
  });

  it("treats a second pause as idempotent and refuses resume when not paused", async () => {
    const id = project("active");
    const first = await engine.pauseProject(id, { reason: "a", actor: "test" });
    const second = await engine.pauseProject(id, { reason: "b", actor: "test" });
    expect(first?.status).toBe("paused");
    expect(second?.status).toBe("paused");
    expect(store.getPauseGeneration(id)).toBe(1); // no second generation bump
    await engine.resumeProject(id, { actor: "test" });
    await expect(engine.resumeProject(id, { actor: "test" })).rejects.toThrow(StoreConflictError);
  });
});

// ── BUG 5: clarification validation hardening (pure functions) ──

describe("chantier 3 hardening: clarification validation", () => {
  it("rejects Windows, UNC, absolute and encoded traversal paths", () => {
    expect(repositoryScopeViolation("src/app.ts")).toBeNull();
    expect(repositoryScopeViolation("a/b/c.txt")).toBeNull();
    expect(repositoryScopeViolation("/etc/passwd")).not.toBeNull();
    expect(repositoryScopeViolation("C:\\Windows\\system32")).not.toBeNull();
    expect(repositoryScopeViolation("\\\\server\\share")).not.toBeNull();
    expect(repositoryScopeViolation("../secrets")).not.toBeNull();
    expect(repositoryScopeViolation("a\\b")).not.toBeNull();
    expect(repositoryScopeViolation("%2e%2e/secrets")).not.toBeNull();
    expect(repositoryScopeViolation("~/secrets")).not.toBeNull();
  });

  it("rejects duplicated multi_choice answers", () => {
    const question = {
      id: "q1", logicalKey: "targets", category: "scope" as const,
      question: "Which targets?", reason: "scope", answerType: "multi_choice" as const,
      options: [{ key: "web", label: "Web" }, { key: "api", label: "API" }],
      required: true, acceptanceCriteriaRefs: [], blockedDecisions: [], blockedMissions: [],
      displayOrder: 0, status: "pending" as const, answer: null, answerValue: null,
    };
    const dup = validateAnswerForQuestion(question, { type: "multi_choice", value: ["web", "web"] });
    expect(dup.some((i) => /duplicated/.test(i.message))).toBe(true);
    const ok = validateAnswerForQuestion(question, { type: "multi_choice", value: ["web", "api"] });
    expect(ok).toEqual([]);
  });

  it("flags real secrets in text answers but not the mere word token", () => {
    expect(looksLikeSecret("we use a token-based authentication approach")).toBe(false);
    expect(looksLikeSecret("the password field should be required")).toBe(false);
    expect(looksLikeSecret("password = hunter2secret")).toBe(true);
    expect(looksLikeSecret("Authorization: Bearer abcdef0123456789abcd")).toBe(true);
    expect(looksLikeSecret("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
  });

  it("closes optional unanswered questions when the group is answered", () => {
    const db = openDatabase(":memory:");
    const store = new Store(db);
    const project = store.createProject({
      name: "Optional", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "supervised",
    });
    const objective = store.createObjective(project.id, "an objective with enough length to skip the gate", ["done"]);
    const group = store.createClarification({
      projectId: project.id,
      objectiveId: objective.id,
      provenance: "deterministic_policy",
      questions: [
        {
          logicalKey: "must-answer", category: "scope", question: "Required?", reason: "r",
          answerType: "text", options: [], required: true, acceptanceCriteriaRefs: [],
          blockedDecisions: [], blockedMissions: [], displayOrder: 0,
        },
        {
          logicalKey: "may-skip", category: "other", question: "Optional?", reason: "r",
          answerType: "text", options: [], required: false, acceptanceCriteriaRefs: [],
          blockedDecisions: [], blockedMissions: [], displayOrder: 1,
        },
      ],
    });
    const required = group.questions.find((q) => q.logicalKey === "must-answer")!;
    const answered = store.answerClarification(group.id, [{ questionId: required.id, answer: "yes" }]);
    expect(answered.status).toBe("answered");
    const optional = answered.questions.find((q) => q.logicalKey === "may-skip")!;
    expect(optional.status).toBe("cancelled");
    db.close();
  });
});

// ── Migration v6 → v7 from a populated earlier database ──

describe("chantier 3 hardening: migration from a populated v5 base", () => {
  it("preserves rows and adds the new columns without loss", () => {
    const db = openDatabase(":memory:");
    // Rewind: apply only up to v5, seed legacy data, then migrate to head.
    // (openDatabase already ran head; rebuild a clean partial DB instead.)
    db.close();
    const partial = new DB(new DatabaseSync(":memory:"));
    partial.pragma("foreign_keys = ON");
    migrate(partial, 5);
    const ts = new Date().toISOString();
    partial
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, status, autonomy_profile, description, created_at, updated_at)
         VALUES ('prj_legacy', 'default', 'Legacy', 'clarifying', 'supervised', '', ?, ?)`,
      )
      .run(ts, ts);
    partial
      .prepare(
        `INSERT INTO objectives (id, project_id, revision, text, acceptance_criteria, created_at, updated_at)
         VALUES ('obj_legacy', 'prj_legacy', 1, 'legacy objective', '[]', ?, ?)`,
      )
      .run(ts, ts);
    partial
      .prepare(
        `INSERT INTO clarifications (id, project_id, objective_id, status, questions, created_at, updated_at)
         VALUES ('clr_legacy', 'prj_legacy', 'obj_legacy', 'open', '[{"id":"legacy-scope","question":"legacy?","answer":null}]', ?, ?)`,
      )
      .run(ts, ts);

    migrate(partial);

    const versions = (partial.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[])
      .map((r) => r.version);
    expect(versions).toContain(6);
    expect(versions).toContain(7);
    const columns = (partial.prepare("PRAGMA table_info(clarifications)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["resume_pending", "provenance", "round", "idempotency_key"]));
    const clarification = partial.prepare("SELECT project_id, resume_pending FROM clarifications WHERE id = 'clr_legacy'").get() as {
      project_id: string;
      resume_pending: number;
    };
    expect(clarification.project_id).toBe("prj_legacy");
    expect(clarification.resume_pending).toBe(0);
    // A legacy clarification row still loads through the store normalizer.
    const store = new Store(partial);
    const loaded = store.getClarification("clr_legacy");
    expect(loaded?.projectId).toBe("prj_legacy");
    expect(loaded?.questions).toHaveLength(1);
    partial.close();
  });
});
