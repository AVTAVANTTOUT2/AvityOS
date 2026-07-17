import { hostname } from "node:os";
import { runCommand, type RunnerHandle } from "./runner.js";

export interface WorkerConfig {
  controlPlaneUrl: string;
  name: string;
  workerId?: string;
  workerToken?: string;
  pollMs: number;
  capabilities: string[];
  fetchImpl?: typeof fetch;
}

interface Lease {
  id: string;
  command: string[];
  cwd: string;
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
  workerId: string | null;
  private workerToken: string | null;

  constructor(private readonly config: WorkerConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.workerId = config.workerId ?? null;
    this.workerToken = config.workerToken ?? null;
  }

  async enroll(): Promise<{ id: string; token: string }> {
    const res = await this.fetchImpl(`${this.config.controlPlaneUrl}/v1/workers/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: this.config.name || hostname(),
        capabilities: this.config.capabilities,
      }),
    });
    if (!res.ok) throw new Error(`enrollment failed: HTTP ${res.status}`);
    const body = (await res.json()) as { id: string; token: string };
    this.workerId = body.id;
    this.workerToken = body.token;
    return body;
  }

  start(): void {
    if (!this.workerId || !this.workerToken) throw new Error("worker not enrolled");
    this.timer = setInterval(() => void this.poll(), this.config.pollMs);
    this.timer.unref?.();
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
    try {
      const res = await this.fetchImpl(`${this.config.controlPlaneUrl}/v1/workers/lease`, {
        method: "POST",
        headers: this.authHeaders(),
        body: "{}",
      });
      if (!res.ok) return;
      const { lease } = (await res.json()) as { lease: Lease | null };
      if (lease) await this.execute(lease);
    } catch {
      // control plane unreachable: keep polling; reconnection is automatic
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

    const handle = runCommand(
      lease.command,
      lease.cwd,
      {
        onOutput: async (text) => {
          const ack = await post(`/v1/terminals/${lease.id}/output`, { text });
          if (ack.cancelRequested) handle.cancel();
        },
        onExit: async ({ exitCode, state }) => {
          await post(`/v1/terminals/${lease.id}/exit`, { exitCode, state });
          this.active.delete(lease.id);
        },
      },
      { timeoutMs: 15 * 60 * 1000 },
    );
    this.active.set(lease.id, handle);
    await handle.done;
  }
}
