import { openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { OperatorPaths, OperatorServiceName, OperatorServicePaths } from "./paths.js";
import { redactText } from "./redact.js";
import { loadOperatorEnvironment } from "./setup.js";

const DEFAULT_MAX_LOG_FILE_BYTES = 256 * 1024;

export interface ServiceStatus {
  readonly state: "running" | "stopped" | "stale";
  readonly pid: number | null;
}

export interface ServiceStatusReport {
  readonly controlPlane: ServiceStatus;
  readonly web: ServiceStatus;
  readonly worker: ServiceStatus;
}

export interface SpawnResult {
  readonly pid: number;
}

export interface ServiceLifecycleDependencies {
  readonly isPidRunning?: (pid: number) => boolean;
  readonly spawnDetached?: (service: OperatorServiceName, env: Record<string, string>) => SpawnResult;
  readonly terminatePid?: (pid: number) => Promise<boolean>;
  readonly prepareLogFileForAppend?: (service: OperatorServiceName) => void;
}

function parsePid(path: string): number | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function resolveService(paths: OperatorPaths, service: OperatorServiceName): OperatorServicePaths {
  if (service === "control-plane") return paths.services.controlPlane;
  if (service === "web") return paths.services.web;
  return paths.services.worker;
}

function defaultPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function boundLogFileForAppend(logFilePath: string, maxBytes = DEFAULT_MAX_LOG_FILE_BYTES): void {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`invalid log size bound: ${maxBytes}`);
  }
  let size = 0;
  try {
    size = statSync(logFilePath).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  try {
    const content = readFileSync(logFilePath);
    const bounded = content.subarray(content.length - maxBytes);
    writeFileSync(logFilePath, bounded, { mode: 0o600 });
  } catch {
    throw new Error(`failed to bound log file before append: ${logFilePath}`);
  }
}

function defaultSpawnDetached(paths: OperatorPaths, service: OperatorServiceName, env: Record<string, string>): SpawnResult {
  const command = "pnpm";
  const args = service === "control-plane"
    ? ["--filter", "@avityos/control-plane", "start"]
    : service === "web"
      ? ["--filter", "@avityos/web", "start"]
      : ["--filter", "@avityos/worker", "start"];
  const servicePaths = resolveService(paths, service);
  const outFd = openSync(servicePaths.logFilePath, "a", 0o600);
  const child = spawn(command, args, {
    cwd: paths.repositoryRoot,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", outFd, outFd],
  });
  child.unref();
  return { pid: child.pid ?? 0 };
}

async function defaultTerminatePid(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!defaultPidRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * Manage detached local services for operator lifecycle commands.
 */
export class OperatorServiceLifecycle {
  private readonly deps: Required<ServiceLifecycleDependencies>;

  constructor(
    private readonly paths: OperatorPaths,
    deps: ServiceLifecycleDependencies = {},
  ) {
    this.deps = {
      isPidRunning: deps.isPidRunning ?? defaultPidRunning,
      spawnDetached: deps.spawnDetached ?? ((service, env) => defaultSpawnDetached(this.paths, service, env)),
      terminatePid: deps.terminatePid ?? defaultTerminatePid,
      prepareLogFileForAppend: deps.prepareLogFileForAppend ?? ((service) => {
        const servicePaths = resolveService(this.paths, service);
        boundLogFileForAppend(servicePaths.logFilePath);
      }),
    };
  }

  private inspectService(service: OperatorServiceName): ServiceStatus {
    const servicePaths = resolveService(this.paths, service);
    const pid = parsePid(servicePaths.pidFilePath);
    if (!pid) return { state: "stopped", pid: null };
    if (this.deps.isPidRunning(pid)) return { state: "running", pid };
    return { state: "stale", pid };
  }

  private clearPidIfStale(service: OperatorServiceName): ServiceStatus {
    const servicePaths = resolveService(this.paths, service);
    const status = this.inspectService(service);
    if (status.state === "stale") {
      unlinkSync(servicePaths.pidFilePath);
      return { state: "stale", pid: status.pid };
    }
    return status;
  }

  async start(services: readonly OperatorServiceName[]): Promise<void> {
    const env = loadOperatorEnvironment(this.paths);
    for (const service of services) {
      const status = this.clearPidIfStale(service);
      if (status.state === "running") continue;
      if (service === "control-plane" && !env.AVITY_API_TOKEN) {
        throw new Error("control-plane start blocked: AVITY_API_TOKEN is missing in protected operator env");
      }
      if (service === "worker" && (!env.AVITY_WORKER_ID || !env.AVITY_WORKER_TOKEN)) {
        throw new Error("worker start blocked: persistent worker credentials are not configured yet (Task 4 boundary)");
      }
      this.deps.prepareLogFileForAppend(service);
      const created = this.deps.spawnDetached(service, env);
      if (!created.pid) {
        throw new Error(`${service} failed to start`);
      }
      const servicePaths = resolveService(this.paths, service);
      writeFileSync(servicePaths.pidFilePath, `${created.pid}\n`, { mode: 0o600 });
    }
  }

  async stop(services: readonly OperatorServiceName[]): Promise<void> {
    for (const service of services) {
      const servicePaths = resolveService(this.paths, service);
      const pid = parsePid(servicePaths.pidFilePath);
      if (!pid) continue;
      await this.deps.terminatePid(pid);
      try {
        unlinkSync(servicePaths.pidFilePath);
      } catch {
        // ignore absent stale pid file
      }
    }
  }

  async restart(services: readonly OperatorServiceName[]): Promise<void> {
    await this.stop(services);
    await this.start(services);
  }

  async status(): Promise<ServiceStatusReport> {
    return {
      controlPlane: this.clearPidIfStale("control-plane"),
      web: this.clearPidIfStale("web"),
      worker: this.clearPidIfStale("worker"),
    };
  }

  readLogs(service: OperatorServiceName, options: { readonly maxBytes: number }): string {
    const servicePaths = resolveService(this.paths, service);
    const content = readFileSync(servicePaths.logFilePath, "utf8");
    const bounded = content.length > options.maxBytes ? content.slice(content.length - options.maxBytes) : content;
    return redactText(bounded);
  }
}
