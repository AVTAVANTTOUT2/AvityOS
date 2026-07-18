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
 *   fake:plan                BRAIN: valid structured output per pipeline
 *                            step (analysis/architecture/plan); one chained
 *                            mission per acceptance criterion
 *   fake:plan-dag            BRAIN: independent parallel missions per
 *                            criterion plus a final QA mission depending on
 *                            all of them (exercises a real DAG)
 *   fake:plan-invalid-once   BRAIN: first attempt per step emits broken
 *                            JSON, the repair attempt emits valid output
 *   fake:plan-slow           BRAIN: hangs like fake:slow (recovery paths)
 *
 * No randomness, no wall-clock dependence except the slow models' timer.
 */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly name: string = "fake";
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;
  /**
   * Honest self-identification: everything this adapter produces is a
   * deterministic engineering fixture, never real AI planning or
   * implementation evidence. The control plane persists this provenance.
   */
  readonly fixture = true;
  private rateLimitedRuns = new Set<string>();
  private defectiveRuns = new Set<string>();
  private rejectedReviews = new Set<string>();
  private invalidBrainSteps = new Set<string>();

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
      "fake:plan",
      "fake:plan-dag",
      "fake:plan-invalid-once",
      "fake:plan-slow",
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

      if (model === "fake:slow" || model === "fake:plan-slow") {
        const deadline = Date.now() + (input.timeoutMs ?? 60_000);
        while (!cancelled && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        if (cancelled) return;
        yield { type: "error", category: "unknown", message: "fake slow run timed out" };
        return;
      }

      if (model.startsWith("fake:plan")) {
        const step = parseMarker(input.userPrompt, "AVITY_BRAIN_STEP") ?? "analysis";
        if (model === "fake:plan-invalid-once" && !self.invalidBrainSteps.has(step)) {
          self.invalidBrainSteps.add(step);
          yield { type: "usage", inputTokens: 90, outputTokens: 20, costUsd: 0 };
          yield { type: "completed", resultText: "Here is the plan: { this is deliberately broken JSON" };
          return;
        }
        const structured = fakeBrainStepOutput(step, input.userPrompt, model === "fake:plan-dag");
        yield { type: "output", text: `fake brain fixture producing deterministic ${step} output\n` };
        yield { type: "usage", inputTokens: 200, outputTokens: 120, costUsd: 0 };
        yield {
          type: "completed",
          resultText: `Deterministic fixture ${step} result.\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\`\n`,
        };
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

function parseMarker(prompt: string, name: string): string | null {
  const match = prompt.match(new RegExp(`^${name}: (.*)$`, "m"));
  return match ? match[1]!.trim() : null;
}

function parseJsonMarker<T>(prompt: string, name: string, fallback: T): T {
  const raw = parseMarker(prompt, name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function inferFixtureRole(criterion: string): string {
  const lower = criterion.toLowerCase();
  if (/(ui|screen|page|frontend|css|design|écran|interface)/.test(lower)) return "frontend";
  if (/(deploy|infra|docker|ci|pipeline)/.test(lower)) return "infrastructure";
  if (/(secur|auth|encrypt|vuln)/.test(lower)) return "cybersecurity";
  if (/(test|qa|coverage)/.test(lower)) return "qa";
  if (/(doc|readme|guide)/.test(lower)) return "documentation";
  return "backend";
}

/**
 * Deterministic structured output for a brain pipeline step, derived only
 * from machine-readable markers in the prompt. This is a fixture, not real
 * reasoning: the control plane records its provenance as `fake_fixture`.
 */
function fakeBrainStepOutput(step: string, prompt: string, parallelDag: boolean): unknown {
  const objective = parseJsonMarker<string>(prompt, "AVITY_OBJECTIVE_JSON", "objective");
  const criteria = parseJsonMarker<string[]>(prompt, "AVITY_ACCEPTANCE_CRITERIA_JSON", []);
  const repoAvailable = parseMarker(prompt, "AVITY_REPO_AVAILABLE") === "true";
  const availableChecks = parseJsonMarker<{ requiredChecks: string[]; checkCommands: Record<string, string[]> }>(
    prompt,
    "AVITY_AVAILABLE_CHECKS_JSON",
    { requiredChecks: [], checkCommands: {} },
  );

  if (step === "analysis") {
    return {
      summary: `Deterministic fixture analysis of: ${summarize(objective)}`,
      objectiveClarity: "clear",
      feasibility: "feasible",
      constraints: [],
      assumptions: ["fixture assumption: offline deterministic environment"],
      risks: [
        {
          title: "Fixture output",
          severity: "low",
          detail: "Produced by the deterministic fake provider, not real reasoning.",
          mitigation: "Configure a live reasoning provider.",
        },
      ],
      evidence: [{ kind: "objective", ref: "objective:current", detail: "" }],
    };
  }

  if (step === "architecture") {
    return {
      overview: `Deterministic fixture architecture for: ${summarize(objective)}`,
      components: [
        {
          name: "delivery",
          responsibility: "Implement the objective inside the existing repository structure.",
          paths: [],
        },
      ],
      decisions: [
        { title: "Fixture architecture", rationale: "Deterministic offline fixture; no real design reasoning." },
      ],
      constraints: [],
      assumptions: [],
      risks: [],
      evidence: [{ kind: "objective", ref: "objective:current", detail: "" }],
    };
  }

  const effectiveCriteria = criteria.length > 0 ? criteria : [objective.slice(0, 200)];
  const missions = effectiveCriteria.map((criterion, index) => ({
    key: `mission-${index + 1}`,
    title: `Implement: ${criterion.slice(0, 120)}`,
    objective: criterion,
    rationale: `Deterministic fixture mission covering acceptance criterion ${index}.`,
    role: inferFixtureRole(criterion),
    milestoneKey: "deliver",
    dependsOn: parallelDag || index === 0 ? [] : [`mission-${index}`],
    acceptanceCriteria: [criterion],
    coversCriteria: criteria.length > 0 ? [index] : [],
    allowedPaths: repoAvailable ? ["**"] : [],
    forbiddenPaths: ["**/.env", "**/secrets/**"],
    requiredChecks: repoAvailable ? availableChecks.requiredChecks : [],
    checkCommands: repoAvailable ? availableChecks.checkCommands : {},
    expectedArtifacts: [],
    budgetUsd: null,
    timeoutSeconds: 900,
    escalationConditions: ["correction loop exhausted"],
    priority: Math.max(0, 60 - index),
  }));
  if (parallelDag) {
    missions.push({
      key: "final-qa",
      title: "Final QA over all delivered criteria",
      objective: "Verify the integrated result of every parallel mission.",
      rationale: "Depends on all parallel missions; exercises a real DAG join.",
      role: "qa",
      milestoneKey: "deliver",
      dependsOn: effectiveCriteria.map((_, index) => `mission-${index + 1}`),
      acceptanceCriteria: ["all parallel missions verified"],
      coversCriteria: [],
      allowedPaths: repoAvailable ? ["**"] : [],
      forbiddenPaths: ["**/.env", "**/secrets/**"],
      requiredChecks: repoAvailable ? availableChecks.requiredChecks : [],
      checkCommands: repoAvailable ? availableChecks.checkCommands : {},
      expectedArtifacts: [],
      budgetUsd: null,
      timeoutSeconds: 900,
      escalationConditions: [],
      priority: 40,
    });
  }
  return {
    summary: `Deterministic fixture plan: ${missions.length} mission(s) for ${summarize(objective)}`,
    milestones: [{ key: "deliver", title: "Deliver objective", description: objective.slice(0, 500), order: 0 }],
    missions,
  };
}
