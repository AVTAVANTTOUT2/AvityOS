import type { ProviderErrorCategory } from "@avityos/contracts";

/**
 * Versioned provider adapter contract (ADR-0005). Everything a provider or
 * coding agent does for AvityOS flows through this interface; the
 * orchestration engine never sees vendor-specific shapes.
 */

export const ADAPTER_CONTRACT_VERSION = 1 as const;

export interface ProviderCapabilities {
  streaming: boolean;
  structuredOutput: boolean;
  toolCalls: boolean;
  /** The adapter can make durable file changes inside StartRunInput.cwd. */
  workspaceEdits: boolean;
  resumption: boolean;
  checkpointRequests: boolean;
}

export interface StartRunInput {
  runId: string;
  model: string;
  /** Structured context assembled by the control plane (mission contract, brain excerpts). */
  systemPrompt: string;
  userPrompt: string;
  /** Working directory for agents that operate on files (command adapter). */
  cwd?: string;
  /**
   * Trusted, control-plane-authorized paths the command adapter may read in
   * addition to `cwd`. This is used for linked Git worktrees, whose `.git`
   * file points back to metadata in the canonical project repository.
   */
  sandboxReadablePaths?: readonly string[];
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export type RunEvent =
  | { type: "output"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "artifact"; path: string; description?: string }
  | { type: "checkpoint_request"; reason: string }
  | { type: "completed"; resultText: string }
  | {
      type: "error";
      category: ProviderErrorCategory;
      message: string;
      retryAfterMs?: number;
    };

export interface RunHandle {
  events: AsyncGenerator<RunEvent, void, void>;
  cancel(): Promise<void>;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  capabilities(): ProviderCapabilities;
  /** Model discovery; static config fallback when the API offers no listing. */
  listModels(): Promise<string[]>;
  healthy(): Promise<boolean>;
  startRun(input: StartRunInput): RunHandle;
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}
