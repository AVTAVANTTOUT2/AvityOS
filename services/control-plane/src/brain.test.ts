import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll, git, initRepo } from "@avityos/git";
import { unblockedMissions } from "@avityos/orchestration";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import { extractStructuredObject } from "./brain.js";
import { openDatabase, type DB } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine, type EngineConfig } from "./engine.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";

const TEST_CONFIG: EngineConfig = {
  ...DEFAULT_ENGINE_CONFIG,
  tickMs: 20,
  maxWaitMs: 5000,
  maxProviderRetries: 1,
  allowModelSwitch: false,
  allowProviderSwitch: false,
};

interface EngineOptions {
  author?: string;
  review?: string;
  brain?: string;
  config?: Partial<EngineConfig>;
  providers?: Map<string, ProviderAdapter>;
  chain?: string[];
  brainModels?: Map<string, string>;
}

function makeEngine(db: DB, options: EngineOptions = {}): { store: Store; engine: Engine } {
  const store = new Store(db);
  const providers = options.providers ?? new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
  const engine = new Engine(
    store,
    providers,
    { ...TEST_CONFIG, ...options.config },
    options.chain ?? ["fake"],
    new Map([["fake", options.author ?? "fake:succeed"]]),
    new Map([["fake", options.review ?? "fake:review-approve"]]),
    new Map(),
    options.brainModels ?? new Map([["fake", options.brain ?? "fake:plan"]]),
  );
  return { store, engine };
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

async function makeFixtureRepo(scratch: string): Promise<string> {
  const repo = join(scratch, "repo");
  await git(scratch, "init", "-b", "main", repo);
  await initRepo(repo);
  await writeFile(join(repo, "README.md"), "# brain fixture\n");
  await writeFile(join(repo, ".env"), "SECRET_TOKEN=do-not-leak-me\n");
  await git(repo, "add", "-A", "-f");
  await git(repo, "commit", "--no-verify", "--no-gpg-sign", "-m", "chore: initial commit");
  return repo;
}

/** Fake provider that records every prompt it receives. */
class RecordingFake extends FakeProviderAdapter {
  readonly systemPrompts: string[] = [];
  readonly userPrompts: string[] = [];
  readonly workingDirectories: (string | undefined)[] = [];
  readonly maxOutputTokens: (number | undefined)[] = [];
  override startRun(input: Parameters<FakeProviderAdapter["startRun"]>[0]) {
    this.systemPrompts.push(input.systemPrompt);
    this.userPrompts.push(input.userPrompt);
    this.workingDirectories.push(input.cwd);
    this.maxOutputTokens.push(input.maxOutputTokens);
    return super.startRun(input);
  }
}

/** Provider that ignores timeoutMs and only stops when the pipeline cancels it. */
class NeverCompletingFake extends FakeProviderAdapter {
  cancelled = false;
  override startRun() {
    let release: (() => void) | null = null;
    let cancelled = false;
    async function* events() {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (!cancelled) {
        yield { type: "completed" as const, resultText: "unexpected late result" };
      }
    }
    return {
      events: events(),
      cancel: async () => {
        this.cancelled = true;
        cancelled = true;
        release?.();
      },
    };
  }
}

let scratch: string;
let db: DB;
let store: Store;
let engine: Engine;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "avity-brain-"));
  db = openDatabase(":memory:");
  ({ store, engine } = makeEngine(db));
});

afterEach(async () => {
  await engine.stop();
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("structured output extraction", () => {
  it("extracts fenced and inline JSON objects from textual answers", () => {
    expect(extractStructuredObject('prose before\n```json\n{"a": 1}\n```\nafter')).toEqual({ a: 1 });
    expect(extractStructuredObject('Result: {"nested": {"b": "x}"}} trailing')).toEqual({ nested: { b: "x}" } });
    expect(extractStructuredObject("no json here")).toBeNull();
    expect(extractStructuredObject("broken { not json")).toBeNull();
  });
});

describe("AI brain pipeline", () => {
  it("really calls the reasoning provider for analysis, architecture and plan, and persists valid output", async () => {
    const recording = new RecordingFake();
    ({ store, engine } = makeEngine(db, {
      providers: new Map<string, ProviderAdapter>([["fake", recording]]),
    }));
    const repo = await makeFixtureRepo(scratch);
    const project = store.createProject({
      name: "Brain", description: "", repoPath: repo, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver the analyzed feature with structured planning evidence",
      ["feature is implemented", "documentation is updated"],
    );
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.activePlan(project.id) !== null);

    // the provider was really called once per pipeline step
    const steps = recording.userPrompts
      .map((prompt) => prompt.match(/^AVITY_BRAIN_STEP: (.*)$/m)?.[1])
      .filter(Boolean);
    expect(steps).toEqual(["analysis", "architecture", "plan"]);
    expect(recording.workingDirectories).toEqual([repo, repo, repo]);
    expect(recording.maxOutputTokens).toEqual([8_192, 16_384, 16_384]);
    // the prompt carries the real repository snapshot, never its secrets
    expect(recording.userPrompts[0]).toContain("README.md");
    expect(recording.userPrompts.join()).not.toContain("do-not-leak-me");

    // durable brain runs with provenance, one succeeded per step
    const runs = store.listBrainRuns(project.id, objective.id);
    expect(runs.map((run) => [run.step, run.state])).toEqual([
      ["analysis", "succeeded"],
      ["architecture", "succeeded"],
      ["plan", "succeeded"],
    ]);
    expect(runs.every((run) => run.provenance === "fake_fixture")).toBe(true);
    const analysis = runs[0]!.output as { summary: string; feasibility: string };
    expect(analysis.feasibility).toBe("feasible");
    const architecture = runs[1]!.output as { overview: string; components: unknown[] };
    expect(architecture.components.length).toBeGreaterThan(0);

    // the persisted plan version references objective, snapshot and runs
    const plan = store.activePlan(project.id)!;
    expect(plan.objectiveId).toBe(objective.id);
    expect(plan.provenance).toBe("fake_fixture");
    expect(plan.providerId).toBe("fake");
    expect(plan.model).toBe("fake:plan");
    expect(plan.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.analysisRunId).toBe(runs[0]!.id);
    expect(plan.planRunId).toBe(runs[2]!.id);

    // complete mission contracts persisted with server-minted ids
    const missions = store.listMissions(project.id);
    expect(missions).toHaveLength(2);
    for (const mission of missions) {
      expect(mission.id).toMatch(/^msn_/);
      expect(mission.logicalKey).toMatch(/^mission-/);
      expect(mission.planId).toBe(plan.id);
      expect(mission.contract.rationale.length).toBeGreaterThan(0);
      expect(mission.contract.forbiddenPaths).toContain("**/.env");
      expect(mission.contract.requiredChecks).toContain("architecture_rule");
      expect(mission.contract.checkCommands.architecture_rule).toEqual(["git", "diff", "--check", "HEAD"]);
      expect(mission.contract.timeoutSeconds).toBe(900);
      expect(mission.contract.escalationConditions.length).toBeGreaterThan(0);
    }

    // events and fixture identification
    const events = store.eventsAfter(0, project.id);
    expect(events.filter((event) => event.type === "brain.step_changed").length).toBeGreaterThanOrEqual(6);
    expect(events.some((event) => event.type === "plan.created")).toBe(true);
    const brainEntries = store.listBrainEntries(project.id);
    expect(brainEntries.some((entry) => entry.title.includes("[fake_fixture"))).toBe(true);
    expect(store.verifyAuditChain()).toBe(true);
  });

  it("opens a structured AI clarification group when analysis is ambiguous", async () => {
    ({ store, engine } = makeEngine(db, { brain: "fake:plan-ambiguous" }));
    const project = store.createProject({
      name: "Analysis gate", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a deliberately detailed objective whose material feasibility is decided by the reasoning provider",
      ["the analysis outcome controls whether execution may begin"],
    );

    const result = await engine.brain.ensurePlan(project.id, objective.id);

    expect(result.status).toBe("clarifying");
    expect(store.getProject(project.id)!.status).toBe("clarifying");
    expect(store.activePlan(project.id)).toBeNull();
    expect(store.listMissions(project.id)).toEqual([]);
    expect(store.listBrainRuns(project.id, objective.id).map((run) => run.step)).toEqual([
      "analysis",
      "clarification",
    ]);
    const clarification = store.listClarifications(project.id, "open")[0]!;
    expect(clarification.provenance).toBe("fake_fixture");
    expect(clarification.questions.length).toBeGreaterThanOrEqual(2);
    expect(clarification.questions.every((question) => question.logicalKey.length > 0)).toBe(true);
    expect(store.getObjective(objective.id)!.analysisSummary).toContain("Deterministic fixture analysis");
  });

  it("blocks after an infeasible AI analysis instead of scheduling work", async () => {
    ({ store, engine } = makeEngine(db, { brain: "fake:plan-infeasible" }));
    const project = store.createProject({
      name: "Infeasible gate", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver a deliberately detailed objective whose material feasibility is decided by the reasoning provider",
      ["the analysis outcome controls whether execution may begin"],
    );

    const result = await engine.brain.ensurePlan(project.id, objective.id);

    expect(result.status).toBe("blocked");
    expect(store.getProject(project.id)!.status).toBe("blocked");
    expect(store.activePlan(project.id)).toBeNull();
    expect(store.listMissions(project.id)).toEqual([]);
    expect(store.listBrainRuns(project.id, objective.id).map((run) => run.step)).toEqual(["analysis"]);
    expect(store.getObjective(objective.id)!.analysisSummary).toContain("Deterministic fixture analysis");
    expect(store.listApprovals("open", project.id)[0]?.description).toContain("infeasible");
  });

  it("redacts provider-shaped secrets from durable brain artifacts", () => {
    const secret = ["sk-", "provideroutputcredential", "1234567890"].join("");
    const project = store.createProject({
      name: "Redaction", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Persist only redacted reasoning output", ["no secret remains"]);
    store.setObjectiveAnalysis(objective.id, `analysis ${secret}`);
    store.addBrainEntry(project.id, "risk", `risk ${secret}`, `body ${secret}`, [`source:${secret}`]);
    const persisted = store.createBrainPlan({
      projectId: project.id,
      objectiveId: objective.id,
      summary: `plan ${secret}`,
      milestones: [{ id: "deliver", title: `title ${secret}`, description: `description ${secret}`, order: 0 }],
      provenance: "live",
      providerId: "fixture",
      model: "fixture",
      snapshotHash: null,
      analysisRunId: null,
      architectureRunId: null,
      planRunId: null,
      idempotencyKey: null,
      replan: { trigger: "new_evidence", cause: `cause ${secret}`, sources: [`evidence:${secret}`], basedOnVersion: 0 },
      missions: [],
    });

    const durable = JSON.stringify({
      objective: store.getObjective(objective.id),
      entries: store.listBrainEntries(project.id),
      plan: persisted.plan,
      events: store.eventsAfter(0, project.id),
    });
    expect(durable).not.toContain(secret);
    expect(durable).toContain("[REDACTED]");
  });

  it("rejects invalid JSON, repairs it within the bound and records the failed attempt", async () => {
    ({ store, engine } = makeEngine(db, { brain: "fake:plan-invalid-once" }));
    const project = store.createProject({
      name: "Repair", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Deliver a feature whose first plan output is invalid", ["works"]);
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.activePlan(project.id) !== null);

    const analysisRuns = store.listBrainRuns(project.id, objective.id).filter((run) => run.step === "analysis");
    expect(analysisRuns.map((run) => run.state)).toEqual(["failed", "succeeded"]);
    expect(analysisRuns[0]!.errorCategory).toBe("invalid_request");
    expect(analysisRuns[0]!.errorDetail).toContain("invalid structured output");
    expect(analysisRuns[1]!.attempt).toBe(2);
    expect(store.getProject(project.id)!.status).not.toBe("blocked");
  });

  it("blocks the project after exhausted repair instead of substituting a heuristic plan", async () => {
    // fake:succeed answers with prose that contains no JSON object at all
    ({ store, engine } = makeEngine(db, { brain: "fake:succeed" }));
    const project = store.createProject({
      name: "NoHeuristic", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Deliver a feature the brain cannot structure", ["works"]);
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.getProject(project.id)!.status === "blocked");

    expect(store.listPlans(project.id)).toHaveLength(0);
    expect(store.listMissions(project.id)).toHaveLength(0);
    const approvals = store.listApprovals("open", project.id);
    expect(approvals.some((approval) => approval.title === "AI planning blocked")).toBe(true);
    const runs = store.listBrainRuns(project.id, objective.id);
    // initial attempt + bounded repairs, all failed, none silently replaced
    expect(runs).toHaveLength(1 + TEST_CONFIG.maxPlanRepairAttempts);
    expect(runs.every((run) => run.state === "failed")).toBe(true);
  });

  it("applies the provider fallback chain to reasoning without silent substitution", async () => {
    const providers = new Map<string, ProviderAdapter>([
      ["limited", new FakeProviderAdapter("limited")],
      ["fake", new FakeProviderAdapter()],
    ]);
    ({ store, engine } = makeEngine(db, {
      providers,
      chain: ["limited", "fake"],
      config: { allowProviderSwitch: true },
      brainModels: new Map([
        ["limited", "fake:fail-rate_limited"],
        ["fake", "fake:plan"],
      ]),
    }));
    const project = store.createProject({
      name: "Fallback", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Deliver a feature through the reasoning fallback chain", ["works"]);
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.activePlan(project.id) !== null);

    const plan = store.activePlan(project.id)!;
    expect(plan.providerId).toBe("fake");
    const runs = store.listBrainRuns(project.id, objective.id);
    expect(runs.some((run) => run.providerId === "limited" && run.state === "failed")).toBe(true);
    const fallbackEvents = store
      .eventsAfter(0, project.id)
      .filter((event) => event.type === "provider.fallback" && event.payload.phase === "brain");
    expect(fallbackEvents.some((event) => event.payload.action === "switch_provider")).toBe(true);
  });

  it("creates a real parallel DAG whose independent missions become ready together", async () => {
    ({ store, engine } = makeEngine(db, { brain: "fake:plan-dag" }));
    const project = store.createProject({
      name: "DAG", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(
      project.id,
      "Deliver two independent tracks then verify them together",
      ["track A works", "track B works"],
    );
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.listMissions(project.id).length === 3);

    const missions = store.listMissions(project.id);
    const byKey = new Map(missions.map((mission) => [mission.logicalKey, mission]));
    const dependencies = store.listDependencies(project.id);
    const finalQa = byKey.get("final-qa")!;
    expect(dependencies).toHaveLength(2);
    expect(dependencies.every((dep) => dep.missionId === finalQa.id)).toBe(true);

    // both independent missions are unblocked together; the join is not
    const unblocked = unblockedMissions(missions, dependencies).map((mission) => mission.logicalKey);
    expect(unblocked.sort()).toEqual(["mission-1", "mission-2"]);
    expect(unblocked).not.toContain("final-qa");
    // the scheduler can start them in parallel within the same tick
    await engine.tick();
    const started = ["mission-1", "mission-2"].map(
      (key) => store.getMission(byKey.get(key)!.id)!.state,
    );
    expect(started.every((state) => state !== "proposed")).toBe(true);
    expect(store.getMission(finalQa.id)!.state).toBe("proposed");
  });

  it("accounts planning usage against the project budget", async () => {
    const project = store.createProject({
      name: "PlanningBudget", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    store.setBudget(project.id, 100);
    const objective = store.createObjective(project.id, "Deliver a feature with accounted planning usage", ["works"]);
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.activePlan(project.id) !== null);

    const planningUsage = store.db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS tokens FROM usage_records WHERE project_id = ? AND run_id IS NULL")
      .get(project.id) as { count: number; tokens: number };
    expect(planningUsage.count).toBeGreaterThanOrEqual(3);
    expect(planningUsage.tokens).toBeGreaterThan(0);
    const runs = store.listBrainRuns(project.id, objective.id);
    expect(runs.every((run) => run.inputTokens > 0)).toBe(true);
  });

  it("replans idempotently from evidence and never replaces an in-flight mission", async () => {
    const project = store.createProject({
      name: "Replan", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Deliver a feature we will replan from evidence", ["works"]);
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.activePlan(project.id) !== null);
    const planV1 = store.activePlan(project.id)!;
    const mission = store.listMissions(project.id)[0]!;

    // an in-flight mission defers the replan and is never replaced
    store.transitionMission(mission.id, "ready", "test");
    store.transitionMission(mission.id, "assigned", "test");
    const deferred = await engine.brain.ensurePlan(project.id, objective.id, {
      trigger: "new_evidence",
      cause: "durable decision changed",
      sources: ["decision:test"],
    });
    expect(deferred.status).toBe("deferred");
    expect(store.getMission(mission.id)!.state).toBe("assigned");
    expect(store.activePlan(project.id)!.id).toBe(planV1.id);

    // once nothing is in flight, the same evidence produces exactly one v2
    store.transitionMission(mission.id, "ready", "test");
    const replanned = await engine.brain.ensurePlan(project.id, objective.id, {
      trigger: "new_evidence",
      cause: "durable decision changed",
      sources: ["decision:test"],
    });
    expect(replanned.status).toBe("planned");
    const planV2 = store.activePlan(project.id)!;
    expect(planV2.version).toBe(planV1.version + 1);
    expect(planV2.replanTrigger).toBe("new_evidence");
    expect(planV2.replanCause).toContain("durable decision changed");
    expect(planV2.replanSources).toEqual(["decision:test"]);
    expect(planV2.basedOnVersion).toBe(planV1.version);
    const evidenceHash = createHash("sha256")
      .update(JSON.stringify({ cause: "durable decision changed", sources: ["decision:test"] }))
      .digest("hex")
      .slice(0, 16);
    expect(store.findIdempotent(`replan:${project.id}:${objective.id}:new_evidence:${evidenceHash}`)).toEqual({
      resourceType: "plan",
      resourceId: planV2.id,
    });
    // history preserved, old cancellable mission cancelled
    expect(store.getPlan(planV1.id)!.active).toBe(false);
    expect(store.getMission(mission.id)!.state).toBe("cancelled");

    const repeated = await engine.brain.ensurePlan(project.id, objective.id, {
      trigger: "new_evidence",
      cause: "durable decision changed",
      sources: ["decision:test"],
    });
    expect(repeated.status).toBe("exists");
    expect(repeated.status === "exists" && repeated.plan.id).toBe(planV2.id);
    expect(store.listPlans(project.id)).toHaveLength(2);

    const newEvidence = await engine.brain.ensurePlan(project.id, objective.id, {
      trigger: "new_evidence",
      cause: "durable decision changed",
      sources: ["decision:additional-proof"],
    });
    expect(newEvidence.status).toBe("planned");
    expect(store.listPlans(project.id)).toHaveLength(3);
  });

  it("enforces brain timeouts even when an adapter ignores timeoutMs", async () => {
    const provider = new NeverCompletingFake();
    ({ store, engine } = makeEngine(db, {
      providers: new Map<string, ProviderAdapter>([["fake", provider]]),
      config: { brainStepTimeoutMs: 25, maxProviderRetries: 0 },
    }));
    const project = store.createProject({
      name: "Timeout", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Bound every brain provider call", ["timeout is durable"]);

    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.getProject(project.id)?.status === "blocked", 1000);

    expect(provider.cancelled).toBe(true);
    expect(store.listBrainRuns(project.id, objective.id)[0]).toMatchObject({
      state: "failed",
      errorCategory: "transient_network",
    });
  });

  it("rejects a stale replan base without replacing the active plan", async () => {
    const project = store.createProject({
      name: "Stale replan", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Keep concurrent replans ordered", ["active plan is preserved"]);
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.activePlan(project.id) !== null);
    const active = store.activePlan(project.id)!;

    expect(() =>
      store.createBrainPlan({
        projectId: project.id,
        objectiveId: objective.id,
        summary: "stale replacement",
        milestones: [],
        provenance: "live",
        providerId: "test",
        model: "test",
        snapshotHash: null,
        analysisRunId: null,
        architectureRunId: null,
        planRunId: null,
        idempotencyKey: null,
        replan: {
          trigger: "new_evidence",
          cause: "concurrent stale result",
          sources: ["evidence:stale"],
          basedOnVersion: active.version - 1,
        },
        missions: [],
      }),
    ).toThrow(/stale replan base/i);
    expect(store.activePlan(project.id)?.id).toBe(active.id);
    expect(store.listPlans(project.id)).toHaveLength(1);
  });

  it("produces plan v2 from a real mission failure, bounded by the replan limit", async () => {
    const repo = await makeFixtureRepo(scratch);
    // fake:succeed edits nothing, so repository missions fail deterministic
    // validation ("no file changes") through the whole correction loop
    ({ store, engine } = makeEngine(db, {
      author: "fake:succeed",
      config: { maxReplansPerObjective: 1 },
    }));
    engine.start();
    const project = store.createProject({
      name: "EvidenceReplan", description: "", repoPath: repo, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Deliver a repository change that the author never produces", ["a real diff exists"]);
    engine.analyzeObjective(project.id, objective.id);

    await waitFor(() => store.listPlans(project.id).length >= 2, 15_000);
    const plans = store.listPlans(project.id);
    const planV2 = plans.find((plan) => plan.version === 2)!;
    expect(planV2.replanTrigger).toBe("mission_failed");
    expect(planV2.replanCause).toContain("failed after bounded correction");
    expect(planV2.replanSources.some((source) => source.startsWith("mission:"))).toBe(true);
    // the failed mission stays in history, but its stale intervention cannot
    // restart v1 after v2 becomes active
    const failedV1 = store.listMissions(project.id).find((mission) => mission.planId === plans[0]!.id)!;
    expect(failedV1.state).toBe("failed");
    const staleApproval = store
      .listApprovals(undefined, project.id)
      .find((approval) => approval.missionId === failedV1.id && approval.title === "Correction limit reached")!;
    expect(staleApproval.status).toBe("withdrawn");
    expect(() => store.resolveApproval(staleApproval.id, "approved", "retry old work")).toThrow(/withdrawn/);

    // defence in depth: even an already-answered stale approval from another
    // process cannot execute a mission from an inactive plan
    const injectedStale = store.createApproval(project.id, failedV1.id, "Stale retry", "test only");
    store.resolveApproval(injectedStale.id, "approved", "simulate a cross-process race");
    engine.applyApprovalDecision(injectedStale.id);
    expect(store.getMission(failedV1.id)!.state).toBe("failed");
    expect(
      store.eventsAfter(0, project.id).some(
        (event) => event.type === "approval.withdrawn" && event.payload.approvalId === staleApproval.id,
      ),
    ).toBe(true);

    // the second failure hits the replan bound: blocked, no infinite loop
    await waitFor(
      () => store.listApprovals("open", project.id).some((approval) => approval.title === "Replan limit reached"),
      15_000,
    );
    expect(store.listPlans(project.id)).toHaveLength(2);
    expect(store.getProject(project.id)!.status).toBe("blocked");
  }, 30_000);

  it("recovers after a restart: orphan brain run failed once, single active plan", async () => {
    ({ store, engine } = makeEngine(db, { brain: "fake:plan-slow" }));
    engine.start();
    const project = store.createProject({
      name: "Recovery", description: "", repoPath: null, repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });
    const objective = store.createObjective(project.id, "Deliver a feature across a control plane restart", ["works"]);
    engine.analyzeObjective(project.id, objective.id);
    await waitFor(() => store.listBrainRuns(project.id, objective.id).some((run) => run.state === "running"));
    await engine.stop(); // simulated crash: the brain run stays `running`

    const { store: store2, engine: engine2 } = makeEngine(db, { brain: "fake:plan" });
    engine2.start();
    try {
      await waitFor(() => store2.getProject(project.id)!.status === "completed", 10_000);
      const runs = store2.listBrainRuns(project.id, objective.id);
      const orphans = runs.filter((run) => run.errorDetail?.includes("restarted"));
      expect(orphans).toHaveLength(1);
      const plans = store2.listPlans(project.id);
      expect(plans.filter((plan) => plan.active)).toHaveLength(1);
      // reconcile ran once; a second reconcile would not duplicate the plan
      engine2.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(store2.listPlans(project.id).filter((plan) => plan.active)).toHaveLength(1);
      expect(store2.listPlans(project.id)).toHaveLength(plans.length);
    } finally {
      await engine2.stop();
    }
  });

  it("keeps two homonymous projects completely isolated through planning", async () => {
    engine.start();
    const first = store.createProject({ name: "Same name", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    const second = store.createProject({ name: "Same name", description: "", repoPath: null, repoRemoteUrl: null, autonomyProfile: "autonomous_with_checkpoints" });
    const firstObjective = store.createObjective(first.id, "Deliver the first isolated homonymous objective", ["first only"]);
    const secondObjective = store.createObjective(second.id, "Deliver the second isolated homonymous objective", ["second only"]);
    engine.analyzeObjective(first.id, firstObjective.id);
    engine.analyzeObjective(second.id, secondObjective.id);
    await waitFor(() => store.activePlan(first.id) !== null && store.activePlan(second.id) !== null);

    expect(store.activePlan(first.id)!.projectId).toBe(first.id);
    expect(store.activePlan(second.id)!.projectId).toBe(second.id);
    expect(store.listBrainRuns(first.id).every((run) => run.projectId === first.id)).toBe(true);
    expect(store.listBrainRuns(second.id).every((run) => run.projectId === second.id)).toBe(true);
    expect(store.listMissions(first.id)[0]!.contract.acceptanceCriteria).toEqual(["first only"]);
    expect(store.listMissions(second.id)[0]!.contract.acceptanceCriteria).toEqual(["second only"]);
    expect(store.listDependencies(first.id).every((dep) => store.getMission(dep.missionId)!.projectId === first.id)).toBe(true);
  });

  it("exposes only really persisted brain state through the public API", async () => {
    const app = await buildServer({ store, engine, version: "test" });
    try {
      const missing = await app.inject({ method: "GET", url: "/v1/projects/prj_missing/brain/state" });
      expect(missing.statusCode).toBe(404);

      const project = store.createProject({
        name: "State", description: "", repoPath: null, repoRemoteUrl: null,
        autonomyProfile: "autonomous_with_checkpoints",
      });
      const before = await app.inject({ method: "GET", url: `/v1/projects/${project.id}/brain/state` });
      expect(before.json()).toMatchObject({ status: "idle", plan: null, runs: [] });

      const objective = store.createObjective(project.id, "Deliver a feature with public brain state", ["works"]);
      engine.analyzeObjective(project.id, objective.id);
      await waitFor(() => store.activePlan(project.id) !== null);

      const after = await app.inject({ method: "GET", url: `/v1/projects/${project.id}/brain/state` });
      const state = after.json() as {
        status: string;
        runs: { step: string; state: string; provenance: string }[];
        analysis: { summary: string } | null;
        architecture: { overview: string } | null;
        plan: { version: number; provenance: string; providerId: string };
        replanCount: number;
      };
      expect(state.status).toBe("planned");
      expect(state.runs.map((run) => run.step)).toEqual(["analysis", "architecture", "plan"]);
      expect(state.runs.every((run) => run.provenance === "fake_fixture")).toBe(true);
      expect(state.analysis?.summary).toContain("fixture analysis");
      expect(state.architecture?.overview).toContain("fixture architecture");
      expect(state.plan).toMatchObject({ version: 1, provenance: "fake_fixture", providerId: "fake" });
      expect(state.replanCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});
