import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AnthropicAdapter,
  CommandProviderAdapter,
  FakeProviderAdapter,
  normalizeHttpStatus,
  OpenAICompatibleAdapter,
  OpenAIResponsesAdapter,
  ProviderConfigError,
  type RunEvent,
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

async function runText(config: ConstructorParameters<typeof CommandProviderAdapter>[1], cwd?: string): Promise<{ events: RunEvent[]; text: string }> {
  const adapter = new CommandProviderAdapter("sbx", config);
  const events = await drain(
    adapter.startRun({ runId: "r", model: "default", systemPrompt: "", userPrompt: "", ...(cwd ? { cwd } : {}) }).events,
  );
  const completed = events.find((e) => e.type === "completed") as { resultText: string } | undefined;
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

describe("command adapter", () => {
  it("streams output and completes on exit 0", async () => {
    const adapter = new CommandProviderAdapter("echo-agent", {
      executable: "echo",
      args: ["{prompt}"],
    });
    const events = await drain(
      adapter.startRun({ runId: "r", model: "default", systemPrompt: "architecture rule", userPrompt: "hello world" }).events,
    );
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect((completed as { resultText: string }).resultText).toContain("architecture rule");
    expect((completed as { resultText: string }).resultText).toContain("hello world");
  });

  it("advertises workspace editing while HTTP text adapters do not", () => {
    const command = new CommandProviderAdapter("echo-agent", { executable: "echo", args: ["{prompt}"] });
    const http = new OpenAICompatibleAdapter("openai", { baseUrl: "https://api.example/v1", apiKey: "k" });
    expect(command.capabilities().workspaceEdits).toBe(true);
    expect(http.capabilities()).toMatchObject({ workspaceEdits: false, streaming: false, toolCalls: false });
  });

  it("normalizes non-zero exits as agent_crash", async () => {
    const adapter = new CommandProviderAdapter("false-agent", {
      executable: "false",
      args: [],
    });
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
    const adapter = new OpenAICompatibleAdapter("openai", {
      baseUrl: "https://api.example/v1",
      apiKey: "test-key",
      fetchImpl: async () =>
        jsonResponse(200, {
          choices: [{ message: { content: "result text" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
    });
    const events = await drain(
      adapter.startRun({ runId: "r", model: "gpt-test", systemPrompt: "s", userPrompt: "u" }).events,
    );
    expect(events).toContainEqual({ type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0 });
    expect(events.at(-1)).toMatchObject({ type: "completed", resultText: "result text" });
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
    expect(requestBody).toMatchObject({ model: "configured", instructions: "review rules", input: "review diff", store: false });
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

describe.skipIf(!SANDBOX_AVAILABLE)("command adapter sandbox isolation", () => {
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
      const { text } = await runText({ executable: "printenv", args: [], env: { AGENT_SCOPED: "yes" } });
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
      // realpath collapses macOS /var → /private/var; compare the basename.
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
      // A write *inside* the workspace is allowed.
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
    const { events } = await runText({ executable: "node", args: ["-e", script], allowNetwork: false });
    // Network denied → the connection cannot succeed → non-zero exit surfaces
    // as a normalized agent error, never a "completed".
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});

describe("command adapter environment scoping", () => {
  it("never leaks the control-plane environment to CLI agents", async () => {
    process.env.AVITY_TEST_CANARY_SECRET = "sk-canary-should-not-leak";
    try {
      const adapter = new CommandProviderAdapter("env-probe", {
        executable: "printenv",
        args: [],
        env: { AGENT_SCOPED_VAR: "yes" },
      });
      const events = await drain(
        adapter.startRun({ runId: "r", model: "default", systemPrompt: "", userPrompt: "" }).events,
      );
      const completed = events.find((e) => e.type === "completed") as { resultText: string };
      expect(completed).toBeDefined();
      expect(completed.resultText).toContain("PATH=");
      expect(completed.resultText).toContain("AGENT_SCOPED_VAR=yes");
      expect(completed.resultText).not.toContain("AVITY_TEST_CANARY_SECRET");
    } finally {
      delete process.env.AVITY_TEST_CANARY_SECRET;
    }
  });
});
