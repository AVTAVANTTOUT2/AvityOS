import { spawn } from "node:child_process";
import { sandboxCommand, type SandboxCredentialFile } from "@avityos/policy";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  RunEvent,
  RunHandle,
  StartRunInput,
} from "./types.js";
import { ADAPTER_CONTRACT_VERSION, ProviderConfigError } from "./types.js";

export interface CommandAdapterConfig {
  /** Executable to run, e.g. "claude" or "cursor-agent". Never a shell string. */
  executable: string;
  /**
   * Base argv. Placeholders: {prompt} → user prompt, {model} → model name.
   * Example (Claude Code): ["-p", "{prompt}", "--output-format", "text"]
   */
  args: readonly string[];
  /** Configured model identifiers exposed to the scheduler. */
  models?: readonly string[];
  /** Whether this command is trusted/capable to make repository edits. */
  workspaceEdits?: boolean;
  /**
   * Explicit environment allowlist for this provider. These are the *only*
   * non-baseline variables the sandboxed agent receives (on top of PATH and a
   * throwaway HOME/TMPDIR). The control plane's process.env is never inherited.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Minimal credential files staged into the throwaway HOME (never the real HOME).
   */
  credentialFiles?: readonly SandboxCredentialFile[];
  /**
   * Extra absolute, canonical paths this provider is explicitly allowed to
   * *read* under the fail-closed sandbox (e.g. a runtime or data directory a
   * specific CLI needs). Declared by trusted provider policy only — never
   * derived from the prompt or the untrusted repository. The sandbox validates
   * each entry (absolute + must exist) before launch.
   */
  readablePaths?: readonly string[];
  /**
   * Per-provider network policy. Defaults to false (fail-closed): only agents
   * that genuinely need to reach a model API should opt in.
   */
  allowNetwork?: boolean;
  /**
   * When set, startRun fails closed with category `auth` before spawn.
   * Used when the provider policy requires auth material that is missing.
   */
  authError?: string;
}

/**
 * Generic subprocess adapter: integrates any CLI coding agent that supports a
 * non-interactive prompt mode (Claude Code `-p`, Cursor CLI, custom tools).
 * Output is streamed line-buffered; the process group is killed on cancel so
 * no orphan children survive.
 *
 * Note: cancel currently sends SIGTERM to the process group only. Escalation
 * SIGTERM → grace period → SIGKILL is intentionally out of scope for the
 * execution-hardening work and remains a residual risk for stuck CLIs.
 */
export class CommandProviderAdapter implements ProviderAdapter {
  readonly name: string;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  constructor(
    name: string,
    private readonly config: CommandAdapterConfig,
  ) {
    this.name = name;
    if (!config.executable || config.executable.includes(" ")) {
      throw new ProviderConfigError(
        `command adapter executable must be a bare program name/path, got ${JSON.stringify(config.executable)}`,
      );
    }
  }

  /** Test/inspection helper: expose the resolved adapter config. */
  getConfig(): Readonly<CommandAdapterConfig> {
    return this.config;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      structuredOutput: false,
      toolCalls: false,
      workspaceEdits: this.config.workspaceEdits ?? true,
      resumption: false,
      checkpointRequests: false,
    };
  }

  async listModels(): Promise<string[]> {
    return this.config.models?.length ? [...this.config.models] : ["default"];
  }

  async healthy(): Promise<boolean> {
    return !this.config.authError;
  }

  startRun(input: StartRunInput): RunHandle {
    if (this.config.authError) {
      const message = this.config.authError;
      async function* failedAuth(): AsyncGenerator<RunEvent, void, void> {
        yield { type: "error", category: "auth", message };
      }
      return { events: failedAuth(), cancel: async () => {} };
    }

    const combinedPrompt = [input.systemPrompt.trim(), input.userPrompt.trim()]
      .filter(Boolean)
      .join("\n\n--- MISSION ---\n\n");
    const argv = this.config.args.map((a) =>
      a
        .replaceAll("{prompt}", combinedPrompt)
        .replaceAll("{systemPrompt}", input.systemPrompt)
        .replaceAll("{userPrompt}", input.userPrompt)
        .replaceAll("{cwd}", input.cwd ?? process.cwd())
        .replaceAll("{model}", input.model),
    );

    // Every CLI agent runs inside the AvityOS OS sandbox: an isolated throwaway
    // HOME, the workspace as the only writable/readable project path, the real
    // user HOME hidden, network denied unless this provider opts in, and an
    // explicit env allowlist. Credential files are staged only when the
    // provider policy lists them. The control plane's process.env is never
    // inherited. If the host cannot provide the sandbox primitive, the run
    // fails closed rather than executing with ambient authority.
    const workspace = input.cwd ?? process.cwd();
    let invocation: ReturnType<typeof sandboxCommand>;
    try {
      invocation = sandboxCommand([this.config.executable, ...argv], workspace, {
        allowNetwork: this.config.allowNetwork ?? false,
        env: this.config.env ? { ...this.config.env } : undefined,
        credentialFiles: this.config.credentialFiles,
        readablePaths: this.config.readablePaths,
      });
    } catch (err) {
      // Fail closed but stay within the adapter contract: surface a normalized
      // error event instead of throwing out of startRun, so the engine treats
      // it as a provider failure rather than crashing the mission loop.
      const message = err instanceof Error ? err.message : String(err);
      async function* failed(): AsyncGenerator<RunEvent, void, void> {
        yield { type: "error", category: "unknown", message: `sandbox unavailable: ${message}` };
      }
      return { events: failed(), cancel: async () => {} };
    }
    let cleanedUp = false;
    const cleanupSandbox = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      invocation.cleanup();
    };

    const child = spawn(invocation.executable, invocation.args, {
      cwd: workspace,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group → clean group kill on cancel
    });

    let cancelled = false;
    const queue: RunEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    const collected: string[] = [];

    const push = (ev: RunEvent) => {
      queue.push(ev);
      notify?.();
    };

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      collected.push(text);
      push({ type: "output", text });
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    child.on("error", (err) => {
      cleanupSandbox();
      push({ type: "error", category: "agent_crash", message: `spawn failed: ${err.message}` });
      done = true;
      notify?.();
    });

    child.on("close", (code, signal) => {
      cleanupSandbox();
      if (cancelled) {
        done = true;
        notify?.();
        return;
      }
      if (code === 0) {
        push({ type: "completed", resultText: collected.join("") });
      } else {
        push({
          type: "error",
          category: "agent_crash",
          message: `process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
        });
      }
      done = true;
      notify?.();
    });

    const timeout = input.timeoutMs
      ? setTimeout(() => {
          push({ type: "error", category: "unknown", message: `run timed out after ${input.timeoutMs}ms` });
          killGroup(child.pid);
          cleanupSandbox();
          cancelled = true;
        }, input.timeoutMs)
      : null;

    async function* events(): AsyncGenerator<RunEvent, void, void> {
      try {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          if (done) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    return {
      events: events(),
      cancel: async () => {
        cancelled = true;
        killGroup(child.pid);
        cleanupSandbox();
        done = true;
        notify?.();
      },
    };
  }
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}
