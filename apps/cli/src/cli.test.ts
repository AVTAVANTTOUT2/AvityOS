import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Engine, openDatabase, Store, buildServer, DEFAULT_ENGINE_CONFIG } from "@avityos/control-plane";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";

// Point the CLI at an isolated config before importing it.
const configDir = mkdtempSync(join(tmpdir(), "avity-cli-"));
process.env.AVITY_CONFIG = join(configDir, "cli.json");
process.env.AVITY_DISABLE_KEYCHAIN = "1";

const { main } = await import("./main.js");
const { CONFIG_PATH, loadConfig, saveConfig } = await import("./client.js");

let app: FastifyInstance;
let store: Store;
let engine: Engine;

let stdout: string[] = [];
let stderr: string[] = [];

function captureOutput(): void {
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void stderr.push(args.join(" ")));
}

beforeAll(async () => {
  const db = openDatabase(":memory:");
  store = new Store(db);
  const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
  engine = new Engine(store, providers, { ...DEFAULT_ENGINE_CONFIG, tickMs: 30 });
  engine.start();
  app = await buildServer({ store, engine, version: "test" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  saveConfig({ controlPlaneUrl: `http://127.0.0.1:${port}` });
});

afterAll(async () => {
  await engine.stop();
  await app.close();
});

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  captureOutput();
  const code = await main(argv);
  vi.restoreAllMocks();
  return { code, out: stdout.join("\n"), err: stderr.join("\n") };
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("waitFor timed out");
}

describe("avity CLI", () => {
  it("stores fallback config with owner-only permissions", () => {
    const previous = loadConfig();
    saveConfig({ ...previous, apiToken: "test-token" });
    expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).apiToken).toBe("test-token");
    saveConfig(previous);
  });

  it("shows usage and exits 2 for unknown commands", async () => {
    expect((await run()).code).toBe(2);
    expect((await run("nonsense")).code).toBe(2);
    expect((await run("help")).code).toBe(0);
  });

  it("doctor reports healthy environment", async () => {
    const { code, out } = await run("doctor");
    expect(code).toBe(0);
    expect(out).toContain("control plane reachable");
  });

  it("drives a project from creation to completion", async () => {
    const created = await run("project", "create", "CLI Demo", "--json");
    expect(created.code).toBe(0);
    const project = JSON.parse(created.out) as { id: string };

    const submitted = await run(
      "objective", "submit", project.id,
      "Deliver the demo feature completely with tests and documentation evidence",
      "feature works end to end",
      "--json",
    );
    expect(submitted.code).toBe(0);

    await waitFor(() => store.getProject(project.id)?.status === "completed");

    const missions = await run("mission", "list", project.id, "--json");
    const items = JSON.parse(missions.out) as { state: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((m) => m.state === "completed")).toBe(true);

    const runsOut = await run("run", "list", "--project", project.id, "--json");
    expect((JSON.parse(runsOut.out) as unknown[]).length).toBeGreaterThan(0);

    const status = await run("status");
    expect(status.code).toBe(0);
    expect(status.out).toContain("projects:");
  });

  it("lists providers and workers, enrolls and revokes", async () => {
    const providers = await run("provider", "list", "--json");
    expect(JSON.parse(providers.out)[0].name).toBe("fake");

    const enrolled = await run("worker", "enroll", "test-worker", "--json");
    const worker = JSON.parse(enrolled.out) as { id: string; token: string };
    expect(worker.token.length).toBeGreaterThan(20);

    const revoked = await run("worker", "revoke", worker.id);
    expect(revoked.code).toBe(0);

    const list = await run("worker", "list", "--json");
    const listed = JSON.parse(list.out) as { id: string; status: string }[];
    expect(listed.find((w) => w.id === worker.id)?.status).toBe("revoked");
  });

  it("answers clarifications through intervention answer", async () => {
    const created = await run("project", "create", "Vague CLI", "--json");
    const project = JSON.parse(created.out) as { id: string };
    const submitted = await run("objective", "submit", project.id, "make something, maybe", "--json");
    const { clarificationId } = JSON.parse(submitted.out) as { clarificationId: string };
    expect(clarificationId).toBeTruthy();

    const answered = await run(
      "intervention", "answer", clarificationId,
      "q_acceptance=The CLI demo passes", "q_scope=nothing else",
    );
    expect(answered.code).toBe(0);
    await waitFor(() => store.getProject(project.id)?.status === "completed");
  });

  it("surfaces API errors with exit code 1", async () => {
    const missing = await run("project", "show", "prj_does_not_exist");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("not_found");
  });
});
