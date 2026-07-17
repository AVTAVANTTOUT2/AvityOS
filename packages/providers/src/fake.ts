import { ProviderErrorCategory } from "@avityos/contracts";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  RunEvent,
  RunHandle,
  StartRunInput,
} from "./types.js";
import { ADAPTER_CONTRACT_VERSION } from "./types.js";

/**
 * Deterministic fake provider — the backbone of tests and the offline demo
 * mode. Behavior is scripted through the model name:
 *
 *   fake:succeed             emit output then complete
 *   fake:fail-<category>     emit a normalized error of that category
 *   fake:rate-limit-once     rate-limit the first run per adapter instance,
 *                            succeed afterwards (exercises fallback policy)
 *   fake:slow                wait until cancelled or timeout (exercises
 *                            cancellation/timeout paths)
 *   fake:checkpoint          request a checkpoint, then complete
 *
 * No randomness, no wall-clock dependence except fake:slow's timer.
 */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly name = "fake";
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;
  private rateLimitedRuns = new Set<string>();

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      structuredOutput: true,
      toolCalls: true,
      resumption: false,
      checkpointRequests: true,
    };
  }

  async listModels(): Promise<string[]> {
    return [
      "fake:succeed",
      "fake:fail-rate_limited",
      "fake:fail-quota_exhausted",
      "fake:fail-agent_crash",
      "fake:rate-limit-once",
      "fake:slow",
      "fake:checkpoint",
    ];
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  startRun(input: StartRunInput): RunHandle {
    let cancelled = false;
    const self = this;

    async function* events(): AsyncGenerator<RunEvent, void, void> {
      const model = input.model;

      if (model === "fake:slow") {
        const deadline = Date.now() + (input.timeoutMs ?? 60_000);
        while (!cancelled && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        if (cancelled) return;
        yield { type: "error", category: "unknown", message: "fake slow run timed out" };
        return;
      }

      if (model.startsWith("fake:fail-")) {
        const raw = model.slice("fake:fail-".length);
        const parsed = ProviderErrorCategory.safeParse(raw);
        const category = parsed.success ? parsed.data : "unknown";
        yield {
          type: "error",
          category,
          message: `scripted ${category} failure`,
          ...(category === "rate_limited" ? { retryAfterMs: 50 } : {}),
        };
        return;
      }

      if (model === "fake:rate-limit-once" && !self.rateLimitedRuns.has(input.userPrompt)) {
        self.rateLimitedRuns.add(input.userPrompt);
        yield {
          type: "error",
          category: "rate_limited",
          message: "scripted first-attempt rate limit",
          retryAfterMs: 20,
        };
        return;
      }

      if (model === "fake:checkpoint") {
        yield { type: "checkpoint_request", reason: "scripted checkpoint before completion" };
      }

      yield { type: "output", text: `fake run ${input.runId}: analyzing objective\n` };
      if (cancelled) return;
      yield { type: "output", text: `fake run ${input.runId}: producing result\n` };
      yield { type: "usage", inputTokens: 120, outputTokens: 80, costUsd: 0 };
      if (cancelled) return;
      yield {
        type: "completed",
        resultText: `FAKE_RESULT for ${input.runId}: ${summarize(input.userPrompt)}`,
      };
    }

    return {
      events: events(),
      cancel: async () => {
        cancelled = true;
      },
    };
  }
}

function summarize(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 120);
}
