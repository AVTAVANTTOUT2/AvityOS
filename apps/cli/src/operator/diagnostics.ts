import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CLAUDE_CODE_SANDBOX_POLICY,
  CODEX_SANDBOX_POLICY,
  CURSOR_SANDBOX_POLICY,
  resolveCliProviderAuth,
} from "@avityos/providers";

const execFileAsync = promisify(execFile);

export type ReadinessState =
  | "ready"
  | "blocked_operator_configuration"
  | "blocked_missing_tool"
  | "blocked_missing_credentials"
  | "blocked_product_gap";

export interface DoctorCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly version: 1;
  readonly readiness: ReadinessState;
  readonly checks: readonly DoctorCheck[];
}

export interface ToolProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProviderProbeResult {
  readonly codex: { readonly binary: boolean; readonly auth: boolean };
  readonly claudeCode: { readonly binary: boolean; readonly auth: boolean };
  readonly cursorAgent: { readonly binary: boolean; readonly auth: boolean };
}

export interface ServiceProbeResult {
  readonly controlPlane: "running" | "stopped" | "stale";
  readonly web: "running" | "stopped" | "stale";
  readonly worker: "running" | "stopped" | "stale";
}

export interface ApiProbeResult {
  readonly health: boolean;
  readonly providersStatus: boolean;
}

export interface SandboxProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

type SandboxBinary = "sandbox-exec" | "bwrap";

export interface DoctorDependencies {
  readonly commandProbe?: (tool: "node" | "pnpm" | "git" | "gh") => Promise<ToolProbeResult>;
  readonly providerProbe?: () => Promise<ProviderProbeResult>;
  readonly serviceProbe?: () => Promise<ServiceProbeResult>;
  readonly apiProbe?: () => Promise<ApiProbeResult>;
  readonly sandboxProbe?: () => Promise<SandboxProbeResult>;
  readonly sandboxBinaryProbe?: (binary: SandboxBinary) => Promise<ToolProbeResult>;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((x) => Number(x) || 0);
  const b = right.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function defaultCommandProbe(tool: "node" | "pnpm" | "git" | "gh"): Promise<ToolProbeResult> {
  try {
    const { stdout } = await execFileAsync(tool, ["--version"], { encoding: "utf8" });
    return { ok: true, detail: stdout.trim() };
  } catch {
    return { ok: false, detail: `${tool} not found` };
  }
}

export async function probeProviderReadiness(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly realHome?: string;
    readonly probeBinary?: (binary: string) => Promise<boolean>;
  } = {},
): Promise<ProviderProbeResult> {
  const probeBinary = options.probeBinary ?? (async (binary: string): Promise<boolean> => {
    try {
      await execFileAsync(binary, ["--version"], { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  });
  const authOptions = options.realHome ? { realHome: options.realHome } : {};
  return {
    codex: {
      binary: await probeBinary(env.AVITY_CODEX_BIN ?? "codex"),
      auth: resolveCliProviderAuth(CODEX_SANDBOX_POLICY, env, authOptions).authenticated,
    },
    claudeCode: {
      binary: await probeBinary(env.AVITY_CLAUDE_CODE_BIN ?? "claude"),
      auth: resolveCliProviderAuth(CLAUDE_CODE_SANDBOX_POLICY, env, authOptions).authenticated,
    },
    cursorAgent: {
      binary: await probeBinary(env.AVITY_CURSOR_BIN ?? "cursor-agent"),
      auth: resolveCliProviderAuth(CURSOR_SANDBOX_POLICY, env, authOptions).authenticated,
    },
  };
}

async function defaultProviderProbe(): Promise<ProviderProbeResult> {
  return probeProviderReadiness();
}

async function defaultServiceProbe(): Promise<ServiceProbeResult> {
  return { controlPlane: "stopped", web: "stopped", worker: "stopped" };
}

async function defaultApiProbe(): Promise<ApiProbeResult> {
  return { health: false, providersStatus: false };
}

async function defaultSandboxBinaryProbe(binary: SandboxBinary): Promise<ToolProbeResult> {
  try {
    await execFileAsync(binary, ["--help"], { encoding: "utf8" });
    return { ok: true, detail: `${binary} available` };
  } catch (error) {
    const probeError = error as NodeJS.ErrnoException & { code?: string | number };
    if (probeError.code === "ENOENT") {
      return { ok: false, detail: `${binary} not found` };
    }
    if (typeof probeError.code === "number") {
      return { ok: true, detail: `${binary} available (exit ${probeError.code})` };
    }
    return { ok: false, detail: `${binary} probe failed (${String(probeError.code ?? "unknown")})` };
  }
}

async function defaultSandboxProbe(
  platform: NodeJS.Platform,
  sandboxBinaryProbe: (binary: SandboxBinary) => Promise<ToolProbeResult>,
): Promise<SandboxProbeResult> {
  if (platform === "darwin") {
    const sandbox = await sandboxBinaryProbe("sandbox-exec");
    return {
      ok: sandbox.ok,
      detail: sandbox.ok
        ? "sandbox-exec detected on macOS host"
        : `sandbox-exec required on macOS host: ${sandbox.detail}`,
    };
  }
  if (platform === "linux") {
    const bwrap = await sandboxBinaryProbe("bwrap");
    return {
      ok: bwrap.ok,
      detail: bwrap.ok
        ? "bwrap detected on Linux host"
        : `bwrap required on Linux host: ${bwrap.detail}`,
    };
  }
  return {
    ok: false,
    detail: `unsupported platform ${platform}; supported platforms are darwin (sandbox-exec) and linux (bwrap)`,
  };
}

function resolveReadiness(checks: readonly DoctorCheck[]): ReadinessState {
  if (checks.some((check) => ["pnpm", "git", "gh", "node"].includes(check.id) && !check.ok)) return "blocked_missing_tool";
  if (checks.some((check) => check.id === "sandbox" && !check.ok)) return "blocked_operator_configuration";
  if (checks.some((check) => check.id === "providers" && !check.ok)) return "blocked_missing_credentials";
  if (checks.some((check) => !check.ok)) return "blocked_product_gap";
  return "ready";
}

/**
 * Collect host diagnostics for the local operator lifecycle.
 */
export async function collectDoctorReport(deps: DoctorDependencies = {}): Promise<DoctorReport> {
  const commandProbe = deps.commandProbe ?? defaultCommandProbe;
  const providerProbe = deps.providerProbe ?? defaultProviderProbe;
  const serviceProbe = deps.serviceProbe ?? defaultServiceProbe;
  const apiProbe = deps.apiProbe ?? defaultApiProbe;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const platform = deps.platform ?? process.platform;
  const sandboxBinaryProbe = deps.sandboxBinaryProbe ?? defaultSandboxBinaryProbe;
  const sandboxProbe = deps.sandboxProbe ?? (() => defaultSandboxProbe(platform, sandboxBinaryProbe));

  const [node, pnpm, git, gh, sandbox, providers, services, api] = await Promise.all([
    Promise.resolve({ ok: compareVersions(nodeVersion, "22.5.0") >= 0, detail: nodeVersion }),
    commandProbe("pnpm"),
    commandProbe("git"),
    commandProbe("gh"),
    sandboxProbe(),
    providerProbe(),
    serviceProbe(),
    apiProbe(),
  ]);

  const providerBinaryOk = providers.codex.binary && providers.claudeCode.binary && providers.cursorAgent.binary;
  const providerAuthOk = providers.codex.auth && providers.claudeCode.auth && providers.cursorAgent.auth;
  const checks: DoctorCheck[] = [
    { id: "node", ok: node.ok, detail: node.detail },
    { id: "pnpm", ok: pnpm.ok, detail: pnpm.detail },
    { id: "git", ok: git.ok, detail: git.detail },
    { id: "gh", ok: gh.ok, detail: gh.detail },
    { id: "sandbox", ok: sandbox.ok, detail: sandbox.detail },
    {
      id: "providers",
      ok: providerBinaryOk && providerAuthOk,
      detail: `codex(binary=${providers.codex.binary},auth=${providers.codex.auth}) claude(binary=${providers.claudeCode.binary},auth=${providers.claudeCode.auth}) cursor(binary=${providers.cursorAgent.binary},auth=${providers.cursorAgent.auth})`,
    },
    {
      id: "services",
      ok: services.controlPlane === "running" && services.web === "running",
      detail: `control-plane=${services.controlPlane}, web=${services.web}, worker=${services.worker}`,
    },
    {
      id: "control_plane",
      ok: api.health && api.providersStatus,
      detail: `health=${api.health}, providers_status=${api.providersStatus}`,
    },
  ];
  return {
    version: 1,
    readiness: resolveReadiness(checks),
    checks,
  };
}
