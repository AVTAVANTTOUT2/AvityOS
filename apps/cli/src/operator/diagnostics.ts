import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export interface DoctorDependencies {
  readonly commandProbe?: (tool: "node" | "pnpm" | "git" | "gh") => Promise<ToolProbeResult>;
  readonly providerProbe?: () => Promise<ProviderProbeResult>;
  readonly serviceProbe?: () => Promise<ServiceProbeResult>;
  readonly apiProbe?: () => Promise<ApiProbeResult>;
  readonly sandboxProbe?: () => Promise<SandboxProbeResult>;
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

async function defaultProviderProbe(): Promise<ProviderProbeResult> {
  const probeBinary = async (binary: string): Promise<boolean> => {
    try {
      await execFileAsync(binary, ["--version"], { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  };
  return {
    codex: { binary: await probeBinary("codex"), auth: Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) },
    claudeCode: {
      binary: await probeBinary("claude"),
      auth: Boolean(process.env.ANTHROPIC_API_KEY),
    },
    cursorAgent: { binary: await probeBinary("cursor-agent"), auth: Boolean(process.env.CURSOR_API_KEY) },
  };
}

async function defaultServiceProbe(): Promise<ServiceProbeResult> {
  return { controlPlane: "stopped", web: "stopped", worker: "stopped" };
}

async function defaultApiProbe(): Promise<ApiProbeResult> {
  return { health: false, providersStatus: false };
}

async function defaultSandboxProbe(platform: NodeJS.Platform): Promise<SandboxProbeResult> {
  if (platform === "darwin") {
    const sandbox = await defaultCommandProbe("node");
    return {
      ok: sandbox.ok && Boolean(process.env.PATH?.includes("/usr/bin")),
      detail: sandbox.ok ? "sandbox-exec expected on macOS host" : "node missing",
    };
  }
  if (platform === "linux") {
    const bwrap = await defaultCommandProbe("git");
    return { ok: bwrap.ok && Boolean(process.env.PATH), detail: bwrap.ok ? "bubblewrap expected on Linux host" : "git missing" };
  }
  return { ok: false, detail: `unsupported platform ${platform}` };
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
  const sandboxProbe = deps.sandboxProbe ?? (() => defaultSandboxProbe(platform));

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
