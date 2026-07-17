import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, openDatabase, Store, buildServer, DEFAULT_ENGINE_CONFIG } from "@avityos/control-plane";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import type { FastifyInstance } from "fastify";
import { runCommand } from "./runner.js";
import { WorkerAgent } from "./agent.js";

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

describe("runner", () => {
  it("streams output and reports success", async () => {
    const output: string[] = [];
    let result: { exitCode: number | null; state: string } | null = null;
    const handle = runCommand(["echo", "hello worker"], process.cwd(), {
      onOutput: (t) => void output.push(t),
      onExit: (r) => {
        result = r;
      },
    });
    await handle.done;
    expect(output.join("")).toContain("hello worker");
    expect(result).toEqual({ exitCode: 0, state: "succeeded" });
  });

  it("cancel kills the whole process group", async () => {
    let result: { exitCode: number | null; state: string } | null = null;
    const handle = runCommand(["sleep", "30"], process.cwd(), {
      onOutput: () => undefined,
      onExit: (r) => {
        result = r;
      },
    });
    const pid = handle.pid!;
    await new Promise((r) => setTimeout(r, 100));
    handle.cancel();
    await handle.done;
    expect(result!.state).toBe("cancelled");
    // the process must actually be gone
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it("times out long commands", async () => {
    let result: { exitCode: number | null; state: string } | null = null;
    const handle = runCommand(
      ["sleep", "30"],
      process.cwd(),
      { onOutput: () => undefined, onExit: (r) => { result = r; } },
      { timeoutMs: 150 },
    );
    await handle.done;
    expect(result!.state).toBe("timed_out");
  });
});

describe("worker <-> control plane integration", () => {
  let app: FastifyInstance;
  let store: Store;
  let engine: Engine;
  let baseUrl: string;
  let agent: WorkerAgent | null = null;

  beforeEach(async () => {
    const db = openDatabase(":memory:");
    store = new Store(db);
    const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
    engine = new Engine(store, providers, { ...DEFAULT_ENGINE_CONFIG, tickMs: 50 });
    app = await buildServer({ store, engine, version: "test" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(async () => {
    if (agent) await agent.stop();
    agent = null;
    await engine.stop();
    await app.close();
  });

  function makeProject(): string {
    return store.createProject({
      name: "term-test",
      description: "",
      repoPath: null,
      repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    }).id;
  }

  it("enrolls, leases a terminal, streams output and reports exit", async () => {
    const projectId = makeProject();
    agent = new WorkerAgent({ controlPlaneUrl: baseUrl, name: "w1", pollMs: 50, capabilities: ["shell"] });
    await agent.enroll();
    agent.start();

    const created = store.createTerminal(projectId, ["echo", "streamed via worker"], process.cwd());
    await waitFor(() => store.getTerminal(created.id)!.state === "succeeded", 5000);

    const terminal = store.getTerminal(created.id)!;
    expect(terminal.exitCode).toBe(0);
    expect(terminal.workerId).toBe(agent.workerId);
    expect(store.terminalLogs(created.id).map((l) => l.text).join("")).toContain("streamed via worker");
  });

  it("scenario 7: forbidden command is denied and audited", async () => {
    const projectId = makeProject();
    const res = await fetch(`${baseUrl}/v1/projects/${projectId}/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: ["rm", "-rf", "/"], cwd: "/tmp" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("policy_denied");

    // denial is recorded in both the event log and the audit chain
    const events = store.eventsAfter(0, projectId);
    const decision = events.find((e) => e.type === "policy.decision");
    expect(decision?.payload.effect).toBe("deny");
    const audit = store.db
      .prepare("SELECT * FROM audit_entries WHERE action = 'terminal.denied'")
      .all() as unknown as { detail: string }[];
    expect(audit.length).toBe(1);
    expect(store.verifyAuditChain()).toBe(true);
    // and nothing was queued
    expect(store.listTerminals(projectId)).toEqual([]);
  });

  it("cancelling a running terminal kills the child process", async () => {
    const projectId = makeProject();
    agent = new WorkerAgent({ controlPlaneUrl: baseUrl, name: "w2", pollMs: 50, capabilities: ["shell"] });
    await agent.enroll();
    agent.start();

    // sleep with periodic output so the worker sees cancelRequested acks
    const created = store.createTerminal(projectId, ["node", "-e", "setInterval(()=>console.log('tick'),100); setTimeout(()=>process.exit(0),30000)"], process.cwd());
    await waitFor(() => store.getTerminal(created.id)!.state === "running", 5000);

    await fetch(`${baseUrl}/v1/terminals/${created.id}/cancel`, { method: "POST" });
    await waitFor(() => store.getTerminal(created.id)!.state === "cancelled", 5000);
    expect(store.getTerminal(created.id)!.state).toBe("cancelled");
  });

  it("rejects workers with bad credentials", async () => {
    const res = await fetch(`${baseUrl}/v1/workers/lease`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-id": "wrk_nope", "x-worker-token": "bad" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
