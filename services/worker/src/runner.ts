import { spawn, type ChildProcess } from "node:child_process";
import { sandboxCommand } from "@avityos/policy";

export interface RunnerCallbacks {
  onOutput: (text: string) => void | Promise<void>;
  onExit: (result: { exitCode: number | null; state: "succeeded" | "failed" | "cancelled" | "timed_out" }) => void | Promise<void>;
}

export interface RunnerHandle {
  pause(): void;
  resume(): void;
  cancel(): void;
  readonly pid: number | undefined;
  readonly done: Promise<void>;
}

/**
 * Subprocess runner for leased terminal sessions. Commands are argv arrays
 * (never shell strings); the child runs detached in its own process group so
 * cancellation kills the whole tree — no orphan processes survive.
 */
export function runCommand(
  argv: readonly string[],
  cwd: string,
  callbacks: RunnerCallbacks,
  options: { timeoutMs?: number; env?: Record<string, string>; sandbox?: boolean; allowNetwork?: boolean } = {},
): RunnerHandle {
  const sandbox = options.sandbox ?? true;
  const [executable, ...args] = argv;
  if (!executable) throw new Error("empty command");
  const invocation = sandbox
    ? sandboxCommand(argv, cwd, { allowNetwork: options.allowNetwork, env: options.env })
    : {
        executable,
        args,
        env: { PATH: process.env.PATH ?? "", ...options.env },
        cleanup: () => undefined,
      };
  const child: ChildProcess = spawn(invocation.executable, invocation.args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // scoped environment: only what the lease provides, plus PATH for resolution
    env: invocation.env,
  });

  let cancelled = false;
  let timedOut = false;
  const cleanup = invocation.cleanup;

  child.stdout?.on("data", (chunk: Buffer) => void callbacks.onOutput(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => void callbacks.onOutput(chunk.toString("utf8")));

  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, options.timeoutMs)
    : null;

  const done = new Promise<void>((resolve) => {
    child.on("error", (err) => {
      void callbacks.onOutput(`spawn error: ${err.message}\n`);
      if (timeout) clearTimeout(timeout);
      cleanup();
      void Promise.resolve(callbacks.onExit({ exitCode: null, state: "failed" })).then(resolve);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      cleanup();
      const state = cancelled ? "cancelled" : timedOut ? "timed_out" : code === 0 ? "succeeded" : "failed";
      void Promise.resolve(callbacks.onExit({ exitCode: code, state })).then(resolve);
    });
  });

  return {
    pid: child.pid,
    done,
    pause: () => {
      if (child.pid) process.kill(-child.pid, "SIGSTOP");
    },
    resume: () => {
      if (child.pid) process.kill(-child.pid, "SIGCONT");
    },
    cancel: () => {
      cancelled = true;
      killGroup(child.pid);
    },
  };
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already exited
    }
  }
  // escalate to SIGKILL if the group is still alive shortly after
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone — nothing to do
    }
  }, 3000).unref?.();
}
