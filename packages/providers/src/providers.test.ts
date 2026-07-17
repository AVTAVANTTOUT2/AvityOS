import { describe, expect, it } from "vitest";
import {
  AnthropicAdapter,
  CommandProviderAdapter,
  FakeProviderAdapter,
  normalizeHttpStatus,
  OpenAICompatibleAdapter,
  ProviderConfigError,
  type RunEvent,
} from "./index.js";

async function drain(events: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
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
      adapter.startRun({ runId: "r", model: "default", systemPrompt: "", userPrompt: "hello world" }).events,
    );
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect((completed as { resultText: string }).resultText).toContain("hello world");
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
