import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Approval,
  Checkpoint,
  Clarification,
  EventEnvelope,
  EventType,
  Mission,
  MissionDependency,
  MissionState,
  AgentRun,
  Objective,
  Plan,
  Project,
  RunState,
} from "@avityos/contracts";
import { assertMissionTransition, assertRunTransition } from "@avityos/orchestration";
import { redactSecrets } from "@avityos/policy";
import type { DB } from "./db.js";

export function now(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
    autonomyProfile: Project["autonomyProfile"];
  }): Project {
    const id = newId("prj");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects (id, workspace_id, name, status, repo_path, repo_remote_url, autonomy_profile, description, created_at, updated_at)
           VALUES (?, 'default', ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.name, input.repoPath, input.repoRemoteUrl, input.autonomyProfile, input.description, ts, ts);
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

  setProjectStatus(id: string, status: Project["status"]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
      this.appendEvent("project.status_changed", { projectId: id }, { status });
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

  setObjectiveAnalysis(id: string, summary: string): void {
    this.db
      .prepare("UPDATE objectives SET analysis_summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, now(), id);
  }

  createClarification(
    projectId: string,
    objectiveId: string,
    questions: { id: string; question: string; options: string[]; answer: string | null }[],
  ): Clarification {
    const id = newId("clr");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO clarifications (id, project_id, objective_id, status, questions, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(id, projectId, objectiveId, JSON.stringify(questions), ts, ts);
      this.appendEvent("clarification.requested", { projectId }, {
        clarificationId: id,
        questions: questions.map((q) => q.question),
      });
    });
    tx();
    return this.getClarification(id)!;
  }

  getClarification(id: string): Clarification | null {
    const r = this.db.prepare("SELECT * FROM clarifications WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      projectId: r.project_id as string,
      objectiveId: r.objective_id as string,
      status: r.status as Clarification["status"],
      questions: JSON.parse(r.questions as string) as Clarification["questions"],
    };
  }

  listClarifications(projectId: string, status?: string): Clarification[] {
    const rows = status
      ? this.db
          .prepare("SELECT id FROM clarifications WHERE project_id = ? AND status = ? ORDER BY created_at ASC")
          .all(projectId, status)
      : this.db.prepare("SELECT id FROM clarifications WHERE project_id = ? ORDER BY created_at ASC").all(projectId);
    return (rows as { id: string }[]).map((r) => this.getClarification(r.id)!);
  }

  answerClarification(id: string, answers: { questionId: string; answer: string }[]): Clarification {
    const clarification = this.getClarification(id);
    if (!clarification) throw new Error(`clarification ${id} not found`);
    const questions = clarification.questions.map((q) => {
      const found = answers.find((a) => a.questionId === q.id);
      return found ? { ...q, answer: found.answer } : q;
    });
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE clarifications SET questions = ?, status = 'answered', updated_at = ? WHERE id = ?")
        .run(JSON.stringify(questions), now(), id);
      this.appendEvent("clarification.answered", { projectId: clarification.projectId }, {
        clarificationId: id,
      });
      this.appendAudit(clarification.projectId, "user", "clarification.answer", JSON.stringify(answers).slice(0, 500));
    });
    tx();
    return this.getClarification(id)!;
  }

  // ── brain ────────────────────────────────────────────────────────────────

  addBrainEntry(
    projectId: string,
    kind: string,
    title: string,
    body: string,
    sources: string[],
  ): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO brain_entries (id, project_id, kind, title, body, sources, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId("brn"), projectId, kind, title, body, JSON.stringify(sources), ts, ts);
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
    };
  }

  activePlan(projectId: string): Plan | null {
    const r = this.db
      .prepare("SELECT id FROM plans WHERE project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1")
      .get(projectId) as { id: string } | undefined;
    return r ? this.getPlan(r.id) : null;
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
  }): Mission {
    const id = newId("msn");
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO missions (id, project_id, plan_id, milestone_id, title, role, state, contract, priority, max_correction_attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`,
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
  transitionMission(id: string, to: MissionState, reason: string, actor = "engine"): Mission {
    const tx = this.db.transaction(() => {
      const mission = this.getMission(id);
      if (!mission) throw new Error(`mission ${id} not found`);
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
    fields: Partial<{ branchName: string; worktreePath: string; correctionAttempts: number }>,
  ): void {
    const mission = this.getMission(id);
    if (!mission) throw new Error(`mission ${id} not found`);
    this.db
      .prepare(
        "UPDATE missions SET branch_name = ?, worktree_path = ?, correction_attempts = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        fields.branchName ?? mission.branchName,
        fields.worktreePath ?? mission.worktreePath,
        fields.correctionAttempts ?? mission.correctionAttempts,
        now(),
        id,
      );
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  createRun(input: {
    projectId: string;
    missionId: string;
    providerId: string | null;
    model: string | null;
    workerId?: string | null;
  }): AgentRun {
    const id = newId("run");
    const ts = now();
    const tx = this.db.transaction(() => {
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

  transitionRun(id: string, to: RunState, extras: { exitReason?: string; errorCategory?: string } = {}): AgentRun {
    const tx = this.db.transaction(() => {
      const run = this.getRun(id);
      if (!run) throw new Error(`run ${id} not found`);
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

  appendRunLog(runId: string, text: string): void {
    const run = this.getRun(runId);
    if (!run) return;
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
  }): void {
    const ts = now();
    const tx = this.db.transaction(() => {
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

  upsertCheckpoint(
    projectId: string,
    missionId: string,
    kind: Checkpoint["kind"],
    status: Checkpoint["status"],
    detail: string,
  ): void {
    const ts = now();
    const existing = this.db
      .prepare("SELECT id FROM checkpoints WHERE mission_id = ? AND kind = ?")
      .get(missionId, kind) as { id: string } | undefined;
    const tx = this.db.transaction(() => {
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
    correctionAttempts: r.correction_attempts as number,
    maxCorrectionAttempts: r.max_correction_attempts as number,
    priority: r.priority as number,
    stateReason: (r.state_reason as string) ?? null,
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
