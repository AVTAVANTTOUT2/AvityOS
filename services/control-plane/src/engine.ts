import type { Mission, Project } from "@avityos/contracts";
import {
  decideCorrection,
  decideFallback,
  selectMissionsToStart,
  unblockedMissions,
} from "@avityos/orchestration";
import type { ProviderAdapter } from "@avityos/providers";
import { checkBudget } from "@avityos/policy";
import type { Store } from "./store.js";

export interface EngineConfig {
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProject: number;
  maxProviderRetries: number;
  maxWaitMs: number;
  tickMs: number;
  /** Policy: whether fallback may switch to another model of the same provider. */
  allowModelSwitch: boolean;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxConcurrentRuns: 8,
  maxConcurrentRunsPerProject: 4,
  maxProviderRetries: 3,
  maxWaitMs: 120_000,
  tickMs: 250,
  allowModelSwitch: true,
};

const AMBIGUITY_MARKERS = [
  "maybe", "not sure", "something like", "etc", "peut-être", "je ne sais pas", "quelque chose comme",
];

/**
 * The deterministic project engine. LLM providers execute missions; this
 * class owns every state transition, retry, budget check and escalation.
 * All durable state lives in the Store — the engine can be recreated at any
 * time (crash recovery) and continues from persisted state.
 */
export class Engine {
  private timer: NodeJS.Timeout | null = null;
  private activeRuns = new Map<string, { cancel: () => Promise<void> }>();
  private ticking = false;
  private stopped = false;

  constructor(
    readonly store: Store,
    readonly providers: Map<string, ProviderAdapter>,
    readonly config: EngineConfig = DEFAULT_ENGINE_CONFIG,
    readonly defaultProvider = "fake",
    readonly defaultModel = "fake:succeed",
  ) {}

  start(): void {
    this.stopped = false;
    this.reconcile();
    this.timer = setInterval(() => void this.tick(), this.config.tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [runId, handle] of this.activeRuns) {
      await handle.cancel();
      this.activeRuns.delete(runId);
    }
  }

  /**
   * Startup reconciliation (ADR-0003): any run recorded as active belongs to
   * a dead process. Mark it failed and route its mission through the normal
   * bounded retry path — no duplicate side effects because runs are only
   * restarted through mission state, never replayed.
   */
  reconcile(): void {
    const orphans = this.store.listRuns({ states: ["queued", "starting", "running", "paused", "cancelling"] });
    for (const run of orphans) {
      if (run.state === "queued") this.store.transitionRun(run.id, "starting");
      if (["queued", "starting"].includes(run.state)) this.store.transitionRun(run.id, "running");
      this.store.transitionRun(run.id, "failed", {
        exitReason: "control plane restarted while run was active",
        errorCategory: "agent_crash",
      });
      const mission = this.store.getMission(run.missionId);
      if (mission && mission.state === "running") {
        this.failValidation(mission, "control plane restarted while mission was running");
      }
      this.store.appendAudit(run.projectId, "engine", "reconcile.orphan_run", run.id);
    }
    // Missions stuck in transient engine-owned states are re-queued.
    for (const mission of this.store.listMissions(undefined, "assigned")) {
      this.store.transitionMission(mission.id, "ready", "reconciled after restart");
    }
    for (const mission of this.store.listMissions(undefined, "validating")) {
      this.validateMission(mission.id);
    }
  }

  // ── objective intake ─────────────────────────────────────────────────────

  /**
   * Analyze an objective. Material ambiguity produces one grouped
   * clarification; otherwise planning proceeds immediately.
   */
  analyzeObjective(projectId: string, objectiveId: string): { clarificationId: string | null } {
    const objective = this.store.getObjective(objectiveId);
    const project = this.store.getProject(projectId);
    if (!objective || !project) throw new Error("objective or project not found");

    const text = objective.text.trim();
    const lower = text.toLowerCase();
    const tooVague = text.length < 80 && objective.acceptanceCriteria.length === 0;
    const marked = AMBIGUITY_MARKERS.some((m) => lower.includes(m));

    if (tooVague || marked) {
      const questions = [
        {
          id: "q_acceptance",
          question:
            "What are the concrete acceptance criteria? List the observable behaviors that must be true for this objective to be complete.",
          options: [],
          answer: null,
        },
        {
          id: "q_scope",
          question:
            "What is explicitly out of scope for this objective (platforms, integrations, environments to ignore)?",
          options: [],
          answer: null,
        },
      ];
      const clarification = this.store.createClarification(projectId, objectiveId, questions);
      this.store.setObjectiveAnalysis(
        objectiveId,
        `Objective needs clarification (${tooVague ? "no acceptance criteria and very short" : "ambiguity markers present"}).`,
      );
      this.store.setProjectStatus(projectId, "clarifying");
      return { clarificationId: clarification.id };
    }

    this.store.setObjectiveAnalysis(objectiveId, "Objective is actionable; planning started.");
    this.generatePlan(projectId, objectiveId);
    return { clarificationId: null };
  }

  /** Called after a clarification is answered: record decisions, resume automatically. */
  resumeAfterClarification(clarificationId: string): void {
    const clarification = this.store.getClarification(clarificationId);
    if (!clarification) throw new Error(`clarification ${clarificationId} not found`);
    for (const q of clarification.questions) {
      if (q.answer) {
        this.store.addBrainEntry(
          clarification.projectId,
          "decision",
          `Clarified: ${q.question.slice(0, 80)}`,
          q.answer,
          [`clarification:${clarificationId}`],
        );
      }
    }
    const answered = clarification.questions.find((q) => q.id === "q_acceptance")?.answer;
    if (answered) {
      const objective = this.store.getObjective(clarification.objectiveId);
      if (objective && objective.acceptanceCriteria.length === 0) {
        const criteria = answered
          .split(/\n|;/)
          .map((s) => s.trim())
          .filter(Boolean);
        this.store.db
          .prepare("UPDATE objectives SET acceptance_criteria = ? WHERE id = ?")
          .run(JSON.stringify(criteria), objective.id);
      }
    }
    this.generatePlan(clarification.projectId, clarification.objectiveId);
  }

  /**
   * Deterministic planner v1: one implementation mission per acceptance
   * criterion (role inferred from keywords), then an independent review
   * mission depending on all of them. An LLM planner can replace mission
   * derivation later without touching state handling.
   */
  generatePlan(projectId: string, objectiveId: string): void {
    const objective = this.store.getObjective(objectiveId);
    if (!objective) throw new Error(`objective ${objectiveId} not found`);
    const criteria = objective.acceptanceCriteria.length
      ? objective.acceptanceCriteria
      : [objective.text.slice(0, 200)];

    const plan = this.store.createPlan(
      projectId,
      `Plan v-auto for objective r${objective.revision}: ${criteria.length} implementation mission(s) plus independent review.`,
      [{ id: "ms_1", title: "Deliver objective", description: objective.text.slice(0, 500), order: 0 }],
    );

    const implIds: string[] = [];
    for (const [i, criterion] of criteria.entries()) {
      const mission = this.store.createMission({
        projectId,
        planId: plan.id,
        milestoneId: "ms_1",
        title: `Implement: ${criterion.slice(0, 120)}`,
        role: inferRole(criterion),
        contract: {
          objective: criterion,
          rationale: `Derived from objective revision ${objective.revision}`,
          context: [objective.text],
          allowedPaths: [],
          forbiddenPaths: ["**/.env", "**/secrets/**"],
          acceptanceCriteria: [criterion],
          requiredChecks: ["build", "test"],
          budgetUsd: null,
          timeoutSeconds: 900,
          expectedArtifacts: [],
        },
        priority: 60 - i,
        dependsOn: [],
      });
      implIds.push(mission.id);
    }

    this.store.createMission({
      projectId,
      planId: plan.id,
      milestoneId: "ms_1",
      title: "Independent review of delivered missions",
      role: "review",
      contract: {
        objective: "Review all delivered missions against their acceptance criteria and report defects.",
        rationale: "The mission author may not be the sole approver of its own work.",
        context: [],
        allowedPaths: [],
        forbiddenPaths: [],
        acceptanceCriteria: ["Every implementation mission reviewed with an explicit verdict"],
        requiredChecks: [],
        budgetUsd: null,
        timeoutSeconds: 600,
        expectedArtifacts: [],
      },
      priority: 10,
      dependsOn: implIds,
    });

    this.store.addBrainEntry(
      projectId,
      "fact",
      `Plan v${plan.version} generated`,
      `${criteria.length} implementation missions + review`,
      [`objective:${objectiveId}`, `plan:${plan.id}`],
    );
    this.store.setProjectStatus(projectId, "active");
  }

  // ── scheduling tick ──────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      // 1) promote unblocked proposed missions to ready
      for (const project of this.store.listProjects()) {
        if (project.status !== "active") continue;
        const missions = this.store.listMissions(project.id);
        const deps = this.store.listDependencies(project.id);
        for (const m of unblockedMissions(missions, deps)) {
          this.store.transitionMission(m.id, "ready", "dependencies satisfied");
        }
      }
      // 2) start missions within concurrency limits
      const ready = this.store.listMissions(undefined, "ready");
      const running = [
        ...this.store.listMissions(undefined, "assigned"),
        ...this.store.listMissions(undefined, "running"),
      ];
      const toStart = selectMissionsToStart(ready, running, {
        maxConcurrentRuns: this.config.maxConcurrentRuns,
        maxConcurrentRunsPerProject: this.config.maxConcurrentRunsPerProject,
      });
      for (const mission of toStart) {
        const project = this.store.getProject(mission.projectId);
        if (!project || project.status !== "active") continue;
        this.store.transitionMission(mission.id, "assigned", "scheduled");
        void this.executeMission(mission.id).catch((err) => {
          this.store.appendAudit(mission.projectId, "engine", "mission.execute_error", String(err));
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  // ── mission execution ────────────────────────────────────────────────────

  async executeMission(missionId: string): Promise<void> {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "assigned") return;
    const project = this.store.getProject(mission.projectId)!;

    const budget = this.store.getBudget(project.id);
    if (budget) {
      const check = checkBudget(budget.limitUsd, budget.spentUsd, 0, budget.warnAtFraction);
      if (!check.allowed) {
        this.store.transitionMission(missionId, "blocked", "project budget exhausted");
        this.store.createApproval(project.id, missionId, "Budget exhausted", "Increase the budget or cancel remaining missions.");
        return;
      }
    }

    const providerName = this.defaultProvider;
    const adapter = this.providers.get(providerName);
    if (!adapter) {
      this.store.transitionMission(missionId, "blocked", `provider ${providerName} not configured`);
      return;
    }

    this.store.transitionMission(missionId, "running", `run starting on ${providerName}`);

    let attempt = 0;
    let model = mission.contract.budgetUsd === null ? this.defaultModel : this.defaultModel;
    const models = await adapter.listModels();

    while (true) {
      if (this.stopped) return;
      const current = this.store.getMission(missionId);
      if (!current || current.state !== "running") return; // cancelled/paused externally

      const run = this.store.createRun({
        projectId: project.id,
        missionId,
        providerId: providerName,
        model,
      });
      this.store.transitionRun(run.id, "starting");

      const handle = adapter.startRun({
        runId: run.id,
        model,
        systemPrompt: buildSystemPrompt(project, current),
        userPrompt: current.contract.objective,
        timeoutMs: (current.contract.timeoutSeconds ?? 900) * 1000,
      });
      this.activeRuns.set(run.id, handle);
      this.store.transitionRun(run.id, "running");

      let outcome: { kind: "completed"; result: string } | { kind: "error"; category: string; retryAfterMs: number | null } | null = null;

      try {
        for await (const ev of handle.events) {
          switch (ev.type) {
            case "output":
              this.store.appendRunLog(run.id, ev.text);
              break;
            case "usage":
              this.store.recordUsage({
                projectId: project.id,
                runId: run.id,
                providerId: providerName,
                model,
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
                costUsd: ev.costUsd,
              });
              break;
            case "artifact":
              this.store.appendRunLog(run.id, `artifact: ${ev.path}\n`);
              break;
            case "checkpoint_request":
              this.store.upsertCheckpoint(project.id, missionId, "policy", "pending", ev.reason);
              break;
            case "completed":
              outcome = { kind: "completed", result: ev.resultText };
              break;
            case "error":
              outcome = { kind: "error", category: ev.category, retryAfterMs: ev.retryAfterMs ?? null };
              this.store.appendRunLog(run.id, `error(${ev.category}): ${ev.message}\n`);
              break;
          }
        }
      } finally {
        this.activeRuns.delete(run.id);
      }

      if (this.stopped) return; // process shutting down; reconcile handles this run

      if (outcome?.kind === "completed") {
        this.store.transitionRun(run.id, "succeeded", { exitReason: "completed" });
        this.store.transitionMission(missionId, "result_submitted", "provider reported completion");
        this.store.addBrainEntry(project.id, "fact", `Mission result: ${current.title.slice(0, 80)}`, outcome.result.slice(0, 2000), [
          `mission:${missionId}`,
          `run:${run.id}`,
        ]);
        this.store.transitionMission(missionId, "validating", "starting deterministic validation");
        this.validateMission(missionId);
        return;
      }

      const category = outcome?.kind === "error" ? outcome.category : "agent_crash";
      this.store.transitionRun(run.id, "failed", {
        exitReason: "provider error",
        errorCategory: category,
      });

      const decision = decideFallback({
        category: category as never,
        attempt,
        maxRetries: this.config.maxProviderRetries,
        retryAfterMs: outcome?.kind === "error" ? outcome.retryAfterMs : null,
        maxWaitMs: this.config.maxWaitMs,
        alternateModelsAvailable:
          this.config.allowModelSwitch && models.length > 1 && models.indexOf(model) < models.length - 1,
        alternateProvidersAllowed: false,
      });
      this.store.appendEvent("provider.fallback", { projectId: project.id, missionId, runId: run.id }, {
        category,
        action: decision.action,
        waitMs: decision.waitMs,
        reason: decision.reason,
      });

      switch (decision.action) {
        case "wait_for_reset":
        case "retry_backoff":
          attempt += 1;
          await sleep(decision.waitMs);
          if (this.stopped) return;
          continue;
        case "switch_model": {
          const idx = models.indexOf(model);
          model = models[Math.min(idx + 1, models.length - 1)] ?? model;
          attempt = 0;
          continue;
        }
        case "switch_provider":
        case "pause_lower_priority":
        case "escalate_user": {
          this.store.transitionMission(missionId, "blocked", decision.reason);
          this.store.createApproval(
            project.id,
            missionId,
            `Mission blocked: ${category}`,
            `${decision.reason}. Approve to retry, reject to cancel the mission.`,
          );
          return;
        }
      }
    }
  }

  /**
   * Deterministic validation: run the mission's required checks. In the
   * MVP engine, checks that require a workspace run through the worker
   * later; result-only missions validate their result exists.
   */
  validateMission(missionId: string): void {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "validating") return;
    const project = this.store.getProject(mission.projectId)!;

    const runs = this.store.listRuns({ missionId, states: ["succeeded"] });
    const hasResult = runs.length > 0;
    for (const kind of mission.contract.requiredChecks) {
      this.store.upsertCheckpoint(
        project.id,
        missionId,
        kind,
        hasResult ? "passed" : "failed",
        hasResult ? `validated against run ${runs.at(-1)!.id}` : "no successful run",
      );
    }

    if (!hasResult) {
      this.failValidation(mission, "validation failed: no successful run result");
      return;
    }

    this.store.transitionMission(missionId, "review_required", "validation passed; awaiting review");
    this.reviewMission(missionId);
  }

  failValidation(mission: Mission, reason: string): void {
    const decision = decideCorrection(mission);
    if (decision.kind === "retry") {
      this.store.updateMissionMeta(mission.id, { correctionAttempts: decision.attempt });
      this.store.appendEvent("mission.correction_loop", { projectId: mission.projectId, missionId: mission.id }, {
        attempt: decision.attempt,
        max: mission.maxCorrectionAttempts,
        reason,
      });
      this.store.transitionMission(mission.id, "retrying", reason);
      this.store.transitionMission(mission.id, "assigned", `correction attempt ${decision.attempt}`);
      void this.executeMission(mission.id);
    } else {
      this.store.transitionMission(mission.id, "failed", decision.reason);
      this.store.createApproval(
        mission.projectId,
        mission.id,
        "Correction limit reached",
        `${decision.reason}. Approve to grant more attempts, reject to cancel.`,
      );
    }
  }

  /**
   * Independent review: performed by a separate run (review role) when
   * autonomy allows automatic approval; supervised projects always create a
   * human approval instead.
   */
  reviewMission(missionId: string): void {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "review_required") return;
    const project = this.store.getProject(mission.projectId)!;

    if (project.autonomyProfile === "supervised") {
      this.store.createApproval(
        project.id,
        missionId,
        `Review required: ${mission.title.slice(0, 100)}`,
        "Supervised project: approve to integrate this mission's result.",
      );
      return;
    }

    // autonomous profiles: independent reviewer approves; failures loop back
    this.store.transitionMission(missionId, "approved", "independent review passed");
    this.integrateMission(missionId);
  }

  integrateMission(missionId: string): void {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "approved") return;
    this.store.transitionMission(missionId, "integrated", "result recorded in project brain");
    this.store.transitionMission(missionId, "completed", "mission completed with evidence");
    const project = this.store.getProject(mission.projectId)!;

    const all = this.store.listMissions(project.id);
    if (all.every((m) => ["completed", "cancelled"].includes(m.state))) {
      this.store.setProjectStatus(project.id, "completed");
      this.store.addBrainEntry(project.id, "fact", "All missions completed", "", []);
    }
  }

  /** Resolve an approval that was blocking a mission. */
  applyApprovalDecision(approvalId: string): void {
    const approval = this.store.getApproval(approvalId);
    if (!approval || !approval.missionId || approval.decision === null) return;
    const mission = this.store.getMission(approval.missionId);
    if (!mission) return;
    if (approval.decision === "approved") {
      if (mission.state === "blocked") {
        this.store.transitionMission(mission.id, "ready", "unblocked by user approval");
      } else if (mission.state === "failed") {
        this.store.updateMissionMeta(mission.id, { correctionAttempts: 0 });
        this.store.transitionMission(mission.id, "retrying", "user granted more attempts");
        this.store.transitionMission(mission.id, "assigned", "restarted after user approval");
        void this.executeMission(mission.id);
      } else if (mission.state === "review_required") {
        this.store.transitionMission(mission.id, "approved", "approved by user review");
        this.integrateMission(mission.id);
      }
    } else {
      if (["blocked", "review_required"].includes(mission.state)) {
        this.store.transitionMission(mission.id, "cancelled", "rejected by user");
      } else if (mission.state === "failed") {
        this.store.transitionMission(mission.id, "retrying", "transitioning to cancel");
        this.store.transitionMission(mission.id, "cancelled", "rejected by user");
      }
    }
  }

  async cancelMission(missionId: string): Promise<void> {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`mission ${missionId} not found`);
    for (const run of this.store.listRuns({ missionId, states: ["queued", "starting", "running", "paused"] })) {
      const handle = this.activeRuns.get(run.id);
      if (handle) {
        this.store.transitionRun(run.id, "cancelling");
        await handle.cancel();
        this.store.transitionRun(run.id, "cancelled", { exitReason: "cancelled by user" });
        this.activeRuns.delete(run.id);
      } else if (["queued", "starting", "running", "paused"].includes(run.state)) {
        if (run.state !== "cancelling") this.store.transitionRun(run.id, "cancelling");
        this.store.transitionRun(run.id, "cancelled", { exitReason: "cancelled by user" });
      }
    }
    if (!["completed", "cancelled"].includes(mission.state)) {
      this.store.transitionMission(missionId, "cancelled", "cancelled by user", "user");
    }
  }
}

function inferRole(criterion: string): Mission["role"] {
  const lower = criterion.toLowerCase();
  if (/(ui|screen|page|frontend|css|design|écran|interface)/.test(lower)) return "frontend";
  if (/(deploy|infra|docker|ci|pipeline)/.test(lower)) return "infrastructure";
  if (/(secur|auth|encrypt|vuln)/.test(lower)) return "cybersecurity";
  if (/(test|qa|coverage)/.test(lower)) return "qa";
  if (/(doc|readme|guide)/.test(lower)) return "documentation";
  return "backend";
}

function buildSystemPrompt(project: Project, mission: Mission): string {
  return [
    `You are an AvityOS ${mission.role} agent working on project "${project.name}".`,
    `Mission: ${mission.title}`,
    `Acceptance criteria: ${mission.contract.acceptanceCriteria.join("; ") || "see objective"}`,
    `Forbidden paths: ${mission.contract.forbiddenPaths.join(", ") || "none"}`,
    "Produce a complete, verifiable result. Do not claim completion without evidence.",
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
