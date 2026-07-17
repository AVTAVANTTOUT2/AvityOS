import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface CliConfig {
  controlPlaneUrl: string;
  apiToken?: string;
  defaultProjectId?: string;
}

export const CONFIG_PATH = process.env.AVITY_CONFIG ?? join(homedir(), ".avity", "cli.json");

export function loadConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CliConfig;
  } catch {
    return { controlPlaneUrl: process.env.AVITY_CONTROL_PLANE_URL ?? "http://127.0.0.1:7717" };
  }
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class Client {
  constructor(private readonly config: CliConfig) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.config.apiToken) headers.authorization = `Bearer ${this.config.apiToken}`;
    let res: Response;
    try {
      res = await fetch(`${this.config.controlPlaneUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ApiError(0, "unreachable", `control plane unreachable at ${this.config.controlPlaneUrl}: ${err}`);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const error = json.error as { code?: string; message?: string } | undefined;
      throw new ApiError(res.status, error?.code ?? "unknown", error?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}
