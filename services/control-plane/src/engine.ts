import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CheckpointKind, Mission, Project } from "@avityos/contracts";
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
import { checkBudget, isCommandAllowed, isPathAllowed, sandboxCommand, type CommandPolicy } from "@avityos/policy";
import type { ProviderAdapter } from "@avityos/providers";
import type { Store } from "./store.js";

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
};

const AMBIGUITY_MARKERS = [
  "maybe", "not sure", "something like", "etc", "peut-être", "je ne sais pas", "quelque chose comme",
];

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
  ) {}

  /** Kept for API compatibility: the preferred provider name. */
  get defaultProvider(): string {
    return this.providerChain[0] ?? "fake";
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
  }

  // ── objective intake ─────────────────────────────────────────────────────

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
   * criterion, serialized in the user's declared order. Projects may progress
   * concurrently, but a single project never fans out every criterion before
   * prior evidence exists. Checks are required only when a real command exists.
   */
  generatePlan(projectId: string, objectiveId: string): void {
    const objective = this.store.getObjective(objectiveId);
    if (!objective) throw new Error(`objective ${objectiveId} not found`);
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    const criteria = objective.acceptanceCriteria.length
      ? objective.acceptanceCriteria
      : [objective.text.slice(0, 200)];

    const plan = this.store.createPlan(
      projectId,
      `Plan v-auto for objective r${objective.revision}: ${criteria.length} implementation mission(s) with independent review.`,
      [{ id: "ms_1", title: "Deliver objective", description: objective.text.slice(0, 500), order: 0 }],
    );

    const detectedChecks = detectProjectChecks(project);
    let previousMissionId: string | null = null;
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
          allowedPaths: project.repoPath ? ["**"] : [],
          forbiddenPaths: ["**/.env", "**/secrets/**"],
          acceptanceCriteria: [criterion],
          requiredChecks: detectedChecks.requiredChecks,
          checkCommands: detectedChecks.checkCommands,
          budgetUsd: null,
          timeoutSeconds: 900,
          expectedArtifacts: [],
          workspaceChangesRequired: project.repoPath !== null,
        },
        priority: 60 - i,
        dependsOn: previousMissionId ? [previousMissionId] : [],
      });
      previousMissionId = mission.id;
    }

    this.store.addBrainEntry(
      projectId,
      "fact",
      `Plan v${plan.version} generated`,
      `${criteria.length} implementation mission(s); every mission gets an independent review run before approval`,
      [`objective:${objectiveId}`, `plan:${plan.id}`],
    );
    this.store.setProjectStatus(projectId, "active");
  }

  // ── scheduling tick ──────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const project of this.store.listProjects()) {
        if (project.status !== "active") continue;
        const missions = this.store.listMissions(project.id);
        const deps = this.store.listDependencies(project.id);
        for (const m of unblockedMissions(missions, deps)) {
          this.store.transitionMission(m.id, "ready", "dependencies satisfied");
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
        this.store.transitionMission(mission.id, "assigned", "scheduled");
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
  private async ensureWorktree(project: Project, mission: Mission): Promise<string | null> {
    if (!project.repoPath) return null;
    const branch = mission.branchName ?? missionBranchName(mission.id, mission.title);
    const worktreePath = mission.worktreePath ?? join(project.repoPath, ".avity", "worktrees", mission.id);

    if (!existsSync(worktreePath)) {
      mkdirSync(dirname(worktreePath), { recursive: true });
      const existing = await listWorktrees(project.repoPath);
      const branchExists = (await git(project.repoPath, "branch", "--list", branch)).trim().length > 0;
      if (existing.some((w) => w.branch === branch)) {
        // branch is checked out in a stale worktree path; detach it first
        const stale = existing.find((w) => w.branch === branch)!;
        await removeWorktree(project.repoPath, stale.path, true).catch(() => undefined);
      }
      if (branchExists) {
        await git(project.repoPath, "worktree", "add", worktreePath, branch);
      } else {
        await addMissionWorktree(project.repoPath, worktreePath, branch, project.defaultBranch);
      }
    }
    this.store.updateMissionMeta(mission.id, { branchName: branch, worktreePath });
    this.store.appendEvent("git.branch_created", { projectId: project.id, missionId: mission.id }, {
      branch,
      worktreePath,
    });
    return worktreePath;
  }

  private async cleanupWorktree(mission: Mission): Promise<void> {
    const project = this.store.getProject(mission.projectId);
    if (!project?.repoPath || !mission.worktreePath) return;
    if (!existsSync(mission.worktreePath)) return;
    await removeWorktree(project.repoPath, mission.worktreePath, true).catch(() => undefined);
    this.store.appendAudit(project.id, "engine", "worktree.cleanup", mission.worktreePath);
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

    let worktreePath: string | null = null;
    try {
      worktreePath = await this.ensureWorktree(project, mission);
    } catch (err) {
      this.store.transitionMission(missionId, "blocked", `worktree creation failed: ${String(err).slice(0, 300)}`);
      this.store.createApproval(project.id, missionId, "Worktree creation failed", String(err).slice(0, 500));
      return;
    }

    const rolePreferred = this.roleProviderChains.get(mission.role) ?? [];
    const orderedProviderChain = [...new Set([...rolePreferred, ...this.providerChain])];
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
      );
      this.store.createApproval(
        project.id,
        missionId,
        "No capable coding provider",
        "Configure Claude Code, Cursor CLI, Codex CLI, or another adapter that advertises workspace editing.",
      );
      return;
    }

    this.store.transitionMission(missionId, "running", `run starting on ${eligibleProviders[0]}`);

    let providerIdx = 0;
    let attempt = 0;
    let model: string | null = null;

    while (true) {
      if (this.stopped) return;
      const current = this.store.getMission(missionId);
      if (!current || current.state !== "running") return;

      const providerName = eligibleProviders[providerIdx];
      const adapter = providerName ? this.providers.get(providerName) : undefined;
      if (!providerName || !adapter) {
        this.store.transitionMission(missionId, "blocked", "no provider available in the configured chain");
        this.store.createApproval(project.id, missionId, "No provider available", "Configure a provider and approve to retry.");
        return;
      }
      const models = await adapter.listModels();
      if (model === null || !models.includes(model)) {
        model = this.defaultModels.get(providerName) ?? models[0] ?? "default";
      }

      const run = this.store.createRun({ projectId: project.id, missionId, providerId: providerName, model });
      this.store.transitionRun(run.id, "starting");

      const handle = adapter.startRun({
        runId: run.id,
        model,
        systemPrompt: buildSystemPrompt(project, current, this.store.listBrainEntries(project.id)),
        userPrompt: current.contract.objective,
        ...(worktreePath ? { cwd: worktreePath } : {}),
        timeoutMs: (current.contract.timeoutSeconds ?? 900) * 1000,
      });
      this.activeRuns.set(run.id, handle);
      this.store.transitionRun(run.id, "running");

      let outcome:
        | { kind: "completed"; result: string }
        | { kind: "error"; category: string; retryAfterMs: number | null }
        | null = null;

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
        await this.validateMission(missionId);
        return;
      }

      const category = outcome?.kind === "error" ? outcome.category : "agent_crash";
      this.store.transitionRun(run.id, "failed", { exitReason: "provider error", errorCategory: category });

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
  async validateMission(missionId: string): Promise<void> {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "validating") return;
    const project = this.store.getProject(mission.projectId)!;

    const runs = this.store.listRuns({ missionId, states: ["succeeded"] });
    if (runs.length === 0) {
      this.failValidation(mission, "validation failed: no successful run result");
      return;
    }

    // 1) path-scope enforcement on actual changed files
    if (mission.worktreePath && mission.branchName && project.repoPath) {
      const changed = await worktreeChangedFiles(mission.worktreePath, project.repoPath, project.defaultBranch, mission.branchName);
      if ((mission.contract.workspaceChangesRequired ?? true) && changed.length === 0) {
        this.store.upsertCheckpoint(project.id, missionId, "policy", "failed", "coding mission produced no file changes");
        this.failValidation(mission, "validation failed: coding mission produced no file changes");
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
          this.store.upsertCheckpoint(project.id, missionId, "policy", "failed", `changed file ${file}: ${verdict.reason}`);
          this.store.appendAudit(project.id, "policy", "mission.path_violation", `${missionId}: ${file}`);
          this.failValidation(mission, `path policy violation: ${file}`);
          return;
        }
      }
      this.store.upsertCheckpoint(
        project.id,
        missionId,
        "policy",
        "passed",
        changed.length ? `${changed.length} changed file(s) within contract paths` : "no file changes",
      );

      for (const artifact of mission.contract.expectedArtifacts) {
        const target = join(mission.worktreePath, artifact);
        const verdict = isPathAllowed(
          mission.worktreePath,
          mission.contract.allowedPaths,
          mission.contract.forbiddenPaths,
          target,
        );
        if (verdict.effect !== "allow" || !existsSync(target)) {
          this.failValidation(mission, `expected artifact missing or forbidden: ${artifact}`);
          return;
        }
      }
    }

    // 2) required checks execute their real commands
    for (const kind of mission.contract.requiredChecks) {
      const argv = mission.contract.checkCommands[kind];
      if (!argv || argv.length === 0) {
        this.store.upsertCheckpoint(project.id, missionId, kind, "failed", "no command configured for required check");
        this.failValidation(mission, `required check ${kind} has no configured command`);
        return;
      }
      const cwd = mission.worktreePath ?? project.repoPath;
      if (!cwd) {
        this.store.upsertCheckpoint(project.id, missionId, kind, "failed", "no worktree/repository to run the check in");
        this.failValidation(mission, `required check ${kind} has nowhere to run`);
        return;
      }
      this.store.upsertCheckpoint(project.id, missionId, kind, "running", argv.join(" "));
      const result = await this.runCheckCommand(project.id, argv, cwd);
      this.store.upsertCheckpoint(
        project.id,
        missionId,
        kind,
        result.ok ? "passed" : "failed",
        `${argv.join(" ")} -> exit ${result.exitCode}${result.detail ? `: ${result.detail.slice(0, 400)}` : ""}`,
      );
      if (!result.ok) {
        this.failValidation(mission, `check ${kind} failed (exit ${result.exitCode})`);
        return;
      }
    }

    // 3) commit validated work (idempotent: skipped when tree is clean)
    if (mission.worktreePath && mission.branchName && project.repoPath) {
      try {
        if (!(await isCleanWorkingTree(mission.worktreePath))) {
          const commit = await commitAll(
            mission.worktreePath,
            `feat(${missionId}): ${mission.title.slice(0, 80)}\n\nMission: ${missionId}\nValidated-by: AvityOS checks`,
          );
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
            this.store.upsertPullRequest({
              projectId: project.id,
              missionId,
              branch: mission.branchName,
              title: mission.title,
              state: published.state,
              number: published.number,
              url: published.url,
            });
          } catch (err) {
            this.store.transitionMission(missionId, "blocked", `GitHub publication failed: ${String(err).slice(0, 300)}`);
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
          });
        }
      } catch (err) {
        this.failValidation(mission, `commit failed: ${String(err).slice(0, 300)}`);
        return;
      }
    }

    this.store.transitionMission(missionId, "review_required", "validation passed; awaiting independent review");
    await this.reviewMission(missionId);
  }

  /** Run a check command: leased to a compatible worker, OS-sandboxed locally otherwise. */
  private async runCheckCommand(
    projectId: string,
    argv: string[],
    cwd: string,
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
      const terminal = this.store.createTerminal(projectId, argv, cwd, null);
      const deadline = Date.now() + this.config.checkTimeoutMs;
      while (Date.now() < deadline) {
        if (this.stopped) return { ok: false, exitCode: null, detail: "engine stopped" };
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

    let invocation: ReturnType<typeof sandboxCommand> | null = null;
    try {
      invocation = sandboxCommand(argv, cwd);
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
      invocation?.cleanup();
    }
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

  // ── independent review ───────────────────────────────────────────────────

  /**
   * Genuine independent review: a separate reviewer run with a distinct
   * identity (dedicated review model; a different provider from the author
   * when the chain offers one) receives the diff, requirements and check
   * evidence, and must return an explicit VERDICT. review_required never
   * auto-approves. Supervised projects require a human instead.
   */
  async reviewMission(missionId: string): Promise<void> {
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

    const authorRun = this.store.listRuns({ missionId, states: ["succeeded"] }).at(-1);
    const authorProvider = authorRun?.providerId ?? this.defaultProvider;
    const reviewerProvider =
      this.providerChain.find((p) => p !== authorProvider && this.providers.has(p)) ?? authorProvider;
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
    }
    const checkpoints = this.store.listCheckpoints(missionId);
    const evidence = checkpoints.map((c) => `${c.kind}: ${c.status} (${c.detail.slice(0, 120)})`).join("\n");

    const run = this.store.createRun({
      projectId: project.id,
      missionId,
      providerId: reviewerProvider,
      model: reviewModel,
    });
    this.store.transitionRun(run.id, "starting");
    this.store.appendRunLog(run.id, `independent review by ${reviewerProvider}/${reviewModel} (author: ${authorProvider})\n`);

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
      timeoutMs: 300_000,
    });
    this.activeRuns.set(run.id, handle);
    this.store.transitionRun(run.id, "running");

    let resultText: string | null = null;
    try {
      for await (const ev of handle.events) {
        if (ev.type === "output") this.store.appendRunLog(run.id, ev.text);
        if (ev.type === "usage") {
          this.store.recordUsage({
            projectId: project.id,
            runId: run.id,
            providerId: reviewerProvider,
            model: reviewModel,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            costUsd: ev.costUsd,
          });
        }
        if (ev.type === "completed") resultText = ev.resultText;
        if (ev.type === "error") {
          this.store.appendRunLog(run.id, `review error(${ev.category}): ${ev.message}\n`);
        }
      }
    } finally {
      this.activeRuns.delete(run.id);
    }

    if (this.stopped) return;

    if (resultText === null) {
      this.store.transitionRun(run.id, "failed", { exitReason: "reviewer did not complete" });
      this.failValidation(this.store.getMission(missionId)!, "independent review run failed");
      return;
    }
    this.store.transitionRun(run.id, "succeeded", { exitReason: "review completed" });

    const approved = /VERDICT:\s*APPROVE/i.test(resultText) && !/VERDICT:\s*REJECT/i.test(resultText);
    this.store.upsertCheckpoint(
      project.id,
      missionId,
      "review",
      approved ? "passed" : "failed",
      resultText.slice(0, 1000),
    );
    this.store.addBrainEntry(
      project.id,
      approved ? "fact" : "risk",
      `Independent review: ${approved ? "approved" : "rejected"} — ${mission.title.slice(0, 60)}`,
      resultText.slice(0, 2000),
      [`mission:${missionId}`, `run:${run.id}`],
    );

    if (approved) {
      this.store.transitionMission(missionId, "approved", `independent review approved (run ${run.id})`);
      await this.integrateMission(missionId);
    } else {
      this.failValidation(this.store.getMission(missionId)!, "independent review rejected the result");
    }
  }

  async integrateMission(missionId: string): Promise<void> {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.state !== "approved") return;
    const project = this.store.getProject(mission.projectId)!;
    const pr = this.store.listPullRequests(project.id).find((candidate) => candidate.missionId === missionId);
    if (project.repoRemoteUrl && pr?.number && pr.state === "draft") {
      try {
        await markGitHubPullRequestReady(project.repoRemoteUrl, pr.number);
        this.store.setPullRequestState(pr.id, "open");
      } catch (err) {
        this.store.transitionMission(missionId, "blocked", `could not mark GitHub PR ready: ${String(err).slice(0, 300)}`);
        this.store.createApproval(
          project.id,
          missionId,
          "GitHub PR could not be marked ready",
          "Verify GitHub CLI authentication and approve to retry. AvityOS will never self-merge this PR.",
        );
        return;
      }
    }
    this.store.transitionMission(missionId, "integrated", "approved PR/branch published and retained for policy-controlled merge");
    await this.cleanupWorktree(mission);
    this.store.transitionMission(missionId, "completed", "mission completed with evidence");

    const all = this.store.listMissions(project.id);
    if (all.every((m) => ["completed", "cancelled"].includes(m.state))) {
      this.store.setProjectStatus(project.id, "completed");
      this.store.addBrainEntry(project.id, "fact", "All missions completed", "", []);
    }
  }

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

function inferRole(criterion: string): Mission["role"] {
  const lower = criterion.toLowerCase();
  if (/(ui|screen|page|frontend|css|design|écran|interface)/.test(lower)) return "frontend";
  if (/(deploy|infra|docker|ci|pipeline)/.test(lower)) return "infrastructure";
  if (/(secur|auth|encrypt|vuln)/.test(lower)) return "cybersecurity";
  if (/(test|qa|coverage)/.test(lower)) return "qa";
  if (/(doc|readme|guide)/.test(lower)) return "documentation";
  return "backend";
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

function detectProjectChecks(project: Project): {
  requiredChecks: CheckpointKind[];
  checkCommands: Record<string, string[]>;
} {
  if (!project.repoPath) return { requiredChecks: [], checkCommands: {} };

  const requiredChecks: CheckpointKind[] = ["architecture_rule"];
  const checkCommands: Record<string, string[]> = {
    architecture_rule: ["git", "diff", "--check", "HEAD"],
  };
  const packageJsonPath = join(project.repoPath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const runner = existsSync(join(project.repoPath, "pnpm-lock.yaml")) ? "pnpm" : "npm";
      for (const kind of ["lint", "typecheck", "test", "build"] as const) {
        if (!scripts[kind]) continue;
        requiredChecks.push(kind);
        checkCommands[kind] = [runner, "run", kind];
      }
    } catch {
      // Malformed project metadata is surfaced by the architecture check and
      // the coding agent; never invent a passing package command.
    }
  } else if (existsSync(join(project.repoPath, "Package.swift"))) {
    requiredChecks.push("build", "test");
    checkCommands.build = ["swift", "build"];
    checkCommands.test = ["swift", "test"];
  }
  return { requiredChecks, checkCommands };
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
