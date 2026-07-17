import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
 *   fake:code                CODING AGENT: writes AVITY.md in input.cwd
 *                            containing the mission objective, then completes
 *   fake:code-defect-once    first run per cwd writes a DEFECT marker into
 *                            AVITY.md; the correction run writes clean content
 *   fake:review-approve      REVIEWER: emits "VERDICT: APPROVE"
 *   fake:review-reject-once  rejects with findings on the first review per
 *                            prompt, approves on re-review
 *
 * No randomness, no wall-clock dependence except fake:slow's timer.
 */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly name: string = "fake";
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;
  private rateLimitedRuns = new Set<string>();
  private defectiveRuns = new Set<string>();
  private rejectedReviews = new Set<string>();

  constructor(name = "fake") {
    this.name = name;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      structuredOutput: false,
      toolCalls: false,
      workspaceEdits: true,
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
      "fake:code",
      "fake:code-defect-once",
      "fake:review-approve",
      "fake:review-reject-once",
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

      if ((model === "fake:code" || model === "fake:code-defect-once") && input.cwd) {
        const target = join(input.cwd, "AVITY.md");
        const firstAttempt = model === "fake:code-defect-once" && !self.defectiveRuns.has(input.cwd);
        if (firstAttempt) self.defectiveRuns.add(input.cwd);
        const content = firstAttempt
          ? `# Mission result\n\nDEFECT: intentionally wrong first attempt\n`
          : `# Mission result\n\n${input.userPrompt}\n`;
        writeFileSync(target, content);
        yield { type: "output", text: `fake coding agent wrote ${target}\n` };
        yield { type: "artifact", path: target, description: "mission result file" };
        yield { type: "usage", inputTokens: 150, outputTokens: 90, costUsd: 0 };
        yield { type: "completed", resultText: `edited AVITY.md (${firstAttempt ? "defective" : "clean"})` };
        return;
      }

      if (model === "fake:review-approve" || model === "fake:review-reject-once") {
        // keyed on the first prompt line (the mission title): stable across
        // re-reviews even though evidence/diff sections change
        const reviewKey = input.userPrompt.split("\n")[0] ?? input.userPrompt;
        const reject = model === "fake:review-reject-once" && !self.rejectedReviews.has(reviewKey);
        if (reject) self.rejectedReviews.add(reviewKey);
        yield { type: "usage", inputTokens: 80, outputTokens: 40, costUsd: 0 };
        yield {
          type: "completed",
          resultText: reject
            ? "FINDINGS: result file contains a defect marker\nVERDICT: REJECT"
            : "FINDINGS: none\nVERDICT: APPROVE",
        };
        return;
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
