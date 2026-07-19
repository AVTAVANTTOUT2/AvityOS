import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  AnswerClarificationRequest,
  CreateMissionRequest,
  CreateProjectRequest,
  EnrollWorkerRequest,
  EventStreamQuery,
  PauseProjectRequest,
  ResolveApprovalRequest,
  ResumeProjectRequest,
  SubmitObjectiveRequest,
  TransitionMissionRequest,
  UpdateProjectRequest,
  type ApiErrorCode,
  type EventEnvelope,
} from "@avityos/contracts";
import { IllegalTransitionError } from "@avityos/orchestration";
import { isCommandAllowed, type CommandPolicy } from "@avityos/policy";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Engine } from "./engine.js";
import { ProjectValidationError, validateRepositoryConfiguration } from "./project-validation.js";
import { newId, now, StoreConflictError, type Store } from "./store.js";

export interface ServerOptions {
  store: Store;
  engine: Engine;
  apiToken?: string;
  version: string;
  /** Policy for ad-hoc project terminals (interactive, human-initiated). */
  commandPolicy?: CommandPolicy;
  /** Policy for mission-scoped check terminals (bound to a worktree). */
  missionCommandPolicy?: CommandPolicy;
  /** Explicit browser-origin allowlist. Never use a wildcard in production. */
  allowedOrigins?: readonly string[];
}

/**
 * Ad-hoc project terminals: observation-oriented allowlist. Interpreters and
 * package managers (node, npm, pnpm, git with hooks) can execute arbitrary
 * code and are therefore NOT allowed here — they are only permitted on
 * mission-scoped terminals whose cwd is bound server-side to a worktree.
 */
export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  allowedExecutables: ["ls", "echo", "cat", "pwd", "sleep"],
  deniedExecutables: ["rm", "sudo", "curl", "wget", "ssh", "scp", "node", "npm", "pnpm", "npx", "sh", "bash", "zsh", "python", "python3"],
};

export const DEFAULT_MISSION_COMMAND_POLICY: CommandPolicy = {
  allowedExecutables: ["git", "pnpm", "npm", "node", "ls", "echo", "cat", "pwd", "sleep"],
  deniedExecutables: ["rm", "sudo", "curl", "wget", "ssh", "scp"],
};

export const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

function apiError(reply: FastifyReply, status: number, code: ApiErrorCode, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

/**
 * Control-plane HTTP API. All bodies/queries are validated with the shared
 * contracts; every mutation goes through the Store/Engine so permission and
 * legality checks are server-side, never UI-side.
 */
export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { store, engine } = opts;
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: [...(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS)], credentials: true });
  const startedAt = Date.now();

  app.addHook("onRequest", async (req, reply) => {
    if (!opts.apiToken) return;
    if (req.url.startsWith("/v1/health")) return;
    // These routes authenticate with short-lived worker credentials and
    // terminal lease tokens instead of the user/admin bearer token.
    const path = req.url.split("?")[0] ?? req.url;
    const workerAuthenticatedRoute =
      req.method === "POST" &&
      (path === "/v1/workers/lease" ||
        /^\/v1\/workers\/[^/]+\/heartbeat$/.test(path) ||
        /^\/v1\/terminals\/[^/]+\/(output|exit)$/.test(path));
    if (workerAuthenticatedRoute) return;
    const header = req.headers.authorization;
    const cookieToken = parseCookie(req.headers.cookie ?? "", "avity_session");
    if (header !== `Bearer ${opts.apiToken}` && cookieToken !== opts.apiToken) {
      await reply.status(401).send({ error: { code: "policy_denied", message: "invalid or missing API token" } });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return apiError(reply, 400, "validation_failed", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    if (err instanceof IllegalTransitionError) {
      return apiError(reply, 409, "illegal_transition", err.message);
    }
    if (err instanceof StoreConflictError) {
      const status =
        err.code === "clarification_incomplete" || err.code === "clarification_obsolete"
          ? 409
          : err.code === "project_paused" || err.code === "project_not_paused"
            ? 409
            : 409;
      return apiError(reply, status, err.code, err.message);
    }
    if (err instanceof ProjectValidationError) {
      return apiError(reply, 400, "validation_failed", err.message);
    }
    return apiError(reply, 500, "internal", err instanceof Error ? err.message : "unexpected internal error");
  });

  function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
    return schema.parse(data);
  }

  // ── health ───────────────────────────────────────────────────────────────

  app.get("/v1/health", async () => ({
    status: "ok" as const,
    version: opts.version,
    uptimeSeconds: (Date.now() - startedAt) / 1000,
  }));

  // Exchange the user/admin bearer for an HttpOnly browser session. This
  // keeps the long-lived token out of localStorage and SSE query strings.
  app.post("/v1/session", async (_req, reply) => {
    reply.header("set-cookie", "avity_session=" + encodeURIComponent(opts.apiToken ?? "") + "; HttpOnly; SameSite=Strict; Path=/");
    return { ok: true };
  });

  app.delete("/v1/session", async (_req, reply) => {
    reply.header("set-cookie", "avity_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return { ok: true };
  });

  // ── projects ─────────────────────────────────────────────────────────────

  app.post("/v1/projects", async (req, reply) => {
    const body = parse(CreateProjectRequest, req.body);
    if (body.idempotencyKey) {
      const existing = store.findIdempotent(body.idempotencyKey);
      if (existing) {
        if (existing.resourceType !== "project") {
          return apiError(reply, 409, "conflict", "idempotency key is already used by another resource");
        }
        const project = store.getProject(existing.resourceId);
        if (!project) {
          return apiError(reply, 409, "conflict", "idempotency key references a missing project");
        }
        const objective = store.latestObjective(project.id);
        const clarificationId = objective
          ? store.listClarifications(project.id, "open").find((item) => item.objectiveId === objective.id)?.id ?? null
          : null;
        return reply.status(200).send({ ...project, clarificationId });
      }
    }
    const repository = await validateRepositoryConfiguration({
      repoPath: body.repoPath,
      repoRemoteUrl: body.repoRemoteUrl,
      defaultBranch: body.defaultBranch,
    });
    if (!body.objective && body.acceptanceCriteria.length > 0) {
      throw new ProjectValidationError("acceptance criteria require a non-empty objective");
    }
    const configuration = store.createOnboardedProject({
      name: body.name,
      description: body.description,
      ...repository,
      autonomyProfile: body.autonomyProfile,
      objective: body.objective,
      acceptanceCriteria: body.acceptanceCriteria,
      budgetUsd: body.budgetUsd,
      budgetWarnAtFraction: body.budgetWarnAtFraction,
    });
    const project = configuration.project;
    if (body.idempotencyKey) store.recordIdempotent(body.idempotencyKey, "project", project.id);
    const analysis = configuration.objective
      ? engine.analyzeObjective(project.id, configuration.objective.id)
      : { clarificationId: null };
    return reply.status(201).send({ ...store.getProject(project.id)!, ...analysis });
  });

  app.get("/v1/projects", async () => ({ items: store.listProjects() }));

  app.get("/v1/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = store.getProject(id);
    if (!project) return apiError(reply, 404, "not_found", `project ${id} not found`);
    return project;
  });

  app.get("/v1/projects/:id/configuration", async (req, reply) => {
    const { id } = req.params as { id: string };
    const configuration = store.getProjectConfiguration(id);
    if (!configuration) return apiError(reply, 404, "not_found", `project ${id} not found`);
    return configuration;
  });

  app.patch("/v1/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = store.getProjectConfiguration(id);
    if (!existing) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const body = parse(UpdateProjectRequest, req.body);
    const repoPath = body.repoPath !== undefined ? body.repoPath : existing.project.repoPath;
    const repoRemoteUrl = body.repoPath === null
      ? null
      : body.repoRemoteUrl !== undefined
        ? body.repoRemoteUrl
        : existing.project.repoRemoteUrl;
    const repository = await validateRepositoryConfiguration({
      repoPath,
      repoRemoteUrl,
      defaultBranch: body.defaultBranch ?? existing.project.defaultBranch,
    });
    const objective = body.objective ?? existing.objective?.text ?? "";
    const acceptanceCriteria = body.acceptanceCriteria ?? existing.objective?.acceptanceCriteria ?? [];
    if (!objective && acceptanceCriteria.length > 0) {
      throw new ProjectValidationError("acceptance criteria require a non-empty objective");
    }
    const budgetUsd = body.budgetUsd !== undefined ? body.budgetUsd : existing.budget?.limitUsd ?? null;
    if (budgetUsd === null && body.budgetWarnAtFraction !== undefined) {
      throw new ProjectValidationError("budget warning threshold requires a project budget");
    }

    const objectiveChanged =
      Boolean(objective) &&
      (existing.objective?.text !== objective ||
        JSON.stringify(existing.objective?.acceptanceCriteria ?? []) !== JSON.stringify(acceptanceCriteria));
    if (objectiveChanged) {
      const safelyCancellableStates = new Set(["proposed", "ready", "paused", "blocked"]);
      const stalePlanMissions = store.listMissions(id).filter(
        (mission) =>
          mission.planId !== null &&
          !["completed", "cancelled"].includes(mission.state),
      );
      const inFlight = stalePlanMissions.filter((mission) => !safelyCancellableStates.has(mission.state));
      if (inFlight.length > 0) {
        return apiError(
          reply,
          409,
          "conflict",
          `objective cannot be revised while missions are in flight or awaiting a decision: ${inFlight
            .map((mission) => `${mission.id} (${mission.state})`)
            .join(", ")}`,
        );
      }
      for (const mission of stalePlanMissions) {
        store.transitionMission(mission.id, "cancelled", "superseded by objective revision", "user");
      }
    }

    const updated = store.updateProjectConfiguration(id, {
      name: body.name ?? existing.project.name,
      description: body.description ?? existing.project.description,
      ...repository,
      objective,
      acceptanceCriteria,
      autonomyProfile: body.autonomyProfile ?? existing.project.autonomyProfile,
      budgetUsd,
      budgetWarnAtFraction: body.budgetWarnAtFraction ?? existing.budget?.warnAtFraction ?? 0.8,
    });
    if (updated.objective?.id !== existing.objective?.id && updated.objective) {
      engine.analyzeObjective(id, updated.objective.id);
      return store.getProjectConfiguration(id);
    }
    return updated;
  });

  app.get("/v1/projects/:id/brain", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    return { items: store.listBrainEntries(id) };
  });

  /**
   * Really persisted state of the AI planning pipeline: durable brain runs
   * (provider, model, provenance, errors), validated analysis/architecture,
   * active plan version and replanning history. Nothing here is optimistic.
   */
  app.get("/v1/projects/:id/brain/state", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = store.getProject(id);
    if (!project) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const objective = store.latestObjective(id);
    const runs = objective ? store.listBrainRuns(id, objective.id) : [];
    const activePlan = store.activePlan(id);
    const planForObjective =
      activePlan && objective && activePlan.objectiveId === objective.id ? activePlan : null;

    const latestOutput = (step: string): unknown => {
      for (let i = runs.length - 1; i >= 0; i -= 1) {
        const run = runs[i]!;
        if (run.step === step && run.state === "succeeded") return run.output;
      }
      return null;
    };

    let status: "idle" | "clarifying" | "running" | "planned" | "blocked" | "failed" | "paused" = "idle";
    if (objective) {
      if (project.status === "paused") status = "paused";
      else if (project.status === "clarifying") status = "clarifying";
      else if (planForObjective) status = "planned";
      else if (runs.some((run) => run.state === "running") || project.status === "planning") status = "running";
      else if (project.status === "blocked") status = "blocked";
      else if (runs.some((run) => run.state === "failed")) status = "failed";
    }

    const replans = store.listPlans(id).filter((plan) => plan.replanTrigger !== null);
    const lastReplanPlan = replans.at(-1) ?? null;
    return {
      projectId: id,
      objectiveId: objective?.id ?? null,
      status,
      currentStep: runs.at(-1)?.step ?? null,
      runs,
      analysis: latestOutput("analysis"),
      architecture: latestOutput("architecture"),
      plan: planForObjective,
      dependencies: store.listDependencies(id),
      replanCount: replans.length,
      clarificationRound: objective ? store.clarificationRoundCount(id, objective.id) : 0,
      lastReplan: lastReplanPlan
        ? {
            trigger: lastReplanPlan.replanTrigger!,
            cause: lastReplanPlan.replanCause ?? "",
            sources: lastReplanPlan.replanSources,
            planVersion: lastReplanPlan.version,
          }
        : null,
    };
  });

  app.get("/v1/projects/:id/usage", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    return { ...store.usageSummary(id), budget: store.getBudget(id) };
  });

  // ── objectives & clarifications ──────────────────────────────────────────

  app.post("/v1/projects/:id/objectives", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const body = parse(SubmitObjectiveRequest, req.body);
    if (body.idempotencyKey) {
      const existing = store.findIdempotent(body.idempotencyKey);
      if (existing) return reply.status(200).send(store.getObjective(existing.resourceId));
    }
    const objective = store.createObjective(id, body.text, body.acceptanceCriteria);
    if (body.idempotencyKey) store.recordIdempotent(body.idempotencyKey, "objective", objective.id);
    const analysis = engine.analyzeObjective(id, objective.id);
    return reply.status(201).send({ objective: store.getObjective(objective.id), ...analysis });
  });

  app.get("/v1/projects/:id/clarifications", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const { status } = req.query as { status?: string };
    return { items: store.listClarifications(id, status) };
  });

  app.get("/v1/clarifications/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const clarification = store.getClarification(id);
    if (!clarification) return apiError(reply, 404, "not_found", `clarification ${id} not found`);
    return clarification;
  });

  app.post("/v1/clarifications/:id/answers", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = store.getClarification(id);
    if (!existing) return apiError(reply, 404, "not_found", `clarification ${id} not found`);
    const project = store.getProject(existing.projectId);
    if (project?.status === "paused") {
      return apiError(reply, 409, "project_paused", `project ${existing.projectId} is paused`);
    }
    if (project && !["clarifying", "planning", "draft", "blocked"].includes(project.status) && existing.status === "open") {
      // Answering is allowed while clarifying; refuse incompatible active execution states.
      if (project.status === "active" && existing.status !== "open") {
        return apiError(
          reply,
          409,
          "conflict",
          `project ${existing.projectId} is ${project.status} and cannot accept clarification answers`,
        );
      }
    }
    const body = parse(AnswerClarificationRequest, req.body);
    const wasOpen = existing.status === "open";
    const updated = store.answerClarification(id, body.answers, { idempotencyKey: body.idempotencyKey });
    if (wasOpen && updated.status === "answered") {
      engine.resumeAfterClarification(id);
    }
    return updated;
  });

  app.get("/v1/projects/:id/pause", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    return store.getProjectPauseState(id);
  });

  app.post("/v1/projects/:id/pause", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const body = parse(PauseProjectRequest, req.body ?? {});
    const state = await engine.pauseProject(id, {
      reason: body.reason,
      actor: "user",
      idempotencyKey: body.idempotencyKey,
    });
    return state;
  });

  app.post("/v1/projects/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const body = parse(ResumeProjectRequest, req.body ?? {});
    const state = await engine.resumeProject(id, {
      actor: "user",
      idempotencyKey: body.idempotencyKey,
    });
    return state;
  });

  // ── plans & missions ─────────────────────────────────────────────────────

  app.get("/v1/projects/:id/plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const plan = store.activePlan(id);
    if (!plan) return apiError(reply, 404, "not_found", "no active plan");
    return { plan, dependencies: store.listDependencies(id) };
  });

  app.get("/v1/projects/:id/missions", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    return { items: store.listMissions(id) };
  });

  app.post("/v1/projects/:id/missions", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const body = parse(CreateMissionRequest, req.body);
    if (body.idempotencyKey) {
      const existing = store.findIdempotent(body.idempotencyKey);
      if (existing) return reply.status(200).send(store.getMission(existing.resourceId));
    }
    const mission = store.createMission({
      projectId: id,
      planId: body.planId,
      milestoneId: body.milestoneId,
      title: body.title,
      role: body.role,
      contract: body.contract,
      priority: body.priority,
      dependsOn: body.dependsOn,
    });
    if (body.idempotencyKey) store.recordIdempotent(body.idempotencyKey, "mission", mission.id);
    return reply.status(201).send(mission);
  });

  app.get("/v1/missions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const mission = store.getMission(id);
    if (!mission) return apiError(reply, 404, "not_found", `mission ${id} not found`);
    return {
      mission,
      checkpoints: store.listCheckpoints(id),
      runs: store.listRuns({ missionId: id }),
    };
  });

  app.post("/v1/missions/:id/transition", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getMission(id)) return apiError(reply, 404, "not_found", `mission ${id} not found`);
    const body = parse(TransitionMissionRequest, req.body);
    if (body.to === "cancelled") {
      await engine.cancelMission(id);
      return store.getMission(id);
    }
    return store.transitionMission(id, body.to, body.reason, "user");
  });

  // ── runs ─────────────────────────────────────────────────────────────────

  app.get("/v1/runs", async (req) => {
    const { projectId, missionId } = req.query as { projectId?: string; missionId?: string };
    const filter: { projectId?: string; missionId?: string } = {};
    if (projectId) filter.projectId = projectId;
    if (missionId) filter.missionId = missionId;
    return { items: store.listRuns(filter) };
  });

  app.get("/v1/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = store.getRun(id);
    if (!run) return apiError(reply, 404, "not_found", `run ${id} not found`);
    return run;
  });

  app.get("/v1/runs/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getRun(id)) return apiError(reply, 404, "not_found", `run ${id} not found`);
    return { items: store.runLogs(id) };
  });

  // ── approvals ────────────────────────────────────────────────────────────

  app.get("/v1/approvals", async (req) => {
    const { status, projectId } = req.query as { status?: string; projectId?: string };
    return { items: store.listApprovals(status, projectId) };
  });

  app.post("/v1/approvals/:id/resolve", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getApproval(id)) return apiError(reply, 404, "not_found", `approval ${id} not found`);
    const body = parse(ResolveApprovalRequest, req.body);
    const approval = store.resolveApproval(id, body.decision, body.note);
    engine.applyApprovalDecision(id);
    return approval;
  });

  // ── events ───────────────────────────────────────────────────────────────

  app.get("/v1/events", async (req) => {
    const query = parse(EventStreamQuery, req.query);
    return { items: store.eventsAfter(query.afterSeq, query.projectId) };
  });

  app.get("/v1/events/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    const query = parse(EventStreamQuery, req.query);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n"); // flush headers immediately

    const send = (ev: EventEnvelope) => {
      if (query.projectId && ev.projectId !== query.projectId) return;
      reply.raw.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    };

    // replay missed events, then stream live — reconnection-safe by seq
    for (const ev of store.eventsAfter(query.afterSeq, query.projectId)) send(ev);
    store.emitter.on("event", send);
    const keepalive = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);

    req.raw.on("close", () => {
      store.emitter.off("event", send);
      clearInterval(keepalive);
    });
    await new Promise(() => undefined); // hold the connection open
  });

  // ── terminal sessions ────────────────────────────────────────────────────

  const commandPolicy = opts.commandPolicy ?? DEFAULT_COMMAND_POLICY;
  const missionCommandPolicy = opts.missionCommandPolicy ?? DEFAULT_MISSION_COMMAND_POLICY;
  const TerminalCreate = z.object({
    command: z.array(z.string().min(1)).min(1),
    /** Optional mission binding: cwd becomes the mission worktree. */
    missionId: z.string().nullable().default(null),
    runId: z.string().nullable().default(null),
  });

  /**
   * The execution cwd is NEVER taken from the client. It resolves
   * server-side to the mission worktree (mission terminals) or the
   * project repository root (project terminals), with realpath containment
   * so symlinked paths cannot escape.
   */
  function resolveTerminalCwd(
    projectId: string,
    missionId: string | null,
  ): { cwd: string } | { error: string } {
    const project = store.getProject(projectId);
    if (!project) return { error: `project ${projectId} not found` };
    if (missionId) {
      const mission = store.getMission(missionId);
      if (!mission || mission.projectId !== projectId) {
        return { error: `mission ${missionId} not found in project ${projectId}` };
      }
      if (!mission.worktreePath) return { error: `mission ${missionId} has no worktree` };
      const resolved = safeRealpath(mission.worktreePath);
      if (!resolved) return { error: "mission worktree does not exist" };
      const repoRoot = project.repoPath ? safeRealpath(project.repoPath) : null;
      // worktrees live under <repo>/.avity/worktrees; a symlinked worktree
      // resolving elsewhere is rejected.
      if (repoRoot && resolved !== repoRoot && !resolved.startsWith(`${repoRoot}/`)) {
        return { error: "mission worktree escapes the project repository" };
      }
      return { cwd: resolved };
    }
    if (!project.repoPath) return { error: "project has no repository; terminals require one" };
    const resolved = safeRealpath(project.repoPath);
    if (!resolved) return { error: "project repository path does not exist" };
    return { cwd: resolved };
  }

  app.post("/v1/projects/:id/terminals", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const body = parse(TerminalCreate, req.body);

    const policy = body.missionId ? missionCommandPolicy : commandPolicy;
    const verdict = isCommandAllowed(policy, body.command);
    store.appendEvent("policy.decision", { projectId: id, missionId: body.missionId }, {
      action: "terminal.spawn",
      resource: body.command.join(" "),
      effect: verdict.effect,
      reason: verdict.reason,
    });
    if (verdict.effect !== "allow") {
      store.appendAudit(id, "policy", "terminal.denied", `${body.command.join(" ")}: ${verdict.reason}`);
      return apiError(reply, 403, "policy_denied", verdict.reason);
    }

    const resolved = resolveTerminalCwd(id, body.missionId);
    if ("error" in resolved) {
      store.appendAudit(id, "policy", "terminal.denied", `cwd resolution: ${resolved.error}`);
      return apiError(reply, 403, "policy_denied", resolved.error);
    }

    store.appendAudit(id, "user", "terminal.create", `${body.command.join(" ")} @ ${resolved.cwd}`);
    return reply.status(201).send(store.createTerminal(id, body.command, resolved.cwd, body.runId));
  });

  app.get("/v1/terminals", async (req) => {
    const { projectId } = req.query as { projectId?: string };
    return { items: store.listTerminals(projectId) };
  });

  app.get("/v1/terminals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const terminal = store.getTerminal(id);
    if (!terminal) return apiError(reply, 404, "not_found", `terminal ${id} not found`);
    return { ...terminal, logs: store.terminalLogs(id) };
  });

  app.post("/v1/terminals/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const terminal = store.getTerminal(id);
    if (!terminal) return apiError(reply, 404, "not_found", `terminal ${id} not found`);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(terminal.state)) return terminal;
    store.setTerminalState(id, "cancelling");
    return store.getTerminal(id);
  });

  function requireWorker(req: FastifyRequest, reply: FastifyReply): string | null {
    const workerId = (req.headers["x-worker-id"] as string) ?? "";
    const token = (req.headers["x-worker-token"] as string) ?? "";
    const row = store.db.prepare("SELECT token_hash, status FROM workers WHERE id = ?").get(workerId) as
      | { token_hash: string; status: string }
      | undefined;
    if (!row || row.token_hash !== sha256(token) || row.status === "revoked") {
      void apiError(reply, 401, "policy_denied", "invalid worker credentials");
      return null;
    }
    return workerId;
  }

  app.post("/v1/workers/lease", async (req, reply) => {
    const workerId = requireWorker(req, reply);
    if (!workerId) return;
    store.heartbeatWorker(workerId);
    const lease = store.leaseTerminal(workerId);
    return { lease };
  });

  app.post("/v1/terminals/:id/output", async (req, reply) => {
    const workerId = requireWorker(req, reply);
    if (!workerId) return;
    const { id } = req.params as { id: string };
    const terminal = store.getTerminal(id);
    if (!terminal) return apiError(reply, 404, "not_found", `terminal ${id} not found`);
    if (terminal.workerId !== workerId) return apiError(reply, 403, "policy_denied", "terminal leased to another worker");
    const body = parse(z.object({ text: z.string(), leaseToken: z.string().min(16) }), req.body);
    if (!store.validateTerminalLease(id, workerId, body.leaseToken)) {
      return apiError(reply, 409, "conflict", "expired or invalid terminal lease");
    }
    if (terminal.state === "starting") store.setTerminalState(id, "running");
    store.appendTerminalLog(id, body.text);
    return { ok: true, cancelRequested: store.getTerminal(id)!.state === "cancelling" };
  });

  app.post("/v1/terminals/:id/exit", async (req, reply) => {
    const workerId = requireWorker(req, reply);
    if (!workerId) return;
    const { id } = req.params as { id: string };
    const terminal = store.getTerminal(id);
    if (!terminal) return apiError(reply, 404, "not_found", `terminal ${id} not found`);
    if (terminal.workerId !== workerId) return apiError(reply, 403, "policy_denied", "terminal leased to another worker");
    const body = parse(
      z.object({
        exitCode: z.number().int().nullable(),
        state: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
        leaseToken: z.string().min(16),
      }),
      req.body,
    );
    if (!store.validateTerminalLease(id, workerId, body.leaseToken)) {
      return apiError(reply, 409, "conflict", "expired or invalid terminal lease");
    }
    store.setTerminalState(id, body.state, body.exitCode);
    return { ok: true };
  });

  // ── workers ──────────────────────────────────────────────────────────────

  app.post("/v1/workers/enroll", async (req, reply) => {
    const body = parse(EnrollWorkerRequest, req.body);
    const id = newId("wrk");
    const token = randomBytes(24).toString("hex");
    const ts = now();
    store.db
      .prepare(
        `INSERT INTO workers (id, name, status, capabilities, max_concurrent_runs, token_hash, created_at, updated_at)
         VALUES (?, ?, 'online', ?, ?, ?, ?, ?)`,
      )
      .run(id, body.name, JSON.stringify(body.capabilities), body.maxConcurrentRuns, sha256(token), ts, ts);
    store.appendEvent("worker.status_changed", {}, { workerId: id, status: "online" });
    store.appendAudit(null, "user", "worker.enroll", `${body.name} (${id})`);
    // The token is returned exactly once and stored only as a hash.
    return reply.status(201).send({ id, name: body.name, token });
  });

  app.get("/v1/workers", async () => {
    const rows = store.db.prepare("SELECT id, name, status, capabilities, last_heartbeat_at, max_concurrent_runs, created_at, updated_at FROM workers").all() as Record<string, unknown>[];
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        capabilities: JSON.parse(r.capabilities as string),
        lastHeartbeatAt: r.last_heartbeat_at ?? null,
        maxConcurrentRuns: r.max_concurrent_runs,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.post("/v1/workers/:id/heartbeat", async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = (req.headers["x-worker-token"] as string) ?? "";
    const row = store.db.prepare("SELECT token_hash, status FROM workers WHERE id = ?").get(id) as
      | { token_hash: string; status: string }
      | undefined;
    if (!row) return apiError(reply, 404, "not_found", `worker ${id} not found`);
    if (row.token_hash !== sha256(auth)) return apiError(reply, 401, "policy_denied", "invalid worker token");
    if (row.status === "revoked") return apiError(reply, 403, "policy_denied", "worker is revoked");
    store.db.prepare("UPDATE workers SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
    return { ok: true };
  });

  app.post("/v1/workers/:id/revoke", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = store.db.prepare("SELECT id FROM workers WHERE id = ?").get(id);
    if (!row) return apiError(reply, 404, "not_found", `worker ${id} not found`);
    store.db.prepare("UPDATE workers SET status = 'revoked', updated_at = ? WHERE id = ?").run(now(), id);
    store.revokeWorkerLeases(id);
    store.appendEvent("worker.status_changed", {}, { workerId: id, status: "revoked" });
    store.appendAudit(null, "user", "worker.revoke", id);
    return { ok: true };
  });

  // ── providers ────────────────────────────────────────────────────────────

  app.get("/v1/providers", async () => {
    const items = [];
    for (const [name, adapter] of engine.providers) {
      items.push({
        name,
        contractVersion: adapter.contractVersion,
        capabilities: adapter.capabilities(),
        healthy: await adapter.healthy(),
        models: await adapter.listModels(),
        default: name === engine.defaultProvider,
      });
    }
    return { items };
  });

  // ── pull requests ────────────────────────────────────────────────────────

  const PrCreate = z.object({
    missionId: z.string().nullable().default(null),
    branch: z.string().min(1),
    title: z.string().min(1),
    state: z.enum(["draft", "open", "merged", "closed"]).default("open"),
    number: z.number().int().nullable().default(null),
    url: z.string().url().nullable().default(null),
  });

  app.post("/v1/projects/:id/prs", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const body = parse(PrCreate, req.body);
    return reply.status(201).send(store.recordPullRequest({ projectId: id, ...body }));
  });

  app.get("/v1/prs", async (req) => {
    const { projectId } = req.query as { projectId?: string };
    return { items: store.listPullRequests(projectId) };
  });

  app.get("/v1/prs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pr = store.getPullRequest(id);
    if (!pr) return apiError(reply, 404, "not_found", `pull request ${id} not found`);
    return pr;
  });

  // ── audit ────────────────────────────────────────────────────────────────

  app.get("/v1/audit", async (req) => {
    const { limit } = req.query as { limit?: string };
    const rows = store.db
      .prepare("SELECT * FROM audit_entries ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(Math.min(Number(limit ?? 100), 500)) as Record<string, unknown>[];
    return { items: rows, chainValid: store.verifyAuditChain() };
  });

  return app;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

/** realpath that returns null instead of throwing (missing path). */
function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
