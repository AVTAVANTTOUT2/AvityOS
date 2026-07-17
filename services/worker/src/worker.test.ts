import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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

  it("denies writes outside the sandboxed mission workspace", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "avity-runner-sandbox-"));
    const workspace = join(scratch, "workspace");
    const outside = join(scratch, "outside.txt");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    let state = "";
    const handle = runCommand(
      ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(outside)}, 'escape')`],
      workspace,
      { onOutput: () => undefined, onExit: (result) => { state = result.state; } },
    );
    await handle.done;
    expect(state).toBe("failed");
    expect(existsSync(outside)).toBe(false);
    await rm(scratch, { recursive: true, force: true });
  });

  it("denies reading secrets outside the sandboxed mission workspace", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "avity-runner-workspace-"));
    const secretHome = await mkdtemp(join(homedir(), ".avity-runner-secret-"));
    const workspace = join(scratch, "workspace");
    const secret = join(secretHome, "control-plane-token");
    await mkdir(workspace);
    await writeFile(secret, "never-expose-this-value");
    const output: string[] = [];
    const handle = runCommand(
      [process.execPath, "-e", `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(secret)}, 'utf8'))`],
      workspace,
      {
        onOutput: (text) => output.push(text),
        onExit: () => undefined,
      },
    );
    await handle.done;
    expect(output.join("")).not.toContain("never-expose-this-value");
    await rm(scratch, { recursive: true, force: true });
    await rm(secretHome, { recursive: true, force: true });
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
    agent = new WorkerAgent({ controlPlaneUrl: baseUrl, name: "w2", pollMs: 50, capabilities: ["shell", "node"] });
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

  it("leases only compatible work within worker capacity and fences stale tokens", () => {
    const projectId = makeProject();
    const ts = new Date().toISOString();
    const insertWorker = (id: string, capabilities: string[], max = 1) => {
      store.db.prepare(
        `INSERT INTO workers (id, name, status, capabilities, max_concurrent_runs, token_hash, created_at, updated_at)
         VALUES (?, ?, 'online', ?, ?, 'hash', ?, ?)`,
      ).run(id, id, JSON.stringify(capabilities), max, ts, ts);
    };
    insertWorker("shell-only", ["shell"]);
    insertWorker("node-worker", ["shell", "node"]);

    const nodeTerminal = store.createTerminal(projectId, ["node", "-e", "process.exit(0)"], process.cwd());
    expect(store.leaseTerminal("shell-only")).toBeNull();
    const lease = store.leaseTerminal("node-worker")!;
    expect(lease.id).toBe(nodeTerminal.id);
    expect(store.validateTerminalLease(lease.id, "node-worker", "wrong-token")).toBe(false);
    expect(store.validateTerminalLease(lease.id, "node-worker", lease.leaseToken)).toBe(true);

    store.createTerminal(projectId, ["echo", "queued"], process.cwd());
    expect(store.leaseTerminal("node-worker")).toBeNull(); // maxConcurrentRuns = 1
    store.revokeWorkerLeases("node-worker");
    expect(store.getTerminal(nodeTerminal.id)!.state).toBe("queued");
    expect(store.validateTerminalLease(lease.id, "node-worker", lease.leaseToken)).toBe(false);
  });

  it("uses the admin bearer only for enrollment, then worker-scoped credentials", async () => {
    const secureDb = openDatabase(":memory:");
    const secureStore = new Store(secureDb);
    const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
    const secureEngine = new Engine(secureStore, providers, { ...DEFAULT_ENGINE_CONFIG, tickMs: 50 });
    const secureApp = await buildServer({ store: secureStore, engine: secureEngine, version: "test", apiToken: "admin-token" });
    await secureApp.listen({ port: 0, host: "127.0.0.1" });
    const address = secureApp.server.address();
    const secureUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const secureAgent = new WorkerAgent({
      controlPlaneUrl: secureUrl,
      name: "secure-worker",
      pollMs: 30,
      capabilities: ["shell"],
      apiToken: "admin-token",
    });
    try {
      expect((await fetch(`${secureUrl}/v1/workers/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "denied" }) })).status).toBe(401);
      await secureAgent.enroll();
      secureAgent.start();
      const project = secureStore.createProject({
        name: "secure", description: "", repoPath: null, repoRemoteUrl: null,
        autonomyProfile: "autonomous_with_checkpoints",
      });
      const terminal = secureStore.createTerminal(project.id, ["echo", "authenticated worker"], process.cwd());
      await waitFor(() => secureStore.getTerminal(terminal.id)!.state === "succeeded", 5000);
      expect(secureStore.terminalLogs(terminal.id).map((log) => log.text).join("")).toContain("authenticated worker");
    } finally {
      await secureAgent.stop();
      await secureEngine.stop();
      await secureApp.close();
      secureDb.close();
    }
  });
});

describe("worker transport policy", () => {
  it("refuses plaintext credentials to a non-loopback control plane", () => {
    expect(() => new WorkerAgent({
      controlPlaneUrl: "http://worker.example",
      name: "remote",
      pollMs: 1000,
      capabilities: ["shell"],
    })).toThrow(/require HTTPS/);
  });
});
