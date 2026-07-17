import { spawn } from "node:child_process";
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
  /** Extra environment variables (e.g. non-interactive flags). */
  env?: Readonly<Record<string, string>>;
}

/**
 * Generic subprocess adapter: integrates any CLI coding agent that supports a
 * non-interactive prompt mode (Claude Code `-p`, Cursor CLI, custom tools).
 * Output is streamed line-buffered; the process group is killed on cancel so
 * no orphan children survive.
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
    return true;
  }

  startRun(input: StartRunInput): RunHandle {
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

    // Scoped environment only: the control plane's process.env (API keys,
    // tokens) is never inherited by CLI agents. Adapter config supplies
    // exactly what the agent needs.
    const child = spawn(this.config.executable, argv, {
      cwd: input.cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...this.config.env,
      },
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
      push({ type: "error", category: "agent_crash", message: `spawn failed: ${err.message}` });
      done = true;
      notify?.();
    });

    child.on("close", (code, signal) => {
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
