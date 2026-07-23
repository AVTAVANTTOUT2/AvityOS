import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { runCommand, type RunnerHandle } from "./runner.js";

type RunCommand = typeof runCommand;

export interface WorkerConfig {
  controlPlaneUrl: string;
  name: string;
  workerId?: string;
  workerToken?: string;
  pollMs: number;
  capabilities: string[];
  maxConcurrentRuns?: number;
  /** Admin bearer used only for first enrollment. */
  apiToken?: string;
  /** Explicit development escape hatch; never enable for a remote worker. */
  allowInsecureTransport?: boolean;
  fetchImpl?: typeof fetch;
  /**
   * Test seam only: overrides the subprocess runner. Production always uses the
   * default sandboxed {@link runCommand}; this never introduces a non-sandboxed
   * execution path in a real worker.
   */
  runCommandImpl?: RunCommand;
}

export interface WorkerCredentials {
  workerId: string;
  workerToken: string;
}

interface Enroller {
  enroll: () => Promise<{ id: string; token: string }>;
}

interface CredentialResolutionInput {
  workerId?: string;
  workerToken?: string;
  credentialsPath?: string;
}

interface Lease {
  id: string;
  command: string[];
  cwd: string;
  leaseToken: string;
  /** Server-authorized read-only roots for the OS sandbox. */
  readablePaths?: string[];
}

export const CREDENTIAL_FILE_MODE = 0o600;

export class WorkerCredentialsFileError extends Error {
  constructor(
    readonly credentialsPath: string,
    readonly reason: "invalid_json" | "invalid_schema" | "unsafe_permissions",
    detail: string,
  ) {
    super(`invalid worker credentials file at ${credentialsPath}: ${detail}`);
    this.name = "WorkerCredentialsFileError";
  }
}

function formatOctal(mode: number): string {
  return `0o${mode.toString(8).padStart(3, "0")}`;
}

export function createEnrollmentMessages(workerId: string, credentialsPath?: string): string[] {
  if (credentialsPath) {
    return [`enrolled as ${workerId}`, `worker credentials stored at ${credentialsPath}`];
  }
  return [`enrolled as ${workerId}`];
}

/**
 * Resolve when `signal` aborts. An abort listener alone does not keep the Node
 * event loop alive; callers must also retain a referenced lifetime handle
 * (the worker poll timer) until stop().
 */
export function waitUntilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Wire SIGINT/SIGTERM to a single AbortController. Returns a disposer that
 * removes the listeners so tests and clean shutdown leave no residual handlers.
 */
export function installProcessSignalAbort(
  controller: AbortController,
  processRef: NodeJS.Process = process,
): () => void {
  const onSignal = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  processRef.once("SIGINT", onSignal);
  processRef.once("SIGTERM", onSignal);
  return () => {
    processRef.off("SIGINT", onSignal);
    processRef.off("SIGTERM", onSignal);
  };
}

export async function loadWorkerCredentialsFromFile(credentialsPath: string): Promise<WorkerCredentials | null> {
  try {
    const fileMode = (await stat(credentialsPath)).mode & 0o777;
    if (fileMode !== CREDENTIAL_FILE_MODE) {
      throw new WorkerCredentialsFileError(
        credentialsPath,
        "unsafe_permissions",
        `expected permissions ${formatOctal(CREDENTIAL_FILE_MODE)} but found ${formatOctal(fileMode)}; fix with chmod 600`,
      );
    }

    const raw = await readFile(credentialsPath, "utf8");
    let parsed: Partial<WorkerCredentials>;
    try {
      parsed = JSON.parse(raw) as Partial<WorkerCredentials>;
    } catch {
      throw new WorkerCredentialsFileError(
        credentialsPath,
        "invalid_json",
        "invalid JSON payload; rewrite the file with a valid enrollment record",
      );
    }
    if (typeof parsed.workerId !== "string" || parsed.workerId.length === 0) {
      throw new WorkerCredentialsFileError(
        credentialsPath,
        "invalid_schema",
        "missing non-empty workerId field",
      );
    }
    if (typeof parsed.workerToken !== "string" || parsed.workerToken.length === 0) {
      throw new WorkerCredentialsFileError(
        credentialsPath,
        "invalid_schema",
        "missing non-empty workerToken field",
      );
    }
    return { workerId: parsed.workerId, workerToken: parsed.workerToken };
  } catch (error) {
    if (error instanceof WorkerCredentialsFileError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function persistWorkerCredentialsAtomically(
  credentialsPath: string,
  credentials: WorkerCredentials,
): Promise<void> {
  const parentDir = dirname(credentialsPath);
  const tmpPath = join(parentDir, `.${basename(credentialsPath)}.${process.pid}.${Date.now()}.tmp`);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(credentials)}\n`;
  await writeFile(tmpPath, payload, { mode: CREDENTIAL_FILE_MODE });
  await rename(tmpPath, credentialsPath);
}

export async function resolveWorkerCredentials(
  input: CredentialResolutionInput,
  enroller: Enroller,
  log: (line: string) => void,
): Promise<WorkerCredentials> {
  if (input.workerId && input.workerToken) {
    return { workerId: input.workerId, workerToken: input.workerToken };
  }

  if (input.credentialsPath) {
    const persisted = await loadWorkerCredentialsFromFile(input.credentialsPath);
    if (persisted) return persisted;
  }

  const enrolled = await enroller.enroll();
  const resolved = { workerId: enrolled.id, workerToken: enrolled.token };
  if (input.credentialsPath) {
    await persistWorkerCredentialsAtomically(input.credentialsPath, resolved);
  }
  for (const line of createEnrollmentMessages(resolved.workerId, input.credentialsPath)) {
    log(line);
  }
  return resolved;
}

/**
 * Worker agent: enrolls with the control plane (token returned once, kept in
 * memory/config — the server stores only a hash), heartbeats via the lease
 * poll, executes leased terminal sessions and streams output back. Honors
 * cancel requests signalled in output acknowledgements.
 */
export class WorkerAgent {
  private timer: NodeJS.Timeout | null = null;
  private active = new Map<string, RunnerHandle>();
  private readonly fetchImpl: typeof fetch;
  private pollInFlight = false;
  workerId: string | null;
  private workerToken: string | null;

  constructor(private readonly config: WorkerConfig) {
    const url = new URL(config.controlPlaneUrl);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback && !config.allowInsecureTransport) {
      throw new Error(`refusing insecure worker transport to ${url.host}; remote control planes require HTTPS`);
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.workerId = config.workerId ?? null;
    this.workerToken = config.workerToken ?? null;
  }

  async enroll(): Promise<{ id: string; token: string }> {
    const res = await this.fetchImpl(`${this.config.controlPlaneUrl}/v1/workers/enroll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiToken ? { authorization: `Bearer ${this.config.apiToken}` } : {}),
      },
      body: JSON.stringify({
        name: this.config.name || hostname(),
        capabilities: this.config.capabilities,
        maxConcurrentRuns: this.config.maxConcurrentRuns ?? 4,
      }),
    });
    if (!res.ok) throw new Error(`enrollment failed: HTTP ${res.status}`);
    const body = (await res.json()) as { id: string; token: string };
    this.workerId = body.id;
    this.workerToken = body.token;
    return body;
  }

  /**
   * Begin lease polling. The interval stays referenced on purpose: unlike the
   * control plane (kept alive by its HTTP server), the worker has no other
   * referenced resource. Calling `unref()` empties the event loop and Node
   * exits 0 immediately after bootstrap.
   */
  start(): void {
    if (!this.workerId || !this.workerToken) throw new Error("worker not enrolled");
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.config.pollMs);
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Run until `signal` aborts, then stop polling and drain active terminals.
   * This is the durable lifecycle entrypoint used by the worker process.
   */
  async run(signal: AbortSignal): Promise<void> {
    this.start();
    try {
      await waitUntilAborted(signal);
    } finally {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const handle of this.active.values()) handle.cancel();
    await Promise.all([...this.active.values()].map((h) => h.done));
    this.active.clear();
  }

  private authHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-worker-id": this.workerId!,
      "x-worker-token": this.workerToken!,
    };
  }

  async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const res = await this.fetchImpl(`${this.config.controlPlaneUrl}/v1/workers/lease`, {
        method: "POST",
        headers: this.authHeaders(),
        body: "{}",
      });
      if (!res.ok) return;
      const { lease } = (await res.json()) as { lease: Lease | null };
      if (lease) void this.execute(lease);
    } catch {
      // control plane unreachable: keep polling; reconnection is automatic
    } finally {
      this.pollInFlight = false;
    }
  }

  async execute(lease: Lease): Promise<void> {
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await this.fetchImpl(`${this.config.controlPlaneUrl}${path}`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : {};
    };

    // Serialize streamed output and make the terminal exit report wait for the
    // full output drain. Without this, a fast command's exit POST (which flips
    // the terminal to succeeded/failed) can overtake the fire-and-forget output
    // POST, so an observer that waits for the terminal state then reads the logs
    // sees them empty. Chaining also preserves chunk ordering. A dropped chunk
    // must never block exit reporting, so per-chunk failures are swallowed.
    let outputDrain: Promise<void> = Promise.resolve();
    const run = this.config.runCommandImpl ?? runCommand;
    const handle = run(
      lease.command,
      lease.cwd,
      {
        onOutput: (text) => {
          outputDrain = outputDrain.then(async () => {
            try {
              const ack = await post(`/v1/terminals/${lease.id}/output`, { text, leaseToken: lease.leaseToken });
              if (ack.cancelRequested) handle.cancel();
            } catch {
              // best-effort streaming; keep draining so exit is never blocked
            }
          });
          return outputDrain;
        },
        onExit: async ({ exitCode, state }) => {
          await outputDrain;
          await post(`/v1/terminals/${lease.id}/exit`, { exitCode, state, leaseToken: lease.leaseToken });
          this.active.delete(lease.id);
        },
      },
      {
        timeoutMs: 15 * 60 * 1000,
        readablePaths: lease.readablePaths,
      },
    );
    this.active.set(lease.id, handle);
    await handle.done;
  }
}
