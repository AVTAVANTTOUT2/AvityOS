import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { collectDoctorReport } from "./diagnostics.js";
import { readEnvFile, writeEnvFileAtomic } from "./env.js";
import type { OperatorPaths } from "./paths.js";

export interface SetupCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SetupCommandRunner {
  run(command: string, args: readonly string[], options?: { readonly cwd?: string }): SetupCommandResult;
}

export interface SetupResult {
  readonly created: readonly string[];
  readonly preserved: readonly string[];
  readonly readiness: string;
}

export interface EnsureOperatorSetupOptions {
  readonly paths: OperatorPaths;
  readonly runner: SetupCommandRunner;
  readonly force: boolean;
  readonly env: NodeJS.ProcessEnv;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeSetupState(paths: OperatorPaths): void {
  const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(paths.setupStatePath, `${payload}\n`, { mode: 0o600 });
  chmodSync(paths.setupStatePath, 0o600);
}

function runOrFail(result: SetupCommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode}`);
  }
}

/**
 * Prepare secure local operator state. Idempotent by default.
 */
export async function ensureOperatorSetup(options: EnsureOperatorSetupOptions): Promise<SetupResult> {
  const { paths, runner, force, env } = options;
  ensurePrivateDirectory(paths.rootDir);
  ensurePrivateDirectory(paths.configDir);
  ensurePrivateDirectory(paths.runDir);
  ensurePrivateDirectory(paths.logsDir);
  ensurePrivateDirectory(paths.reportsDir);

  const created: string[] = [];
  const preserved: string[] = [];
  const envExists = existsSync(paths.operatorEnvPath);
  const current = envExists ? readEnvFile(paths.operatorEnvPath) : {};

  if (!envExists) created.push(paths.operatorEnvPath);
  if (envExists && !force) {
    preserved.push(paths.operatorEnvPath);
  }
  const nextEnv = (envExists && !force)
    ? current
    : {
      AVITY_CONTROL_PLANE_URL: current.AVITY_CONTROL_PLANE_URL ?? env.AVITY_CONTROL_PLANE_URL ?? "http://127.0.0.1:7717",
      ...(current.AVITY_API_TOKEN ? { AVITY_API_TOKEN: current.AVITY_API_TOKEN } : env.AVITY_API_TOKEN ? { AVITY_API_TOKEN: env.AVITY_API_TOKEN } : {}),
      ...(current.AVITY_WORKER_ID ? { AVITY_WORKER_ID: current.AVITY_WORKER_ID } : {}),
      ...(current.AVITY_WORKER_TOKEN ? { AVITY_WORKER_TOKEN: current.AVITY_WORKER_TOKEN } : {}),
    };
  if (!envExists || force) {
    writeEnvFileAtomic(paths.operatorEnvPath, nextEnv);
  } else {
    const mode = statSync(paths.operatorEnvPath).mode & 0o777;
    if (mode !== 0o600) chmodSync(paths.operatorEnvPath, 0o600);
  }

  writeSetupState(paths);
  const report = await collectDoctorReport({ nodeVersion: env.AVITY_NODE_VERSION_OVERRIDE ?? process.versions.node });
  if (report.readiness === "blocked_missing_tool") {
    const missing = report.checks.filter((check) => !check.ok).map((check) => check.id).join(", ");
    throw new Error(`setup blocked: missing required tools (${missing})`);
  }
  if (report.readiness === "blocked_operator_configuration") {
    throw new Error("setup blocked: sandbox support is missing; no unsandboxed fallback is allowed");
  }

  runOrFail(runner.run("pnpm", ["--filter", "@avityos/control-plane", "build"], { cwd: paths.repositoryRoot }), "control-plane build");
  runOrFail(runner.run("pnpm", ["--filter", "@avityos/worker", "build"], { cwd: paths.repositoryRoot }), "worker build");
  runOrFail(runner.run("pnpm", ["--filter", "@avityos/web", "build"], { cwd: paths.repositoryRoot }), "web build");

  return {
    created,
    preserved,
    readiness: report.readiness,
  };
}

export function loadOperatorEnvironment(paths: OperatorPaths): Record<string, string> {
  if (!existsSync(paths.operatorEnvPath)) {
    throw new Error(`operator env missing at ${paths.operatorEnvPath}; run "avity setup" first`);
  }
  return readEnvFile(paths.operatorEnvPath);
}

export function saveOperatorEnvironment(paths: OperatorPaths, env: Record<string, string>): void {
  writeEnvFileAtomic(paths.operatorEnvPath, env);
}

export function mergeOperatorEnvironment(
  current: Record<string, string>,
  updates: Record<string, string | undefined>,
): Record<string, string> {
  const next: Record<string, string> = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    next[key] = value;
  }
  return next;
}

export function readProtectedTokenFromFile(path: string): string {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`token file ${path} must have mode 0600`);
  }
  return readFileSync(path, "utf8").trim();
}
