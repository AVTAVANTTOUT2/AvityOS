import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { TeamRole, type Mission, type Project } from "@avityos/contracts";
import {
  decideCorrection,
  decideFallback,
  selectMissionsToStart,
  unblockedMissions,
} from "@avityos/orchestration";
import {
  addMissionWorktree,
  changedFiles,
  commitAll,
  git,
  isCleanWorkingTree,
  listWorktrees,
  markGitHubPullRequestReady,
  missionBranchName,
  publishGitHubPullRequest,
  removeWorktree,
} from "@avityos/git";
import {
  checkBudget,
  ConfinementError,
  ensureConfinedDirectory,
  isCommandAllowed,
  isInsideRoot,
  isPathAllowed,
  resolveAndAssertInside,
  sandboxCommand,
  type CommandPolicy,
} from "@avityos/policy";
import type { ProviderAdapter } from "@avityos/providers";
import { BrainPipeline } from "./brain.js";
import {
  effectiveBrainProviderChain,
  effectiveProviderChainForRole,
  selectDistinctReviewerProvider,
  uniqueProviderChain,
} from "./provider-routing.js";
import { StoreConflictError, type Store } from "./store.js";

const execFileAsync = promisify(execFile);

export interface EngineConfig {
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProject: number;
  maxProviderRetries: number;
  maxWaitMs: number;
  tickMs: number;
  /** Policy: whether fallback may switch to another model of the same provider. */
  allowModelSwitch: boolean;
  /** Policy: whether fallback may move down the provider chain. */
  allowProviderSwitch: boolean;
  /** Allowlist for mission check commands (argv-based, no shell). */
  checkCommandPolicy: CommandPolicy;
  /** How long to wait for a worker-executed check before failing it. */
  checkTimeoutMs: number;
  /** Bounded repair attempts for invalid AI planning output. */
  maxPlanRepairAttempts: number;
  /** Evidence-based replans allowed per objective before escalating. */
  maxReplansPerObjective: number;
  /** Clarification rounds allowed per objective before escalating. */
  maxClarificationRounds: number;
  /** Hard cap on questions in one clarification round. */
  maxClarificationQuestions: number;
  /** Timeout for one AI brain pipeline step. */
  brainStepTimeoutMs: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxConcurrentRuns: 8,
  maxConcurrentRunsPerProject: 4,
  maxProviderRetries: 3,
  maxWaitMs: 120_000,
  tickMs: 250,
  allowModelSwitch: true,
  allowProviderSwitch: true,
  checkCommandPolicy: {
    allowedExecutables: ["git", "pnpm", "npm", "node", "swift", "ls", "echo", "cat", "pwd", "sleep"],
    deniedExecutables: ["rm", "sudo", "curl", "wget", "ssh", "scp"],
  },
  checkTimeoutMs: 10 * 60 * 1000,
  maxPlanRepairAttempts: 2,
  maxReplansPerObjective: 3,
  maxClarificationRounds: 3,
  maxClarificationQuestions: 8,
  brainStepTimeoutMs: 5 * 60 * 1000,
};

/**
 * The deterministic project engine. LLM providers write code and review it;
 * this class owns every state transition, worktree, retry, check execution,
 * budget gate and escalation. All durable state lives in the Store — the
 * engine can be recreated at any time (crash recovery) and continues from
 * persisted state.
 */
export class Engine {
  private timer: NodeJS.Timeout | null = null;
  private activeRuns = new Map<string, { cancel: () => Promise<void> }>();
  private ticking = false;
  private stopped = false;
  /** The AI planning pipeline; the engine remains the durable authority. */
  readonly brain: BrainPipeline;

  constructor(
    readonly store: Store,
    readonly providers: Map<string, ProviderAdapter>,
    readonly config: EngineConfig = DEFAULT_ENGINE_CONFIG,
    /** Ordered fallback chain of provider names (first = preferred). */
    readonly providerChain: string[] = ["fake"],
    /** Default model per provider (coding/author runs). */
    readonly defaultModels: Map<string, string> = new Map([["fake", "fake:succeed"]]),
    /** Reviewer model per provider — a distinct identity from the author. */
    readonly reviewModels: Map<string, string> = new Map([["fake", "fake:review-approve"]]),
    /** Optional team-role routing; remaining providers stay available as fallbacks. */
    readonly roleProviderChains: ReadonlyMap<Mission["role"], readonly string[]> = new Map(),
    /** Reasoning model per provider for the brain pipeline. */
    readonly brainModels: Map<string, string> = new Map([["fake", "fake:plan"]]),
  ) {
    // Reasoning does not require workspace edits: providers without editing
    // capability remain valid analysts/planners. The orchestrator role chain
    // is preferred, then the global chain (shared helper with the preflight).
    const brainChain = effectiveBrainProviderChain({
      providerChain,
      roleProviderChains,
    });
    this.brain = new BrainPipeline(store, providers, {
      providerChain: brainChain,
      models: brainModels,
      maxProviderRetries: config.maxProviderRetries,
      maxWaitMs: config.maxWaitMs,
      maxRepairAttempts: config.maxPlanRepairAttempts,
      maxReplansPerObjective: config.maxReplansPerObjective,
      maxClarificationRounds: config.maxClarificationRounds,
      maxClarificationQuestions: config.maxClarificationQuestions,
      stepTimeoutMs: config.brainStepTimeoutMs,
      checkCommandPolicy: config.checkCommandPolicy,
      allowModelSwitch: config.allowModelSwitch,
      allowProviderSwitch: config.allowProviderSwitch,
    });
  }

  /** Kept for API compatibility: the preferred provider name. */
  get defaultProvider(): string {
    return this.providerChain[0] ?? "fake";
  }

  /**
   * Defensive snapshot of provider routing for diagnostics (E2E preflight).
   * Never exposes mutable internal collections.
   */
  getProviderRoutingSnapshot(): {
    providers: Map<string, ProviderAdapter>;
    providerChain: readonly string[];
    roleProviderChains: ReadonlyMap<string, readonly string[]>;
    missionRoles: readonly string[];
  } {
    return {
      providers: new Map(this.providers),
      providerChain: [...this.providerChain],
      roleProviderChains: new Map(
        [...this.roleProviderChains.entries()].map(([role, chain]) => [role, [...chain]]),
      ),
      missionRoles: [...TeamRole.options],
    };
  }

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
    await this.brain.stop();
    for (const [runId, handle] of this.activeRuns) {
      await handle.cancel();
      this.activeRuns.delete(runId);
    }
  }

  /**
   * Startup reconciliation (ADR-0003): any run recorded as active belongs to
   * a dead process. Mark it failed once and route its mission through the
   * normal bounded retry path — worktrees are reused, commits are skipped
   * when the tree is clean, and PR records are idempotent per mission, so a
   * restart cannot duplicate side effects.
   */
  reconcile(): void {
    this.store.releaseOrphanedClarificationResumeClaims();
    // snapshot BEFORE orphan handling: failValidation may legitimately
    // re-dispatch missions as `assigned`, and those must not be demoted
    const staleAssigned = this.store.listMissions(undefined, "assigned").map((m) => m.id);
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
    for (const missionId of staleAssigned) {
      if (this.store.getMission(missionId)?.state === "assigned") {
        this.store.transitionMission(missionId, "ready", "reconciled after restart");
      }
    }
    for (const mission of this.store.listMissions(undefined, "validating")) {
      void this.validateMission(mission.id);
    }
    for (const mission of this.store.listMissions(undefined, "review_required")) {
      void this.reviewMission(mission.id);
    }
    // Recover clarification resumes whose brain kick was lost to a crash
    // between the answer commit and startPlanning (invariant P-RESUME).
    for (const pending of this.store.listPendingClarificationResumes()) {
      if (this.store.isProjectPaused(pending.projectId)) continue;
      this.resumeAfterClarification(pending.id);
    }
    this.brain.reconcile();
  }

  // ── objective intake ─────────────────────────────────────────────────────

  analyzeObjective(projectId: string, objectiveId: string): { clarificationId: string | null } {
    const objective = this.store.getObjective(objectiveId);
    const project = this.store.getProject(projectId);
    if (!objective || !project) throw new Error("objective or project not found");
    if (project.status === "paused") {
      throw new Error(`project ${projectId} is paused; resume before submitting a new objective analysis`);
    }

    const text = objective.text.trim();
    // Deterministic policy gate only — never labelled as AI clarification.
    const tooVague = text.length < 80 && objective.acceptanceCriteria.length === 0;
    if (tooVague) {
      const clarification = this.store.createClarification({
        projectId,
        objectiveId,
        provenance: "deterministic_policy",
        providerId: null,
        model: null,
        questions: [
          {
            logicalKey: "acceptance-criteria",
            category: "acceptance_criteria",
            question:
              "What are the concrete acceptance criteria? List the observable behaviors that must be true for this objective to be complete.",
            reason: "The objective is too short and has no acceptance criteria, so planning cannot start safely.",
            answerType: "text",
            options: [],
            required: true,
            acceptanceCriteriaRefs: [],
            blockedDecisions: ["plan coverage"],
            blockedMissions: [],
            displayOrder: 0,
          },
          {
            logicalKey: "out-of-scope",
            category: "scope",
            question:
              "What is explicitly out of scope for this objective (platforms, integrations, environments to ignore)?",
            reason: "Scope boundaries are required before the AI planner can propose missions.",
            answerType: "text",
            options: [],
            required: true,
            acceptanceCriteriaRefs: [],
            blockedDecisions: ["mission scope"],
            blockedMissions: [],
            displayOrder: 1,
          },
        ],
      });
      this.store.setObjectiveAnalysis(
        objectiveId,
        "Deterministic policy gate: objective needs clarification (no acceptance criteria and very short). Not an AI clarification.",
      );
      this.store.setProjectStatus(projectId, "clarifying");
      return { clarificationId: clarification.id };
    }

    this.store.setObjectiveAnalysis(objectiveId, "Objective intake accepted; AI planning started.");
    this.startPlanning(projectId, objectiveId);
    return { clarificationId: null };
  }

  /**
   * Kick the durable asynchronous AI pipeline for the latest objective
   * revision. A previous plan for an older revision makes this an
   * `objective_revised` replan with recorded cause and sources.
   */
  private startPlanning(projectId: string, objectiveId: string): void {
    const objective = this.store.getObjective(objectiveId);
    const previousPlan = this.store.activePlan(projectId);
    const replan =
      previousPlan && previousPlan.objectiveId !== objectiveId
        ? {
            trigger: "objective_revised" as const,
            cause: `objective revision ${objective?.revision ?? "?"} supersedes the plan v${previousPlan.version} objective`,
            sources: [`objective:${objectiveId}`, `plan:${previousPlan.id}`],
          }
        : undefined;
    this.store.setProjectStatus(projectId, "planning");
    void this.brain.ensurePlan(projectId, objectiveId, replan).catch((err) => {
      if (this.stopped) return;
      try {
        this.store.appendAudit(projectId, "engine", "brain.pipeline_error", String(err).slice(0, 500));
      } catch {
        // shutdown race: the database may already be closed
      }
    });
  }

  /**
   * Resume the brain pipeline after a clarification group was answered.
   *
   * Durable and idempotent (invariant P-RESUME): the answer transaction sets a
   * durable `resume_pending` flag, so a crash between the answer commit and
   * this call is recovered by {@link reconcile}. The engine atomically claims
   * the outbox intent and materializes every decision with a per-question
   * idempotency key before planning is kicked. An orphaned claim is released
   * on restart; a paused project is skipped and re-driven on explicit resume.
   */
  resumeAfterClarification(clarificationId: string): boolean {
    let claimed: { projectId: string; objectiveId: string } | null = null;
    try {
      claimed = this.store.claimClarificationResume(clarificationId);
    } catch (err) {
      if (err instanceof StoreConflictError && err.code === "project_paused") return false;
      throw err;
    }
    if (!claimed) return false;
    try {
      // Kick planning first (durably sets status=planning), then acknowledge
      // the claimed outbox intent. A synchronous failure releases the claim.
      this.startPlanning(claimed.projectId, claimed.objectiveId);
      this.store.clearClarificationResume(clarificationId);
      return true;
    } catch (err) {
      this.store.releaseClarificationResume(clarificationId);
      throw err;
    }
  }

  /**
   * Atomic project pause: durable pause request, scheduling freeze, cancel
   * active provider runs, revoke worker leases and fence late results.
   */
  async pauseProject(
    projectId: string,
    opts: { reason?: string; actor?: string; idempotencyKey?: string } = {},
  ): Promise<ReturnType<Store["getProjectPauseState"]>> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    const begun = this.store.beginProjectPause({
      projectId,
      reason: opts.reason ?? "",
      actor: opts.actor ?? "user",
      idempotencyKey: opts.idempotencyKey,
    });
    if (begun.alreadyPaused) return begun.state;

    await this.brain.cancelProject(projectId);
    for (const runId of begun.runIdsToCancel) {
      const handle = this.activeRuns.get(runId);
      if (handle) {
        try {
          await handle.cancel();
        } catch {
          // Provider ignore is fenced by run state + pause generation.
        }
        this.activeRuns.delete(runId);
      }
      this.store.completePausedRunCancellation(runId, "cancelled by atomic project pause");
    }
    this.store.revokeProjectWorkerLeases(projectId);
    return this.store.getProjectPauseState(projectId);
  }

  /**
   * Atomic project resume: restore status, restart interrupted missions as
   * new attempts, and resume planning exactly once when needed.
   */
  async resumeProject(
    projectId: string,
    opts: { actor?: string; idempotencyKey?: string } = {},
  ): Promise<ReturnType<Store["getProjectPauseState"]>> {
    const resumed = this.store.resumeProject({
      projectId,
      actor: opts.actor ?? "user",
      idempotencyKey: opts.idempotencyKey,
    });
    if (resumed.alreadyResumed) return resumed.state;

    let clarificationResumed = false;
    for (const pending of this.store.listPendingClarificationResumes()) {
      if (pending.projectId !== projectId) continue;
      clarificationResumed = this.resumeAfterClarification(pending.id) || clarificationResumed;
    }

    if (resumed.resumePlanning && !clarificationResumed) {
      const objective = this.store.latestObjective(projectId);
      if (objective) this.startPlanning(projectId, objective.id);
    }

    for (const item of resumed.missionsToResume) {
      const mission = this.store.getMission(item.missionId);
      if (!mission) continue;
      if (mission.state === "ready" && ["running", "assigned", "retrying"].includes(item.fromState)) {
        // New attempt linked to history via prior cancelled runs; scheduler starts it.
        continue;
      }
      if (mission.state === "validating") void this.validateMission(mission.id);
      if (mission.state === "review_required") void this.reviewMission(mission.id);
      if (mission.state === "approved") void this.integrateMission(mission.id);
    }
    return this.store.getProjectPauseState(projectId);
  }

  /**
   * Fence a durable side effect against an in-flight pause. Returns true (and
   * records an explicit `run.fenced` event) when the project became paused
   * during an asynchronous workflow, meaning the caller must abandon the late
   * result without creating a checkpoint, integrating a change, mutating the
   * paused mission or consuming budget again (invariant P-FENCE). Callers must
   * re-check after every provider await and before every durable effect.
   */
  private fencePausedWork(
    projectId: string,
    missionId: string | null,
    context: string,
    expectedPauseGeneration = this.store.getPauseGeneration(projectId),
  ): boolean {
    const generation = this.store.getPauseGeneration(projectId);
    if (!this.store.isProjectPaused(projectId) && generation === expectedPauseGeneration) return false;
    this.store.appendEvent("run.fenced", { projectId, missionId }, {
      reason: `project pause fence: ${context} discarded`,
      context,
      expectedPauseGeneration,
      actualPauseGeneration: generation,
    });
    this.store.appendAudit(
      projectId,
      "engine",
      "pause.fenced",
      `${context}${missionId ? ` (mission ${missionId})` : ""}`,
    );
    return true;
  }

  // ── scheduling tick ──────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const project of this.store.listProjects()) {
        if (project.status !== "active") continue;
        const pauseGeneration = this.store.getPauseGeneration(project.id);
        const missions = this.store.listMissions(project.id);
        const deps = this.store.listDependencies(project.id);
        for (const m of unblockedMissions(missions, deps)) {
          this.store.transitionMission(m.id, "ready", "dependencies satisfied", "engine", pauseGeneration);
        }
      }
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
        const pauseGeneration = this.store.getPauseGeneration(project.id);
        this.store.transitionMission(mission.id, "assigned", "scheduled", "engine", pauseGeneration);
        void this.executeMission(mission.id).catch((err) => {
          this.store.appendAudit(mission.projectId, "engine", "mission.execute_error", String(err));
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  // ── worktrees ────────────────────────────────────────────────────────────

  /**
   * Coding missions execute inside a dedicated git worktree on a mission
   * branch (`mission/<id>-<slug>`), created from the project's base branch
   * and persisted on the mission. Reused (not recreated) after restarts.
   */
  private async ensureWorktree(
    project: Project,
    mission: Mission,
    expectedPauseGeneration: number,
  ): Promise<string | null> {
    if (!project.repoPath) return null;
    const branch = mission.branchName ?? missionBranchName(mission.id, mission.title);
    const worktreePath = mission.worktreePath ?? join(project.repoPath, ".avity", "worktrees", mission.id);

    // Confine the worktree location to <repo>/.avity/worktrees on canonical
    // paths. Rejects a persisted/redirected worktree path that escapes, and a
    // `.avity/worktrees` whose components symlink outside the repository.
    assertWorktreeConfined(project.repoPath, worktreePath);

    if (!existsSync(worktreePath)) {
      // `.avity/worktrees` was created/validated by assertWorktreeConfined; do
      // not recursively mkdir through unvalidated components.
      const existing = await listWorktrees(project.repoPath);
      if (this.fencePausedWork(project.id, mission.id, "worktree listing", expectedPauseGeneration)) return null;
      const branchExists = (await git(project.repoPath, "branch", "--list", branch)).trim().length > 0;
      if (this.fencePausedWork(project.id, mission.id, "worktree branch lookup", expectedPauseGeneration)) return null;
      if (existing.some((w) => w.branch === branch)) {
        // branch is checked out in a stale worktree path; detach it first
        const stale = existing.find((w) => w.branch === branch)!;
        await removeWorktree(project.repoPath, stale.path, true).catch(() => undefined);
        if (this.fencePausedWork(project.id, mission.id, "stale worktree removal", expectedPauseGeneration)) return null;
      }
      if (branchExists) {
        await git(project.repoPath, "worktree", "add", worktreePath, branch);
      } else {
        await addMissionWorktree(project.repoPath, worktreePath, branch, project.defaultBranch);
      }
      if (this.fencePausedWork(project.id, mission.id, "worktree creation", expectedPauseGeneration)) return null;
    }
    this.store.updateMissionMeta(mission.id, { branchName: branch, worktreePath }, expectedPauseGeneration);
    this.store.appendEvent("git.branch_created", { projectId: project.id, missionId: mission.id }, {
      branch,
      worktreePath,
    });
    return worktreePath;
  }

  private async cleanupWorktree(mission: Mission, expectedPauseGeneration?: number): Promise<void> {
    const project = this.store.getProject(mission.projectId);
    if (!project?.repoPath || !mission.worktreePath) return;
    if (!existsSync(mission.worktreePath)) return;
    await removeWorktree(project.repoPath, mission.worktreePath, true).catch(() => undefined);
    if (
      expectedPauseGeneration !== undefined &&
      this.fencePausedWork(project.id, mission.id, "worktree cleanup", expectedPauseGeneration)
    ) return;
    this.store.appendAudit(project.id, "engine", "worktree.cleanup", mission.worktreePath);
  }

  // ── mission execution ────────────────────────────────────────────────────

  async executeMission(missionId: string): Promise<void> {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "assigned") return;
    const project = this.store.getProject(mission.projectId)!;
    const pauseGeneration = this.store.getPauseGeneration(project.id);
    if (this.fencePausedWork(project.id, missionId, "mission execution", pauseGeneration)) return;

    const budget = this.store.getBudget(project.id);
    if (budget) {
      const check = checkBudget(budget.limitUsd, budget.spentUsd, 0, budget.warnAtFraction);
      if (check.warn) {
        this.store.appendEvent("budget.threshold", { projectId: project.id, missionId }, {
          limitUsd: budget.limitUsd,
          spentUsd: budget.spentUsd,
          warnAtFraction: budget.warnAtFraction,
          remainingUsd: check.remainingUsd,
        });
      }
      if (!check.allowed || check.remainingUsd <= 0) {
        this.store.transitionMission(missionId, "blocked", "project budget exhausted", "engine", pauseGeneration);
        this.store.createApproval(project.id, missionId, "Budget exhausted", "Increase the budget or cancel remaining missions.");
        return;
      }
    }

    let worktreePath: string | null = null;
    try {
      worktreePath = await this.ensureWorktree(project, mission, pauseGeneration);
      if (this.fencePausedWork(project.id, missionId, "worktree preparation", pauseGeneration)) return;
    } catch (err) {
      if (this.fencePausedWork(project.id, missionId, "worktree preparation failure", pauseGeneration)) return;
      this.store.transitionMission(missionId, "blocked", `worktree creation failed: ${String(err).slice(0, 300)}`, "engine", pauseGeneration);
      this.store.createApproval(project.id, missionId, "Worktree creation failed", String(err).slice(0, 500));
      return;
    }

    const orderedProviderChain = effectiveProviderChainForRole(
      {
        providerChain: this.providerChain,
        roleProviderChains: this.roleProviderChains,
      },
      mission.role,
    );
    const eligibleProviders = orderedProviderChain.filter((name) => {
      const adapter = this.providers.get(name);
      return adapter && (!worktreePath || adapter.capabilities().workspaceEdits);
    });
    if (eligibleProviders.length === 0) {
      this.store.transitionMission(
        missionId,
        "blocked",
        worktreePath
          ? "no configured provider can edit a mission workspace"
          : "no configured provider is available",
        "engine",
        pauseGeneration,
      );
      this.store.createApproval(
        project.id,
        missionId,
        "No capable coding provider",
        "Configure Claude Code, Cursor CLI, Codex CLI, or another adapter that advertises workspace editing.",
      );
      return;
    }

    this.store.transitionMission(missionId, "running", `run starting on ${eligibleProviders[0]}`, "engine", pauseGeneration);

    let providerIdx = 0;
    let attempt = 0;
    let model: string | null = null;

    while (true) {
      if (this.stopped) return;
      if (this.fencePausedWork(project.id, missionId, "mission continuation", pauseGeneration)) return;
      const current = this.store.getMission(missionId);
      if (!current || current.state !== "running") return;

      const providerName = eligibleProviders[providerIdx];
      const adapter = providerName ? this.providers.get(providerName) : undefined;
      if (!providerName || !adapter) {
        this.store.transitionMission(missionId, "blocked", "no provider available in the configured chain", "engine", pauseGeneration);
        this.store.createApproval(project.id, missionId, "No provider available", "Configure a provider and approve to retry.");
        return;
      }
      const models = await adapter.listModels();
      if (this.fencePausedWork(project.id, missionId, "provider model discovery", pauseGeneration)) return;
      if (model === null || !models.includes(model)) {
        model = this.defaultModels.get(providerName) ?? models[0] ?? "default";
      }

      const run = this.store.createRun({
        projectId: project.id,
        missionId,
        providerId: providerName,
        model,
        expectedPauseGeneration: pauseGeneration,
      });
      this.store.transitionRun(run.id, "starting", {}, pauseGeneration);

      const handle = adapter.startRun({
        runId: run.id,
        model,
        systemPrompt: buildSystemPrompt(project, current, this.store.listBrainEntries(project.id)),
        userPrompt: current.contract.objective,
        ...(worktreePath ? { cwd: worktreePath } : {}),
        ...(worktreePath && project.repoPath
          ? { sandboxReadablePaths: [project.repoPath] }
          : {}),
        timeoutMs: (current.contract.timeoutSeconds ?? 900) * 1000,
      });
      this.activeRuns.set(run.id, handle);
      this.store.transitionRun(run.id, "running", {}, pauseGeneration);

      let outcome:
        | { kind: "completed"; result: string }
        | { kind: "error"; category: string; retryAfterMs: number | null }
        | null = null;

      try {
        for await (const ev of handle.events) {
          if (this.fencePausedWork(project.id, missionId, "provider event", pauseGeneration)) break;
          switch (ev.type) {
            case "output":
              this.store.appendRunLog(run.id, ev.text, pauseGeneration);
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
                expectedPauseGeneration: pauseGeneration,
              });
              break;
            case "artifact":
              this.store.appendRunLog(run.id, `artifact: ${ev.path}\n`, pauseGeneration);
              break;
            case "checkpoint_request":
              this.store.upsertCheckpoint(
                project.id,
                missionId,
                "policy",
                "pending",
                ev.reason,
                pauseGeneration,
              );
              break;
            case "completed":
              outcome = { kind: "completed", result: ev.resultText };
              break;
            case "error":
              outcome = { kind: "error", category: ev.category, retryAfterMs: ev.retryAfterMs ?? null };
              this.store.appendRunLog(run.id, `error(${ev.category}): ${ev.message}\n`, pauseGeneration);
              break;
          }
        }
      } finally {
        this.activeRuns.delete(run.id);
      }

      if (this.stopped) return; // process shutting down; reconcile handles this run
      if (this.fencePausedWork(project.id, missionId, "provider outcome", pauseGeneration)) return;

      // Atomic pause / fencing: refuse late results from revoked runs.
      const freshRun = this.store.getRun(run.id);
      const freshProject = this.store.getProject(project.id);
      if (
        !freshRun ||
        !freshProject ||
        freshProject.status === "paused" ||
        !["running", "starting"].includes(freshRun.state)
      ) {
        if (freshRun && ["cancelling", "cancelled"].includes(freshRun.state) && outcome?.kind === "completed") {
          this.store.appendEvent("run.fenced", {
            projectId: project.id,
            missionId,
            runId: run.id,
          }, { reason: "late provider result after pause/cancel", outcome: "completed" });
        }
        return;
      }

      if (outcome?.kind === "completed") {
        try {
          this.store.assertRunAcceptable(run.id, pauseGeneration);
        } catch {
          return;
        }
        this.store.transitionRun(run.id, "succeeded", { exitReason: "completed" }, pauseGeneration);
        this.store.transitionMission(missionId, "result_submitted", "provider reported completion", "engine", pauseGeneration);
        this.store.addBrainEntry(project.id, "fact", `Mission result: ${current.title.slice(0, 80)}`, outcome.result.slice(0, 2000), [
          `mission:${missionId}`,
          `run:${run.id}`,
        ], pauseGeneration);
        this.store.transitionMission(missionId, "validating", "starting deterministic validation", "engine", pauseGeneration);
        await this.validateMission(missionId, pauseGeneration);
        return;
      }

      const category = outcome?.kind === "error" ? outcome.category : "agent_crash";
      if (!["running", "starting"].includes(this.store.getRun(run.id)?.state ?? "")) return;
      this.store.transitionRun(
        run.id,
        "failed",
        { exitReason: "provider error", errorCategory: category },
        pauseGeneration,
      );

      const decision = decideFallback({
        category: category as never,
        attempt,
        maxRetries: this.config.maxProviderRetries,
        retryAfterMs: outcome?.kind === "error" ? outcome.retryAfterMs : null,
        maxWaitMs: this.config.maxWaitMs,
        alternateModelsAvailable:
          this.config.allowModelSwitch && models.length > 1 && models.indexOf(model) < models.length - 1,
        alternateProvidersAllowed:
          this.config.allowProviderSwitch && providerIdx < eligibleProviders.length - 1,
      });
      this.store.appendEvent("provider.fallback", { projectId: project.id, missionId, runId: run.id }, {
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
          if (this.stopped) return;
          if (this.fencePausedWork(project.id, missionId, "provider retry wait", pauseGeneration)) return;
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
        case "escalate_user": {
          this.store.transitionMission(missionId, "blocked", decision.reason, "engine", pauseGeneration);
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

  // ── validation: real checks, real evidence ───────────────────────────────

  /**
   * Deterministic validation. Evidence-based only:
   * - changed files must respect the mission's path contract;
   * - every required check runs its configured real command in the worktree
   *   (via a capable worker when available, OS-sandboxed locally otherwise)
   *   and passes
   *   solely on its exit code;
   * - a required check with no configured command fails — checks are never
   *   assumed.
   */
  async validateMission(missionId: string, expectedPauseGeneration?: number): Promise<void> {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "validating") return;
    const project = this.store.getProject(mission.projectId)!;
    const pauseGeneration = expectedPauseGeneration ?? this.store.getPauseGeneration(project.id);
    if (this.fencePausedWork(project.id, missionId, "validation", pauseGeneration)) return;

    const runs = this.store.listRuns({ missionId, states: ["succeeded"] });
    if (runs.length === 0) {
      this.failValidation(mission, "validation failed: no successful run result", pauseGeneration);
      return;
    }

    // 1) path-scope enforcement on actual changed files
    if (mission.worktreePath && mission.branchName && project.repoPath) {
      const changed = await worktreeChangedFiles(mission.worktreePath, project.repoPath, project.defaultBranch, mission.branchName);
      if (this.fencePausedWork(project.id, missionId, "validation path scan", pauseGeneration)) return;
      if ((mission.contract.workspaceChangesRequired ?? true) && changed.length === 0) {
        this.store.upsertCheckpoint(project.id, missionId, "policy", "failed", "coding mission produced no file changes", pauseGeneration);
        this.failValidation(mission, "validation failed: coding mission produced no file changes", pauseGeneration);
        return;
      }
      for (const file of changed) {
        const verdict = isPathAllowed(
          mission.worktreePath,
          mission.contract.allowedPaths,
          mission.contract.forbiddenPaths,
          join(mission.worktreePath, file),
        );
        if (verdict.effect !== "allow") {
          this.store.upsertCheckpoint(project.id, missionId, "policy", "failed", `changed file ${file}: ${verdict.reason}`, pauseGeneration);
          this.store.appendAudit(project.id, "policy", "mission.path_violation", `${missionId}: ${file}`);
          this.failValidation(mission, `path policy violation: ${file}`, pauseGeneration);
          return;
        }
      }
      this.store.upsertCheckpoint(
        project.id,
        missionId,
        "policy",
        "passed",
        changed.length ? `${changed.length} changed file(s) within contract paths` : "no file changes",
        pauseGeneration,
      );

      for (const artifact of mission.contract.expectedArtifacts) {
        // Canonical, fail-closed artifact confinement: relative-only, no `..`,
        // must exist, and the artifact itself must not be a symlink (nor sit
        // behind a symlink component that resolves outside the worktree).
        let confined: string;
        try {
          confined = resolveAndAssertInside(mission.worktreePath, artifact, {
            allowAbsolute: false,
            allowParentSegments: false,
            mustExist: true,
            denySymlinkedFinal: true,
          }).absolute;
        } catch (err) {
          const reason = err instanceof ConfinementError ? err.message : String(err);
          this.store.appendAudit(project.id, "policy", "mission.artifact_violation", `${missionId}: ${artifact}`);
          this.failValidation(mission, `expected artifact rejected: ${artifact} (${reason})`, pauseGeneration);
          return;
        }
        const verdict = isPathAllowed(
          mission.worktreePath,
          mission.contract.allowedPaths,
          mission.contract.forbiddenPaths,
          confined,
        );
        if (verdict.effect !== "allow") {
          this.failValidation(mission, `expected artifact forbidden: ${artifact} (${verdict.reason})`, pauseGeneration);
          return;
        }
      }
    }

    // 2) required checks execute their real commands
    for (const kind of mission.contract.requiredChecks) {
      // A pause during a preceding check must not accept later check results.
      if (this.fencePausedWork(project.id, missionId, "validation checks", pauseGeneration)) return;
      const argv = mission.contract.checkCommands[kind];
      if (!argv || argv.length === 0) {
        this.store.upsertCheckpoint(project.id, missionId, kind, "failed", "no command configured for required check", pauseGeneration);
        this.failValidation(mission, `required check ${kind} has no configured command`, pauseGeneration);
        return;
      }
      const cwd = mission.worktreePath ?? project.repoPath;
      if (!cwd) {
        this.store.upsertCheckpoint(project.id, missionId, kind, "failed", "no worktree/repository to run the check in", pauseGeneration);
        this.failValidation(mission, `required check ${kind} has nowhere to run`, pauseGeneration);
        return;
      }
      this.store.upsertCheckpoint(project.id, missionId, kind, "running", argv.join(" "), pauseGeneration);
      const result = await this.runCheckCommand(project.id, argv, cwd, pauseGeneration);
      if (this.fencePausedWork(project.id, missionId, `validation check ${kind}`, pauseGeneration)) return;
      this.store.upsertCheckpoint(
        project.id,
        missionId,
        kind,
        result.ok ? "passed" : "failed",
        `${argv.join(" ")} -> exit ${result.exitCode}${result.detail ? `: ${result.detail.slice(0, 400)}` : ""}`,
        pauseGeneration,
      );
      if (!result.ok) {
        this.failValidation(mission, `check ${kind} failed (exit ${result.exitCode})`, pauseGeneration);
        return;
      }
    }

    // 3) commit validated work (idempotent: skipped when tree is clean)
    // Fence before any durable git side effect: a pause here must not commit,
    // publish a PR or advance the mission.
    if (this.fencePausedWork(project.id, missionId, "validation commit", pauseGeneration)) return;
    if (mission.worktreePath && mission.branchName && project.repoPath) {
      try {
        const clean = await isCleanWorkingTree(mission.worktreePath);
        if (this.fencePausedWork(project.id, missionId, "validation clean-tree check", pauseGeneration)) return;
        if (!clean) {
          const commit = await commitAll(
            mission.worktreePath,
            `feat(${missionId}): ${mission.title.slice(0, 80)}\n\nMission: ${missionId}\nValidated-by: AvityOS checks`,
          );
          if (this.fencePausedWork(project.id, missionId, "validation commit result", pauseGeneration)) return;
          this.store.appendEvent("git.commit_created", { projectId: project.id, missionId }, {
            commit,
            branch: mission.branchName,
          });
          this.store.appendAudit(project.id, "engine", "git.commit", `${missionId}: ${commit}`);
        }
        if (project.repoRemoteUrl) {
          try {
            const published = await publishGitHubPullRequest({
              repoPath: project.repoPath,
              remoteUrl: project.repoRemoteUrl,
              branch: mission.branchName,
              baseBranch: project.defaultBranch,
              title: mission.title,
              body: buildPullRequestBody(project, mission, this.store.listCheckpoints(missionId)),
            });
            if (this.fencePausedWork(project.id, missionId, "validation publication", pauseGeneration)) return;
            this.store.upsertPullRequest({
              projectId: project.id,
              missionId,
              branch: mission.branchName,
              title: mission.title,
              state: published.state,
              number: published.number,
              url: published.url,
              expectedPauseGeneration: pauseGeneration,
            });
          } catch (err) {
            if (this.fencePausedWork(project.id, missionId, "validation publication failure", pauseGeneration)) return;
            this.store.transitionMission(
              missionId,
              "blocked",
              `GitHub publication failed: ${String(err).slice(0, 300)}`,
              "engine",
              pauseGeneration,
            );
            this.store.createApproval(
              project.id,
              missionId,
              "GitHub publication requires attention",
              "Verify gh authentication, repository permissions and the configured remote, then approve to retry.",
            );
            return;
          }
        } else {
          this.store.upsertPullRequest({
            projectId: project.id,
            missionId,
            branch: mission.branchName,
            title: mission.title,
            state: "open",
            expectedPauseGeneration: pauseGeneration,
          });
        }
      } catch (err) {
        if (this.fencePausedWork(project.id, missionId, "validation commit failure", pauseGeneration)) return;
        this.failValidation(mission, `commit failed: ${String(err).slice(0, 300)}`, pauseGeneration);
        return;
      }
    }

    if (this.fencePausedWork(project.id, missionId, "validation completion", pauseGeneration)) return;
    this.store.transitionMission(missionId, "review_required", "validation passed; awaiting independent review", "engine", pauseGeneration);
    await this.reviewMission(missionId, pauseGeneration);
  }

  /** Run a check command: leased to a compatible worker, OS-sandboxed locally otherwise. */
  private async runCheckCommand(
    projectId: string,
    argv: string[],
    cwd: string,
    expectedPauseGeneration: number,
  ): Promise<{ ok: boolean; exitCode: number | null; detail: string }> {
    const verdict = isCommandAllowed(this.config.checkCommandPolicy, argv);
    this.store.appendEvent("policy.decision", { projectId }, {
      action: "check.exec",
      resource: argv.join(" "),
      effect: verdict.effect,
      reason: verdict.reason,
    });
    if (verdict.effect !== "allow") {
      this.store.appendAudit(projectId, "policy", "check.denied", `${argv.join(" ")}: ${verdict.reason}`);
      return { ok: false, exitCode: null, detail: verdict.reason };
    }

    if (this.store.hasAvailableWorker(argv)) {
      const terminal = this.store.createTerminal(projectId, argv, cwd, null, undefined, expectedPauseGeneration);
      const deadline = Date.now() + this.config.checkTimeoutMs;
      while (Date.now() < deadline) {
        if (this.stopped) return { ok: false, exitCode: null, detail: "engine stopped" };
        if (
          this.store.isProjectPaused(projectId) ||
          this.store.getPauseGeneration(projectId) !== expectedPauseGeneration
        ) {
          this.store.setTerminalState(terminal.id, "cancelling");
          return { ok: false, exitCode: null, detail: "project paused during check" };
        }
        const t = this.store.getTerminal(terminal.id)!;
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(t.state)) {
          const logs = this.store.terminalLogs(terminal.id).map((l) => l.text).join("");
          return { ok: t.state === "succeeded", exitCode: t.exitCode, detail: logs.slice(-500) };
        }
        await sleep(150);
      }
      this.store.setTerminalState(terminal.id, "cancelling");
      return { ok: false, exitCode: null, detail: "check timed out waiting for worker" };
    }

    // Checks run in a mission worktree (`<repo>/.avity/worktrees/<name>`) whose
    // linked `.git` file points at the main repository's git common dir. Under
    // the fail-closed sandbox that directory is outside the workspace, so git
    // would report "not a git repository". Grant read on the *server-validated*
    // project repo path (never the worktree's own `.git`, which the untrusted
    // repository controls and could redirect elsewhere).
    const readablePaths: string[] = [];
    const repoPath = this.store.getProject(projectId)?.repoPath;
    if (repoPath && existsSync(repoPath)) readablePaths.push(repoPath);

    let invocation: ReturnType<typeof sandboxCommand> | null = null;
    try {
      invocation = sandboxCommand(argv, cwd, readablePaths.length ? { readablePaths } : {});
    } catch (err) {
      // Fail closed with an identifiable detail: never pretend a missing OS
      // sandbox was a non-zero exit from the check command itself.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        exitCode: null,
        detail: `sandbox_unavailable: ${message}`,
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(invocation.executable, invocation.args, {
        cwd,
        timeout: this.config.checkTimeoutMs,
        env: invocation.env,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { ok: true, exitCode: 0, detail: (stdout + stderr).slice(-500) };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        ok: false,
        exitCode: typeof e.code === "number" ? e.code : 1,
        detail: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-500),
      };
    } finally {
      invocation.cleanup();
    }
  }

  failValidation(mission: Mission, reason: string, expectedPauseGeneration?: number): void {
    const decision = decideCorrection(mission);
    if (decision.kind === "retry") {
      this.store.updateMissionMeta(
        mission.id,
        { correctionAttempts: decision.attempt },
        expectedPauseGeneration,
      );
      this.store.appendEvent("mission.correction_loop", { projectId: mission.projectId, missionId: mission.id }, {
        attempt: decision.attempt,
        max: mission.maxCorrectionAttempts,
        reason,
      });
      this.store.transitionMission(mission.id, "retrying", reason, "engine", expectedPauseGeneration);
      this.store.transitionMission(
        mission.id,
        "assigned",
        `correction attempt ${decision.attempt}`,
        "engine",
        expectedPauseGeneration,
      );
      void this.executeMission(mission.id);
    } else {
      this.store.transitionMission(mission.id, "failed", decision.reason, "engine", expectedPauseGeneration);
      this.store.createApproval(
        mission.projectId,
        mission.id,
        "Correction limit reached",
        `${decision.reason}. Approve to grant more attempts, reject to cancel.`,
      );
      this.maybeReplanAfterFailure(mission, reason);
    }
  }

  /**
   * Evidence-based replanning trigger: a plan mission that failed after its
   * bounded correction loop. Bounded and idempotent in the pipeline; the
   * failed mission remains in history. If a replacement plan is committed,
   * its stale approval is withdrawn atomically and cannot restart old work.
   */
  private maybeReplanAfterFailure(mission: Mission, reason: string): void {
    if (!mission.planId) return;
    const project = this.store.getProject(mission.projectId);
    if (!project || project.autonomyProfile === "supervised") return;
    const objective = this.store.latestObjective(project.id);
    if (!objective) return;
    const evidence = this.store
      .listCheckpoints(mission.id)
      .filter((checkpoint) => checkpoint.status === "failed")
      .map((checkpoint) => `checkpoint:${checkpoint.id}`);
    void this.brain
      .ensurePlan(project.id, objective.id, {
        trigger: "mission_failed",
        cause: `mission ${mission.id} (${mission.title.slice(0, 80)}) failed after bounded correction: ${reason}`.slice(0, 500),
        sources: [`mission:${mission.id}`, ...evidence],
      })
      .catch((err) => {
        if (this.stopped) return;
        try {
          this.store.appendAudit(project.id, "engine", "brain.pipeline_error", String(err).slice(0, 500));
        } catch {
          // shutdown race: the database may already be closed
        }
      });
  }

  // ── independent review ───────────────────────────────────────────────────

  /**
   * Genuine independent review: a separate reviewer run with a distinct
   * identity (dedicated review model; a different provider from the author
   * when the chain offers one) receives the diff, requirements and check
   * evidence, and must return an explicit VERDICT. review_required never
   * auto-approves. Supervised projects require a human instead.
   */
  async reviewMission(missionId: string, expectedPauseGeneration?: number): Promise<void> {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "review_required") return;
    const project = this.store.getProject(mission.projectId)!;
    const pauseGeneration = expectedPauseGeneration ?? this.store.getPauseGeneration(project.id);
    if (this.fencePausedWork(project.id, missionId, "review", pauseGeneration)) return;

    if (project.autonomyProfile === "supervised") {
      this.store.createApproval(
        project.id,
        missionId,
        `Review required: ${mission.title.slice(0, 100)}`,
        "Supervised project: approve to integrate this mission's result.",
      );
      return;
    }

    const authorRun = this.store.listRuns({ missionId, states: ["succeeded"] }).at(-1);
    const authorProvider = authorRun?.providerId ?? this.defaultProvider;
    // Historical behaviour: reviewer selection uses the global chain only.
    const reviewChain = uniqueProviderChain(this.providerChain);
    const reviewerProvider = selectDistinctReviewerProvider(
      reviewChain,
      new Set(this.providers.keys()),
      authorProvider,
    );
    const adapter = this.providers.get(reviewerProvider);
    if (!adapter) {
      this.store.createApproval(project.id, missionId, "No reviewer available", "Configure a review provider.");
      return;
    }
    const reviewModel =
      this.reviewModels.get(reviewerProvider) ?? this.defaultModels.get(reviewerProvider) ?? "default";

    let diff = "";
    if (mission.worktreePath && mission.branchName && project.repoPath) {
      diff = await git(project.repoPath, "diff", `${project.defaultBranch}...${mission.branchName}`)
        .then((d) => d.slice(0, 20_000))
        .catch(() => "");
      if (this.fencePausedWork(project.id, missionId, "review diff", pauseGeneration)) return;
    }
    const checkpoints = this.store.listCheckpoints(missionId);
    const evidence = checkpoints.map((c) => `${c.kind}: ${c.status} (${c.detail.slice(0, 120)})`).join("\n");

    const run = this.store.createRun({
      projectId: project.id,
      missionId,
      providerId: reviewerProvider,
      model: reviewModel,
      expectedPauseGeneration: pauseGeneration,
    });
    this.store.transitionRun(run.id, "starting", {}, pauseGeneration);
    this.store.appendRunLog(
      run.id,
      `independent review by ${reviewerProvider}/${reviewModel} (author: ${authorProvider})\n`,
      pauseGeneration,
    );

    const handle = adapter.startRun({
      runId: run.id,
      model: reviewModel,
      systemPrompt:
        "You are an independent reviewer. You did not author this change. " +
        "Verify the diff against the requirements and evidence. " +
        "End your answer with exactly 'VERDICT: APPROVE' or 'VERDICT: REJECT'.",
      userPrompt: [
        `Mission: ${mission.title}`,
        `Acceptance criteria:\n${mission.contract.acceptanceCriteria.join("\n") || "(from objective)"}`,
        `Project brain:\n${formatBrainContext(this.store.listBrainEntries(project.id)) || "(no recorded decisions)"}`,
        `Check evidence:\n${evidence || "(none)"}`,
        `Diff:\n${diff || "(no file changes)"}`,
      ].join("\n\n"),
      ...(mission.worktreePath ? { cwd: mission.worktreePath } : {}),
      ...(mission.worktreePath && project.repoPath
        ? { sandboxReadablePaths: [project.repoPath] }
        : {}),
      timeoutMs: 300_000,
    });
    this.activeRuns.set(run.id, handle);
    this.store.transitionRun(run.id, "running", {}, pauseGeneration);

    let resultText: string | null = null;
    try {
      for await (const ev of handle.events) {
        if (this.fencePausedWork(project.id, missionId, "reviewer event", pauseGeneration)) break;
        if (ev.type === "output") this.store.appendRunLog(run.id, ev.text, pauseGeneration);
        if (ev.type === "usage") {
          this.store.recordUsage({
            projectId: project.id,
            runId: run.id,
            providerId: reviewerProvider,
            model: reviewModel,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            costUsd: ev.costUsd,
            expectedPauseGeneration: pauseGeneration,
          });
        }
        if (ev.type === "completed") resultText = ev.resultText;
        if (ev.type === "error") {
          this.store.appendRunLog(run.id, `review error(${ev.category}): ${ev.message}\n`, pauseGeneration);
        }
      }
    } finally {
      this.activeRuns.delete(run.id);
    }

    if (this.stopped) return;
    // Fence a reviewer that finished after the project was paused: its verdict
    // must not create a checkpoint, approve or integrate the paused mission.
    if (this.fencePausedWork(project.id, missionId, "late reviewer verdict", pauseGeneration)) {
      if (["running", "starting"].includes(this.store.getRun(run.id)?.state ?? "")) {
        this.store.transitionRun(run.id, "failed", { exitReason: "fenced: project paused during review" });
      }
      return;
    }

    if (resultText === null) {
      this.store.transitionRun(run.id, "failed", { exitReason: "reviewer did not complete" }, pauseGeneration);
      this.failValidation(
        this.store.getMission(missionId)!,
        "independent review run failed",
        pauseGeneration,
      );
      return;
    }
    this.store.transitionRun(run.id, "succeeded", { exitReason: "review completed" }, pauseGeneration);

    const approved = /VERDICT:\s*APPROVE/i.test(resultText) && !/VERDICT:\s*REJECT/i.test(resultText);
    this.store.upsertCheckpoint(
      project.id,
      missionId,
      "review",
      approved ? "passed" : "failed",
      resultText.slice(0, 1000),
      pauseGeneration,
    );
    this.store.addBrainEntry(
      project.id,
      approved ? "fact" : "risk",
      `Independent review: ${approved ? "approved" : "rejected"} — ${mission.title.slice(0, 60)}`,
      resultText.slice(0, 2000),
      [`mission:${missionId}`, `run:${run.id}`],
      pauseGeneration,
    );

    if (approved) {
      this.store.transitionMission(missionId, "approved", `independent review approved (run ${run.id})`, "engine", pauseGeneration);
      await this.integrateMission(missionId, pauseGeneration);
    } else {
      this.failValidation(
        this.store.getMission(missionId)!,
        "independent review rejected the result",
        pauseGeneration,
      );
    }
  }

  async integrateMission(missionId: string, expectedPauseGeneration?: number): Promise<void> {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "approved") return;
    const project = this.store.getProject(mission.projectId)!;
    const pauseGeneration = expectedPauseGeneration ?? this.store.getPauseGeneration(project.id);
    if (this.fencePausedWork(project.id, missionId, "integration", pauseGeneration)) return;
    const pr = this.store.listPullRequests(project.id).find((candidate) => candidate.missionId === missionId);
    if (project.repoRemoteUrl && pr?.number && pr.state === "draft") {
      try {
        await markGitHubPullRequestReady(project.repoRemoteUrl, pr.number);
        // A pause during the GitHub round-trip must not integrate or complete.
        if (this.fencePausedWork(project.id, missionId, "integration publish", pauseGeneration)) return;
        this.store.setPullRequestState(pr.id, "open", pauseGeneration);
      } catch (err) {
        if (this.fencePausedWork(project.id, missionId, "integration publish failure", pauseGeneration)) return;
        this.store.transitionMission(
          missionId,
          "blocked",
          `could not mark GitHub PR ready: ${String(err).slice(0, 300)}`,
          "engine",
          pauseGeneration,
        );
        this.store.createApproval(
          project.id,
          missionId,
          "GitHub PR could not be marked ready",
          "Verify GitHub CLI authentication and approve to retry. AvityOS will never self-merge this PR.",
        );
        return;
      }
    }
    this.store.transitionMission(
      missionId,
      "integrated",
      "approved PR/branch published and retained for policy-controlled merge",
      "engine",
      pauseGeneration,
    );
    await this.cleanupWorktree(mission, pauseGeneration);
    if (this.fencePausedWork(project.id, missionId, "integration cleanup", pauseGeneration)) return;
    this.store.transitionMission(missionId, "completed", "mission completed with evidence", "engine", pauseGeneration);

    const all = this.store.listMissions(project.id);
    if (all.every((m) => ["completed", "cancelled"].includes(m.state))) {
      this.store.setProjectStatus(project.id, "completed");
      this.store.addBrainEntry(project.id, "fact", "All missions completed", "", [], pauseGeneration);
    }
  }

  applyApprovalDecision(approvalId: string): void {
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.decision === null) return;
    if (!approval.missionId) {
      // Planning-level interventions (blocked brain pipeline, replan limit).
      const project = this.store.getProject(approval.projectId);
      const objective = this.store.latestObjective(approval.projectId);
      if (!project || !objective) return;
      if (approval.decision === "approved") {
        const activePlan = this.store.activePlan(approval.projectId);
        if (activePlan && activePlan.objectiveId === objective.id) {
          this.store.setProjectStatus(approval.projectId, "active");
        } else {
          this.startPlanning(approval.projectId, objective.id);
        }
      }
      return;
    }
    const mission = this.store.getMission(approval.missionId);
    if (!mission || mission.projectId !== approval.projectId) return;
    if (mission.planId) {
      const activePlan = this.store.activePlan(mission.projectId);
      if (!activePlan || activePlan.id !== mission.planId) {
        this.store.appendAudit(
          mission.projectId,
          "engine",
          "approval.stale_ignored",
          `${approval.id}: mission ${mission.id} belongs to inactive plan ${mission.planId}`,
        );
        return;
      }
    }
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
        void this.integrateMission(mission.id);
      }
    } else {
      if (["blocked", "review_required"].includes(mission.state)) {
        this.store.transitionMission(mission.id, "cancelled", "rejected by user");
        void this.cleanupWorktree(mission);
      } else if (mission.state === "failed") {
        this.store.transitionMission(mission.id, "retrying", "transitioning to cancel");
        this.store.transitionMission(mission.id, "cancelled", "rejected by user");
        void this.cleanupWorktree(mission);
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
    await this.cleanupWorktree(mission);
  }
}

/**
 * Assert a mission worktree lives under <repo>/.avity/worktrees on canonical
 * paths. Creates missing `.avity` / `worktrees` components only after every
 * existing component has been inspected with `lstat` and validated — never
 * via a recursive mkdir that could materialise directories through an
 * outbound symlink. Throws {@link ConfinementError} when a component escapes.
 */
function assertWorktreeConfined(repoPath: string, worktreePath: string): void {
  const confined = ensureConfinedDirectory(repoPath, join(".avity", "worktrees"));
  if (!isInsideRoot(confined.absolute, worktreePath)) {
    throw new ConfinementError(
      `worktree path escapes ${confined.absolute}: ${worktreePath}`,
      "escapes_root",
    );
  }
}

/** Changed files: committed relative to base plus uncommitted worktree changes. */
async function worktreeChangedFiles(
  worktreePath: string,
  repoPath: string,
  baseBranch: string,
  branch: string,
): Promise<string[]> {
  const committed = await changedFiles(repoPath, baseBranch, branch).catch(() => [] as string[]);
  const status = await git(worktreePath, "status", "--porcelain").catch(() => "");
  const uncommitted = status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  return [...new Set([...committed, ...uncommitted])];
}

function buildSystemPrompt(
  project: Project,
  mission: Mission,
  brain: ReturnType<Store["listBrainEntries"]>,
): string {
  return [
    `You are an AvityOS ${mission.role} agent working on project "${project.name}".`,
    `Mission: ${mission.title}`,
    `Acceptance criteria: ${mission.contract.acceptanceCriteria.join("; ") || "see objective"}`,
    `Allowed paths: ${mission.contract.allowedPaths.join(", ") || "all paths inside the worktree"}`,
    `Forbidden paths: ${mission.contract.forbiddenPaths.join(", ") || "none"}`,
    `Required checks: ${mission.contract.requiredChecks.join(", ") || "repository policy checks"}`,
    `Expected artifacts: ${mission.contract.expectedArtifacts.join(", ") || "none declared"}`,
    `Project brain (durable decisions, risks and prior evidence):\n${formatBrainContext(brain) || "(empty)"}`,
    ...mission.contract.context.map((entry) => `Context: ${entry}`),
    "Work only inside the provided working directory.",
    "Inspect the repository and its architecture rules before editing. Keep the worktree clean and make only mission-scoped changes.",
    "Produce a complete, verifiable result. Do not claim completion without evidence.",
  ].join("\n");
}

function formatBrainContext(entries: ReturnType<Store["listBrainEntries"]>): string {
  const selected = entries
    .filter((entry) => ["decision", "convention", "risk", "fact", "assumption"].includes(entry.kind))
    .slice(-20)
    .map((entry) => `[${entry.kind}] ${entry.title}: ${entry.body}`.trim());
  return selected.join("\n").slice(-8_000);
}

function buildPullRequestBody(
  project: Project,
  mission: Mission,
  checkpoints: ReturnType<Store["listCheckpoints"]>,
): string {
  const evidence = checkpoints
    .map((checkpoint) => `- ${checkpoint.kind}: **${checkpoint.status}** — ${checkpoint.detail.slice(0, 300)}`)
    .join("\n");
  return [
    "## AvityOS mission",
    "",
    `Project: ${project.name}`,
    `Mission: ${mission.id}`,
    `Role: ${mission.role}`,
    "",
    "## Objective",
    "",
    mission.contract.objective,
    "",
    "## Acceptance criteria",
    "",
    ...(mission.contract.acceptanceCriteria.length
      ? mission.contract.acceptanceCriteria.map((criterion) => `- ${criterion}`)
      : ["- See objective"]),
    "",
    "## Verification evidence",
    "",
    evidence || "- No checkpoint evidence recorded",
    "",
    "## Risk and rollback",
    "",
    "Review the scoped diff and CI evidence. Roll back by closing this PR; AvityOS does not self-merge.",
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
