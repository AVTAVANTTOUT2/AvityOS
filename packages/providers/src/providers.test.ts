import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxedCommand } from "@avityos/policy";
import {
  AnthropicAdapter,
  CommandProviderAdapter,
  FakeProviderAdapter,
  normalizeHttpStatus,
  OpenAICompatibleAdapter,
  OpenAIResponsesAdapter,
  ProviderConfigError,
  type ProcessSpawner,
  type RunEvent,
  type SandboxLauncher,
} from "./index.js";

async function drain(events: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

/** The OS sandbox primitive AvityOS requires to run any CLI agent. */
const SANDBOX_AVAILABLE =
  (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) ||
  (process.platform === "linux" && ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].some(existsSync));

/**
 * Hermetic sandbox double for unit tests: builds the same env contract
 * (throwaway HOME, explicit allowlist, no process.env inheritance) without
 * requiring Bubblewrap or sandbox-exec. Production never uses this path.
 */
function hermeticSandbox(
  argv: readonly string[],
  _cwd: string,
  options: { env?: Record<string, string> } = {},
): SandboxedCommand {
  const [executable, ...args] = argv;
  if (!executable) throw new Error("empty command");
  const home = mkdtempSync(join(tmpdir(), "avity-hermetic-home-"));
  let cleaned = false;
  return {
    executable,
    args: [...args],
    home,
    env: {
      ...options.env,
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: home,
    },
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const hermeticRuntime = { sandbox: hermeticSandbox as SandboxLauncher };

async function runHermetic(
  config: ConstructorParameters<typeof CommandProviderAdapter>[1],
  cwd?: string,
): Promise<{ events: RunEvent[]; text: string }> {
  const adapter = new CommandProviderAdapter("sbx", config, hermeticRuntime);
  const events = await drain(
    adapter.startRun({
      runId: "r",
      model: "default",
      systemPrompt: "",
      userPrompt: "",
      ...(cwd ? { cwd } : {}),
    }).events,
  );
  const completed = events.find((e) => e.type === "completed") as
    | { resultText: string }
    | undefined;
  return { events, text: completed?.resultText ?? "" };
}

describe("fake provider", () => {
  it("succeeds deterministically", async () => {
    const fake = new FakeProviderAdapter();
    const run = fake.startRun({
      runId: "r1",
      model: "fake:succeed",
      systemPrompt: "",
      userPrompt: "build the thing",
    });
    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("emits scripted normalized failures", async () => {
    const fake = new FakeProviderAdapter();
    const events = await drain(
      fake.startRun({
        runId: "r2",
        model: "fake:fail-quota_exhausted",
        systemPrompt: "",
        userPrompt: "x",
      }).events,
    );
    expect(events).toEqual([
      { type: "error", category: "quota_exhausted", message: "scripted quota_exhausted failure" },
    ]);
  });

  it("rate-limits the first attempt then succeeds (fallback fixture)", async () => {
    const fake = new FakeProviderAdapter();
    const first = await drain(
      fake.startRun({ runId: "a", model: "fake:rate-limit-once", systemPrompt: "", userPrompt: "same" }).events,
    );
    expect(first[0]).toMatchObject({ type: "error", category: "rate_limited", retryAfterMs: 20 });
    const second = await drain(
      fake.startRun({ runId: "b", model: "fake:rate-limit-once", systemPrompt: "", userPrompt: "same" }).events,
    );
    expect(second.at(-1)).toMatchObject({ type: "completed" });
  });

  it("supports cancellation of slow runs", async () => {
    const fake = new FakeProviderAdapter();
    const run = fake.startRun({
      runId: "r3",
      model: "fake:slow",
      systemPrompt: "",
      userPrompt: "x",
      timeoutMs: 5000,
    });
    const drained = drain(run.events);
    await new Promise((r) => setTimeout(r, 30));
    await run.cancel();
    const events = await drained;
    expect(events.every((e) => e.type !== "completed")).toBe(true);
  });
});

describe("command adapter (hermetic unit)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("streams output and completes on exit 0", async () => {
    const adapter = new CommandProviderAdapter(
      "echo-agent",
      { executable: "echo", args: ["{prompt}"] },
      hermeticRuntime,
    );
    const events = await drain(
      adapter.startRun({
        runId: "r",
        model: "default",
        systemPrompt: "architecture rule",
        userPrompt: "hello world",
      }).events,
    );
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect((completed as { resultText: string }).resultText).toContain("architecture rule");
    expect((completed as { resultText: string }).resultText).toContain("hello world");
  });

  it("advertises workspace editing while HTTP text adapters do not", () => {
    const command = new CommandProviderAdapter("echo-agent", {
      executable: "echo",
      args: ["{prompt}"],
    });
    const http = new OpenAICompatibleAdapter("openai", {
      baseUrl: "https://api.example/v1",
      apiKey: "k",
    });
    expect(command.capabilities().workspaceEdits).toBe(true);
    expect(http.capabilities()).toMatchObject({
      workspaceEdits: false,
      streaming: false,
      toolCalls: false,
    });
  });

  it("normalizes non-zero exits as agent_crash", async () => {
    const adapter = new CommandProviderAdapter(
      "false-agent",
      { executable: "false", args: [] },
      hermeticRuntime,
    );
    const events = await drain(
      adapter.startRun({ runId: "r", model: "default", systemPrompt: "", userPrompt: "" }).events,
    );
    expect(events.at(-1)).toMatchObject({ type: "error", category: "agent_crash" });
  });

  it("rejects shell-string executables", () => {
    expect(
      () => new CommandProviderAdapter("bad", { executable: "rm -rf /", args: [] }),
    ).toThrow(ProviderConfigError);
  });

  it("reports sandbox_unavailable when the sandbox launcher fails", async () => {
    let spawnCalls = 0;
    const adapter = new CommandProviderAdapter(
      "no-sandbox",
      { executable: "echo", args: ["should-not-run"] },
      {
        sandbox: () => {
          throw new Error("no supported OS sandbox is available; install bubblewrap on Linux or use a macOS worker");
        },
        spawn: ((..._args: Parameters<ProcessSpawner>) => {
          spawnCalls += 1;
          throw new Error("spawn must not be reached when sandbox is unavailable");
        }) as ProcessSpawner,
      },
    );
    const events = await drain(
      adapter.startRun({ runId: "r", model: "default", systemPrompt: "", userPrompt: "" }).events,
    );
    expect(spawnCalls).toBe(0);
    expect(events).toEqual([
      {
        type: "error",
        category: "sandbox_unavailable",
        message:
          "sandbox unavailable: no supported OS sandbox is available; install bubblewrap on Linux or use a macOS worker",
      },
    ]);
  });

  it("never falls back to unsandboxed execution when the default sandbox is missing", async () => {
    // Production wiring (no injected sandbox): on a host without the OS
    // primitive, startRun must emit sandbox_unavailable and must not complete.
    if (SANDBOX_AVAILABLE) {
      // When the host *does* provide the primitive, this assertion is N/A —
      // the real sandbox path is covered by the integration suite below.
      return;
    }
    const adapter = new CommandProviderAdapter("echo-agent", {
      executable: "echo",
      args: ["ambient-authority-must-not-run"],
    });
    const events = await drain(
      adapter.startRun({ runId: "r", model: "default", systemPrompt: "", userPrompt: "" }).events,
    );
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      category: "sandbox_unavailable",
    });
  });

  it("never leaks the control-plane environment to CLI agents", async () => {
    process.env.AVITY_TEST_CANARY_SECRET = "sk-canary-should-not-leak";
    try {
      const { text } = await runHermetic({
        executable: "printenv",
        args: [],
        env: { AGENT_SCOPED_VAR: "yes" },
      });
      expect(text).toContain("PATH=");
      expect(text).toContain("AGENT_SCOPED_VAR=yes");
      expect(text).not.toContain("AVITY_TEST_CANARY_SECRET");
      expect(text).not.toContain("sk-canary-should-not-leak");
    } finally {
      delete process.env.AVITY_TEST_CANARY_SECRET;
    }
  });

  it("preserves an explicitly allowlisted credential env var", async () => {
    const { text } = await runHermetic({
      executable: "printenv",
      args: ["CURSOR_API_KEY"],
      env: { CURSOR_API_KEY: "test-credential-value" },
    });
    expect(text.trim()).toBe("test-credential-value");
  });

  it("normalizes spawn failures as agent_crash", async () => {
    const adapter = new CommandProviderAdapter(
      "spawn-fail",
      { executable: "echo", args: [] },
      {
        sandbox: hermeticSandbox,
        spawn: ((_cmd, _args, _opts) => {
          const child = new EventEmitter() as EventEmitter & {
            stdout: Readable | null;
            stderr: Readable | null;
            pid: number;
          };
          child.stdout = null;
          child.stderr = null;
          child.pid = 0;
          queueMicrotask(() => child.emit("error", new Error("ENOENT")));
          return child as ReturnType<ProcessSpawner>;
        }) as ProcessSpawner,
      },
    );
    const events = await drain(
      adapter.startRun({ runId: "r", model: "default", systemPrompt: "", userPrompt: "" }).events,
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      category: "agent_crash",
      message: expect.stringContaining("spawn failed"),
    });
  });

  it("supports cancellation of a running process", async () => {
    const adapter = new CommandProviderAdapter(
      "slow",
      { executable: "sleep", args: ["30"] },
      hermeticRuntime,
    );
    const run = adapter.startRun({
      runId: "r",
      model: "default",
      systemPrompt: "",
      userPrompt: "",
    });
    const drained = drain(run.events);
    await new Promise((r) => setTimeout(r, 30));
    await run.cancel();
    const events = await drained;
    expect(events.every((e) => e.type !== "completed")).toBe(true);
  });

  it("emits a timeout error and does not complete", async () => {
    const adapter = new CommandProviderAdapter(
      "slow",
      { executable: "sleep", args: ["30"] },
      hermeticRuntime,
    );
    const events = await drain(
      adapter.startRun({
        runId: "r",
        model: "default",
        systemPrompt: "",
        userPrompt: "",
        timeoutMs: 50,
      }).events,
    );
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(events.some((e) => e.type === "error" && e.message.includes("timed out"))).toBe(true);
  });

  it("uses a throwaway HOME distinct from the real one", async () => {
    const { text } = await runHermetic({ executable: "printenv", args: ["HOME"] });
    const home = text.trim();
    homes.push(home);
    expect(home).not.toBe(homedir());
    expect(home).toContain("avity-hermetic-home-");
  });
});

describe("http error normalization", () => {
  it("maps statuses to closed categories", () => {
    expect(normalizeHttpStatus(401, null).category).toBe("auth");
    expect(normalizeHttpStatus(429, "2.5")).toEqual({ category: "rate_limited", retryAfterMs: 2500 });
    expect(normalizeHttpStatus(402, null).category).toBe("quota_exhausted");
    expect(normalizeHttpStatus(400, null).category).toBe("invalid_request");
    expect(normalizeHttpStatus(503, null).category).toBe("transient_network");
  });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("openai-compatible adapter", () => {
  it("completes a run and reports usage", async () => {
    let requestBody: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter("openai", {
      baseUrl: "https://api.example/v1",
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(200, {
          choices: [{ message: { content: "result text" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    });
    const events = await drain(
      adapter.startRun({ runId: "r", model: "gpt-test", systemPrompt: "s", userPrompt: "u" }).events,
    );
    expect(requestBody.max_tokens).toBe(16_384);
    expect(events).toContainEqual({ type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0 });
    expect(events.at(-1)).toMatchObject({ type: "completed", resultText: "result text" });
  });

  it("falls back to reasoning_content when message content is empty", async () => {
    let requestBody: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter("deepseek", {
      baseUrl: "https://api.deepseek.example",
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(200, {
          choices: [{ message: { content: "", reasoning_content: "```json\n{\"ok\":true}\n```" } }],
          usage: { prompt_tokens: 3, completion_tokens: 9 },
        });
      },
    });
    const events = await drain(
      adapter.startRun({
        runId: "r",
        model: "deepseek-v4-pro",
        systemPrompt: "",
        userPrompt: "plan",
        maxOutputTokens: 16_384,
      }).events,
    );
    expect(requestBody.max_tokens).toBe(16_384);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      resultText: "```json\n{\"ok\":true}\n```",
    });
  });

  it("normalizes 429 with retry-after", async () => {
    const adapter = new OpenAICompatibleAdapter("deepseek", {
      baseUrl: "https://api.deepseek.example",
      apiKey: "k",
      fetchImpl: async () => jsonResponse(429, { error: "slow down" }, { "retry-after": "1" }),
    });
    const events = await drain(
      adapter.startRun({ runId: "r", model: "deepseek-chat", systemPrompt: "", userPrompt: "" }).events,
    );
    expect(events[0]).toMatchObject({ type: "error", category: "rate_limited", retryAfterMs: 1000 });
  });

  it("merges configured and discovered models", async () => {
    const adapter = new OpenAICompatibleAdapter("openai", {
      baseUrl: "https://api.example/v1",
      apiKey: "k",
      models: ["configured-model"],
      fetchImpl: async () => jsonResponse(200, { data: [{ id: "live-model" }] }),
    });
    expect(await adapter.listModels()).toEqual(["configured-model", "live-model"]);
  });
});

describe("OpenAI Responses adapter", () => {
  it("uses /responses with instructions and parses output_text", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const adapter = new OpenAIResponsesAdapter({
      baseUrl: "https://api.openai.example/v1",
      apiKey: "k",
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(200, {
          output: [{ type: "message", content: [{ type: "output_text", text: "review complete" }] }],
          usage: { input_tokens: 12, output_tokens: 4 },
        });
      },
    });
    const events = await drain(
      adapter.startRun({ runId: "r", model: "configured", systemPrompt: "review rules", userPrompt: "review diff" }).events,
    );
    expect(requestUrl).toBe("https://api.openai.example/v1/responses");
    expect(requestBody).toMatchObject({
      model: "configured",
      instructions: "review rules",
      input: "review diff",
      store: false,
    });
    expect(events).toContainEqual({ type: "usage", inputTokens: 12, outputTokens: 4, costUsd: 0 });
    expect(events.at(-1)).toMatchObject({ type: "completed", resultText: "review complete" });
  });
});

describe("anthropic adapter", () => {
  it("completes a run from content blocks", async () => {
    const adapter = new AnthropicAdapter({
      baseUrl: "https://api.anthropic.example",
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse(200, {
          content: [{ type: "text", text: "claude says hi" }],
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
    });
    const events = await drain(
      adapter.startRun({ runId: "r", model: "claude-test", systemPrompt: "s", userPrompt: "u" }).events,
    );
    expect(events.at(-1)).toMatchObject({ type: "completed", resultText: "claude says hi" });
    expect(events).toContainEqual({ type: "usage", inputTokens: 7, outputTokens: 3, costUsd: 0 });
  });
});

/**
 * Integration suite: requires the real OS sandbox primitive. Skipped with an
 * explicit reason on unsupported hosts. Never simulates a green production
 * path without isolation.
 */
describe.skipIf(!SANDBOX_AVAILABLE)("command adapter sandbox isolation (integration)", () => {
  async function runText(
    config: ConstructorParameters<typeof CommandProviderAdapter>[1],
    cwd?: string,
  ): Promise<{ events: RunEvent[]; text: string }> {
    const adapter = new CommandProviderAdapter("sbx", config);
    const events = await drain(
      adapter.startRun({
        runId: "r",
        model: "default",
        systemPrompt: "",
        userPrompt: "",
        ...(cwd ? { cwd } : {}),
      }).events,
    );
    const completed = events.find((e) => e.type === "completed") as
      | { resultText: string }
      | undefined;
    return { events, text: completed?.resultText ?? "" };
  }

  it("runs the agent with a throwaway HOME, never the real one", async () => {
    const { text } = await runText({ executable: "printenv", args: ["HOME"] });
    const home = text.trim();
    expect(home).not.toBe(homedir());
    expect(home).toContain("avity-sandbox-home-");
  });

  it("cannot read a file placed in the real HOME", async () => {
    const canaryDir = mkdtempSync(join(homedir(), ".avity-sbx-canary-"));
    const canary = join(canaryDir, "secret.txt");
    const secret = "top-secret-real-home-value";
    writeFileSync(canary, `${secret}\n`);
    try {
      const { text } = await runText({
        executable: "sh",
        args: ["-c", `cat '${canary}' 2>/dev/null; echo DONE`],
      });
      expect(text).toContain("DONE");
      expect(text).not.toContain(secret);
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  it("exposes only explicitly allowlisted environment variables", async () => {
    process.env.AVITY_SBX_UNAUTHORIZED = "should-not-leak";
    try {
      const { text } = await runText({
        executable: "printenv",
        args: [],
        env: { AGENT_SCOPED: "yes" },
      });
      expect(text).toContain("AGENT_SCOPED=yes");
      expect(text).toContain("HOME=");
      expect(text).not.toContain("AVITY_SBX_UNAUTHORIZED");
      expect(text).not.toContain("should-not-leak");
    } finally {
      delete process.env.AVITY_SBX_UNAUTHORIZED;
    }
  });

  it("runs inside the provided workspace directory", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "avity-sbx-ws-"));
    try {
      const { text } = await runText({ executable: "pwd", args: [] }, workspace);
      expect(text.trim().endsWith(workspace.split("/").pop()!)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("refuses writes outside the workspace and throwaway HOME", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "avity-sbx-ws-"));
    const external = mkdtempSync(join(tmpdir(), "avity-sbx-ext-"));
    const forbidden = join(external, "pwned");
    try {
      await runText(
        { executable: "sh", args: ["-c", `echo pwned > '${forbidden}' 2>/dev/null; echo DONE`] },
        workspace,
      );
      expect(existsSync(forbidden)).toBe(false);
      const inside = join(workspace, "ok.txt");
      await runText({ executable: "sh", args: ["-c", `echo ok > '${inside}'; echo DONE`] }, workspace);
      expect(existsSync(inside)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("denies network access unless the provider opts in", async () => {
    const script =
      "const s=require('net').connect(443,'1.1.1.1');" +
      "s.on('connect',()=>{s.destroy();process.exit(0)});" +
      "s.on('error',()=>process.exit(7));" +
      "setTimeout(()=>process.exit(7),2500);";
    const { events } = await runText({
      executable: "node",
      args: ["-e", script],
      allowNetwork: false,
    });
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});

describe("command adapter sandbox skip rationale when sandbox missing", () => {
  it("documents that integration isolation requires an OS sandbox primitive", () => {
    if (SANDBOX_AVAILABLE) {
      expect(SANDBOX_AVAILABLE).toBe(true);
      return;
    }
    expect(SANDBOX_AVAILABLE).toBe(false);
    // Without sandbox-exec/bwrap, CLI providers fail closed; OS isolation
    // integration coverage is N/A on this host and must not be faked green.
  });
});
