import type { ProviderErrorCategory } from "@avityos/contracts";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  RunEvent,
  RunHandle,
  StartRunInput,
} from "./types.js";
import { ADAPTER_CONTRACT_VERSION, ProviderConfigError } from "./types.js";

export type FetchLike = typeof fetch;

export interface HttpAdapterConfig {
  baseUrl: string;
  apiKey: string;
  /** Static model list; merged with live discovery when the API supports it. */
  models?: readonly string[];
  fetchImpl?: FetchLike;
}

export function normalizeHttpStatus(status: number, retryAfterHeader: string | null): {
  category: ProviderErrorCategory;
  retryAfterMs?: number;
} {
  const retryAfterMs = retryAfterHeader ? Number.parseFloat(retryAfterHeader) * 1000 : undefined;
  if (status === 401 || status === 403) return { category: "auth" };
  if (status === 429) {
    return retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
      ? { category: "rate_limited", retryAfterMs }
      : { category: "rate_limited" };
  }
  if (status === 402) return { category: "quota_exhausted" };
  if (status === 400 || status === 404 || status === 422) return { category: "invalid_request" };
  if (status >= 500) return { category: "transient_network" };
  return { category: "unknown" };
}

async function readJsonResponse<T>(
  response: Response,
  signal: AbortSignal,
): Promise<
  | { state: "ok"; body: T }
  | { state: "aborted" }
  | { state: "failed"; error: unknown }
> {
  try {
    return { state: "ok", body: await response.json() as T };
  } catch (error) {
    return signal.aborted
      ? { state: "aborted" }
      : { state: "failed", error };
  }
}

/**
 * Adapter for OpenAI-compatible chat-completions APIs. Covers OpenAI itself
 * and DeepSeek (and any compatible endpoint) purely through configuration —
 * model names and base URLs are never hardcoded (ADR-0005).
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: string;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;
  private readonly fetchImpl: FetchLike;

  constructor(
    name: string,
    private readonly config: HttpAdapterConfig,
  ) {
    this.name = name;
    if (!config.baseUrl) throw new ProviderConfigError(`${name}: baseUrl is required`);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  capabilities(): ProviderCapabilities {
    return {
      // This adapter currently uses a single non-streaming chat-completions
      // request and deliberately does not claim tools it does not execute.
      streaming: false,
      structuredOutput: false,
      toolCalls: false,
      workspaceEdits: false,
      resumption: false,
      checkpointRequests: false,
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      });
      if (!res.ok) return [...(this.config.models ?? [])];
      const body = (await res.json()) as { data?: { id: string }[] };
      const discovered = (body.data ?? []).map((m) => m.id);
      return [...new Set([...(this.config.models ?? []), ...discovered])];
    } catch {
      return [...(this.config.models ?? [])];
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  startRun(input: StartRunInput): RunHandle {
    const controller = new AbortController();
    const { fetchImpl, config } = this;

    async function* events(): AsyncGenerator<RunEvent, void, void> {
      let res: Response;
      try {
        res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: input.model,
            // DeepSeek v4 reasoning models spend completion budget on
            // reasoning_content; 4k frequently truncates the final JSON plan.
            max_tokens: input.maxOutputTokens ?? 16_384,
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.userPrompt },
            ],
          }),
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        yield { type: "error", category: "transient_network", message: String(err) };
        return;
      }

      if (!res.ok) {
        const norm = normalizeHttpStatus(res.status, res.headers.get("retry-after"));
        const detail = await res.text().catch(() => "");
        yield {
          type: "error",
          category: norm.category,
          message: `HTTP ${res.status}: ${detail.slice(0, 500)}`,
          ...(norm.retryAfterMs !== undefined ? { retryAfterMs: norm.retryAfterMs } : {}),
        };
        return;
      }

      const parsed = await readJsonResponse<{
        choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>(res, controller.signal);
      if (parsed.state === "aborted") return;
      if (parsed.state === "failed") {
        yield {
          type: "error",
          category: "transient_network",
          message: `response JSON failed: ${String(parsed.error)}`,
        };
        return;
      }
      const body = parsed.body;
      const message = body.choices?.[0]?.message;
      const content = message?.content?.trim() ? message.content : "";
      const reasoning = message?.reasoning_content?.trim() ? message.reasoning_content : "";
      // Prefer visible content; fall back to reasoning when the model only emits
      // structured output inside reasoning_content (DeepSeek v4 reasoners).
      const text = content || reasoning;
      yield { type: "output", text };
      yield {
        type: "usage",
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        costUsd: 0, // pricing tables are configuration, not code (ADR-0005)
      };
      yield { type: "completed", resultText: text };
    }

    return {
      events: events(),
      cancel: async () => controller.abort(),
    };
  }
}

/**
 * OpenAI's current Responses API surface. This adapter is intentionally a
 * reasoning/review adapter: coding missions that require filesystem changes
 * are routed to Codex CLI/SDK or another workspace-capable adapter.
 */
export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly name = "openai";
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: HttpAdapterConfig) {
    if (!config.baseUrl) throw new ProviderConfigError("openai: baseUrl is required");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: false,
      structuredOutput: false,
      toolCalls: false,
      workspaceEdits: false,
      resumption: false,
      checkpointRequests: false,
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      });
      if (!res.ok) return [...(this.config.models ?? [])];
      const body = (await res.json()) as { data?: { id: string }[] };
      return [...new Set([...(this.config.models ?? []), ...(body.data ?? []).map((model) => model.id)])];
    } catch {
      return [...(this.config.models ?? [])];
    }
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.fetchImpl(`${this.config.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      })).ok;
    } catch {
      return false;
    }
  }

  startRun(input: StartRunInput): RunHandle {
    const controller = new AbortController();
    const { fetchImpl, config } = this;
    async function* events(): AsyncGenerator<RunEvent, void, void> {
      let res: Response;
      try {
        res = await fetchImpl(`${config.baseUrl}/responses`, {
          method: "POST",
          signal: controller.signal,
          headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: input.model,
            instructions: input.systemPrompt,
            input: input.userPrompt,
            max_output_tokens: input.maxOutputTokens ?? 4096,
            store: false,
          }),
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        yield { type: "error", category: "transient_network", message: String(err) };
        return;
      }
      if (!res.ok) {
        const norm = normalizeHttpStatus(res.status, res.headers.get("retry-after"));
        const detail = await res.text().catch(() => "");
        yield {
          type: "error",
          category: norm.category,
          message: `HTTP ${res.status}: ${detail.slice(0, 500)}`,
          ...(norm.retryAfterMs !== undefined ? { retryAfterMs: norm.retryAfterMs } : {}),
        };
        return;
      }
      const parsed = await readJsonResponse<{
        output?: { type?: string; content?: { type?: string; text?: string }[] }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      }>(res, controller.signal);
      if (parsed.state === "aborted") return;
      if (parsed.state === "failed") {
        yield {
          type: "error",
          category: "transient_network",
          message: `response JSON failed: ${String(parsed.error)}`,
        };
        return;
      }
      const body = parsed.body;
      const text = (body.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((content) => content.type === "output_text")
        .map((content) => content.text ?? "")
        .join("");
      yield { type: "output", text };
      yield {
        type: "usage",
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
        costUsd: 0,
      };
      yield { type: "completed", resultText: text };
    }
    return { events: events(), cancel: async () => controller.abort() };
  }
}

/** Adapter for the Anthropic Messages API. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: HttpAdapterConfig) {
    if (!config.baseUrl) throw new ProviderConfigError("anthropic: baseUrl is required");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: false,
      structuredOutput: false,
      toolCalls: false,
      workspaceEdits: false,
      resumption: false,
      checkpointRequests: false,
    };
  }

  async listModels(): Promise<string[]> {
    return [...(this.config.models ?? [])];
  }

  async healthy(): Promise<boolean> {
    return this.config.apiKey.length > 0;
  }

  startRun(input: StartRunInput): RunHandle {
    const controller = new AbortController();
    const { fetchImpl, config } = this;

    async function* events(): AsyncGenerator<RunEvent, void, void> {
      let res: Response;
      try {
        res = await fetchImpl(`${config.baseUrl}/v1/messages`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: input.model,
            max_tokens: input.maxOutputTokens ?? 4096,
            system: input.systemPrompt,
            messages: [{ role: "user", content: input.userPrompt }],
          }),
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        yield { type: "error", category: "transient_network", message: String(err) };
        return;
      }

      if (!res.ok) {
        const norm = normalizeHttpStatus(res.status, res.headers.get("retry-after"));
        const detail = await res.text().catch(() => "");
        yield {
          type: "error",
          category: norm.category,
          message: `HTTP ${res.status}: ${detail.slice(0, 500)}`,
          ...(norm.retryAfterMs !== undefined ? { retryAfterMs: norm.retryAfterMs } : {}),
        };
        return;
      }

      const parsed = await readJsonResponse<{
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      }>(res, controller.signal);
      if (parsed.state === "aborted") return;
      if (parsed.state === "failed") {
        yield {
          type: "error",
          category: "transient_network",
          message: `response JSON failed: ${String(parsed.error)}`,
        };
        return;
      }
      const body = parsed.body;
      const text = (body.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      yield { type: "output", text };
      yield {
        type: "usage",
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
        costUsd: 0,
      };
      yield { type: "completed", resultText: text };
    }

    return {
      events: events(),
      cancel: async () => controller.abort(),
    };
  }
}
