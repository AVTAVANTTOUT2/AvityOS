import { createHash } from "node:crypto";
import type {
  BrainObjectiveAnalysis as Analysis,
  BrainArchitectureProposal as Architecture,
  BrainClarificationProposal as ClarificationProposal,
  BrainPlanProposal as PlanProposal,
  BrainProvenance,
  BrainStep,
  Clarification,
  Mission,
  Objective,
  Plan,
  Project,
  RepoSnapshot,
  ReplanTrigger,
} from "@avityos/contracts";
import {
  BrainObjectiveAnalysis,
  BrainArchitectureProposal,
  BrainClarificationProposal,
  BrainPlanProposal,
} from "@avityos/contracts";
import { decideFallback } from "@avityos/orchestration";
import { checkBudget, type CommandPolicy } from "@avityos/policy";
import type { ProviderAdapter, RunHandle } from "@avityos/providers";
import { validateClarificationProposal } from "./clarification-policy.js";
import { validatePlanProposal } from "./plan-validation.js";
import { buildRepoSnapshot } from "./snapshot.js";
import type { Store } from "./store.js";

/**
 * The durable, asynchronous AI planning pipeline (chantier 2):
 *
 *   objective -> bounded repo snapshot -> analysis -> architecture ->
 *   plan/DAG -> deterministic validation -> transactional persistence ->
 *   scheduling
 *
 * Every AI step goes through a `ProviderAdapter` (never a direct vendor
 * call), records a durable `brain_runs` row with provenance, applies the
 * existing deterministic fallback policy across the configured reasoning
 * chain and performs a bounded repair of invalid structured output. When
 * every attempt is exhausted the project is blocked with an intervention —
 * a heuristic plan is never silently substituted for an AI plan.
 */
export interface BrainPipelineConfig {
  /** Ordered reasoning provider chain; editing capability is NOT required. */
  providerChain: readonly string[];
  /** Reasoning model per provider. */
  models: ReadonlyMap<string, string>;
  maxProviderRetries: number;
  maxWaitMs: number;
  /** Bounded repair attempts for schema- or validation-invalid output. */
  maxRepairAttempts: number;
  /** Evidence-based replans allowed per objective before escalating. */
  maxReplansPerObjective: number;
  /** Clarification rounds allowed per objective before escalating. */
  maxClarificationRounds: number;
  /** Hard cap on questions produced in one clarification round. */
  maxClarificationQuestions: number;
  stepTimeoutMs: number;
  checkCommandPolicy: CommandPolicy;
  allowModelSwitch: boolean;
  allowProviderSwitch: boolean;
}

export interface ReplanRequest {
  trigger: ReplanTrigger;
  cause: string;
  sources: string[];
}

export type EnsurePlanResult =
  | { status: "planned"; plan: Plan }
  | { status: "exists"; plan: Plan }
  | { status: "clarifying"; clarification: Clarification }
  | { status: "deferred"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "paused"; reason: string };

/** Mission states during which a replan must be refused or deferred. */
const IN_FLIGHT_MISSION_STATES = new Set([
  "assigned",
  "running",
  "result_submitted",
  "validating",
  "review_required",
  "approved",
  "integrated",
  "retrying",
]);

class BrainBlocked extends Error {}
class BrainStopped extends Error {}
class BrainPaused extends Error {}

interface RepairContext {
  issues: string[];
  previousOutput: string;
}

interface StepResult<T> {
  value: T;
  runId: string;
  providerId: string;
  model: string;
  provenance: BrainProvenance;
}

export class BrainPipeline {
  private readonly inFlight = new Map<string, symbol>();
  private readonly activeHandles = new Map<string, RunHandle>();
  private stopped = false;

  constructor(
    readonly store: Store,
    readonly providers: Map<string, ProviderAdapter>,
    readonly config: BrainPipelineConfig,
  ) {}

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [runId, handle] of this.activeHandles) {
      await handle.cancel();
      this.activeHandles.delete(runId);
    }
  }

  /** Cancel in-flight brain provider handles for one project (atomic pause). */
  async cancelProject(projectId: string): Promise<void> {
    const active = [...this.activeHandles.entries()].filter(([runId]) => {
      const run = this.store.getBrainRun(runId);
      return run?.projectId === projectId;
    });
    for (const [runId, handle] of active) {
      await handle.cancel();
      this.activeHandles.delete(runId);
      const run = this.store.getBrainRun(runId);
      if (run?.state === "running") {
        this.store.finishBrainRun(runId, {
          state: "cancelled",
          errorCategory: "agent_crash",
          errorDetail: "cancelled because the project was paused",
        });
      }
    }
    this.inFlight.delete(projectId);
  }

  /**
   * Startup reconciliation: any brain run recorded as running belongs to a
   * dead process — fail it exactly once, then resume planning for projects
   * left in `planning` without an active plan for their latest objective.
   * Idempotent: an already-persisted plan is never duplicated.
   */
  reconcile(): void {
    for (const run of this.store.listOrphanBrainRuns()) {
      this.store.finishBrainRun(run.id, {
        state: "failed",
        errorCategory: "agent_crash",
        errorDetail: "control plane restarted while the brain step was running",
      });
      this.store.appendAudit(run.projectId, "engine", "reconcile.orphan_brain_run", run.id);
    }
    for (const project of this.store.listProjects()) {
      if (project.status === "paused") continue;
      if (project.status !== "planning") continue;
      const objective = this.store.latestObjective(project.id);
      if (!objective) continue;
      const active = this.store.activePlan(project.id);
      if (active && active.objectiveId === objective.id) {
        this.store.setProjectStatus(project.id, "active");
        continue;
      }
      void this.ensurePlan(project.id, objective.id).catch((err) => {
        this.store.appendAudit(project.id, "engine", "brain.pipeline_error", String(err).slice(0, 500));
      });
    }
  }

  /**
   * Idempotent pipeline entry. Without `replan`, plans the objective unless
   * an active plan for it already exists. With `replan`, produces a new plan
   * version from real evidence — bounded, idempotent per cause, refusing to
   * touch in-flight missions and preserving plan history.
   */
  async ensurePlan(projectId: string, objectiveId: string, replan?: ReplanRequest): Promise<EnsurePlanResult> {
    if (this.stopped) return { status: "deferred", reason: "engine stopping" };
    if (this.inFlight.has(projectId)) return { status: "deferred", reason: "planning already in flight" };
    const token = Symbol(projectId);
    this.inFlight.set(projectId, token);
    try {
      return await this.run(projectId, objectiveId, replan ?? null);
    } finally {
      // cancelProject deliberately frees the slot so resume can start a fresh
      // generation before an uncooperative old provider returns. The old
      // continuation must never delete the replacement generation's token.
      if (this.inFlight.get(projectId) === token) this.inFlight.delete(projectId);
    }
  }

  private async run(projectId: string, objectiveId: string, replan: ReplanRequest | null): Promise<EnsurePlanResult> {
    const project = this.store.getProject(projectId);
    const objective = this.store.getObjective(objectiveId);
    if (!project || !objective || objective.projectId !== projectId) {
      return { status: "deferred", reason: "project or objective not found" };
    }
    if (project.status === "paused") {
      return { status: "paused", reason: "project is paused" };
    }
    const pauseGeneration = this.store.getPauseGeneration(projectId);
    const latest = this.store.latestObjective(projectId);
    if (!latest || latest.id !== objectiveId) {
      return { status: "deferred", reason: "objective revision superseded" };
    }
    const openClarification = this.store.listClarifications(projectId, "open")[0];
    if (openClarification) {
      return { status: "clarifying", clarification: openClarification };
    }

    const activePlan = this.store.activePlan(projectId);
    if (!replan && activePlan && activePlan.objectiveId === objectiveId) {
      return { status: "exists", plan: activePlan };
    }

    let replanIdempotencyKey: string | null = null;
    if (replan) {
      const inFlightMissions = this.store
        .listMissions(projectId)
        .filter((mission) => IN_FLIGHT_MISSION_STATES.has(mission.state));
      if (inFlightMissions.length > 0) {
        this.store.appendEvent("plan.replanned", { projectId }, {
          deferred: true,
          trigger: replan.trigger,
          cause: replan.cause,
          reason: `missions in flight: ${inFlightMissions.map((mission) => mission.id).join(", ")}`,
        });
        return { status: "deferred", reason: "an active mission is in flight; a replan never replaces it" };
      }

      // Idempotent per objective, trigger and complete evidence fingerprint:
      // re-requesting the same evidence never creates a second plan version,
      // while genuinely new sources are allowed to produce a new plan.
      const evidenceHash = createHash("sha256")
        .update(JSON.stringify({ cause: replan.cause, sources: [...replan.sources].sort() }))
        .digest("hex")
        .slice(0, 16);
      replanIdempotencyKey = `replan:${projectId}:${objectiveId}:${replan.trigger}:${evidenceHash}`;
      const existing = this.store.findIdempotent(replanIdempotencyKey);
      if (existing?.resourceType === "plan") {
        const plan = this.store.getPlan(existing.resourceId);
        if (plan) return { status: "exists", plan };
      }

      const replansForObjective = this.store
        .listPlans(projectId)
        .filter((plan) => plan.objectiveId === objectiveId && plan.replanTrigger !== null).length;
      if (replansForObjective >= this.config.maxReplansPerObjective) {
        const reason = `replan limit reached (${this.config.maxReplansPerObjective}) for objective ${objectiveId}`;
        this.blockPlanning(
          projectId,
          "Replan limit reached",
          `${reason}. Approve to resume execution with the current plan, or revise the objective to produce a new one.`,
        );
        return { status: "blocked", reason };
      }
    }

    this.store.setProjectStatus(projectId, "planning");

    try {
      this.assertPlanningBudget(projectId);

      let snapshot: RepoSnapshot | null = null;
      try {
        snapshot = await buildRepoSnapshot(project);
      } catch (err) {
        throw new BrainBlocked(`repository snapshot failed: ${String(err).slice(0, 300)}`);
      }
      this.assertNotPaused(projectId, pauseGeneration);

      const priorAnswers = this.priorClarificationContext(projectId, objectiveId);
      const analysisResult = await this.runStep<Analysis>({
        project,
        objective,
        expectedPauseGeneration: pauseGeneration,
        step: "analysis",
        schema: BrainObjectiveAnalysis,
        buildPrompts: (repair) =>
          buildStepPrompts({
            step: "analysis",
            project,
            objective,
            snapshot,
            analysis: null,
            architecture: null,
            replan,
            repair,
            priorAnswers,
          }),
      });
      this.assertNotPaused(projectId, pauseGeneration);
      this.store.setObjectiveAnalysis(objective.id, analysisResult.value.summary, pauseGeneration);
      if (analysisResult.value.feasibility === "infeasible") {
        throw new BrainBlocked(
          "AI analysis found the objective infeasible under the persisted constraints; revise the objective or constraints before retrying",
        );
      }
      if (analysisResult.value.objectiveClarity === "ambiguous") {
        const clarifying = await this.requestStructuredClarifications({
          project,
          objective,
          snapshot,
          analysis: analysisResult.value,
          priorAnswers,
          analysisRunId: analysisResult.runId,
          providerId: analysisResult.providerId,
          model: analysisResult.model,
          provenance: analysisResult.provenance,
          expectedPauseGeneration: pauseGeneration,
        });
        return clarifying;
      }

      this.assertNotPaused(projectId, pauseGeneration);
      this.assertPlanningBudget(projectId);
      const architectureResult = await this.runStep<Architecture>({
        project,
        objective,
        expectedPauseGeneration: pauseGeneration,
        step: "architecture",
        schema: BrainArchitectureProposal,
        buildPrompts: (repair) =>
          buildStepPrompts({
            step: "architecture",
            project,
            objective,
            snapshot,
            analysis: analysisResult.value,
            architecture: null,
            replan,
            repair,
            priorAnswers,
          }),
      });

      this.assertNotPaused(projectId, pauseGeneration);
      this.assertPlanningBudget(projectId);
      const budget = this.store.getBudget(projectId);
      const planResult = await this.runStep<PlanProposal>({
        project,
        objective,
        expectedPauseGeneration: pauseGeneration,
        step: "plan",
        schema: BrainPlanProposal,
        buildPrompts: (repair) =>
          buildStepPrompts({
            step: "plan",
            project,
            objective,
            snapshot,
            analysis: analysisResult.value,
            architecture: architectureResult.value,
            replan,
            repair,
            priorAnswers,
          }),
        validate: (proposal) => {
          const verdict = validatePlanProposal(proposal, {
            acceptanceCriteria: objective.acceptanceCriteria,
            repoAvailable: project.repoPath !== null,
            availableChecks: snapshot?.availableChecks ?? null,
            checkCommandPolicy: this.config.checkCommandPolicy,
            projectBudgetUsd: budget?.limitUsd ?? null,
          });
          return verdict.ok ? [] : verdict.issues;
        },
      });

      this.assertNotPaused(projectId, pauseGeneration);
      const persisted = this.persistPlan({
        project,
        objective,
        snapshot,
        analysis: analysisResult,
        architecture: architectureResult,
        plan: planResult,
        idempotencyKey: replanIdempotencyKey,
        replan: replan ? { ...replan, basedOnVersion: activePlan?.version ?? 0 } : null,
        expectedPauseGeneration: pauseGeneration,
      });
      return persisted.created
        ? { status: "planned", plan: persisted.plan }
        : { status: "exists", plan: persisted.plan };
    } catch (err) {
      if (err instanceof BrainPaused) {
        return { status: "paused", reason: err.message };
      }
      if (err instanceof BrainStopped || this.stopped) {
        return { status: "deferred", reason: "engine stopped during planning; recovery resumes it" };
      }
      try {
        this.assertNotPaused(projectId, pauseGeneration);
      } catch (pauseErr) {
        if (pauseErr instanceof BrainPaused) {
          return { status: "paused", reason: pauseErr.message };
        }
        throw pauseErr;
      }
      if (err instanceof BrainBlocked) {
        this.blockPlanning(projectId, "AI planning blocked", `${err.message}. Fix the cause, then approve to retry planning.`);
        return { status: "blocked", reason: err.message };
      }
      throw err;
    }
  }

  private assertNotPaused(projectId: string, expectedPauseGeneration?: number): void {
    const project = this.store.getProject(projectId);
    const generation = this.store.getPauseGeneration(projectId);
    if (
      project?.status === "paused" ||
      (expectedPauseGeneration !== undefined && generation !== expectedPauseGeneration)
    ) {
      throw new BrainPaused(
        `project pause fence changed during brain pipeline (expected generation ${expectedPauseGeneration ?? generation}, actual ${generation})`,
      );
    }
  }

  private priorClarificationContext(projectId: string, objectiveId: string): string[] {
    const answered = this.store
      .listClarifications(projectId)
      .filter((group) => group.objectiveId === objectiveId && group.status === "answered");
    const lines: string[] = [];
    for (const group of answered) {
      for (const question of group.questions) {
        if (question.status === "answered" && question.answer) {
          // Keep key→answer only so policy checks do not treat the prior
          // question text itself as "already present" information.
          lines.push(`${question.logicalKey} → ${question.answer}`);
        }
      }
    }
    return lines;
  }

  private async requestStructuredClarifications(input: {
    project: Project;
    objective: Objective;
    snapshot: RepoSnapshot | null;
    analysis: Analysis;
    priorAnswers: string[];
    analysisRunId: string;
    providerId: string;
    model: string;
    provenance: BrainProvenance;
    expectedPauseGeneration: number;
  }): Promise<EnsurePlanResult> {
    const rounds = this.store.clarificationRoundCount(input.project.id, input.objective.id);
    if (rounds >= this.config.maxClarificationRounds) {
      throw new BrainBlocked(
        `clarification round limit reached (${this.config.maxClarificationRounds}) for objective ${input.objective.id}`,
      );
    }
    this.assertNotPaused(input.project.id, input.expectedPauseGeneration);
    const answeredKeys = new Set(
      this.store
        .listClarifications(input.project.id)
        .filter((group) => group.objectiveId === input.objective.id && group.status === "answered")
        .flatMap((group) => group.questions.filter((q) => q.status === "answered").map((q) => q.logicalKey)),
    );
    const clarificationResult = await this.runStep<ClarificationProposal>({
      project: input.project,
      objective: input.objective,
      expectedPauseGeneration: input.expectedPauseGeneration,
      step: "clarification",
      schema: BrainClarificationProposal,
      buildPrompts: (repair) =>
        buildStepPrompts({
          step: "clarification",
          project: input.project,
          objective: input.objective,
          snapshot: input.snapshot,
          analysis: input.analysis,
          architecture: null,
          replan: null,
          repair,
          priorAnswers: input.priorAnswers,
        }),
      validate: (proposal) =>
        validateClarificationProposal(proposal, {
          objectiveText: input.objective.text,
          acceptanceCriteria: input.objective.acceptanceCriteria,
          priorAnswerKeys: answeredKeys,
          priorAnswerBodies: input.priorAnswers,
          maxQuestions: this.config.maxClarificationQuestions,
        }).map((issue) => `${issue.path}: ${issue.message}`),
    });

    if (!clarificationResult.value.needsClarification || clarificationResult.value.questions.length === 0) {
      // Model resolved ambiguity without questions — continue as clear.
      this.store.setObjectiveAnalysis(
        input.objective.id,
        `${input.analysis.summary} (clarification step found no material questions).`,
      );
      // Force clarity by continuing the pipeline from architecture.
      this.assertNotPaused(input.project.id, input.expectedPauseGeneration);
      this.assertPlanningBudget(input.project.id);
      const architectureResult = await this.runStep<Architecture>({
        project: input.project,
        objective: input.objective,
        expectedPauseGeneration: input.expectedPauseGeneration,
        step: "architecture",
        schema: BrainArchitectureProposal,
        buildPrompts: (repair) =>
          buildStepPrompts({
            step: "architecture",
            project: input.project,
            objective: input.objective,
            snapshot: input.snapshot,
            analysis: { ...input.analysis, objectiveClarity: "clear" },
            architecture: null,
            replan: null,
            repair,
            priorAnswers: input.priorAnswers,
          }),
      });
      this.assertNotPaused(input.project.id, input.expectedPauseGeneration);
      this.assertPlanningBudget(input.project.id);
      const budget = this.store.getBudget(input.project.id);
      const planResult = await this.runStep<PlanProposal>({
        project: input.project,
        objective: input.objective,
        expectedPauseGeneration: input.expectedPauseGeneration,
        step: "plan",
        schema: BrainPlanProposal,
        buildPrompts: (repair) =>
          buildStepPrompts({
            step: "plan",
            project: input.project,
            objective: input.objective,
            snapshot: input.snapshot,
            analysis: { ...input.analysis, objectiveClarity: "clear" },
            architecture: architectureResult.value,
            replan: null,
            repair,
            priorAnswers: input.priorAnswers,
          }),
        validate: (proposal) => {
          const verdict = validatePlanProposal(proposal, {
            acceptanceCriteria: input.objective.acceptanceCriteria,
            repoAvailable: input.project.repoPath !== null,
            availableChecks: input.snapshot?.availableChecks ?? null,
            checkCommandPolicy: this.config.checkCommandPolicy,
            projectBudgetUsd: budget?.limitUsd ?? null,
          });
          return verdict.ok ? [] : verdict.issues;
        },
      });
      const persisted = this.persistPlan({
        project: input.project,
        objective: input.objective,
        snapshot: input.snapshot,
        analysis: {
          value: { ...input.analysis, objectiveClarity: "clear" },
          runId: input.analysisRunId,
          providerId: input.providerId,
          model: input.model,
          provenance: input.provenance,
        },
        architecture: architectureResult,
        plan: planResult,
        idempotencyKey: null,
        replan: null,
        expectedPauseGeneration: input.expectedPauseGeneration,
      });
      return persisted.created
        ? { status: "planned", plan: persisted.plan }
        : { status: "exists", plan: persisted.plan };
    }

    const clarificationProvenance: Clarification["provenance"] =
      clarificationResult.provenance === "fake_fixture" ? "fake_fixture" : "live";
    this.assertNotPaused(input.project.id, input.expectedPauseGeneration);
    const clarification = this.store.createClarification({
      projectId: input.project.id,
      objectiveId: input.objective.id,
      provenance: clarificationProvenance,
      providerId: clarificationResult.providerId,
      model: clarificationResult.model,
      brainRunId: clarificationResult.runId,
      idempotencyKey: `clr:${input.project.id}:${input.objective.id}:${rounds + 1}:${clarificationResult.runId}`,
      expectedPauseGeneration: input.expectedPauseGeneration,
      questions: clarificationResult.value.questions.map((question) => ({
        logicalKey: question.key,
        category: question.category,
        question: question.question,
        reason: question.reason,
        answerType: question.answerType,
        options: question.options,
        required: question.required,
        acceptanceCriteriaRefs: question.acceptanceCriteriaRefs,
        blockedDecisions: question.blockedDecisions,
        blockedMissions: question.blockedMissions,
        displayOrder: question.displayOrder,
      })),
    });
    this.store.setProjectStatus(input.project.id, "clarifying", input.expectedPauseGeneration);
    this.store.appendAudit(
      input.project.id,
      "engine",
      "brain.clarification",
      `${clarification.questions.length} structured question(s); provenance=${clarification.provenance}`,
    );
    return { status: "clarifying", clarification };
  }

  /** Planning consumes the same project budget as execution — fail closed. */
  private assertPlanningBudget(projectId: string): void {
    const budget = this.store.getBudget(projectId);
    if (!budget) return;
    const verdict = checkBudget(budget.limitUsd, budget.spentUsd, 0, budget.warnAtFraction);
    if (verdict.warn) {
      this.store.appendEvent("budget.threshold", { projectId }, {
        limitUsd: budget.limitUsd,
        spentUsd: budget.spentUsd,
        warnAtFraction: budget.warnAtFraction,
        remainingUsd: verdict.remainingUsd,
        phase: "planning",
      });
    }
    if (!verdict.allowed || verdict.remainingUsd <= 0) {
      throw new BrainBlocked("planning budget exhausted");
    }
  }

  private blockPlanning(projectId: string, title: string, description: string): void {
    this.store.setProjectStatus(projectId, "blocked");
    this.store.createApproval(projectId, null, title, description);
    this.store.appendAudit(projectId, "engine", "brain.blocked", `${title}: ${description}`.slice(0, 500));
  }

  /**
   * One pipeline step: provider fallback loop, durable brain runs, JSON
   * extraction, strict Zod validation and bounded repair of invalid output.
   */
  private async runStep<T>(input: {
    project: Project;
    objective: Objective;
    expectedPauseGeneration: number;
    step: BrainStep;
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } };
    buildPrompts(repair: RepairContext | null): { systemPrompt: string; userPrompt: string };
    validate?(value: T): string[];
  }): Promise<StepResult<T>> {
    const eligible = this.config.providerChain.filter((name) => this.providers.has(name));
    if (eligible.length === 0) {
      throw new BrainBlocked("no reasoning provider is configured for the brain pipeline");
    }

    let providerIdx = 0;
    let attempt = 0;
    let attemptNumber = 0;
    let repairs = 0;
    let repair: RepairContext | null = null;
    let model: string | null = null;

    while (true) {
      if (this.stopped) throw new BrainStopped();
      this.assertNotPaused(input.project.id, input.expectedPauseGeneration);
      const providerName = eligible[providerIdx];
      const adapter = providerName ? this.providers.get(providerName) : undefined;
      if (!providerName || !adapter) {
        throw new BrainBlocked("no reasoning provider left in the configured chain");
      }
      const models = await adapter.listModels();
      if (this.stopped) throw new BrainStopped();
      this.assertNotPaused(input.project.id, input.expectedPauseGeneration);
      if (model === null || !models.includes(model)) {
        model = this.config.models.get(providerName) ?? models[0] ?? "default";
      }
      const provenance: BrainProvenance = isFixtureAdapter(adapter) ? "fake_fixture" : "live";
      const prompts = input.buildPrompts(repair);

      attemptNumber += 1;
      const run = this.store.createBrainRun({
        projectId: input.project.id,
        objectiveId: input.objective.id,
        step: input.step,
        attempt: attemptNumber,
        providerId: providerName,
        model,
        provenance,
        input: prompts.userPrompt.slice(0, 20_000),
        expectedPauseGeneration: input.expectedPauseGeneration,
      });

      const handle = adapter.startRun({
        runId: run.id,
        model,
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        ...(input.project.repoPath ? { cwd: input.project.repoPath } : {}),
        timeoutMs: this.config.stepTimeoutMs,
        // Plan/architecture JSON is large; HTTP adapters default high, but make
        // the brain intent explicit so reasoning models keep room for content.
        maxOutputTokens: input.step === "plan" || input.step === "architecture" ? 16_384 : 8_192,
      });
      this.activeHandles.set(run.id, handle);

      let resultText: string | null = null;
      let streamed = "";
      let error: { category: string; message: string; retryAfterMs: number | null } | null = null;
      let timedOut = false;
      const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      const timeout = setTimeout(() => {
        timedOut = true;
        void handle.cancel().catch(() => undefined);
      }, this.config.stepTimeoutMs);
      try {
        for await (const ev of handle.events) {
          this.assertNotPaused(input.project.id, input.expectedPauseGeneration);
          if (ev.type === "output") streamed += ev.text;
          if (ev.type === "completed") resultText = ev.resultText;
          if (ev.type === "usage") {
            usage.inputTokens += ev.inputTokens;
            usage.outputTokens += ev.outputTokens;
            usage.costUsd += ev.costUsd;
            this.store.recordUsage({
              projectId: input.project.id,
              runId: null,
              providerId: providerName,
              model,
              inputTokens: ev.inputTokens,
              outputTokens: ev.outputTokens,
              costUsd: ev.costUsd,
              expectedPauseGeneration: input.expectedPauseGeneration,
            });
          }
          if (ev.type === "error") {
            error = { category: ev.category, message: ev.message, retryAfterMs: ev.retryAfterMs ?? null };
          }
        }
      } finally {
        clearTimeout(timeout);
        this.activeHandles.delete(run.id);
      }

      // A stop mid-step leaves this run `running`; recovery fails it once.
      if (this.stopped) throw new BrainStopped();
      this.assertNotPaused(input.project.id, input.expectedPauseGeneration);

      if (timedOut) {
        error = {
          category: "transient_network",
          message: `brain step timed out after ${this.config.stepTimeoutMs}ms`,
          retryAfterMs: null,
        };
      }

      const text = resultText ?? (streamed || null);
      if (error || text === null) {
        const category = error?.category ?? "agent_crash";
        this.store.finishBrainRun(
          run.id,
          {
            state: "failed",
            errorCategory: category,
            errorDetail: error?.message ?? "provider produced no result",
            ...usage,
          },
          input.expectedPauseGeneration,
        );
        const decision = decideFallback({
          category: category as never,
          attempt,
          maxRetries: this.config.maxProviderRetries,
          retryAfterMs: error?.retryAfterMs ?? null,
          maxWaitMs: this.config.maxWaitMs,
          alternateModelsAvailable:
            this.config.allowModelSwitch && models.length > 1 && models.indexOf(model) < models.length - 1,
          alternateProvidersAllowed: this.config.allowProviderSwitch && providerIdx < eligible.length - 1,
        });
        this.store.appendEvent("provider.fallback", { projectId: input.project.id }, {
          phase: "brain",
          step: input.step,
          provider: providerName,
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
            continue;
          case "switch_model": {
            const idx = models.indexOf(model);
            model = models[Math.min(idx + 1, models.length - 1)] ?? model;
            attempt = 0;
            continue;
          }
          case "switch_provider":
            providerIdx += 1;
            attempt = 0;
            model = null;
            continue;
          case "pause_lower_priority":
          case "escalate_user":
            throw new BrainBlocked(`brain step ${input.step} failed on ${providerName}: ${decision.reason}`);
        }
      }

      const issues: string[] = [];
      let value: T | null = null;
      const parsed = extractStructuredObject(text!);
      if (parsed === null) {
        issues.push("no parsable JSON object found in the response");
      } else {
        const outcome = input.schema.safeParse(parsed);
        if (!outcome.success) {
          issues.push(...outcome.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".")}: ${issue.message}`));
        } else {
          const extra = input.validate?.(outcome.data) ?? [];
          if (extra.length > 0) issues.push(...extra.slice(0, 20));
          else value = outcome.data;
        }
      }

      if (value !== null) {
        this.store.finishBrainRun(
          run.id,
          { state: "succeeded", output: value, ...usage },
          input.expectedPauseGeneration,
        );
        return { value, runId: run.id, providerId: providerName, model, provenance };
      }

      this.store.finishBrainRun(
        run.id,
        {
          state: "failed",
          errorCategory: "invalid_request",
          errorDetail: `invalid structured output: ${issues.join("; ")}`.slice(0, 2000),
          ...usage,
        },
        input.expectedPauseGeneration,
      );
      if (repairs < this.config.maxRepairAttempts) {
        repairs += 1;
        repair = { issues, previousOutput: text!.slice(0, 4000) };
        continue;
      }
      throw new BrainBlocked(
        `brain step ${input.step} produced invalid output after ${repairs + 1} attempt(s): ${issues.slice(0, 5).join("; ")}`,
      );
    }
  }

  /** Validated proposal -> durable plan version, missions, DAG and brain memory. */
  private persistPlan(input: {
    project: Project;
    objective: Objective;
    snapshot: RepoSnapshot | null;
    analysis: StepResult<Analysis>;
    architecture: StepResult<Architecture>;
    plan: StepResult<PlanProposal>;
    idempotencyKey: string | null;
    replan: (ReplanRequest & { basedOnVersion: number }) | null;
    expectedPauseGeneration: number;
  }): { plan: Plan; missions: Mission[]; created: boolean } {
    const { project, objective } = input;
    const proposal = input.plan.value;
    const budget = this.store.getBudget(project.id);

    const persisted = this.store.createBrainPlan({
      projectId: project.id,
      objectiveId: objective.id,
      summary: proposal.summary,
      milestones: proposal.milestones.map((milestone) => ({
        id: milestone.key,
        title: milestone.title,
        description: milestone.description,
        order: milestone.order,
      })),
      provenance: input.plan.provenance,
      providerId: input.plan.providerId,
      model: input.plan.model,
      snapshotHash: input.snapshot?.hash ?? null,
      analysisRunId: input.analysis.runId,
      architectureRunId: input.architecture.runId,
      planRunId: input.plan.runId,
      idempotencyKey: input.idempotencyKey,
      expectedPauseGeneration: input.expectedPauseGeneration,
      replan: input.replan
        ? {
            trigger: input.replan.trigger,
            cause: input.replan.cause,
            sources: input.replan.sources,
            basedOnVersion: input.replan.basedOnVersion,
          }
        : null,
      missions: proposal.missions.map((mission) => ({
        logicalKey: mission.key,
        title: mission.title,
        role: mission.role,
        milestoneId: mission.milestoneKey,
        priority: mission.priority,
        dependsOnKeys: mission.dependsOn,
        contract: {
          objective: mission.objective,
          rationale: mission.rationale,
          context: [objective.text],
          allowedPaths: mission.allowedPaths,
          forbiddenPaths: [...new Set([...mission.forbiddenPaths, "**/.env", "**/secrets/**"])],
          acceptanceCriteria: mission.acceptanceCriteria,
          requiredChecks: mission.requiredChecks,
          checkCommands: mission.checkCommands,
          budgetUsd: mission.budgetUsd ?? budget?.limitUsd ?? null,
          timeoutSeconds: mission.timeoutSeconds,
          expectedArtifacts: mission.expectedArtifacts,
          workspaceChangesRequired: project.repoPath !== null,
          escalationConditions: mission.escalationConditions,
        },
      })),
    });

    if (!persisted.created) return persisted;

    const fixtureNote =
      input.plan.provenance === "fake_fixture"
        ? " [fake_fixture: deterministic offline fixture output, not real AI planning evidence]"
        : "";
    this.store.addBrainEntry(
      project.id,
      "fact",
      `Plan v${persisted.plan.version} generated by ${input.plan.providerId}/${input.plan.model}${fixtureNote}`,
      proposal.summary.slice(0, 2000),
      [
        `plan:${persisted.plan.id}`,
        `objective:${objective.id}`,
        `brainRun:${input.analysis.runId}`,
        `brainRun:${input.architecture.runId}`,
        `brainRun:${input.plan.runId}`,
        ...(input.snapshot ? [`snapshot:${input.snapshot.hash}`] : []),
      ],
      input.expectedPauseGeneration,
    );
    this.store.addBrainEntry(
      project.id,
      "proposal",
      `Proposed architecture (plan v${persisted.plan.version})${fixtureNote}`,
      input.architecture.value.overview.slice(0, 2000),
      [`brainRun:${input.architecture.runId}`, `plan:${persisted.plan.id}`],
      input.expectedPauseGeneration,
    );
    for (const decision of input.architecture.value.decisions.slice(0, 5)) {
      this.store.addBrainEntry(project.id, "proposal", decision.title.slice(0, 300), decision.rationale, [
        `brainRun:${input.architecture.runId}`,
      ], input.expectedPauseGeneration);
    }
    for (const risk of [...input.analysis.value.risks, ...input.architecture.value.risks].slice(0, 5)) {
      this.store.addBrainEntry(
        project.id,
        "risk",
        risk.title.slice(0, 300),
        [risk.detail, risk.mitigation && `Mitigation: ${risk.mitigation}`].filter(Boolean).join("\n"),
        [`brainRun:${input.analysis.runId}`],
        input.expectedPauseGeneration,
      );
    }
    return persisted;
  }
}

function isFixtureAdapter(adapter: ProviderAdapter): boolean {
  return (adapter as { fixture?: boolean }).fixture === true;
}

/**
 * Extract one JSON object from provider text output. Adapters do not
 * advertise structured output, so a fenced or inline JSON object inside a
 * textual answer is accepted, then strictly validated by the caller.
 */
export function extractStructuredObject(text: string): unknown | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) candidates.push(fenced[1]!);
  const balanced = firstBalancedObject(text);
  if (balanced) candidates.push(balanced);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const STEP_INSTRUCTIONS: Readonly<Record<BrainStep, string>> = {
  analysis: [
    "Produce the structured objective/repository analysis as one JSON object with exactly these fields:",
    '{"summary": string, "objectiveClarity": "clear"|"ambiguous", "feasibility": "feasible"|"risky"|"infeasible",',
    ' "constraints": string[], "assumptions": string[],',
    ' "risks": [{"title": string, "severity": "low"|"medium"|"high", "detail": string, "mitigation": string}],',
    ' "evidence": [{"kind": "file"|"git"|"manifest"|"script"|"check"|"doc"|"objective", "ref": string, "detail": string}]}',
    "Reference real snapshot entries in evidence (e.g. {\"kind\":\"file\",\"ref\":\"file:README.md@<commit>\"}).",
    "Mark objectiveClarity=ambiguous only when material decisions are missing and cannot be inferred safely.",
  ].join("\n"),
  clarification: [
    "Propose ONLY material clarification questions as one JSON object with exactly these fields:",
    '{"summary": string, "needsClarification": boolean,',
    ' "questions": [{"key": string, "category": "acceptance_criteria"|"scope"|"constraint"|"decision"|"budget"|"path_scope"|"other",',
    '   "question": string, "reason": string,',
    '   "answerType": "text"|"boolean"|"single_choice"|"multi_choice"|"number"|"budget"|"path_scope",',
    '   "options": [{"key": string, "label": string}], "required": boolean,',
    '   "acceptanceCriteriaRefs": number[], "blockedDecisions": string[], "blockedMissions": string[], "displayOrder": number}]}',
    "Rules: ask only what is materially necessary; never ask for secrets/API keys/passwords; never ask for out-of-repo paths;",
    "never ask the user to run arbitrary commands; never repeat already-answered keys; group every question of this round together;",
    "if nothing material is missing, return needsClarification=false and questions=[].",
  ].join("\n"),
  architecture: [
    "Propose the target architecture as one JSON object with exactly these fields:",
    '{"overview": string, "components": [{"name": string, "responsibility": string, "paths": string[]}],',
    ' "decisions": [{"title": string, "rationale": string}], "constraints": string[], "assumptions": string[],',
    ' "risks": [{"title": string, "severity": "low"|"medium"|"high", "detail": string, "mitigation": string}],',
    ' "evidence": [{"kind": string, "ref": string, "detail": string}]}',
  ].join("\n"),
  plan: [
    "Produce the mission plan/DAG as one JSON object with exactly these fields:",
    '{"summary": string, "milestones": [{"key": string, "title": string, "description": string, "order": number}],',
    ' "missions": [{"key": string, "title": string, "objective": string, "rationale": string,',
    '   "role": "product"|"architecture"|"frontend"|"backend"|"infrastructure"|"cybersecurity"|"qa"|"review"|"documentation"|"orchestrator",',
    '   "milestoneKey": string, "dependsOn": string[], "acceptanceCriteria": string[], "coversCriteria": number[],',
    '   "allowedPaths": string[], "forbiddenPaths": string[], "requiredChecks": string[],',
    '   "checkCommands": {"<check>": string[]}, "expectedArtifacts": string[], "budgetUsd": number|null,',
    '   "timeoutSeconds": number, "escalationConditions": string[], "priority": number}]}',
    "Rules: keys are stable lowercase identifiers (a-z0-9-_); dependencies must reference mission keys of this plan;",
    "the graph must be acyclic; missions without dependencies run in parallel — only order missions when a real",
    "dependency exists; every acceptance criterion index must appear in some mission's coversCriteria; requiredChecks",
    "must use the really available check commands provided; assign each mission the genuinely fitting specialist role.",
  ].join("\n"),
};

function condensedSnapshot(snapshot: RepoSnapshot): Record<string, unknown> {
  return {
    branch: snapshot.branch,
    commit: snapshot.commit,
    workingTreeClean: snapshot.workingTreeClean,
    hash: snapshot.hash,
    languages: snapshot.languages,
    scripts: snapshot.scripts,
    availableChecks: snapshot.availableChecks,
    fileTree: snapshot.fileTree.slice(0, 400),
    truncatedFileCount: snapshot.truncatedFileCount + Math.max(0, snapshot.fileTree.length - 400),
    documents: snapshot.documents.map((doc) => ({
      path: doc.path,
      truncated: doc.truncated,
      content: doc.content.slice(0, 4000),
    })),
    manifests: snapshot.manifests.map((manifest) => ({
      path: manifest.path,
      truncated: manifest.truncated,
      content: manifest.content.slice(0, 2000),
    })),
  };
}

function buildStepPrompts(input: {
  step: BrainStep;
  project: Project;
  objective: Objective;
  snapshot: RepoSnapshot | null;
  analysis: Analysis | null;
  architecture: Architecture | null;
  replan: ReplanRequest | null;
  repair: RepairContext | null;
  priorAnswers?: string[];
}): { systemPrompt: string; userPrompt: string } {
  const availableChecks = input.snapshot?.availableChecks ?? { requiredChecks: [], checkCommands: {} };
  const sections: string[] = [
    `AVITY_BRAIN_STEP: ${input.step}`,
    `AVITY_OBJECTIVE_JSON: ${JSON.stringify(input.objective.text)}`,
    `AVITY_ACCEPTANCE_CRITERIA_JSON: ${JSON.stringify(input.objective.acceptanceCriteria)}`,
    `AVITY_REPO_AVAILABLE: ${input.project.repoPath !== null}`,
    `AVITY_AVAILABLE_CHECKS_JSON: ${JSON.stringify(availableChecks)}`,
    "",
    `Objective (revision ${input.objective.revision}): ${input.objective.text}`,
    input.objective.acceptanceCriteria.length
      ? `Acceptance criteria (cover every index):\n${input.objective.acceptanceCriteria
          .map((criterion, index) => `${index}. ${criterion}`)
          .join("\n")}`
      : "Acceptance criteria: none declared — derive them from the objective.",
  ];
  if (input.priorAnswers && input.priorAnswers.length > 0) {
    sections.push(
      `Prior user clarification answers (do not re-ask these keys):\n${input.priorAnswers.map((line) => `- ${line}`).join("\n")}`,
    );
  }
  if (input.snapshot) {
    sections.push(`Repository snapshot (bounded, secret-free):\n${JSON.stringify(condensedSnapshot(input.snapshot))}`);
  } else {
    sections.push("Repository snapshot: none — this is a greenfield project without a repository.");
  }
  if (input.analysis) sections.push(`Validated analysis:\n${JSON.stringify(input.analysis)}`);
  if (input.architecture) sections.push(`Validated architecture:\n${JSON.stringify(input.architecture)}`);
  if (input.replan) {
    sections.push(
      `REPLANNING from real evidence — trigger: ${input.replan.trigger}; cause: ${input.replan.cause}; sources: ${input.replan.sources.join(", ")}. Produce a corrected plan that addresses this evidence while preserving still-valid work.`,
    );
  }
  sections.push(STEP_INSTRUCTIONS[input.step]);
  if (input.repair) {
    sections.push(
      `Your previous response was invalid. Issues:\n- ${input.repair.issues.slice(0, 20).join("\n- ")}\n\nPrevious response (excerpt):\n${input.repair.previousOutput}\n\nReturn a corrected JSON object that fixes every issue.`,
    );
  }
  return {
    systemPrompt: [
      `You are the central planning brain of AvityOS for project "${input.project.name}" (step: ${input.step}).`,
      "You reason and propose; the deterministic control plane owns all durable state and validates your output.",
      "Respond with exactly one JSON object matching the required schema, inside a ```json fence, with no other JSON in the reply.",
      "Never invent repository paths, scripts or check commands: only use what the snapshot proves to exist.",
      "Never request secrets, API keys, passwords, out-of-repository paths or arbitrary shell commands.",
    ].join("\n"),
    userPrompt: sections.join("\n\n"),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
