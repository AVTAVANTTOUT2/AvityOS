import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  AnswerClarificationRequest,
  CreateMissionRequest,
  CreateProjectRequest,
  EnrollWorkerRequest,
  EventStreamQuery,
  ResolveApprovalRequest,
  SubmitObjectiveRequest,
  TransitionMissionRequest,
  type ApiErrorCode,
  type EventEnvelope,
} from "@avityos/contracts";
import { IllegalTransitionError } from "@avityos/orchestration";
import { isCommandAllowed, type CommandPolicy } from "@avityos/policy";
import { createHash, randomBytes } from "node:crypto";
import type { Engine } from "./engine.js";
import { newId, now, type Store } from "./store.js";

export interface ServerOptions {
  store: Store;
  engine: Engine;
  apiToken?: string;
  version: string;
  commandPolicy?: CommandPolicy;
}

export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  allowedExecutables: ["git", "pnpm", "npm", "node", "ls", "echo", "cat", "pwd", "sleep"],
  deniedExecutables: ["rm", "sudo", "curl", "wget", "ssh", "scp"],
};

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
  await app.register(cors, { origin: true });
  const startedAt = Date.now();

  app.addHook("onRequest", async (req, reply) => {
    if (!opts.apiToken) return;
    if (req.url.startsWith("/v1/health")) return;
    const header = req.headers.authorization;
    if (header !== `Bearer ${opts.apiToken}`) {
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
    return apiError(reply, 500, "internal", err.message);
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

  // ── projects ─────────────────────────────────────────────────────────────

  app.post("/v1/projects", async (req, reply) => {
    const body = parse(CreateProjectRequest, req.body);
    if (body.idempotencyKey) {
      const existing = store.findIdempotent(body.idempotencyKey);
      if (existing) return reply.status(200).send(store.getProject(existing.resourceId));
    }
    const project = store.createProject({
      name: body.name,
      description: body.description,
      repoPath: body.repoPath,
      repoRemoteUrl: body.repoRemoteUrl,
      autonomyProfile: body.autonomyProfile,
    });
    if (body.idempotencyKey) store.recordIdempotent(body.idempotencyKey, "project", project.id);
    return reply.status(201).send(project);
  });

  app.get("/v1/projects", async () => ({ items: store.listProjects() }));

  app.get("/v1/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = store.getProject(id);
    if (!project) return apiError(reply, 404, "not_found", `project ${id} not found`);
    return project;
  });

  app.get("/v1/projects/:id/brain", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    return { items: store.listBrainEntries(id) };
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

  app.post("/v1/clarifications/:id/answers", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getClarification(id)) return apiError(reply, 404, "not_found", `clarification ${id} not found`);
    const body = parse(AnswerClarificationRequest, req.body);
    const updated = store.answerClarification(id, body.answers);
    engine.resumeAfterClarification(id);
    return updated;
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
      "access-control-allow-origin": "*",
    });

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
  const TerminalCreate = z.object({
    command: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1),
    runId: z.string().nullable().default(null),
  });

  app.post("/v1/projects/:id/terminals", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getProject(id)) return apiError(reply, 404, "not_found", `project ${id} not found`);
    const body = parse(TerminalCreate, req.body);

    const verdict = isCommandAllowed(commandPolicy, body.command);
    store.appendEvent("policy.decision", { projectId: id }, {
      action: "terminal.spawn",
      resource: body.command.join(" "),
      effect: verdict.effect,
      reason: verdict.reason,
    });
    if (verdict.effect !== "allow") {
      store.appendAudit(id, "policy", "terminal.denied", `${body.command.join(" ")}: ${verdict.reason}`);
      return apiError(reply, 403, "policy_denied", verdict.reason);
    }
    store.appendAudit(id, "user", "terminal.create", body.command.join(" "));
    return reply.status(201).send(store.createTerminal(id, body.command, body.cwd, body.runId));
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
    store.db.prepare("UPDATE workers SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), workerId);
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
    const body = parse(z.object({ text: z.string() }), req.body);
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
      z.object({ exitCode: z.number().int().nullable(), state: z.enum(["succeeded", "failed", "cancelled", "timed_out"]) }),
      req.body,
    );
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
    store.appendEvent("worker.status_changed", {}, { workerId: id, status: "revoked" });
    store.appendAudit(null, "user", "worker.revoke", id);
    return { ok: true };
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
