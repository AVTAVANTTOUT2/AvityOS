import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Approval,
  BrainProvenance,
  BrainRun,
  BrainRunState,
  BrainStep,
  Checkpoint,
  Clarification,
  ClarificationAnswerValue,
  ClarificationProvenance,
  ClarificationQuestion,
  EventEnvelope,
  EventType,
  Mission,
  MissionDependency,
  MissionState,
  AgentRun,
  Objective,
  Plan,
  Project,
  ProjectConfiguration,
  ProjectPauseState,
  ProjectStatus,
  PullRequestRef,
  ReplanTrigger,
  RunState,
} from "@avityos/contracts";
import { Clarification as ClarificationSchema } from "@avityos/contracts";
import {
  assertMissionTransition,
  assertProjectTransition,
  assertRunTransition,
  MISSION_PAUSEABLE_STATES,
  RUN_CANCELLABLE_ON_PAUSE,
} from "@avityos/orchestration";
import { redactSecrets } from "@avityos/policy";
import {
  coerceLegacyAnswer,
  serializeAnswerValue,
  validateAnswerForQuestion,
} from "./clarification-policy.js";
import type { DB } from "./db.js";

export const WORKER_HEARTBEAT_WINDOW_MS = 15_000;

export class StoreConflictError extends Error {
  constructor(
    readonly code:
      | "clarification_obsolete"
      | "clarification_incomplete"
      | "clarification_already_answered"
      | "project_paused"
      | "project_not_paused"
      | "illegal_transition"
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function redactStructured<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactStructured(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStructured(item)]),
    ) as T;
  }
  return value;
}

/**
 * Persistence layer. Every mutation that changes durable state also appends
 * the corresponding event inside the same SQLite transaction, so audit
 * history and state can never diverge (ADR-0003).
 */
export class Store {
  readonly emitter = new EventEmitter();

  constructor(readonly db: DB) {
    this.emitter.setMaxListeners(100);
  }

  // ── events ───────────────────────────────────────────────────────────────

  appendEvent(
    type: EventType,
    scope: { projectId?: string | null; missionId?: string | null; runId?: string | null },
    payload: Record<string, unknown>,
  ): EventEnvelope {
    const id = newId("ev");
    const createdAt = now();
    const clean = JSON.parse(redactSecrets(JSON.stringify(payload))) as Record<string, unknown>;
    const info = this.db
      .prepare(
        `INSERT INTO events (id, type, project_id, mission_id, run_id, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        type,
        scope.projectId ?? null,
        scope.missionId ?? null,
        scope.runId ?? null,
        createdAt,
        JSON.stringify(clean),
      );
    const envelope: EventEnvelope = {
      schemaVersion: 1,
      seq: Number(info.lastInsertRowid),
      id,
      type,
      projectId: scope.projectId ?? null,
      missionId: scope.missionId ?? null,
      runId: scope.runId ?? null,
      createdAt,
      payload: clean,
    };
    queueMicrotask(() => this.emitter.emit("event", envelope));
    return envelope;
  }

  eventsAfter(afterSeq: number, projectId?: string, limit = 500): EventEnvelope[] {
    const rows = projectId
      ? this.db
          .prepare(
            "SELECT * FROM events WHERE seq > ? AND project_id = ? ORDER BY seq ASC LIMIT ?",
          )
          .all(afterSeq, projectId, limit)
      : this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(afterSeq, limit);
    return (rows as Record<string, unknown>[]).map((r) => ({
      schemaVersion: 1,
      seq: r.seq as number,
      id: r.id as string,
      type: r.type as EventEnvelope["type"],
      projectId: (r.project_id as string) ?? null,
      missionId: (r.mission_id as string) ?? null,
      runId: (r.run_id as string) ?? null,
      createdAt: r.created_at as string,
      payload: JSON.parse(r.payload as string) as Record<string, unknown>,
    }));
  }

  // ── audit hash chain ─────────────────────────────────────────────────────

  appendAudit(projectId: string | null, actor: string, action: string, detail: string): void {
    const prev = this.db
      .prepare("SELECT entry_hash FROM audit_entries ORDER BY rowid DESC LIMIT 1")
      .get() as { entry_hash: string } | undefined;
    const id = newId("aud");
    const createdAt = now();
    const cleanDetail = redactSecrets(detail);
    const entryHash = createHash("sha256")
      .update(`${prev?.entry_hash ?? ""}|${id}|${createdAt}|${actor}|${action}|${cleanDetail}`)
      .digest("hex");
    this.db
      .prepare(
        `INSERT INTO audit_entries (id, created_at, project_id, actor, action, detail, entry_hash, previous_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, createdAt, projectId, actor, action, cleanDetail, entryHash, prev?.entry_hash ?? null);
  }

  verifyAuditChain(): boolean {
    const rows = this.db
      .prepare("SELECT * FROM audit_entries ORDER BY rowid ASC")
      .all() as unknown as Record<string, string | null>[];
    let prevHash: string | null = null;
    for (const r of rows) {
      const expected: string = createHash("sha256")
        .update(`${prevHash ?? ""}|${r.id}|${r.created_at}|${r.actor}|${r.action}|${r.detail}`)
        .digest("hex");
      if (expected !== r.entry_hash || (r.previous_hash ?? null) !== prevHash) return false;
      prevHash = r.entry_hash ?? null;
    }
    return true;
  }

  // ── idempotency ──────────────────────────────────────────────────────────

  findIdempotent(key: string): { resourceType: string; resourceId: string } | null {
    const row = this.db
      .prepare("SELECT resource_type, resource_id FROM idempotency_keys WHERE key = ?")
      .get(key) as { resource_type: string; resource_id: string } | undefined;
    return row ? { resourceType: row.resource_type, resourceId: row.resource_id } : null;
  }

  recordIdempotent(key: string, resourceType: string, resourceId: string): void {
    this.db
      .prepare(
        "INSERT INTO idempotency_keys (key, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(key, resourceType, resourceId, now());
  }

  // ── projects ─────────────────────────────────────────────────────────────

  createProject(input: {
    name: string;
    description: string;
    repoPath: string | null;
    repoRemoteUrl: string | null;
    defaultBranch?: string;
    autonomyProfile: Project["autonomyProfile"];
  }): Project {
    const id = newId("prj");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects (id, workspace_id, name, status, repo_path, repo_remote_url, default_branch, autonomy_profile, description, created_at, updated_at)
           VALUES (?, 'default', ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.name, input.repoPath, input.repoRemoteUrl, input.defaultBranch ?? "main", input.autonomyProfile, input.description, ts, ts);
      this.appendEvent("project.created", { projectId: id }, { name: input.name });
      this.appendAudit(id, "user", "project.create", `created project ${input.name}`);
    });
    tx();
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToProject(r) : null;
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC").all() as Record<string, unknown>[]).map(
      rowToProject,
    );
  }

  getProjectConfiguration(id: string): ProjectConfiguration | null {
    const project = this.getProject(id);
    if (!project) return null;
    return { project, objective: this.latestObjective(id), budget: this.getBudget(id) };
  }

  createOnboardedProject(input: {
    name: string;
    description: string;
    repoPath: string | null;
    repoRemoteUrl: string | null;
    defaultBranch: string;
    autonomyProfile: Project["autonomyProfile"];
    objective: string;
    acceptanceCriteria: string[];
    budgetUsd: number | null;
    budgetWarnAtFraction: number;
  }): ProjectConfiguration {
    let projectId = "";
    const tx = this.db.transaction(() => {
      const project = this.createProject(input);
      projectId = project.id;
      if (input.budgetUsd !== null) this.setBudget(project.id, input.budgetUsd, input.budgetWarnAtFraction);
      if (input.objective) this.createObjective(project.id, input.objective, input.acceptanceCriteria);
    });
    tx();
    return this.getProjectConfiguration(projectId)!;
  }

  updateProjectConfiguration(id: string, input: {
    name: string;
    description: string;
    repoPath: string | null;
    repoRemoteUrl: string | null;
    defaultBranch: string;
    autonomyProfile: Project["autonomyProfile"];
    objective: string;
    acceptanceCriteria: string[];
    budgetUsd: number | null;
    budgetWarnAtFraction: number;
  }): ProjectConfiguration {
    const existing = this.getProjectConfiguration(id);
    if (!existing) throw new Error(`project ${id} not found`);
    const changedFields: string[] = [];
    const tx = this.db.transaction(() => {
      const projectChanged =
        existing.project.name !== input.name ||
        existing.project.description !== input.description ||
        existing.project.repoPath !== input.repoPath ||
        existing.project.repoRemoteUrl !== input.repoRemoteUrl ||
        existing.project.defaultBranch !== input.defaultBranch ||
        existing.project.autonomyProfile !== input.autonomyProfile;
      if (projectChanged) {
        this.db.prepare(
          `UPDATE projects
           SET name = ?, description = ?, repo_path = ?, repo_remote_url = ?, default_branch = ?, autonomy_profile = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          input.name,
          input.description,
          input.repoPath,
          input.repoRemoteUrl,
          input.defaultBranch,
          input.autonomyProfile,
          now(),
          id,
        );
        changedFields.push("project");
      }

      const currentCriteria = existing.objective?.acceptanceCriteria ?? [];
      const objectiveChanged =
        Boolean(input.objective) &&
        (existing.objective?.text !== input.objective ||
          JSON.stringify(currentCriteria) !== JSON.stringify(input.acceptanceCriteria));
      if (objectiveChanged) {
        this.createObjective(id, input.objective, input.acceptanceCriteria);
        changedFields.push("objective");
      }

      const budgetChanged = input.budgetUsd === null
        ? existing.budget !== null
        : existing.budget?.limitUsd !== input.budgetUsd ||
          existing.budget.warnAtFraction !== input.budgetWarnAtFraction;
      if (budgetChanged) {
        if (input.budgetUsd === null) this.clearBudget(id);
        else this.setBudget(id, input.budgetUsd, input.budgetWarnAtFraction);
        changedFields.push("budget");
      }

      if (changedFields.length > 0) {
        this.appendEvent("project.updated", { projectId: id }, { fields: changedFields });
        this.appendAudit(id, "user", "project.update", `updated ${changedFields.join(", ")}`);
      }
    });
    tx();
    return this.getProjectConfiguration(id)!;
  }

  setProjectStatus(id: string, status: Project["status"], expectedPauseGeneration?: number): void {
    const tx = this.db.transaction(() => {
      const project = this.getProject(id);
      if (!project) throw new Error(`project ${id} not found`);
      if (expectedPauseGeneration !== undefined) {
        this.assertProjectAcceptingWork(id, expectedPauseGeneration);
      }
      if (project.status === status) return;
      // Pause/resume own their transitions and fencing side effects.
      if (status === "paused" || project.status === "paused") {
        throw new StoreConflictError(
          "illegal_transition",
          `use pauseProject/resumeProject for paused transitions (${project.status} -> ${status})`,
        );
      }
      assertProjectTransition(project.status, status);
      this.db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
      this.appendEvent("project.status_changed", { projectId: id }, { from: project.status, status });
    });
    tx();
  }

  getPauseGeneration(projectId: string): number {
    const row = this.db
      .prepare("SELECT pause_generation FROM projects WHERE id = ?")
      .get(projectId) as { pause_generation: number } | undefined;
    return row?.pause_generation ?? 0;
  }

  /** Cheap durable check used by every critical path to fence a paused project. */
  isProjectPaused(projectId: string): boolean {
    const row = this.db.prepare("SELECT status FROM projects WHERE id = ?").get(projectId) as
      | { status: string }
      | undefined;
    return row?.status === "paused";
  }

  /**
   * Transactional fencing guard for durable work acceptance. The generation
   * check keeps a continuation that crossed pause -> resume fenced even though
   * the project is active again by the time it attempts its write.
   */
  assertProjectAcceptingWork(projectId: string, expectedPauseGeneration?: number): void {
    const row = this.db
      .prepare("SELECT status, pause_generation FROM projects WHERE id = ?")
      .get(projectId) as { status: string; pause_generation: number } | undefined;
    if (!row) throw new Error(`project ${projectId} not found`);
    if (
      row.status === "paused" ||
      (expectedPauseGeneration !== undefined && row.pause_generation !== expectedPauseGeneration)
    ) {
      throw new StoreConflictError(
        "project_paused",
        `project ${projectId} rejected stale work (status=${row.status}, generation=${row.pause_generation}, expected=${expectedPauseGeneration ?? "current"})`,
      );
    }
  }

  getProjectPauseState(projectId: string): ProjectPauseState | null {
    const project = this.getProject(projectId);
    if (!project) return null;
    const pause = this.db
      .prepare(
        `SELECT * FROM project_pauses WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    const generation = this.getPauseGeneration(projectId);
    const cancelling = this.listRuns({
      projectId,
      states: ["cancelling"],
    }).map((run) => run.id);
    if (project.status === "paused") {
      return {
        projectId,
        status: cancelling.length > 0 ? "pausing" : "paused",
        reason: (pause?.reason as string | null) ?? (this.db.prepare("SELECT paused_reason FROM projects WHERE id = ?").get(projectId) as { paused_reason: string | null } | undefined)?.paused_reason ?? null,
        actor: (pause?.actor as string | null) ?? null,
        previousStatus: (pause?.previous_status as string | null) ?? null,
        generation,
        pausedAt: (pause?.created_at as string | null) ?? null,
        resumedAt: (pause?.resumed_at as string | null) ?? null,
        cancellingRunIds: cancelling,
      };
    }
    if (pause && pause.status === "resumed" && !pause.resumed_at) {
      return {
        projectId,
        status: "resuming",
        reason: (pause.reason as string | null) ?? null,
        actor: (pause.actor as string | null) ?? null,
        previousStatus: (pause.previous_status as string | null) ?? null,
        generation,
        pausedAt: pause.created_at as string,
        resumedAt: null,
        cancellingRunIds: [],
      };
    }
    return {
      projectId,
      status: "active",
      reason: null,
      actor: null,
      previousStatus: null,
      generation,
      pausedAt: null,
      resumedAt: (pause?.resumed_at as string | null) ?? null,
      cancellingRunIds: [],
    };
  }

  /**
   * Begin an atomic project pause inside one transaction: bump the fencing
   * generation, record the pause row, mark pauseable missions and refuse any
   * later scheduling until resume. Provider cancellation happens after commit.
   */
  beginProjectPause(input: {
    projectId: string;
    reason: string;
    actor: string;
    idempotencyKey?: string;
  }): { state: ProjectPauseState; runIdsToCancel: string[]; alreadyPaused: boolean } {
    let result: { state: ProjectPauseState; runIdsToCancel: string[]; alreadyPaused: boolean } | null = null;
    const tx = this.db.transaction(() => {
      const project = this.getProject(input.projectId);
      if (!project) throw new Error(`project ${input.projectId} not found`);
      if (input.idempotencyKey) {
        const existing = this.db
          .prepare(
            "SELECT id FROM project_pauses WHERE project_id = ? AND idempotency_key = ?",
          )
          .get(input.projectId, input.idempotencyKey) as { id: string } | undefined;
        if (existing) {
          result = {
            state: this.getProjectPauseState(input.projectId)!,
            runIdsToCancel: [],
            alreadyPaused: true,
          };
          return;
        }
      }
      if (project.status === "paused") {
        result = {
          state: this.getProjectPauseState(input.projectId)!,
          runIdsToCancel: [],
          alreadyPaused: true,
        };
        return;
      }
      assertProjectTransition(project.status, "paused");
      const ts = now();
      const generation = this.getPauseGeneration(input.projectId) + 1;
      const pauseId = newId("pause");
      const runIds = this.listRuns({
        projectId: input.projectId,
        states: [...RUN_CANCELLABLE_ON_PAUSE],
      }).map((run) => run.id);
      this.db
        .prepare(
          `UPDATE projects
           SET status = 'paused', pause_generation = ?, status_before_pause = ?,
               paused_reason = ?, paused_at = ?, paused_by = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          generation,
          project.status,
          redactSecrets(input.reason).slice(0, 2000),
          ts,
          input.actor,
          ts,
          input.projectId,
        );
      this.db
        .prepare(
          `INSERT INTO project_pauses
             (id, project_id, status, reason, actor, previous_status, generation, idempotency_key, cancelling_run_ids, created_at)
           VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pauseId,
          input.projectId,
          redactSecrets(input.reason).slice(0, 2000),
          input.actor,
          project.status,
          generation,
          input.idempotencyKey ?? null,
          JSON.stringify(runIds),
          ts,
        );
      for (const mission of this.listMissions(input.projectId)) {
        if (!MISSION_PAUSEABLE_STATES.includes(mission.state)) continue;
        this.db
          .prepare("UPDATE missions SET paused_from_state = ?, updated_at = ? WHERE id = ?")
          .run(mission.state, ts, mission.id);
        this.transitionMission(mission.id, "paused", `project paused: ${input.reason || "no reason"}`, input.actor);
      }
      for (const runId of runIds) {
        const run = this.getRun(runId);
        if (!run) continue;
        if (run.state === "queued") this.transitionRun(runId, "starting");
        if (["queued", "starting", "running", "paused"].includes(this.getRun(runId)!.state)) {
          const current = this.getRun(runId)!;
          if (current.state !== "cancelling" && current.state !== "cancelled") {
            if (current.state === "paused") {
              this.transitionRun(runId, "cancelling");
            } else if (current.state === "running" || current.state === "starting") {
              this.transitionRun(runId, "cancelling");
            } else if (current.state === "queued") {
              // queued already moved to starting above
              this.transitionRun(runId, "cancelling");
            }
          }
        }
      }
      this.appendEvent("project.paused", { projectId: input.projectId }, {
        reason: input.reason,
        actor: input.actor,
        generation,
        previousStatus: project.status,
        cancellingRunIds: runIds,
      });
      this.appendEvent("project.status_changed", { projectId: input.projectId }, {
        from: project.status,
        status: "paused",
      });
      this.appendAudit(input.projectId, input.actor, "project.pause", input.reason.slice(0, 500));
      result = {
        state: this.getProjectPauseState(input.projectId)!,
        runIdsToCancel: runIds,
        alreadyPaused: false,
      };
    });
    tx();
    return result!;
  }

  /** Finalize cancelled runs after provider cancel, then leave project paused. */
  completePausedRunCancellation(runId: string, exitReason: string): void {
    const run = this.getRun(runId);
    if (!run) return;
    if (run.state === "cancelling") {
      this.transitionRun(runId, "cancelled", { exitReason });
    } else if (RUN_CANCELLABLE_ON_PAUSE.includes(run.state)) {
      if (run.state === "queued") this.transitionRun(runId, "starting");
      const current = this.getRun(runId)!;
      if (current.state === "starting" || current.state === "running" || current.state === "paused") {
        this.transitionRun(runId, "cancelling");
      }
      if (this.getRun(runId)?.state === "cancelling") {
        this.transitionRun(runId, "cancelled", { exitReason });
      }
    }
  }

  /**
   * Resume a paused project transactionally. Returns missions that need a new
   * execution attempt and whether planning should restart.
   */
  resumeProject(input: {
    projectId: string;
    actor: string;
    idempotencyKey?: string;
  }): {
    state: ProjectPauseState;
    alreadyResumed: boolean;
    resumePlanning: boolean;
    missionsToResume: { missionId: string; fromState: MissionState }[];
  } {
    let result: {
      state: ProjectPauseState;
      alreadyResumed: boolean;
      resumePlanning: boolean;
      missionsToResume: { missionId: string; fromState: MissionState }[];
    } | null = null;
    const tx = this.db.transaction(() => {
      const project = this.getProject(input.projectId);
      if (!project) throw new Error(`project ${input.projectId} not found`);
      if (input.idempotencyKey) {
        const existing = this.findIdempotent(`resume:${input.projectId}:${input.idempotencyKey}`);
        if (existing) {
          result = {
            state: this.getProjectPauseState(input.projectId)!,
            alreadyResumed: true,
            resumePlanning: false,
            missionsToResume: [],
          };
          return;
        }
      }
      if (project.status !== "paused") {
        if (input.idempotencyKey) {
          // Idempotent resume against an already-active project.
          result = {
            state: this.getProjectPauseState(input.projectId)!,
            alreadyResumed: true,
            resumePlanning: false,
            missionsToResume: [],
          };
          return;
        }
        throw new StoreConflictError(
          "project_not_paused",
          `project ${input.projectId} is ${project.status}, not paused`,
        );
      }
      const meta = this.db
        .prepare("SELECT status_before_pause FROM projects WHERE id = ?")
        .get(input.projectId) as { status_before_pause: string | null };
      const previous = (meta.status_before_pause as ProjectStatus | null) ?? "active";
      assertProjectTransition("paused", previous);
      const ts = now();
      const missionsToResume: { missionId: string; fromState: MissionState }[] = [];
      for (const mission of this.listMissions(input.projectId)) {
        if (mission.state !== "paused") continue;
        const fromRow = this.db
          .prepare("SELECT paused_from_state FROM missions WHERE id = ?")
          .get(mission.id) as { paused_from_state: string | null };
        const fromState = (fromRow.paused_from_state as MissionState | null) ?? "ready";
        missionsToResume.push({ missionId: mission.id, fromState });
        const resumeTo = resumeMissionTarget(fromState);
        this.transitionMission(mission.id, resumeTo, `project resumed (was ${fromState})`, input.actor);
        this.db
          .prepare("UPDATE missions SET paused_from_state = NULL, updated_at = ? WHERE id = ?")
          .run(ts, mission.id);
      }
      this.db
        .prepare(
          `UPDATE projects
           SET status = ?, status_before_pause = NULL, paused_reason = NULL,
               paused_at = NULL, paused_by = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(previous, ts, input.projectId);
      this.db
        .prepare(
          `UPDATE project_pauses SET status = 'resumed', resumed_at = ?
           WHERE project_id = ? AND status = 'active'`,
        )
        .run(ts, input.projectId);
      if (input.idempotencyKey) {
        this.recordIdempotent(`resume:${input.projectId}:${input.idempotencyKey}`, "project", input.projectId);
      }
      this.appendEvent("project.resumed", { projectId: input.projectId }, {
        actor: input.actor,
        previousStatus: previous,
        missions: missionsToResume,
      });
      this.appendEvent("project.status_changed", { projectId: input.projectId }, {
        from: "paused",
        status: previous,
      });
      this.appendAudit(input.projectId, input.actor, "project.resume", previous);
      result = {
        state: {
          projectId: input.projectId,
          status: previous === "planning" ? "resuming" : "active",
          reason: null,
          actor: input.actor,
          previousStatus: previous,
          generation: this.getPauseGeneration(input.projectId),
          pausedAt: null,
          resumedAt: ts,
          cancellingRunIds: [],
        },
        alreadyResumed: false,
        // draft+objective is the create race window; resume must restart analysis.
        resumePlanning:
          previous === "planning" || previous === "clarifying" || previous === "draft",
        missionsToResume,
      };
    });
    tx();
    return result!;
  }

  /** Refuse late provider/worker results against a paused or fenced project. */
  assertRunAcceptable(runId: string, expectedPauseGeneration?: number): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const project = this.getProject(run.projectId);
    if (!project) throw new Error(`project ${run.projectId} not found`);
    if (
      project.status === "paused" ||
      (expectedPauseGeneration !== undefined &&
        this.getPauseGeneration(run.projectId) !== expectedPauseGeneration)
    ) {
      this.appendEvent("run.fenced", { projectId: run.projectId, missionId: run.missionId, runId }, {
        reason: "project is paused or the run crossed a pause generation",
        expectedPauseGeneration,
        actualPauseGeneration: this.getPauseGeneration(run.projectId),
      });
      throw new StoreConflictError("project_paused", `run ${runId} refused by project pause fence`);
    }
    if (!["running", "starting", "queued"].includes(run.state)) {
      this.appendEvent("run.fenced", { projectId: run.projectId, missionId: run.missionId, runId }, {
        reason: `run state ${run.state} is not accepting results`,
        state: run.state,
      });
      throw new StoreConflictError("conflict", `run ${runId} in state ${run.state} cannot accept results`);
    }
  }

  /**
   * Revoke terminal leases for one project ONLY. Strictly scoped by
   * project_id: sessions of the SAME worker that belong to another project are
   * never touched, preserving cross-project isolation (invariant P-ISO). A
   * started-but-not-running session is returned to the queue (safe to retry
   * once resumed); a running/cancelling session is cancelled. Every affected
   * lease token is invalidated so a later worker result is fenced, and a
   * `run.fenced` audit event is emitted per session.
   */
  revokeProjectWorkerLeases(projectId: string): void {
    const ts = now();
    const tx = this.db.transaction(() => {
      const affected = this.db
        .prepare(
          `SELECT id, worker_id, state FROM terminal_sessions
           WHERE project_id = ? AND state IN ('starting','running','cancelling')`,
        )
        .all(projectId) as { id: string; worker_id: string | null; state: string }[];
      if (affected.length === 0) return;
      this.db
        .prepare(
          `UPDATE terminal_sessions
           SET state = CASE WHEN state = 'starting' THEN 'queued' ELSE 'cancelled' END,
               worker_id = NULL, lease_expires_at = NULL, lease_token_hash = NULL, updated_at = ?
           WHERE project_id = ? AND state IN ('starting','running','cancelling')`,
        )
        .run(ts, projectId);
      for (const session of affected) {
        this.appendEvent("run.fenced", { projectId }, {
          terminalId: session.id,
          workerId: session.worker_id,
          reason: "project paused: worker lease revoked (project-scoped)",
        });
      }
    });
    tx();
  }

  // ── objectives & clarifications ──────────────────────────────────────────

  createObjective(projectId: string, text: string, acceptanceCriteria: string[]): Objective {
    const id = newId("obj");
    const ts = now();
    const rev = (this.db
      .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS rev FROM objectives WHERE project_id = ?")
      .get(projectId) as { rev: number }).rev;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO objectives (id, project_id, revision, text, acceptance_criteria, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, projectId, rev, text, JSON.stringify(acceptanceCriteria), ts, ts);
      // A new objective revision obsoletes any open clarification groups.
      const open = this.listClarifications(projectId, "open");
      for (const clarification of open) {
        this.markClarificationObsolete(clarification.id, "objective revised");
      }
      this.appendEvent("objective.submitted", { projectId }, { objectiveId: id, revision: rev });
      this.appendAudit(projectId, "user", "objective.submit", text.slice(0, 200));
    });
    tx();
    return this.getObjective(id)!;
  }

  getObjective(id: string): Objective | null {
    const r = this.db.prepare("SELECT * FROM objectives WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      projectId: r.project_id as string,
      revision: r.revision as number,
      text: r.text as string,
      acceptanceCriteria: JSON.parse(r.acceptance_criteria as string) as string[],
      analysisSummary: (r.analysis_summary as string) ?? null,
    };
  }

  latestObjective(projectId: string): Objective | null {
    const r = this.db
      .prepare("SELECT id FROM objectives WHERE project_id = ? ORDER BY revision DESC LIMIT 1")
      .get(projectId) as { id: string } | undefined;
    return r ? this.getObjective(r.id) : null;
  }

  setObjectiveAnalysis(id: string, summary: string, expectedPauseGeneration?: number): void {
    const tx = this.db.transaction(() => {
      const objective = this.getObjective(id);
      if (!objective) throw new Error(`objective ${id} not found`);
      if (expectedPauseGeneration !== undefined) {
        this.assertProjectAcceptingWork(objective.projectId, expectedPauseGeneration);
      }
      this.db
        .prepare("UPDATE objectives SET analysis_summary = ?, updated_at = ? WHERE id = ?")
        .run(redactSecrets(summary).slice(0, 5000), now(), id);
    });
    tx();
  }

  createClarification(input: {
    projectId: string;
    objectiveId: string;
    questions: Omit<ClarificationQuestion, "id" | "status" | "answer" | "answerValue">[];
    provenance: ClarificationProvenance;
    providerId?: string | null;
    model?: string | null;
    brainRunId?: string | null;
    round?: number;
    idempotencyKey?: string | null;
    expectedPauseGeneration?: number;
  }): Clarification {
    if (input.idempotencyKey) {
      const existing = this.db
        .prepare("SELECT id FROM clarifications WHERE project_id = ? AND idempotency_key = ?")
        .get(input.projectId, input.idempotencyKey) as { id: string } | undefined;
      if (existing) return this.getClarification(existing.id)!;
    }
    const id = newId("clr");
    const ts = now();
    const round =
      input.round ??
      ((this.db
        .prepare("SELECT COALESCE(MAX(round), 0) + 1 AS r FROM clarifications WHERE project_id = ? AND objective_id = ?")
        .get(input.projectId, input.objectiveId) as { r: number }).r);
    const questions: ClarificationQuestion[] = input.questions.map((question, index) => ({
      ...question,
      id: newId("clq"),
      status: "pending",
      answer: null,
      answerValue: null,
      displayOrder: question.displayOrder ?? index,
    }));
    const parsed = ClarificationSchema.parse({
      id,
      createdAt: ts,
      updatedAt: ts,
      projectId: input.projectId,
      objectiveId: input.objectiveId,
      status: "open",
      schemaVersion: 1,
      round,
      provenance: input.provenance,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      brainRunId: input.brainRunId ?? null,
      questions,
    });
    const tx = this.db.transaction(() => {
      this.assertProjectAcceptingWork(input.projectId, input.expectedPauseGeneration);
      // Only one open group per project at a time — withdraw older opens.
      for (const open of this.listClarifications(input.projectId, "open")) {
        this.markClarificationObsolete(open.id, "superseded by a new clarification round");
      }
      this.db
        .prepare(
          `INSERT INTO clarifications
             (id, project_id, objective_id, status, questions, created_at, updated_at,
              schema_version, round, provenance, provider_id, model, brain_run_id, idempotency_key)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.objectiveId,
          JSON.stringify(parsed.questions),
          ts,
          ts,
          1,
          round,
          input.provenance,
          input.providerId ?? null,
          input.model ?? null,
          input.brainRunId ?? null,
          input.idempotencyKey ?? null,
        );
      this.appendEvent("clarification.requested", { projectId: input.projectId }, {
        clarificationId: id,
        round,
        provenance: input.provenance,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        questions: parsed.questions.map((q) => ({
          id: q.id,
          logicalKey: q.logicalKey,
          category: q.category,
          question: q.question,
          reason: q.reason,
          answerType: q.answerType,
          required: q.required,
          displayOrder: q.displayOrder,
        })),
      });
      this.appendAudit(
        input.projectId,
        "engine",
        "clarification.request",
        `${parsed.questions.length} question(s), provenance=${input.provenance}`,
      );
    });
    tx();
    return this.getClarification(id)!;
  }

  getClarification(id: string): Clarification | null {
    const r = this.db.prepare("SELECT * FROM clarifications WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return rowToClarification(r);
  }

  listClarifications(projectId: string, status?: string): Clarification[] {
    const rows = status
      ? this.db
          .prepare("SELECT id FROM clarifications WHERE project_id = ? AND status = ? ORDER BY created_at ASC")
          .all(projectId, status)
      : this.db.prepare("SELECT id FROM clarifications WHERE project_id = ? ORDER BY created_at ASC").all(projectId);
    return (rows as { id: string }[]).map((r) => this.getClarification(r.id)!);
  }

  clarificationRoundCount(projectId: string, objectiveId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM clarifications WHERE project_id = ? AND objective_id = ?")
      .get(projectId, objectiveId) as { c: number };
    return row.c;
  }

  markClarificationObsolete(id: string, reason: string): void {
    const clarification = this.getClarification(id);
    if (!clarification || clarification.status !== "open") return;
    const questions = clarification.questions.map((question) =>
      question.status === "pending" ? { ...question, status: "obsolete" as const } : question,
    );
    this.db
      .prepare("UPDATE clarifications SET questions = ?, status = 'expired', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(questions), now(), id);
    this.appendEvent("clarification.obsolete", { projectId: clarification.projectId }, {
      clarificationId: id,
      reason,
    });
  }

  answerClarification(
    id: string,
    answers: { questionId: string; value?: ClarificationAnswerValue; answer?: string }[],
    opts: { idempotencyKey?: string } = {},
  ): Clarification {
    let result: Clarification | null = null;
    const tx = this.db.transaction(() => {
      const clarification = this.getClarification(id);
      if (!clarification) throw new Error(`clarification ${id} not found`);
      if (opts.idempotencyKey) {
        const existing = this.findIdempotent(`clr-answer:${id}:${opts.idempotencyKey}`);
        if (existing?.resourceType === "clarification" && existing.resourceId === id) {
          result = clarification.status === "answered" ? clarification : this.getClarification(id)!;
          return;
        }
      }
      this.assertProjectAcceptingWork(clarification.projectId);
      if (clarification.status === "answered") {
        throw new StoreConflictError(
          "clarification_already_answered",
          `clarification ${id} was already answered`,
        );
      }
      if (clarification.status !== "open") {
        throw new StoreConflictError(
          "clarification_obsolete",
          `clarification ${id} is ${clarification.status} and can no longer accept answers`,
        );
      }

      const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
      const unknown = answers.filter(
        (answer) => !clarification.questions.some((question) => question.id === answer.questionId),
      );
      if (unknown.length > 0) {
        throw new StoreConflictError(
          "conflict",
          `unknown question id(s): ${unknown.map((a) => a.questionId).join(", ")}`,
        );
      }

      const updated: ClarificationQuestion[] = [];
      for (const question of clarification.questions) {
        const submitted = byId.get(question.id);
        if (!submitted) {
          if (question.required) {
            throw new StoreConflictError(
              "clarification_incomplete",
              `required question ${question.id} (${question.logicalKey}) is missing`,
            );
          }
          updated.push(question);
          continue;
        }
        let value = submitted.value ?? null;
        if (!value && submitted.answer !== undefined) {
          value = coerceLegacyAnswer(question, submitted.answer);
          if (!value) {
            throw new StoreConflictError(
              "conflict",
              `could not coerce answer for question ${question.id} as ${question.answerType}`,
            );
          }
        }
        if (!value) {
          throw new StoreConflictError("conflict", `answer value missing for question ${question.id}`);
        }
        const issues = validateAnswerForQuestion(question, value);
        if (issues.length > 0) {
          throw new StoreConflictError("conflict", issues.map((issue) => issue.message).join("; "));
        }
        updated.push({
          ...question,
          status: "answered",
          answerValue: value,
          answer: serializeAnswerValue(value),
        });
      }

      const ts = now();
      // Optional questions left unanswered are closed (not left dangling in
      // `pending`) now that the group is answered, so the group has no
      // lingering open question after closure.
      const closed = updated.map((question) =>
        question.status === "pending" && !question.required
          ? { ...question, status: "cancelled" as const }
          : question,
      );
      // resume_pending = 1 records the durable intent to resume the brain
      // pipeline. It is committed atomically with the answers so a crash before
      // the engine kicks planning is reconciled on restart (invariant P-RESUME).
      this.db
        .prepare(
          "UPDATE clarifications SET questions = ?, status = 'answered', resume_pending = 1, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(closed), ts, id);
      if (opts.idempotencyKey) {
        this.recordIdempotent(`clr-answer:${id}:${opts.idempotencyKey}`, "clarification", id);
      }
      this.appendEvent("clarification.answered", { projectId: clarification.projectId }, {
        clarificationId: id,
        round: clarification.round,
        answers: updated
          .filter((question) => question.status === "answered")
          .map((question) => ({
            questionId: question.id,
            logicalKey: question.logicalKey,
            answerType: question.answerType,
            answer: question.answer,
          })),
      });
      this.appendAudit(
        clarification.projectId,
        "user",
        "clarification.answer",
        JSON.stringify(
          updated
            .filter((question) => question.answer !== null)
            .map((question) => ({ key: question.logicalKey, answer: question.answer })),
        ).slice(0, 500),
      );
      result = this.getClarification(id)!;
    });
    tx();
    return result!;
  }

  /** Answered clarification groups whose brain resume has not yet been claimed. */
  listPendingClarificationResumes(): { id: string; projectId: string; objectiveId: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, objective_id FROM clarifications
         WHERE resume_pending = 1 AND status = 'answered' ORDER BY created_at ASC`,
      )
      .all() as { id: string; project_id: string; objective_id: string }[];
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, objectiveId: r.objective_id }));
  }

  /**
   * Release claims left by a dead engine. Called once during startup
   * reconciliation before pending intents are drained.
   */
  releaseOrphanedClarificationResumeClaims(): void {
    this.db
      .prepare("UPDATE clarifications SET resume_pending = 1, updated_at = ? WHERE resume_pending = 2")
      .run(now());
  }

  /**
   * Claim and materialize one clarification outcome atomically. All decision
   * rows and their idempotency keys commit together, so a crash cannot leave a
   * partially recorded outcome. resume_pending=2 is an in-flight outbox claim.
   */
  claimClarificationResume(
    id: string,
  ): { projectId: string; objectiveId: string } | null {
    let result: { projectId: string; objectiveId: string } | null = null;
    const tx = this.db.transaction(() => {
      const clarification = this.getClarification(id);
      if (!clarification || clarification.status !== "answered") return;
      this.assertProjectAcceptingWork(clarification.projectId);
      const claimed = this.db
        .prepare(
          "UPDATE clarifications SET resume_pending = 2, updated_at = ? WHERE id = ? AND resume_pending = 1",
        )
        .run(now(), id);
      if (Number(claimed.changes) !== 1) return;

      for (const question of clarification.questions) {
        if (!question.answer) continue;
        const key = `clarification-decision:${id}:${question.id}`;
        if (this.findIdempotent(key)) continue;
        const entryId = this.addBrainEntry(
          clarification.projectId,
          "decision",
          `Clarified (${question.logicalKey}): ${question.question.slice(0, 80)}`,
          question.answer,
          [`clarification:${id}`, `question:${question.logicalKey}`, "user"],
        );
        this.recordIdempotent(key, "brain_entry", entryId);
      }

      const acceptance = clarification.questions.find(
        (question) =>
          question.logicalKey === "acceptance-criteria" ||
          question.category === "acceptance_criteria",
      )?.answer;
      if (acceptance) {
        const objective = this.getObjective(clarification.objectiveId);
        if (objective && objective.acceptanceCriteria.length === 0) {
          const criteria = acceptance
            .split(/\n|;/)
            .map((value) => value.trim())
            .filter(Boolean);
          this.db
            .prepare("UPDATE objectives SET acceptance_criteria = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(criteria), now(), objective.id);
        }
      }
      result = { projectId: clarification.projectId, objectiveId: clarification.objectiveId };
    });
    tx();
    return result;
  }

  /** Release a live claim when planning could not be kicked. */
  releaseClarificationResume(id: string): void {
    this.db
      .prepare("UPDATE clarifications SET resume_pending = 1, updated_at = ? WHERE id = ? AND resume_pending = 2")
      .run(now(), id);
  }

  /** Clear the durable resume intent once planning has been (re)kicked. */
  clearClarificationResume(id: string): void {
    this.db
      .prepare("UPDATE clarifications SET resume_pending = 0, updated_at = ? WHERE id = ? AND resume_pending = 2")
      .run(now(), id);
  }

  // ── brain ────────────────────────────────────────────────────────────────

  addBrainEntry(
    projectId: string,
    kind: string,
    title: string,
    body: string,
    sources: string[],
    expectedPauseGeneration?: number,
  ): string {
    const ts = now();
    const id = newId("brn");
    const cleanSources = redactStructured(sources);
    const tx = this.db.transaction(() => {
      if (expectedPauseGeneration !== undefined) {
        this.assertProjectAcceptingWork(projectId, expectedPauseGeneration);
      }
      this.db
        .prepare(
          `INSERT INTO brain_entries (id, project_id, kind, title, body, sources, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          kind,
          redactSecrets(title).slice(0, 300),
          redactSecrets(body).slice(0, 10_000),
          JSON.stringify(cleanSources),
          ts,
          ts,
        );
    });
    tx();
    return id;
  }

  listBrainEntries(projectId: string): {
    id: string;
    kind: string;
    title: string;
    body: string;
    sources: string[];
    createdAt: string;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM brain_entries WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      title: r.title as string,
      body: r.body as string,
      sources: JSON.parse(r.sources as string) as string[],
      createdAt: r.created_at as string,
    }));
  }

  // ── plans ────────────────────────────────────────────────────────────────

  createPlan(projectId: string, summary: string, milestones: Plan["milestones"]): Plan {
    const id = newId("pln");
    const ts = now();
    const version = (this.db
      .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM plans WHERE project_id = ?")
      .get(projectId) as { v: number }).v;
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE plans SET active = 0, updated_at = ? WHERE project_id = ?").run(ts, projectId);
      this.db
        .prepare(
          `INSERT INTO plans (id, project_id, version, summary, milestones, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, projectId, version, summary, JSON.stringify(milestones), ts, ts);
      this.appendEvent(version === 1 ? "plan.created" : "plan.updated", { projectId }, { planId: id, version });
    });
    tx();
    return this.getPlan(id)!;
  }

  getPlan(id: string): Plan | null {
    const r = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      projectId: r.project_id as string,
      version: r.version as number,
      summary: r.summary as string,
      milestones: JSON.parse(r.milestones as string) as Plan["milestones"],
      active: Boolean(r.active),
      objectiveId: (r.objective_id as string) ?? null,
      provenance: (r.provenance as Plan["provenance"]) ?? null,
      providerId: (r.provider_id as string) ?? null,
      model: (r.model as string) ?? null,
      snapshotHash: (r.snapshot_hash as string) ?? null,
      replanTrigger: (r.replan_trigger as Plan["replanTrigger"]) ?? null,
      replanCause: (r.replan_cause as string) ?? null,
      replanSources: JSON.parse((r.replan_sources as string) ?? "[]") as string[],
      basedOnVersion: (r.based_on_version as number) ?? null,
      analysisRunId: (r.analysis_run_id as string) ?? null,
      architectureRunId: (r.architecture_run_id as string) ?? null,
      planRunId: (r.plan_run_id as string) ?? null,
    };
  }

  activePlan(projectId: string): Plan | null {
    const r = this.db
      .prepare("SELECT id FROM plans WHERE project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1")
      .get(projectId) as { id: string } | undefined;
    return r ? this.getPlan(r.id) : null;
  }

  listPlans(projectId: string): Plan[] {
    const rows = this.db
      .prepare("SELECT id FROM plans WHERE project_id = ? ORDER BY version ASC")
      .all(projectId) as { id: string }[];
    return rows.map((r) => this.getPlan(r.id)!);
  }

  // ── brain runs (durable AI planning pipeline) ────────────────────────────

  createBrainRun(input: {
    projectId: string;
    objectiveId: string;
    step: BrainStep;
    attempt: number;
    providerId: string | null;
    model: string | null;
    provenance: BrainProvenance;
    input: string | null;
    expectedPauseGeneration?: number;
  }): BrainRun {
    const id = newId("brr");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.assertProjectAcceptingWork(input.projectId, input.expectedPauseGeneration);
      this.db
        .prepare(
          `INSERT INTO brain_runs (id, project_id, objective_id, step, state, attempt, provider_id, model, provenance, input, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.objectiveId,
          input.step,
          input.attempt,
          input.providerId,
          input.model,
          input.provenance,
          input.input === null ? null : redactSecrets(input.input),
          ts,
          ts,
        );
      this.appendEvent("brain.step_changed", { projectId: input.projectId }, {
        brainRunId: id,
        objectiveId: input.objectiveId,
        step: input.step,
        state: "running",
        attempt: input.attempt,
        provider: input.providerId,
        model: input.model,
        provenance: input.provenance,
      });
    });
    tx();
    return this.getBrainRun(id)!;
  }

  finishBrainRun(
    id: string,
    result: {
      state: Exclude<BrainRunState, "running">;
      output?: unknown;
      errorCategory?: string | null;
      errorDetail?: string | null;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    },
    expectedPauseGeneration?: number,
  ): BrainRun {
    const run = this.getBrainRun(id);
    if (!run) throw new Error(`brain run ${id} not found`);
    const ts = now();
    const tx = this.db.transaction(() => {
      if (expectedPauseGeneration !== undefined) {
        this.assertProjectAcceptingWork(run.projectId, expectedPauseGeneration);
      }
      this.db
        .prepare(
          `UPDATE brain_runs SET state = ?, output = ?, error_category = ?, error_detail = ?,
             input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          result.state,
          result.output === undefined ? null : redactSecrets(JSON.stringify(result.output)),
          result.errorCategory ?? null,
          result.errorDetail === undefined || result.errorDetail === null
            ? null
            : redactSecrets(result.errorDetail).slice(0, 2000),
          result.inputTokens ?? 0,
          result.outputTokens ?? 0,
          result.costUsd ?? 0,
          ts,
          id,
        );
      this.appendEvent("brain.step_changed", { projectId: run.projectId }, {
        brainRunId: id,
        objectiveId: run.objectiveId,
        step: run.step,
        state: result.state,
        attempt: run.attempt,
        provider: run.providerId,
        model: run.model,
        provenance: run.provenance,
        ...(result.errorCategory ? { errorCategory: result.errorCategory } : {}),
      });
    });
    tx();
    return this.getBrainRun(id)!;
  }

  getBrainRun(id: string): BrainRun | null {
    const r = this.db.prepare("SELECT * FROM brain_runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToBrainRun(r) : null;
  }

  listBrainRuns(projectId: string, objectiveId?: string): BrainRun[] {
    const rows = (
      objectiveId
        ? this.db
            .prepare("SELECT * FROM brain_runs WHERE project_id = ? AND objective_id = ? ORDER BY rowid ASC")
            .all(projectId, objectiveId)
        : this.db.prepare("SELECT * FROM brain_runs WHERE project_id = ? ORDER BY rowid ASC").all(projectId)
    ) as Record<string, unknown>[];
    return rows.map(rowToBrainRun);
  }

  /** Orphaned pipeline attempts from a dead process (recovery, once). */
  listOrphanBrainRuns(): BrainRun[] {
    const rows = this.db
      .prepare("SELECT * FROM brain_runs WHERE state = 'running' ORDER BY rowid ASC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToBrainRun);
  }

  /**
   * Persist a validated AI plan atomically: cancel the previous plan's
   * legally cancellable missions, deactivate old plan versions, insert the
   * new version, mint server ids for every proposed mission, resolve logical
   * dependency keys and activate the project — all in one transaction.
   * Refuses to persist against a superseded objective revision.
   */
  createBrainPlan(input: {
    projectId: string;
    objectiveId: string;
    summary: string;
    milestones: Plan["milestones"];
    provenance: BrainProvenance;
    providerId: string | null;
    model: string | null;
    snapshotHash: string | null;
    analysisRunId: string | null;
    architectureRunId: string | null;
    planRunId: string | null;
    /** Persisted in the same transaction as the plan for crash-safe replans. */
    idempotencyKey: string | null;
    expectedPauseGeneration?: number;
    replan: { trigger: ReplanTrigger; cause: string; sources: string[]; basedOnVersion: number } | null;
    missions: {
      logicalKey: string;
      title: string;
      role: Mission["role"];
      milestoneId: string | null;
      contract: Mission["contract"];
      priority: number;
      dependsOnKeys: string[];
    }[];
  }): { plan: Plan; missions: Mission[]; created: boolean } {
    const CANCELLABLE: readonly MissionState[] = ["proposed", "ready", "paused", "blocked"];
    const cleanSummary = redactSecrets(input.summary).slice(0, 5000);
    const cleanMilestones = redactStructured(input.milestones);
    const cleanReplan = input.replan
      ? {
          ...input.replan,
          cause: redactSecrets(input.replan.cause).slice(0, 500),
          sources: redactStructured(input.replan.sources),
        }
      : null;
    const cleanMissions = input.missions.map((mission) => ({
      ...mission,
      title: redactSecrets(mission.title).slice(0, 300),
      contract: redactStructured(mission.contract),
    }));
    let planId = "";
    let created = true;
    const missionIds: string[] = [];
    const tx = this.db.transaction(() => {
      if (input.idempotencyKey) {
        const existing = this.findIdempotent(input.idempotencyKey);
        if (existing) {
          if (existing.resourceType !== "plan") {
            throw new Error(`idempotency key ${input.idempotencyKey} belongs to ${existing.resourceType}`);
          }
          const plan = this.getPlan(existing.resourceId);
          if (!plan || plan.projectId !== input.projectId || plan.objectiveId !== input.objectiveId) {
            throw new Error(`idempotency key ${input.idempotencyKey} points to an invalid plan`);
          }
          planId = plan.id;
          created = false;
          return;
        }
      }

      this.assertProjectAcceptingWork(input.projectId, input.expectedPauseGeneration);

      const latest = this.latestObjective(input.projectId);
      if (!latest || latest.id !== input.objectiveId) {
        throw new Error(`objective ${input.objectiveId} was superseded; refusing to persist a stale plan`);
      }
      if (cleanReplan) {
        const activeVersion = this.activePlan(input.projectId)?.version ?? 0;
        if (activeVersion !== cleanReplan.basedOnVersion) {
          throw new Error(
            `stale replan base v${cleanReplan.basedOnVersion}; active plan is v${activeVersion}`,
          );
        }
      }

      const version = (this.db
        .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM plans WHERE project_id = ?")
        .get(input.projectId) as { v: number }).v;

      for (const mission of this.listMissions(input.projectId)) {
        if (mission.planId !== null) {
          this.withdrawOpenApprovalsForMission(mission.id, `superseded by plan v${version}`);
        }
        if (mission.planId !== null && CANCELLABLE.includes(mission.state)) {
          this.transitionMission(mission.id, "cancelled", `superseded by plan v${version}`);
        }
      }

      planId = newId("pln");
      const ts = now();
      this.db.prepare("UPDATE plans SET active = 0, updated_at = ? WHERE project_id = ?").run(ts, input.projectId);
      this.db
        .prepare(
          `INSERT INTO plans (id, project_id, version, summary, milestones, active, objective_id, provenance,
             provider_id, model, snapshot_hash, replan_trigger, replan_cause, replan_sources, based_on_version,
             analysis_run_id, architecture_run_id, plan_run_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          planId,
          input.projectId,
          version,
          cleanSummary,
          JSON.stringify(cleanMilestones),
          input.objectiveId,
          input.provenance,
          input.providerId,
          input.model,
          input.snapshotHash,
          cleanReplan?.trigger ?? null,
          cleanReplan?.cause ?? null,
          JSON.stringify(cleanReplan?.sources ?? []),
          cleanReplan?.basedOnVersion ?? null,
          input.analysisRunId,
          input.architectureRunId,
          input.planRunId,
          ts,
          ts,
        );
      this.appendEvent(version === 1 ? "plan.created" : "plan.updated", { projectId: input.projectId }, {
        planId,
        version,
        provenance: input.provenance,
        provider: input.providerId,
        model: input.model,
        snapshotHash: input.snapshotHash,
      });
      if (cleanReplan) {
        this.appendEvent("plan.replanned", { projectId: input.projectId }, {
          planId,
          version,
          basedOnVersion: cleanReplan.basedOnVersion,
          trigger: cleanReplan.trigger,
          cause: cleanReplan.cause,
          sources: cleanReplan.sources,
        });
        this.appendAudit(
          input.projectId,
          "engine",
          "plan.replanned",
          `v${cleanReplan.basedOnVersion} -> v${version} (${cleanReplan.trigger}): ${cleanReplan.cause}`.slice(0, 500),
        );
      }

      const idByKey = new Map<string, string>();
      for (const mission of cleanMissions) {
        const created = this.createMission({
          projectId: input.projectId,
          planId,
          milestoneId: mission.milestoneId,
          title: mission.title,
          role: mission.role,
          contract: mission.contract,
          priority: mission.priority,
          dependsOn: [],
          logicalKey: mission.logicalKey,
        });
        idByKey.set(mission.logicalKey, created.id);
        missionIds.push(created.id);
      }
      for (const mission of cleanMissions) {
        const missionId = idByKey.get(mission.logicalKey)!;
        for (const key of mission.dependsOnKeys) {
          const dependsOnId = idByKey.get(key);
          if (!dependsOnId) throw new Error(`unresolved mission dependency key: ${key}`);
          this.db
            .prepare("INSERT INTO mission_deps (mission_id, depends_on_mission_id) VALUES (?, ?)")
            .run(missionId, dependsOnId);
        }
      }
      if (input.idempotencyKey) {
        this.recordIdempotent(input.idempotencyKey, "plan", planId);
      }
      this.setProjectStatus(input.projectId, "active");
    });
    tx();
    const missions = created
      ? missionIds.map((id) => this.getMission(id)!)
      : this.listMissions(input.projectId).filter((mission) => mission.planId === planId);
    return { plan: this.getPlan(planId)!, missions, created };
  }

  // ── missions ─────────────────────────────────────────────────────────────

  createMission(input: {
    projectId: string;
    planId: string | null;
    milestoneId: string | null;
    title: string;
    role: Mission["role"];
    contract: Mission["contract"];
    priority: number;
    dependsOn: string[];
    maxCorrectionAttempts?: number;
    logicalKey?: string | null;
  }): Mission {
    const id = newId("msn");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO missions (id, project_id, plan_id, milestone_id, title, role, state, contract, priority, max_correction_attempts, logical_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.planId,
          input.milestoneId,
          input.title,
          input.role,
          JSON.stringify(input.contract),
          input.priority,
          input.maxCorrectionAttempts ?? 3,
          input.logicalKey ?? null,
          ts,
          ts,
        );
      for (const dep of input.dependsOn) {
        this.db
          .prepare("INSERT INTO mission_deps (mission_id, depends_on_mission_id) VALUES (?, ?)")
          .run(id, dep);
      }
      this.appendEvent("mission.created", { projectId: input.projectId, missionId: id }, {
        title: input.title,
        role: input.role,
      });
    });
    tx();
    return this.getMission(id)!;
  }

  getMission(id: string): Mission | null {
    const r = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToMission(r) : null;
  }

  listMissions(projectId?: string, state?: MissionState): Mission[] {
    let rows: Record<string, unknown>[];
    if (projectId && state) {
      rows = this.db
        .prepare("SELECT * FROM missions WHERE project_id = ? AND state = ? ORDER BY created_at ASC")
        .all(projectId, state) as Record<string, unknown>[];
    } else if (projectId) {
      rows = this.db
        .prepare("SELECT * FROM missions WHERE project_id = ? ORDER BY created_at ASC")
        .all(projectId) as Record<string, unknown>[];
    } else if (state) {
      rows = this.db.prepare("SELECT * FROM missions WHERE state = ? ORDER BY created_at ASC").all(state) as Record<
        string,
        unknown
      >[];
    } else {
      rows = this.db.prepare("SELECT * FROM missions ORDER BY created_at ASC").all() as Record<string, unknown>[];
    }
    return rows.map(rowToMission);
  }

  listDependencies(projectId: string): MissionDependency[] {
    const rows = this.db
      .prepare(
        `SELECT d.mission_id, d.depends_on_mission_id FROM mission_deps d
         JOIN missions m ON m.id = d.mission_id WHERE m.project_id = ?`,
      )
      .all(projectId) as { mission_id: string; depends_on_mission_id: string }[];
    return rows.map((r) => ({ missionId: r.mission_id, dependsOnMissionId: r.depends_on_mission_id }));
  }

  /**
   * The only way mission state changes. Validates legality against the
   * transition table inside a transaction and appends the state event
   * atomically. Illegal transitions throw and change nothing.
   */
  transitionMission(
    id: string,
    to: MissionState,
    reason: string,
    actor = "engine",
    expectedPauseGeneration?: number,
  ): Mission {
    const tx = this.db.transaction(() => {
      const mission = this.getMission(id);
      if (!mission) throw new Error(`mission ${id} not found`);
      if (expectedPauseGeneration !== undefined) {
        this.assertProjectAcceptingWork(mission.projectId, expectedPauseGeneration);
      }
      assertMissionTransition(mission.state, to);
      this.db
        .prepare("UPDATE missions SET state = ?, state_reason = ?, updated_at = ? WHERE id = ?")
        .run(to, reason || null, now(), id);
      this.appendEvent("mission.state_changed", { projectId: mission.projectId, missionId: id }, {
        from: mission.state,
        to,
        reason,
      });
      this.appendAudit(mission.projectId, actor, "mission.transition", `${id}: ${mission.state} -> ${to} (${reason})`);
    });
    tx();
    return this.getMission(id)!;
  }

  updateMissionMeta(
    id: string,
    fields: Partial<{
      branchName: string;
      worktreePath: string;
      baselineCommit: string;
      correctionAttempts: number;
    }>,
    expectedPauseGeneration?: number,
  ): void {
    const tx = this.db.transaction(() => {
      const mission = this.getMission(id);
      if (!mission) throw new Error(`mission ${id} not found`);
      if (expectedPauseGeneration !== undefined) {
        this.assertProjectAcceptingWork(mission.projectId, expectedPauseGeneration);
      }
      this.db
        .prepare(
          `UPDATE missions
           SET branch_name = ?, worktree_path = ?, baseline_commit = ?,
               correction_attempts = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          fields.branchName ?? mission.branchName,
          fields.worktreePath ?? mission.worktreePath,
          fields.baselineCommit ?? mission.baselineCommit,
          fields.correctionAttempts ?? mission.correctionAttempts,
          now(),
          id,
        );
    });
    tx();
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  createRun(input: {
    projectId: string;
    missionId: string;
    providerId: string | null;
    model: string | null;
    workerId?: string | null;
    expectedPauseGeneration?: number;
  }): AgentRun {
    const id = newId("run");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.assertProjectAcceptingWork(input.projectId, input.expectedPauseGeneration);
      this.db
        .prepare(
          `INSERT INTO runs (id, project_id, mission_id, provider_id, model, worker_id, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(id, input.projectId, input.missionId, input.providerId, input.model, input.workerId ?? null, ts, ts);
      this.appendEvent("run.state_changed", { projectId: input.projectId, missionId: input.missionId, runId: id }, {
        state: "queued",
        model: input.model,
      });
    });
    tx();
    return this.getRun(id)!;
  }

  getRun(id: string): AgentRun | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToRun(r) : null;
  }

  listRuns(filter: { projectId?: string; missionId?: string; states?: RunState[] } = {}): AgentRun[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.projectId) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.missionId) {
      clauses.push("mission_id = ?");
      params.push(filter.missionId);
    }
    if (filter.states?.length) {
      clauses.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      params.push(...filter.states);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY created_at ASC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  transitionRun(
    id: string,
    to: RunState,
    extras: { exitReason?: string; errorCategory?: string } = {},
    expectedPauseGeneration?: number,
  ): AgentRun {
    const tx = this.db.transaction(() => {
      const run = this.getRun(id);
      if (!run) throw new Error(`run ${id} not found`);
      if (expectedPauseGeneration !== undefined) {
        this.assertProjectAcceptingWork(run.projectId, expectedPauseGeneration);
      }
      assertRunTransition(run.state, to);
      const ts = now();
      this.db
        .prepare(
          `UPDATE runs SET state = ?, exit_reason = COALESCE(?, exit_reason),
             error_category = COALESCE(?, error_category),
             started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
             ended_at = CASE WHEN ? IN ('succeeded','failed','cancelled','timed_out') THEN ? ELSE ended_at END,
             updated_at = ? WHERE id = ?`,
        )
        .run(to, extras.exitReason ?? null, extras.errorCategory ?? null, to, ts, to, ts, ts, id);
      this.appendEvent("run.state_changed", { projectId: run.projectId, missionId: run.missionId, runId: id }, {
        from: run.state,
        to,
        ...extras,
      });
    });
    tx();
    return this.getRun(id)!;
  }

  appendRunLog(runId: string, text: string, expectedPauseGeneration?: number): void {
    const tx = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) return;
      if (expectedPauseGeneration !== undefined) {
        this.assertProjectAcceptingWork(run.projectId, expectedPauseGeneration);
      }
      const clean = redactSecrets(text);
      const seq = (this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM run_logs WHERE run_id = ?")
        .get(runId) as { s: number }).s;
      this.db
        .prepare("INSERT INTO run_logs (run_id, seq, text, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, seq, clean, now());
      this.appendEvent("run.output", { projectId: run.projectId, missionId: run.missionId, runId }, {
        text: clean.length > 4000 ? `${clean.slice(0, 4000)}…` : clean,
      });
    });
    tx();
  }

  runLogs(runId: string): { seq: number; text: string; createdAt: string }[] {
    const rows = this.db
      .prepare("SELECT seq, text, created_at FROM run_logs WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as { seq: number; text: string; created_at: string }[];
    return rows.map((r) => ({ seq: r.seq, text: r.text, createdAt: r.created_at }));
  }

  recordUsage(input: {
    projectId: string;
    runId: string | null;
    providerId: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    expectedPauseGeneration?: number;
  }): void {
    const ts = now();
    const tx = this.db.transaction(() => {
      this.assertProjectAcceptingWork(input.projectId, input.expectedPauseGeneration);
      this.db
        .prepare(
          `INSERT INTO usage_records (id, project_id, run_id, provider_id, model, input_tokens, output_tokens, cost_usd, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId("usg"), input.projectId, input.runId, input.providerId, input.model, input.inputTokens, input.outputTokens, input.costUsd, ts, ts);
      if (input.runId) {
        this.db
          .prepare(
            "UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?",
          )
          .run(input.inputTokens, input.outputTokens, input.costUsd, ts, input.runId);
      }
      this.db
        .prepare("UPDATE budgets SET spent_usd = spent_usd + ?, updated_at = ? WHERE project_id = ?")
        .run(input.costUsd, ts, input.projectId);
      this.appendEvent("run.usage", { projectId: input.projectId, runId: input.runId }, {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsd: input.costUsd,
      });
    });
    tx();
  }

  usageSummary(projectId: string): { inputTokens: number; outputTokens: number; costUsd: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(cost_usd),0) AS c
         FROM usage_records WHERE project_id = ?`,
      )
      .get(projectId) as { i: number; o: number; c: number };
    return { inputTokens: r.i, outputTokens: r.o, costUsd: r.c };
  }

  // ── approvals & checkpoints ──────────────────────────────────────────────

  createApproval(projectId: string, missionId: string | null, title: string, description: string): Approval {
    const id = newId("apr");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO approvals (id, project_id, mission_id, status, title, description, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(id, projectId, missionId, title, description, ts, ts);
      this.appendEvent("approval.requested", { projectId, missionId }, { approvalId: id, title });
    });
    tx();
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | null {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      projectId: r.project_id as string,
      missionId: (r.mission_id as string) ?? null,
      status: r.status as Approval["status"],
      title: r.title as string,
      description: r.description as string,
      decision: (r.decision as Approval["decision"]) ?? null,
      decidedAt: (r.decided_at as string) ?? null,
    };
  }

  listApprovals(status?: string, projectId?: string): Approval[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (projectId) {
      clauses.push("project_id = ?");
      params.push(projectId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT id FROM approvals ${where} ORDER BY created_at ASC`)
      .all(...params) as { id: string }[];
    return rows.map((r) => this.getApproval(r.id)!);
  }

  resolveApproval(id: string, decision: "approved" | "rejected", note: string): Approval {
    const approval = this.getApproval(id);
    if (!approval) throw new Error(`approval ${id} not found`);
    if (approval.status !== "open") throw new Error(`approval ${id} is already ${approval.status}`);
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE approvals SET status = 'answered', decision = ?, decided_at = ?, updated_at = ? WHERE id = ?")
        .run(decision, ts, ts, id);
      this.appendEvent("approval.resolved", { projectId: approval.projectId, missionId: approval.missionId }, {
        approvalId: id,
        decision,
        note,
      });
      this.appendAudit(approval.projectId, "user", "approval.resolve", `${id}: ${decision} ${note}`.trim());
    });
    tx();
    return this.getApproval(id)!;
  }

  withdrawOpenApprovalsForMission(missionId: string, reason: string): number {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error(`mission ${missionId} not found`);
    let withdrawn = 0;
    const tx = this.db.transaction(() => {
      const approvals = this.db
        .prepare("SELECT id FROM approvals WHERE mission_id = ? AND status = 'open' ORDER BY created_at ASC")
        .all(missionId) as { id: string }[];
      const ts = now();
      for (const approval of approvals) {
        const result = this.db
          .prepare("UPDATE approvals SET status = 'withdrawn', updated_at = ? WHERE id = ? AND status = 'open'")
          .run(ts, approval.id);
        if (Number(result.changes) !== 1) continue;
        withdrawn += 1;
        this.appendEvent("approval.withdrawn", { projectId: mission.projectId, missionId }, {
          approvalId: approval.id,
          reason,
        });
        this.appendAudit(mission.projectId, "engine", "approval.withdraw", `${approval.id}: ${reason}`);
      }
    });
    tx();
    return withdrawn;
  }

  upsertCheckpoint(
    projectId: string,
    missionId: string,
    kind: Checkpoint["kind"],
    status: Checkpoint["status"],
    detail: string,
    expectedPauseGeneration?: number,
  ): void {
    const ts = now();
    const tx = this.db.transaction(() => {
      this.assertProjectAcceptingWork(projectId, expectedPauseGeneration);
      const existing = this.db
        .prepare("SELECT id FROM checkpoints WHERE mission_id = ? AND kind = ?")
        .get(missionId, kind) as { id: string } | undefined;
      if (existing) {
        this.db
          .prepare("UPDATE checkpoints SET status = ?, detail = ?, updated_at = ? WHERE id = ?")
          .run(status, detail, ts, existing.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO checkpoints (id, project_id, mission_id, kind, status, detail, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(newId("chk"), projectId, missionId, kind, status, detail, ts, ts);
      }
      this.appendEvent("checkpoint.updated", { projectId, missionId }, { kind, status, detail });
    });
    tx();
  }

  listCheckpoints(missionId: string): Checkpoint[] {
    const rows = this.db
      .prepare("SELECT * FROM checkpoints WHERE mission_id = ? ORDER BY created_at ASC")
      .all(missionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      projectId: r.project_id as string,
      missionId: r.mission_id as string,
      kind: r.kind as Checkpoint["kind"],
      status: r.status as Checkpoint["status"],
      detail: r.detail as string,
      evidenceRef: (r.evidence_ref as string) ?? null,
    }));
  }

  // ── terminal sessions ────────────────────────────────────────────────────

  createTerminal(
    projectId: string,
    command: string[],
    cwd: string,
    runId: string | null = null,
    requiredCapabilities: string[] = commandCapabilities(command),
    expectedPauseGeneration?: number,
  ): {
    id: string;
    state: string;
  } {
    const id = newId("trm");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.assertProjectAcceptingWork(projectId, expectedPauseGeneration);
      this.db
        .prepare(
          `INSERT INTO terminal_sessions
             (id, project_id, run_id, command, cwd, state, required_capabilities, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(id, projectId, runId, JSON.stringify(command), cwd, JSON.stringify(requiredCapabilities), ts, ts);
      this.appendEvent("terminal.output", { projectId, runId }, {
        terminalId: id,
        state: "queued",
        command,
      });
    });
    tx();
    return { id, state: "queued" };
  }

  getTerminal(id: string): {
    id: string;
    projectId: string;
    runId: string | null;
    workerId: string | null;
    command: string[];
    cwd: string;
    state: string;
    exitCode: number | null;
    requiredCapabilities: string[];
    leaseExpiresAt: string | null;
    leaseAttempts: number;
  } | null {
    const r = this.db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      runId: (r.run_id as string) ?? null,
      workerId: (r.worker_id as string) ?? null,
      command: JSON.parse(r.command as string) as string[],
      cwd: r.cwd as string,
      state: r.state as string,
      exitCode: (r.exit_code as number) ?? null,
      requiredCapabilities: JSON.parse((r.required_capabilities as string) ?? '["shell"]') as string[],
      leaseExpiresAt: (r.lease_expires_at as string) ?? null,
      leaseAttempts: (r.lease_attempts as number) ?? 0,
    };
  }

  /** Whether a live worker has both free capacity and every capability required by this command. */
  hasAvailableWorker(command: readonly string[], heartbeatWindowMs = WORKER_HEARTBEAT_WINDOW_MS): boolean {
    const required = commandCapabilities(command);
    const cutoff = new Date(Date.now() - heartbeatWindowMs).toISOString();
    const workers = this.db
      .prepare(
        `SELECT w.id, w.capabilities, w.max_concurrent_runs,
                (SELECT COUNT(*) FROM terminal_sessions t
                 WHERE t.worker_id = w.id AND t.state IN ('starting', 'running', 'cancelling')) AS active_runs
         FROM workers w
         WHERE w.status = 'online' AND w.last_heartbeat_at > ?`,
      )
      .all(cutoff) as unknown as Array<{
        id: string;
        capabilities: string;
        max_concurrent_runs: number;
        active_runs: number;
      }>;
    return workers.some((worker) => {
      if (worker.active_runs >= worker.max_concurrent_runs) return false;
      const capabilities = new Set(JSON.parse(worker.capabilities) as string[]);
      return required.every((capability) => capabilities.has(capability));
    });
  }

  /**
   * Atomically lease the oldest compatible terminal to an online worker.
   * Capacity and capability checks happen server-side; a short-lived opaque
   * token fences stale/revoked workers from reporting a later result.
   */
  leaseTerminal(workerId: string, leaseSeconds = 30): (NonNullable<ReturnType<Store["getTerminal"]>> & { leaseToken: string }) | null {
    let leasedId: string | null = null;
    let leaseToken: string | null = null;
    const tx = this.db.transaction(() => {
      this.reconcileExpiredTerminalLeases();
      const worker = this.db
        .prepare("SELECT status, capabilities, max_concurrent_runs FROM workers WHERE id = ?")
        .get(workerId) as { status: string; capabilities: string; max_concurrent_runs: number } | undefined;
      if (!worker || worker.status !== "online") return;
      const active = this.db
        .prepare("SELECT COUNT(*) AS count FROM terminal_sessions WHERE worker_id = ? AND state IN ('starting', 'running', 'cancelling')")
        .get(workerId) as { count: number };
      if (active.count >= worker.max_concurrent_runs) return;
      const capabilities = new Set(JSON.parse(worker.capabilities) as string[]);
      // A queued terminal whose project is paused must never be leased: the
      // durable pause is authoritative even in the window before its leases are
      // revoked (invariant P-FENCE).
      const rows = this.db
        .prepare(
          `SELECT t.id AS id, t.required_capabilities AS required_capabilities
           FROM terminal_sessions t
           JOIN projects p ON p.id = t.project_id
           WHERE t.state = 'queued' AND p.status != 'paused'
           ORDER BY t.created_at ASC`,
        )
        .all() as unknown as { id: string; required_capabilities: string }[];
      const row = rows.find((candidate) =>
        (JSON.parse(candidate.required_capabilities) as string[]).every((capability) => capabilities.has(capability)),
      );
      if (!row) return;
      leaseToken = randomUUID().replaceAll("-", "");
      const tokenHash = createHash("sha256").update(leaseToken).digest("hex");
      const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      this.db
        .prepare(
          `UPDATE terminal_sessions
           SET state = 'starting', worker_id = ?, lease_expires_at = ?, lease_token_hash = ?,
               lease_attempts = lease_attempts + 1, updated_at = ?
           WHERE id = ? AND state = 'queued'`,
        )
        .run(workerId, expiresAt, tokenHash, now(), row.id);
      leasedId = row.id;
    });
    tx();
    const terminal = leasedId ? this.getTerminal(leasedId) : null;
    return terminal && leaseToken ? { ...terminal, leaseToken } : null;
  }

  heartbeatWorker(workerId: string, leaseSeconds = 30): void {
    const ts = now();
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE workers SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, workerId);
      this.db
        .prepare(
          `UPDATE terminal_sessions SET lease_expires_at = ?, updated_at = ?
           WHERE worker_id = ? AND state IN ('starting', 'running', 'cancelling')`,
        )
        .run(expiresAt, ts, workerId);
    });
    tx();
  }

  validateTerminalLease(id: string, workerId: string, leaseToken: string): boolean {
    const row = this.db
      .prepare("SELECT worker_id, lease_token_hash, lease_expires_at, state FROM terminal_sessions WHERE id = ?")
      .get(id) as { worker_id: string | null; lease_token_hash: string | null; lease_expires_at: string | null; state: string } | undefined;
    if (!row || row.worker_id !== workerId || !row.lease_token_hash || !row.lease_expires_at) return false;
    if (new Date(row.lease_expires_at).getTime() <= Date.now()) return false;
    if (!["starting", "running", "cancelling"].includes(row.state)) return false;
    return row.lease_token_hash === createHash("sha256").update(leaseToken).digest("hex");
  }

  reconcileExpiredTerminalLeases(): void {
    const ts = now();
    // A lease that expired before execution started is safe to retry. Once a
    // worker reported output, automatic replay could duplicate side effects,
    // so running work is failed and left to the bounded mission retry loop.
    this.db
      .prepare(
        `UPDATE terminal_sessions
         SET state = 'queued', worker_id = NULL, lease_expires_at = NULL, lease_token_hash = NULL, updated_at = ?
         WHERE state = 'starting' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(ts, ts);
    this.db
      .prepare(
        `UPDATE terminal_sessions
         SET state = 'failed', exit_code = NULL, lease_expires_at = NULL, lease_token_hash = NULL, updated_at = ?
         WHERE state IN ('running', 'cancelling') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(ts, ts);
  }

  revokeWorkerLeases(workerId: string): void {
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE terminal_sessions
           SET state = CASE WHEN state = 'starting' THEN 'queued' ELSE 'cancelled' END,
               worker_id = NULL, lease_expires_at = NULL, lease_token_hash = NULL, updated_at = ?
           WHERE worker_id = ? AND state IN ('starting', 'running', 'cancelling')`,
        )
        .run(ts, workerId);
    });
    tx();
  }

  setTerminalState(id: string, state: string, exitCode: number | null = null): void {
    const terminal = this.getTerminal(id);
    if (!terminal) throw new Error(`terminal ${id} not found`);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE terminal_sessions SET state = ?, exit_code = ?,
           lease_expires_at = CASE WHEN ? IN ('succeeded','failed','cancelled','timed_out') THEN NULL ELSE lease_expires_at END,
           lease_token_hash = CASE WHEN ? IN ('succeeded','failed','cancelled','timed_out') THEN NULL ELSE lease_token_hash END,
           updated_at = ? WHERE id = ?`,
        )
        .run(state, exitCode, state, state, now(), id);
      this.appendEvent("terminal.output", { projectId: terminal.projectId, runId: terminal.runId }, {
        terminalId: id,
        state,
        exitCode,
      });
    });
    tx();
  }

  appendTerminalLog(id: string, text: string): void {
    const terminal = this.getTerminal(id);
    if (!terminal) return;
    const clean = redactSecrets(text);
    const seq = (this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM terminal_logs WHERE terminal_id = ?")
      .get(id) as { s: number }).s;
    this.db
      .prepare("INSERT INTO terminal_logs (terminal_id, seq, text, created_at) VALUES (?, ?, ?, ?)")
      .run(id, seq, clean, now());
    this.appendEvent("terminal.output", { projectId: terminal.projectId, runId: terminal.runId }, {
      terminalId: id,
      text: clean.length > 4000 ? `${clean.slice(0, 4000)}…` : clean,
    });
  }

  terminalLogs(id: string): { seq: number; text: string; createdAt: string }[] {
    const rows = this.db
      .prepare("SELECT seq, text, created_at FROM terminal_logs WHERE terminal_id = ? ORDER BY seq ASC")
      .all(id) as unknown as { seq: number; text: string; created_at: string }[];
    return rows.map((r) => ({ seq: r.seq, text: r.text, createdAt: r.created_at }));
  }

  listTerminals(projectId?: string): NonNullable<ReturnType<Store["getTerminal"]>>[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT id FROM terminal_sessions WHERE project_id = ? ORDER BY created_at ASC").all(projectId)
        : this.db.prepare("SELECT id FROM terminal_sessions ORDER BY created_at ASC").all()
    ) as unknown as { id: string }[];
    return rows.map((r) => this.getTerminal(r.id)!);
  }

  // ── pull requests ────────────────────────────────────────────────────────

  recordPullRequest(input: {
    projectId: string;
    missionId: string | null;
    branch: string;
    title: string;
    state: "draft" | "open" | "merged" | "closed";
    number?: number | null;
    url?: string | null;
    expectedPauseGeneration?: number;
  }): PullRequestRef {
    const id = newId("pr");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.assertProjectAcceptingWork(input.projectId, input.expectedPauseGeneration);
      this.db
        .prepare(
          `INSERT INTO pull_requests (id, project_id, mission_id, number, url, branch, title, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.projectId, input.missionId, input.number ?? null, input.url ?? null, input.branch, input.title, input.state, ts, ts);
      this.appendEvent("git.pr_opened", { projectId: input.projectId, missionId: input.missionId }, {
        prId: id,
        branch: input.branch,
        title: input.title,
      });
    });
    tx();
    return this.getPullRequest(id)!;
  }

  upsertPullRequest(input: {
    projectId: string;
    missionId: string;
    branch: string;
    title: string;
    state: "draft" | "open" | "merged" | "closed";
    number?: number | null;
    url?: string | null;
    expectedPauseGeneration?: number;
  }): PullRequestRef {
    let id: string | null = null;
    const tx = this.db.transaction(() => {
      this.assertProjectAcceptingWork(input.projectId, input.expectedPauseGeneration);
      const existing = this.db
        .prepare("SELECT id FROM pull_requests WHERE mission_id = ?")
        .get(input.missionId) as { id: string } | undefined;
      if (!existing) {
        id = this.recordPullRequest(input).id;
        return;
      }
      id = existing.id;
      this.db
        .prepare(
          `UPDATE pull_requests SET number = ?, url = ?, branch = ?, title = ?, state = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.number ?? null, input.url ?? null, input.branch, input.title, input.state, now(), existing.id);
      this.appendEvent("git.pr_updated", { projectId: input.projectId, missionId: input.missionId }, {
        prId: existing.id,
        number: input.number ?? null,
        url: input.url ?? null,
        state: input.state,
      });
    });
    tx();
    return this.getPullRequest(id!)!;
  }

  setPullRequestState(
    id: string,
    state: PullRequestRef["state"],
    expectedPauseGeneration?: number,
  ): PullRequestRef {
    const pr = this.getPullRequest(id);
    if (!pr) throw new Error(`pull request ${id} not found`);
    const tx = this.db.transaction(() => {
      this.assertProjectAcceptingWork(pr.projectId, expectedPauseGeneration);
      this.db.prepare("UPDATE pull_requests SET state = ?, updated_at = ? WHERE id = ?").run(state, now(), id);
      this.appendEvent("git.pr_updated", { projectId: pr.projectId, missionId: pr.missionId }, { prId: id, state });
    });
    tx();
    return this.getPullRequest(id)!;
  }

  getPullRequest(id: string): PullRequestRef | null {
    const r = this.db.prepare("SELECT * FROM pull_requests WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      projectId: r.project_id as string,
      missionId: (r.mission_id as string) ?? null,
      number: (r.number as number) ?? null,
      url: (r.url as string) ?? null,
      branch: r.branch as string,
      title: r.title as string,
      state: r.state as PullRequestRef["state"],
    };
  }

  listPullRequests(projectId?: string): PullRequestRef[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT id FROM pull_requests WHERE project_id = ? ORDER BY created_at ASC").all(projectId)
        : this.db.prepare("SELECT id FROM pull_requests ORDER BY created_at ASC").all()
    ) as unknown as { id: string }[];
    return rows.map((r) => this.getPullRequest(r.id)!);
  }

  // ── budgets ──────────────────────────────────────────────────────────────

  setBudget(projectId: string, limitUsd: number, warnAtFraction = 0.8): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO budgets (id, project_id, limit_usd, warn_at_fraction, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET limit_usd = excluded.limit_usd, warn_at_fraction = excluded.warn_at_fraction, updated_at = excluded.updated_at`,
      )
      .run(newId("bdg"), projectId, limitUsd, warnAtFraction, ts, ts);
  }

  clearBudget(projectId: string): void {
    this.db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
  }

  getBudget(projectId: string): { limitUsd: number; spentUsd: number; warnAtFraction: number } | null {
    const r = this.db
      .prepare("SELECT limit_usd, spent_usd, warn_at_fraction FROM budgets WHERE project_id = ?")
      .get(projectId) as { limit_usd: number; spent_usd: number; warn_at_fraction: number } | undefined;
    return r ? { limitUsd: r.limit_usd, spentUsd: r.spent_usd, warnAtFraction: r.warn_at_fraction } : null;
  }
}

// ── row mappers ────────────────────────────────────────────────────────────

function rowToProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    status: r.status as Project["status"],
    repoPath: (r.repo_path as string) ?? null,
    repoRemoteUrl: (r.repo_remote_url as string) ?? null,
    defaultBranch: r.default_branch as string,
    autonomyProfile: r.autonomy_profile as Project["autonomyProfile"],
    description: r.description as string,
  };
}

function rowToMission(r: Record<string, unknown>): Mission {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    projectId: r.project_id as string,
    planId: (r.plan_id as string) ?? null,
    milestoneId: (r.milestone_id as string) ?? null,
    title: r.title as string,
    role: r.role as Mission["role"],
    state: r.state as MissionState,
    contract: JSON.parse(r.contract as string) as Mission["contract"],
    branchName: (r.branch_name as string) ?? null,
    worktreePath: (r.worktree_path as string) ?? null,
    baselineCommit: (r.baseline_commit as string) ?? null,
    correctionAttempts: r.correction_attempts as number,
    maxCorrectionAttempts: r.max_correction_attempts as number,
    priority: r.priority as number,
    stateReason: (r.state_reason as string) ?? null,
    logicalKey: (r.logical_key as string) ?? null,
  };
}

function rowToRun(r: Record<string, unknown>): AgentRun {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    projectId: r.project_id as string,
    missionId: r.mission_id as string,
    agentProfileId: (r.agent_profile_id as string) ?? null,
    workerId: (r.worker_id as string) ?? null,
    providerId: (r.provider_id as string) ?? null,
    model: (r.model as string) ?? null,
    state: r.state as RunState,
    exitReason: (r.exit_reason as string) ?? null,
    errorCategory: (r.error_category as AgentRun["errorCategory"]) ?? null,
    startedAt: (r.started_at as string) ?? null,
    endedAt: (r.ended_at as string) ?? null,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    costUsd: r.cost_usd as number,
  };
}

function rowToBrainRun(r: Record<string, unknown>): BrainRun {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    projectId: r.project_id as string,
    objectiveId: r.objective_id as string,
    step: r.step as BrainRun["step"],
    state: r.state as BrainRun["state"],
    attempt: r.attempt as number,
    providerId: (r.provider_id as string) ?? null,
    model: (r.model as string) ?? null,
    provenance: r.provenance as BrainRun["provenance"],
    errorCategory: (r.error_category as BrainRun["errorCategory"]) ?? null,
    errorDetail: (r.error_detail as string) ?? null,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    costUsd: r.cost_usd as number,
    output: r.output === null || r.output === undefined ? null : (JSON.parse(r.output as string) as unknown),
  };
}

function commandCapabilities(command: readonly string[]): string[] {
  const executable = command[0]?.split("/").pop() ?? "";
  if (executable === "git") return ["shell", "git"];
  if (["node", "npm", "npx", "pnpm"].includes(executable)) return ["shell", "node"];
  if (executable === "swift") return ["shell", "swift"];
  return ["shell"];
}

function resumeMissionTarget(fromState: MissionState): MissionState {
  switch (fromState) {
    case "running":
    case "assigned":
    case "retrying":
      return "ready";
    case "proposed":
      // A proposed mission may still be waiting on dependency completion.
      // Restoring it as ready bypasses the scheduler's dependency gate after
      // any project pause/resume cycle.
      return "proposed";
    case "ready":
      return "ready";
    case "result_submitted":
      return "validating";
    case "validating":
      return "validating";
    case "review_required":
      return "review_required";
    case "approved":
      return "approved";
    case "integrated":
      return "integrated";
    case "blocked":
      return "blocked";
    default:
      return "ready";
  }
}

function rowToClarification(r: Record<string, unknown>): Clarification {
  const rawQuestions = JSON.parse(r.questions as string) as unknown[];
  const questions = rawQuestions.map((raw, index) => normalizeStoredQuestion(raw, index));
  return ClarificationSchema.parse({
    id: r.id as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    projectId: r.project_id as string,
    objectiveId: r.objective_id as string,
    status: r.status as Clarification["status"],
    schemaVersion: (r.schema_version as 1 | undefined) ?? 1,
    round: (r.round as number | undefined) ?? 1,
    provenance: (r.provenance as Clarification["provenance"] | undefined) ?? "deterministic_policy",
    providerId: (r.provider_id as string | null | undefined) ?? null,
    model: (r.model as string | null | undefined) ?? null,
    brainRunId: (r.brain_run_id as string | null | undefined) ?? null,
    questions,
  });
}

/** Accept both structured v1 questions and legacy flat {id,question,options,answer}. */
function normalizeStoredQuestion(raw: unknown, index: number): ClarificationQuestion {
  const value = raw as Record<string, unknown>;
  if (typeof value.logicalKey === "string" && typeof value.answerType === "string") {
    return value as ClarificationQuestion;
  }
  const legacyOptions = Array.isArray(value.options)
    ? (value.options as unknown[]).map((option, optionIndex) =>
        typeof option === "string"
          ? { key: `opt-${optionIndex + 1}`, label: option }
          : (option as { key: string; label: string }),
      )
    : [];
  const slug = String(value.id ?? `q-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64);
  // LogicalKey requires at least two characters starting with [a-z0-9]; a
  // degenerate legacy id must not make the whole group unparseable.
  const logicalKey = /^[a-z0-9][a-z0-9_-]{1,63}$/.test(slug) ? slug : `q-${index + 1}`;
  return {
    id: String(value.id ?? `legacy-${index}`),
    logicalKey,
    category: legacyOptions.length > 0 ? "decision" : "other",
    question: String(value.question ?? ""),
    reason: "Legacy clarification question retained for compatibility.",
    answerType: legacyOptions.length >= 2 ? "single_choice" : "text",
    options: legacyOptions,
    required: true,
    acceptanceCriteriaRefs: [],
    blockedDecisions: [],
    blockedMissions: [],
    displayOrder: index,
    status: value.answer ? "answered" : "pending",
    answer: (value.answer as string | null | undefined) ?? null,
    answerValue:
      typeof value.answer === "string" && value.answer.length > 0
        ? { type: "text", value: value.answer }
        : null,
  };
}
