import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";

export interface CliConfig {
  controlPlaneUrl: string;
  apiToken?: string;
  defaultProjectId?: string;
}

export const CONFIG_PATH = process.env.AVITY_CONFIG ?? join(homedir(), ".avity", "cli.json");
const KEYCHAIN_SERVICE = "com.avityos.cli";

function usesKeychain(): boolean {
  return process.platform === "darwin" && process.env.AVITY_DISABLE_KEYCHAIN !== "1";
}

function loadKeychainToken(): string | undefined {
  if (!usesKeychain()) return undefined;
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", userInfo().username, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveKeychainToken(token: string): void {
  execFileSync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", userInfo().username, "-w"],
    { input: `${token}\n`, stdio: ["pipe", "ignore", "pipe"] },
  );
}

export function loadConfig(): CliConfig {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CliConfig;
    const apiToken = process.env.AVITY_API_TOKEN ?? loadKeychainToken() ?? config.apiToken;
    return { ...config, ...(apiToken ? { apiToken } : {}) };
  } catch {
    const apiToken = process.env.AVITY_API_TOKEN ?? loadKeychainToken();
    return {
      controlPlaneUrl: process.env.AVITY_CONTROL_PLANE_URL ?? "http://127.0.0.1:7717",
      ...(apiToken ? { apiToken } : {}),
    };
  }
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  if (config.apiToken && usesKeychain()) saveKeychainToken(config.apiToken);
  const diskConfig = usesKeychain()
    ? { ...config, apiToken: undefined }
    : config;
  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(diskConfig, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, CONFIG_PATH);
  chmodSync(CONFIG_PATH, 0o600);
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

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
}
