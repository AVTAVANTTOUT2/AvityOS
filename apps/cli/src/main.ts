#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { E2EPreflightReport } from "@avityos/contracts";
import {
  ApiError,
  Client,
  loadConfig,
  resolveConfigPath,
  saveConfig,
} from "./client.js";
import { collectDoctorReport } from "./operator/diagnostics.js";
import { readEnvFile } from "./operator/env.js";
import { resolveOperatorPaths, type OperatorServiceName } from "./operator/paths.js";
import { redactText } from "./operator/redact.js";
import { ensureOperatorSetup, mergeOperatorEnvironment, readProtectedTokenFromFile, saveOperatorEnvironment } from "./operator/setup.js";
import { OperatorServiceLifecycle } from "./operator/services.js";
import { createExternalLiveFixture } from "./operator/fixture.js";
import { prepareLiveCampaign, runLiveCampaign } from "./operator/campaign.js";
import {
  createCampaignReportWriter,
  createCampaignStateStore,
} from "./operator/campaign-report.js";

interface ProviderStatusReasonView {
  code: string;
  category: string;
  message: string;
  tools: string[];
  environmentVariables: string[];
  remediation: string[];
}

interface ProviderStatusEntryView {
  name: string;
  kind: string;
  real: boolean;
  registered: boolean;
  status: string;
  reasons: ProviderStatusReasonView[];
  workspaceEdits: boolean;
  missionRoutable: boolean;
  routedRoles: string[];
}

interface ProviderStatusCheckView {
  key: string;
  status: string;
  detail: string;
  reasons: ProviderStatusReasonView[];
}

interface ProviderStatusReportView {
  schemaVersion: number;
  generatedAt: string;
  executionMode: string;
  campaign: {
    faultInjection: {
      enabled: boolean;
      provider: string | null;
      category: string | null;
    };
  };
  providers: ProviderStatusEntryView[];
  checks: ProviderStatusCheckView[];
  note: string;
}

function reasonCategory(
  reasons: readonly ProviderStatusReasonView[],
  code: string,
): string {
  return reasons.find((reason) => reason.code === code)?.category ?? "ready";
}

function formatProviderStatusHuman(report: ProviderStatusReportView): string {
  const providerBlocks = report.providers.map((provider) => {
    const binary = provider.kind === "cli"
      ? reasonCategory(provider.reasons, "binary_missing")
      : "n/a";
    const auth = reasonCategory(provider.reasons, "auth_missing");
    const sandbox = provider.kind === "cli"
      ? (provider.registered ? "ready" : "blocked_missing_tool")
      : "n/a";
    return [
      provider.name,
      `  binary: ${binary}`,
      `  sandbox: ${sandbox}`,
      `  auth: ${auth}`,
      `  workspace_edits: ${provider.workspaceEdits ? "yes" : "no"}`,
      `  registered: ${provider.registered ? "yes" : "no"}`,
      `  status: ${provider.status}`,
      `  reachable_roles: ${provider.routedRoles.length ? provider.routedRoles.join(", ") : "(none)"}`,
    ].join("\n");
  });
  const checks = report.checks.map((check) =>
    `${check.key}: ${check.status} — ${check.detail}`
  );
  return [
    `execution mode: ${report.executionMode}`,
    `fault injection: ${report.campaign.faultInjection.enabled ? "enabled" : "disabled"}`,
    "",
    ...providerBlocks,
    "",
    "checks:",
    ...checks,
    "",
    report.note,
  ].join("\n");
}

/**
 * The `avity` CLI. Human output by default; pass --json anywhere for
 * machine-readable output. Exit codes: 0 success, 1 API/runtime error,
 * 2 usage error.
 */

interface Ctx {
  client: Client;
  json: boolean;
  args: string[];
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function out(ctx: Ctx, data: unknown, human: (d: never) => string): void {
  if (ctx.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(human(data as never));
  }
}

function table(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return "(none)";
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join("  ");
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(columns.map((c) => String(r[c] ?? ""))))].join("\n");
}

function requireArg(ctx: Ctx, index: number, name: string): string {
  const value = ctx.args[index];
  if (!value) {
    throw new UsageError(`missing required argument: <${name}>`);
  }
  return value;
}

function flag(ctx: Ctx, name: string): string | undefined {
  const idx = ctx.args.indexOf(`--${name}`);
  const value = idx >= 0 ? ctx.args[idx + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function flagValues(ctx: Ctx, name: string): string[] {
  return ctx.args.flatMap((value, index) => value === `--${name}` && ctx.args[index + 1] && !ctx.args[index + 1]!.startsWith("--")
    ? [ctx.args[index + 1]!]
    : []);
}

function hasFlag(ctx: Ctx, name: string): boolean {
  return ctx.args.includes(`--${name}`);
}

function numberFlag(ctx: Ctx, name: string): number | undefined {
  const value = flag(ctx, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

function boundedPositiveIntegerFlag(
  ctx: Ctx,
  name: string,
  options: { readonly min: number; readonly max: number; readonly defaultValue: number },
): number {
  const value = flag(ctx, name);
  if (value === undefined) return options.defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--${name} must be an integer between ${options.min} and ${options.max}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new UsageError(`--${name} must be an integer between ${options.min} and ${options.max}`);
  }
  return parsed;
}

type Handler = (ctx: Ctx) => Promise<void>;

function resolveRepositoryRoot(): string {
  const fromConfig = dirname(dirname(dirname(resolveConfigPath())));
  return process.env.AVITY_REPOSITORY_ROOT ?? process.cwd() ?? fromConfig;
}

function setupRunner(): { run: (command: string, args: readonly string[], options?: { cwd?: string }) => { exitCode: number; stdout: string; stderr: string } } {
  return {
    run(command, args, options) {
      try {
        const stdout = execFileSync(command, [...args], { cwd: options?.cwd, encoding: "utf8", stdio: "pipe" });
        return { exitCode: 0, stdout, stderr: "" };
      } catch (error) {
        const details = error as { status?: number; stdout?: string; stderr?: string };
        return {
          exitCode: details.status ?? 1,
          stdout: details.stdout ?? "",
          stderr: details.stderr ?? "",
        };
      }
    },
  };
}

function selectedServices(ctx: Ctx): OperatorServiceName[] {
  const service = flag(ctx, "service");
  if (!service || service === "all") return ["control-plane", "web", "worker"];
  if (service === "control-plane" || service === "web" || service === "worker") return [service];
  throw new UsageError(`unknown service: ${service} (allowed: control-plane|web|worker|all)`);
}

async function collectCliDoctorReport(client: Client) {
  const paths = resolveOperatorPaths({ repositoryRoot: resolveRepositoryRoot() });
  const lifecycle = new OperatorServiceLifecycle(paths);
  return collectDoctorReport({
    serviceProbe: async () => {
      const status = await lifecycle.status();
      return {
        controlPlane: status.controlPlane.state,
        web: status.web.state,
        worker: status.worker.state,
      };
    },
    apiProbe: async () => {
      try {
        const health = await client.get<{ status: string }>("/v1/health");
        await client.get<{ version: number; items: unknown[] }>("/v1/providers/status");
        return { health: health.status === "ok", providersStatus: true };
      } catch {
        return { health: false, providersStatus: false };
      }
    },
  });
}

function campaignRetentionCount(): number {
  const raw = process.env.AVITY_E2E_REPORT_RETENTION ?? "20";
  if (!/^\d+$/.test(raw)) {
    throw new UsageError("AVITY_E2E_REPORT_RETENTION must be an integer between 1 and 1000");
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new UsageError("AVITY_E2E_REPORT_RETENTION must be an integer between 1 and 1000");
  }
  return parsed;
}

function campaignConfiguration() {
  const config = loadConfig();
  return {
    cliVersion: "0.1.0",
    controlPlaneUrl: config.controlPlaneUrl,
    environment: {
      AVITY_EXECUTION_MODE: process.env.AVITY_EXECUTION_MODE,
      AVITY_PROVIDER_CHAIN: process.env.AVITY_PROVIDER_CHAIN,
      AVITY_BRAIN_PROVIDER_CHAIN: process.env.AVITY_BRAIN_PROVIDER_CHAIN,
      AVITY_REVIEWER_PROVIDER_CHAIN: process.env.AVITY_REVIEWER_PROVIDER_CHAIN,
      AVITY_CAMPAIGN_FAULT_PROVIDER: process.env.AVITY_CAMPAIGN_FAULT_PROVIDER,
      AVITY_CAMPAIGN_FAULT_CATEGORY: process.env.AVITY_CAMPAIGN_FAULT_CATEGORY,
      AVITY_API_TOKEN: process.env.AVITY_API_TOKEN,
    },
  };
}

async function interactiveProjectConfirmation(projectId: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(
      `Type the exact project id "${projectId}" to authorize objective submission: `,
    );
  } finally {
    prompt.close();
  }
}

const commands: Record<string, Handler | Record<string, Handler>> = {
  setup: async (ctx) => {
    const paths = resolveOperatorPaths({ repositoryRoot: resolveRepositoryRoot() });
    const config = loadConfig();
    const result = await ensureOperatorSetup({
      paths,
      runner: setupRunner(),
      force: hasFlag(ctx, "force"),
      env: { ...process.env, ...(config.apiToken ? { AVITY_API_TOKEN: config.apiToken } : {}) },
    });
    out(ctx, result, (payload: typeof result) =>
      `setup complete\nreadiness: ${payload.readiness}\ncreated: ${payload.created.length}\npreserved: ${payload.preserved.length}`,
    );
  },

  start: async (ctx) => {
    const paths = resolveOperatorPaths({ repositoryRoot: resolveRepositoryRoot() });
    const lifecycle = new OperatorServiceLifecycle(paths);
    const services = selectedServices(ctx);
    await lifecycle.start(services);
    out(ctx, { started: services }, (payload: { started: string[] }) => `started: ${payload.started.join(", ")}`);
  },

  stop: async (ctx) => {
    const paths = resolveOperatorPaths({ repositoryRoot: resolveRepositoryRoot() });
    const lifecycle = new OperatorServiceLifecycle(paths);
    const services = selectedServices(ctx);
    await lifecycle.stop(services);
    out(ctx, { stopped: services }, (payload: { stopped: string[] }) => `stopped: ${payload.stopped.join(", ")}`);
  },

  restart: async (ctx) => {
    const paths = resolveOperatorPaths({ repositoryRoot: resolveRepositoryRoot() });
    const lifecycle = new OperatorServiceLifecycle(paths);
    const services = selectedServices(ctx);
    await lifecycle.restart(services);
    out(ctx, { restarted: services }, (payload: { restarted: string[] }) => `restarted: ${payload.restarted.join(", ")}`);
  },

  logs: async (ctx) => {
    const service = (flag(ctx, "service") ?? "control-plane") as OperatorServiceName;
    if (!["control-plane", "web", "worker"].includes(service)) {
      throw new UsageError(`unknown service: ${service}`);
    }
    const maxBytes = boundedPositiveIntegerFlag(ctx, "max-bytes", {
      min: 256,
      max: 1_048_576,
      defaultValue: 16_384,
    });
    const paths = resolveOperatorPaths({ repositoryRoot: resolveRepositoryRoot() });
    const lifecycle = new OperatorServiceLifecycle(paths);
    const output = lifecycle.readLogs(service, { maxBytes });
    out(ctx, { service, logs: output }, (payload: { logs: string }) => payload.logs);
  },

  init: async () => {
    const config = loadConfig();
    saveConfig(config);
    console.log(`wrote ${resolveConfigPath()} (control plane: ${config.controlPlaneUrl})`);
  },

  login: async (ctx) => {
    const config = loadConfig();
    const url = flag(ctx, "url");
    const tokenFlag = flag(ctx, "token");
    const tokenFromStdin = hasFlag(ctx, "token-stdin");
    const tokenFile = flag(ctx, "token-file");
    const tokenSources = [tokenFlag ? 1 : 0, tokenFromStdin ? 1 : 0, tokenFile ? 1 : 0].reduce((sum, value) => sum + value, 0);
    if (tokenFlag) {
      throw new UsageError("legacy --token is refused; use --token-stdin or --token-file <0600-path>");
    }
    if (tokenSources > 1) {
      throw new UsageError("only one token source is allowed: --token-stdin OR --token-file");
    }
    let token: string | undefined;
    if (tokenFromStdin) {
      token = readFileSync(0, "utf8").trim();
      if (!token) throw new UsageError("stdin token is empty");
    } else if (tokenFile) {
      token = readProtectedTokenFromFile(tokenFile);
    }
    if (url) config.controlPlaneUrl = url;
    if (token) config.apiToken = token;
    saveConfig(config);
    if (token) {
      const paths = resolveOperatorPaths({ repositoryRoot: resolveRepositoryRoot() });
      try {
        const parsed = readEnvFile(paths.operatorEnvPath);
        saveOperatorEnvironment(paths, mergeOperatorEnvironment(parsed, { AVITY_API_TOKEN: token }));
      } catch (error) {
        const reason = redactText(error instanceof Error ? error.message : "unknown error");
        console.warn(`warning: operator env sync skipped (${reason})`);
      }
    }
    console.log(`saved credentials to ${resolveConfigPath()}`);
  },

  doctor: async (ctx) => {
    const report = await collectCliDoctorReport(ctx.client);
    out(ctx, report, (payload: typeof report) => {
      const labels: Record<string, string> = {
        control_plane: "control plane reachable",
      };
      const rows = payload.checks.map((check) => ({
        check: labels[check.id] ?? check.id,
        ok: check.ok,
        detail: check.detail,
      }));
      return `readiness: ${payload.readiness}\n${table(rows, ["check", "ok", "detail"])}`;
    });
    if (["blocked_missing_tool", "blocked_operator_configuration"].includes(report.readiness)) {
      throw new Error(`doctor blocked: ${report.readiness}`);
    }
  },

  status: async (ctx) => {
    const paths = resolveOperatorPaths({ repositoryRoot: resolveRepositoryRoot() });
    const lifecycle = new OperatorServiceLifecycle(paths);
    const serviceStatus = await lifecycle.status();
    let controlPlaneApi: "ready" | "unavailable" = "unavailable";
    let controlPlaneSummary: {
      projects: number | null;
      activeRuns: number | null;
      openInterventions: number | null;
    } = {
      projects: null,
      activeRuns: null,
      openInterventions: null,
    };
    try {
      const [projects, approvals, runs] = await Promise.all([
        ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/projects"),
        ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/approvals?status=open"),
        ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/runs"),
      ]);
      const active = runs.items.filter((r) => ["queued", "starting", "running"].includes(r.state as string));
      controlPlaneSummary = {
        projects: projects.items.length,
        activeRuns: active.length,
        openInterventions: approvals.items.length,
      };
      controlPlaneApi = "ready";
    } catch {
      // Keep process status, but never misreport an unreachable API as an
      // empty durable store.
    }
    const data = {
      services: serviceStatus,
      controlPlaneApi,
      ...controlPlaneSummary,
    };
    const count = (value: number | null): string =>
      value === null ? "unavailable" : String(value);
    out(ctx, data, (d: typeof data) =>
      [
        `control-plane: ${d.services.controlPlane.state}${d.services.controlPlane.pid ? ` (pid ${d.services.controlPlane.pid})` : ""}`,
        `control-plane API: ${d.controlPlaneApi}`,
        `web: ${d.services.web.state}${d.services.web.pid ? ` (pid ${d.services.web.pid})` : ""}`,
        `worker: ${d.services.worker.state}${d.services.worker.pid ? ` (pid ${d.services.worker.pid})` : ""}`,
        `projects: ${count(d.projects)}`,
        `active runs: ${count(d.activeRuns)}`,
        `open interventions: ${count(d.openInterventions)}`,
      ].join("\n"),
    );
  },

  project: {
    create: async (ctx) => {
      const name = requireArg(ctx, 1, "name");
      const warningPercent = numberFlag(ctx, "warn-at") ?? 80;
      const project = await ctx.client.post<Record<string, unknown>>("/v1/projects", {
        name,
        description: flag(ctx, "description") ?? "",
        autonomyProfile: flag(ctx, "autonomy") ?? "autonomous_with_checkpoints",
        repoPath: flag(ctx, "repo") ?? null,
        repoRemoteUrl: flag(ctx, "remote") ?? null,
        defaultBranch: flag(ctx, "branch") ?? "main",
        objective: flag(ctx, "objective") ?? "",
        acceptanceCriteria: flagValues(ctx, "criterion"),
        budgetUsd: numberFlag(ctx, "budget") ?? null,
        budgetWarnAtFraction: warningPercent / 100,
      });
      out(ctx, project, (p: Record<string, unknown>) => `created project ${p.id} (${p.name})`);
    },
    update: async (ctx) => {
      const id = requireArg(ctx, 1, "project-id");
      const input: Record<string, unknown> = {};
      const values: [string, string][] = [
        ["name", "name"],
        ["description", "description"],
        ["repo", "repoPath"],
        ["remote", "repoRemoteUrl"],
        ["branch", "defaultBranch"],
        ["objective", "objective"],
        ["autonomy", "autonomyProfile"],
      ];
      for (const [option, field] of values) {
        const value = flag(ctx, option);
        if (value !== undefined) input[field] = value;
      }
      const criteria = flagValues(ctx, "criterion");
      if (criteria.length > 0 || hasFlag(ctx, "clear-criteria")) input.acceptanceCriteria = criteria;
      const budget = numberFlag(ctx, "budget");
      if (budget !== undefined) input.budgetUsd = budget;
      if (hasFlag(ctx, "no-budget")) input.budgetUsd = null;
      const warningPercent = numberFlag(ctx, "warn-at");
      if (warningPercent !== undefined) input.budgetWarnAtFraction = warningPercent / 100;
      if (hasFlag(ctx, "no-repo")) {
        input.repoPath = null;
        input.repoRemoteUrl = null;
      }
      const configuration = await ctx.client.patch<Record<string, unknown>>(`/v1/projects/${id}`, input);
      out(ctx, configuration, () => `updated project ${id}`);
    },
    list: async (ctx) => {
      const { items } = await ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/projects");
      out(ctx, items, (rows: Record<string, unknown>[]) => table(rows, ["id", "name", "status", "autonomyProfile"]));
    },
    show: async (ctx) => {
      const id = requireArg(ctx, 1, "project-id");
      const configuration = await ctx.client.get<{
        project: Record<string, unknown>;
        objective: { text: string; acceptanceCriteria: string[] } | null;
        budget: { limitUsd: number; spentUsd: number; warnAtFraction: number } | null;
      }>(`/v1/projects/${id}/configuration`);
      const project = configuration.project;
      const usage = await ctx.client.get<Record<string, unknown>>(`/v1/projects/${id}/usage`);
      out(ctx, { ...configuration, usage }, (d: typeof configuration & { usage: Record<string, unknown> }) =>
        [
          `${d.project.name} (${d.project.id})`,
          `status: ${d.project.status}`,
          `objective: ${d.objective?.text ?? "(none)"}`,
          `criteria: ${d.objective?.acceptanceCriteria.join("; ") ?? "(none)"}`,
          `repository: ${d.project.repoPath ?? "(none)"}`,
          `remote: ${d.project.repoRemoteUrl ?? "(none)"}`,
          `default branch: ${d.project.defaultBranch}`,
          `autonomy: ${d.project.autonomyProfile}`,
          `budget: ${d.budget ? `$${d.budget.limitUsd} (warning at ${Math.round(d.budget.warnAtFraction * 100)}%)` : "unlimited"}`,
          `tokens: ${d.usage.inputTokens} in / ${d.usage.outputTokens} out, cost $${d.usage.costUsd}`,
        ].join("\n"),
      );
    },
    pause: async (ctx) => {
      const id = requireArg(ctx, 1, "project-id");
      const reason = flag(ctx, "reason") ?? "";
      const state = await ctx.client.post<Record<string, unknown>>(`/v1/projects/${id}/pause`, {
        reason,
        idempotencyKey: flag(ctx, "idempotency-key"),
      });
      out(ctx, state, (s: Record<string, unknown>) =>
        `project ${id} ${s.status}${s.reason ? ` — ${s.reason}` : ""} (generation ${s.generation})`,
      );
    },
    resume: async (ctx) => {
      const id = requireArg(ctx, 1, "project-id");
      const state = await ctx.client.post<Record<string, unknown>>(`/v1/projects/${id}/resume`, {
        idempotencyKey: flag(ctx, "idempotency-key"),
      });
      out(ctx, state, (s: Record<string, unknown>) => `project ${id} resumed → ${s.status}`);
    },
  },

  clarification: {
    list: async (ctx) => {
      const projectId = requireArg(ctx, 1, "project-id");
      const status = flag(ctx, "status");
      const path = status
        ? `/v1/projects/${projectId}/clarifications?status=${encodeURIComponent(status)}`
        : `/v1/projects/${projectId}/clarifications`;
      const { items } = await ctx.client.get<{ items: Record<string, unknown>[] }>(path);
      out(ctx, items, (rows: Record<string, unknown>[]) =>
        table(
          rows.map((row) => ({
            id: row.id,
            status: row.status,
            round: row.round,
            provenance: row.provenance,
            questions: Array.isArray(row.questions) ? (row.questions as unknown[]).length : 0,
          })),
          ["id", "status", "round", "provenance", "questions"],
        ),
      );
    },
    show: async (ctx) => {
      const projectId = requireArg(ctx, 1, "project-id");
      const { items } = await ctx.client.get<{
        items: {
          id: string;
          status: string;
          provenance: string;
          round: number;
          questions: {
            id: string;
            logicalKey: string;
            question: string;
            reason: string;
            answerType: string;
            required: boolean;
            options: { key: string; label: string }[];
          }[];
        }[];
      }>(`/v1/projects/${projectId}/clarifications?status=open`);
      const open = items[0];
      if (!open) {
        out(ctx, { items: [] }, () => "no open clarification group");
        return;
      }
      out(ctx, open, (group: typeof open) =>
        [
          `${group.id} — round ${group.round} — ${group.status} — provenance=${group.provenance}`,
          ...group.questions.map(
            (question, index) =>
              `${index + 1}. [${question.logicalKey}] (${question.answerType}${question.required ? ", required" : ""})\n   Q: ${question.question}\n   why: ${question.reason}${
                question.options.length
                  ? `\n   options: ${question.options.map((option) => `${option.key}=${option.label}`).join(", ")}`
                  : ""
              }`,
          ),
        ].join("\n"),
      );
    },
    answer: async (ctx) => {
      const projectId = requireArg(ctx, 1, "project-id");
      const { items } = await ctx.client.get<{
        items: {
          id: string;
          questions: {
            id: string;
            logicalKey: string;
            answerType: string;
            required: boolean;
            question: string;
            options: { key: string; label: string }[];
          }[];
        }[];
      }>(`/v1/projects/${projectId}/clarifications?status=open`);
      const open = items[0];
      if (!open) throw new Error(`no open clarification for project ${projectId}`);

      const jsonFlag = flag(ctx, "answers-json");
      let answers: { questionId: string; answer?: string; value?: unknown }[] = [];
      if (jsonFlag) {
        const parsed = JSON.parse(jsonFlag) as { questionId?: string; logicalKey?: string; answer?: string; value?: unknown }[];
        answers = parsed.map((entry) => {
          const question = open.questions.find(
            (candidate) => candidate.id === entry.questionId || candidate.logicalKey === entry.logicalKey,
          );
          if (!question) throw new Error(`unknown question in --answers-json: ${JSON.stringify(entry)}`);
          return {
            questionId: question.id,
            ...(entry.value !== undefined ? { value: entry.value } : { answer: String(entry.answer ?? "") }),
          };
        });
      } else {
        const pairs = ctx.args.slice(2).filter((arg) => !arg.startsWith("--") && arg.includes("="));
        if (pairs.length === 0) {
          // Interactive: prompt for every required question on stdin.
          const readline = await import("node:readline/promises");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          try {
            for (const question of open.questions) {
              const hint = question.options.length
                ? ` [${question.options.map((option) => option.key).join("|")}]`
                : "";
              const answer = (await rl.question(`${question.logicalKey}${hint}: ${question.question}\n> `)).trim();
              if (!answer && question.required) throw new Error(`missing required answer for ${question.logicalKey}`);
              if (answer) answers.push({ questionId: question.id, answer });
            }
          } finally {
            rl.close();
          }
        } else {
          answers = pairs.map((pair) => {
            const [key, ...rest] = pair.split("=");
            const question = open.questions.find(
              (candidate) => candidate.id === key || candidate.logicalKey === key,
            );
            if (!question) throw new Error(`unknown question key ${key}`);
            return { questionId: question.id, answer: rest.join("=") };
          });
        }
      }
      const result = await ctx.client.post<Record<string, unknown>>(`/v1/clarifications/${open.id}/answers`, {
        answers,
        idempotencyKey: flag(ctx, "idempotency-key"),
      });
      out(ctx, result, () => `clarification ${open.id} answered; planning resumes automatically`);
    },
  },

  objective: {
    submit: async (ctx) => {
      const projectId = requireArg(ctx, 1, "project-id");
      const text = requireArg(ctx, 2, "objective-text");
      const criteria = ctx.args.slice(3).filter((a) => !a.startsWith("--"));
      const result = await ctx.client.post<{ objective: Record<string, unknown>; clarificationId: string | null }>(
        `/v1/projects/${projectId}/objectives`,
        { text, acceptanceCriteria: criteria },
      );
      out(ctx, result, (r: typeof result) =>
        r.clarificationId
          ? `objective recorded; clarification needed: ${r.clarificationId}\nrun: avity intervention list`
          : `objective recorded and planning started (${r.objective.id})`,
      );
    },
  },

  plan: {
    show: async (ctx) => {
      const projectId = requireArg(ctx, 1, "project-id");
      const { plan, dependencies } = await ctx.client.get<{
        plan: Record<string, unknown>;
        dependencies: { missionId: string; dependsOnMissionId: string }[];
      }>(`/v1/projects/${projectId}/plan`);
      out(ctx, { plan, dependencies }, (d: { plan: Record<string, unknown> }) =>
        [
          `plan v${d.plan.version}: ${d.plan.summary}`,
          `provenance: ${d.plan.provenance ?? "(pre-brain plan)"}${d.plan.providerId ? ` — ${d.plan.providerId}/${d.plan.model}` : ""}`,
          ...(d.plan.replanTrigger ? [`replanned (${d.plan.replanTrigger}): ${d.plan.replanCause}`] : []),
        ].join("\n"),
      );
    },
  },

  brain: {
    show: async (ctx) => {
      const projectId = requireArg(ctx, 1, "project-id");
      const state = await ctx.client.get<{
        status: string;
        currentStep: string | null;
        runs: Record<string, unknown>[];
        analysis: { summary?: string; feasibility?: string; risks?: { title: string; severity: string }[] } | null;
        architecture: { overview?: string } | null;
        plan: Record<string, unknown> | null;
        dependencies: { missionId: string; dependsOnMissionId: string }[];
        replanCount: number;
        lastReplan: { trigger: string; cause: string; planVersion: number } | null;
      }>(`/v1/projects/${projectId}/brain/state`);
      out(ctx, state, (s: typeof state) =>
        [
          `status: ${s.status}${s.currentStep ? ` (step: ${s.currentStep})` : ""}`,
          `plan: ${s.plan ? `v${s.plan.version} [${s.plan.provenance ?? "?"}] via ${s.plan.providerId}/${s.plan.model}` : "(none persisted)"}`,
          `analysis: ${s.analysis?.summary ?? "(none persisted)"}`,
          `feasibility: ${s.analysis?.feasibility ?? "—"}; risks: ${(s.analysis?.risks ?? []).map((r) => `${r.title} (${r.severity})`).join(", ") || "—"}`,
          `architecture: ${s.architecture?.overview?.slice(0, 200) ?? "(none persisted)"}`,
          `dependencies: ${s.dependencies.length}`,
          `replans: ${s.replanCount}${s.lastReplan ? ` — last: v${s.lastReplan.planVersion} (${s.lastReplan.trigger}) ${s.lastReplan.cause}` : ""}`,
          "runs:",
          table(
            s.runs.map((r) => ({ step: r.step, state: r.state, attempt: r.attempt, provider: r.providerId, model: r.model, provenance: r.provenance })),
            ["step", "state", "attempt", "provider", "model", "provenance"],
          ),
        ].join("\n"),
      );
    },
  },

  mission: {
    list: async (ctx) => {
      const projectId = requireArg(ctx, 1, "project-id");
      const { items } = await ctx.client.get<{ items: Record<string, unknown>[] }>(`/v1/projects/${projectId}/missions`);
      out(ctx, items, (rows: Record<string, unknown>[]) => table(rows, ["id", "title", "role", "state", "priority"]));
    },
  },

  run: {
    list: async (ctx) => {
      const projectId = flag(ctx, "project");
      const { items } = await ctx.client.get<{ items: Record<string, unknown>[] }>(
        projectId ? `/v1/runs?projectId=${projectId}` : "/v1/runs",
      );
      out(ctx, items, (rows: Record<string, unknown>[]) => table(rows, ["id", "missionId", "model", "state", "costUsd"]));
    },
    logs: async (ctx) => {
      const runId = requireArg(ctx, 1, "run-id");
      const { items } = await ctx.client.get<{ items: { text: string }[] }>(`/v1/runs/${runId}/logs`);
      out(ctx, items, (rows: { text: string }[]) => rows.map((r) => r.text).join(""));
    },
    pause: async (ctx) => missionTransition(ctx, "paused"),
    resume: async (ctx) => missionTransition(ctx, "running"),
    cancel: async (ctx) => missionTransition(ctx, "cancelled"),
  },

  intervention: {
    list: async (ctx) => {
      const { items } = await ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/approvals?status=open");
      const projects = await ctx.client.get<{ items: { id: string }[] }>("/v1/projects");
      const clarifications: Record<string, unknown>[] = [];
      for (const p of projects.items) {
        const c = await ctx.client.get<{ items: Record<string, unknown>[] }>(
          `/v1/projects/${p.id}/clarifications?status=open`,
        );
        clarifications.push(...c.items.map((x) => ({ ...x, kind: "clarification" })));
      }
      const all = [...items.map((x) => ({ ...x, kind: "approval" })), ...clarifications];
      out(ctx, all, (rows: Record<string, unknown>[]) => table(rows, ["kind", "id", "title", "projectId"]));
    },
    answer: async (ctx) => {
      const id = requireArg(ctx, 1, "intervention-id");
      if (id.startsWith("clr_")) {
        const clarification = await ctx.client.get<{
          id: string;
          questions: { id: string; logicalKey: string }[];
        }>(`/v1/clarifications/${id}`);
        const pairs = ctx.args.slice(2).filter((a) => !a.startsWith("--"));
        const answers = pairs.map((p) => {
          const [key, ...rest] = p.split("=");
          const question = clarification.questions.find(
            (candidate) => candidate.id === key || candidate.logicalKey === key,
          );
          if (!question) throw new Error(`unknown question key ${key}`);
          return { questionId: question.id, answer: rest.join("=") };
        });
        const result = await ctx.client.post<Record<string, unknown>>(`/v1/clarifications/${id}/answers`, { answers });
        out(ctx, result, () => `clarification ${id} answered; execution resumes automatically`);
      } else {
        const decision = flag(ctx, "decision") ?? "approved";
        const result = await ctx.client.post<Record<string, unknown>>(`/v1/approvals/${id}/resolve`, {
          decision,
          note: flag(ctx, "note") ?? "",
        });
        out(ctx, result, () => `approval ${id}: ${decision}`);
      }
    },
  },

  provider: {
    list: async (ctx) => {
      const { items } = await ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/providers");
      out(ctx, items, (rows: Record<string, unknown>[]) => table(rows, ["name", "healthy", "default"]));
    },
    status: async (ctx) => {
      const report = await ctx.client.get<ProviderStatusReportView>("/v1/providers/status");
      out(ctx, report, (payload: ProviderStatusReportView) => formatProviderStatusHuman(payload));
      if (
        report.providers.some((provider) => provider.status !== "ready")
        || report.checks.some((check) => check.status !== "ready")
      ) {
        throw new Error("provider status blocked: one or more providers or checks are not ready");
      }
    },
  },

  e2e: async (ctx) => {
    const [subcommand, action] = ctx.args;
    if (subcommand === "preflight") {
      const projectId = flag(ctx, "project");
      const path = projectId
        ? `/v1/e2e/preflight?projectId=${encodeURIComponent(projectId)}`
        : "/v1/e2e/preflight";
      const report = await ctx.client.get<E2EPreflightReport>(path);
      out(ctx, report, (r: E2EPreflightReport) => {
        const rows = r.scenarios.map((scenario) => {
          const requirements = [
            ...new Set(
              scenario.reasons.flatMap((reason) => [
                ...reason.tools,
                ...reason.environmentVariables,
              ]),
            ),
          ];
          return {
            scenario: scenario.key,
            status: scenario.status,
            detail: requirements.length
              ? `${scenario.detail} (needs: ${requirements.join(", ")})`
              : scenario.detail,
          };
        });
        return [
          `readiness: ${r.readiness} (${r.readyCount} ready, ${r.blockedCount} blocked)`,
          `real providers: ${r.realProviderCount}${r.usesFakeFixtureOnly ? " (fake fixture only)" : ""}`,
          `Git available: ${r.github.gitAvailable}`,
          `gh available: ${r.github.ghAvailable}`,
          `credential hint: ${r.github.credentialHintAvailable}`,
          `gh authenticated: ${r.github.ghAuthenticated}`,
          `repository readable: ${r.github.repositoryReadable}`,
          `repository push dry-run succeeded: ${r.github.repositoryPushDryRunSucceeded}`,
          `repository write role observed: ${r.github.repositoryWriteRoleObserved}`,
          "",
          table(rows, ["scenario", "status", "detail"]),
          "",
          r.note,
        ].join("\n");
      });
      return;
    }
    if (subcommand === "live" && (action === "prepare" || action === "run")) {
      const projectId = flag(ctx, "project");
      if (!projectId) {
        throw new UsageError("missing required argument: --project <id>");
      }
      const paths = resolveOperatorPaths({ repositoryRoot: resolveRepositoryRoot() });
      const reportWriter = createCampaignReportWriter({
        operatorRoot: paths.rootDir,
        reportsDir: paths.reportsDir,
        repositoryRoot: paths.repositoryRoot,
        retentionCount: campaignRetentionCount(),
      });
      const stateStore = createCampaignStateStore({
        operatorRoot: paths.rootDir,
        reportsDir: paths.reportsDir,
        repositoryRoot: paths.repositoryRoot,
      });
      const dependencies = {
        api: ctx.client,
        collectDoctor: () => collectCliDoctorReport(ctx.client),
        reportWriter,
        stateStore,
        configuration: campaignConfiguration(),
        confirmProject: interactiveProjectConfirmation,
      };
      const allowFaultInjection = hasFlag(ctx, "allow-fault-injection");
      const result = action === "prepare"
        ? await prepareLiveCampaign(
            { projectId, allowFaultInjection },
            dependencies,
          )
        : await runLiveCampaign(
            {
              projectId,
              allowFaultInjection,
              isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
              confirmedProjectId: flag(ctx, "confirm-project"),
              pullRequestPolicy: (() => {
                const value = flag(ctx, "pr-policy") ?? "draft";
                if (value !== "draft" && value !== "ready-for-review") {
                  throw new UsageError("--pr-policy must be draft or ready-for-review");
                }
                return value;
              })(),
              maxPolls: boundedPositiveIntegerFlag(ctx, "max-polls", {
                min: 1,
                max: 1_000,
                defaultValue: 150,
              }),
              pollIntervalMs: boundedPositiveIntegerFlag(ctx, "poll-interval-ms", {
                min: 1,
                max: 60_000,
                defaultValue: 2_000,
              }),
            },
            dependencies,
          );
      const payload = {
        ok: result.ok,
        reportPath: result.reportPath,
        report: result.report,
      };
      out(
        ctx,
        payload,
        (data: typeof payload) => [
          `campaign: ${data.report.campaignId}`,
          `readiness: ${data.report.readiness.status}`,
          `result: ${data.report.campaign.result}`,
          `report: ${data.reportPath ?? "(not written)"}`,
          ...data.report.recommendations.map((recommendation) => `action: ${recommendation}`),
        ].join("\n"),
      );
      if (!result.ok) {
        throw new Error(
          `${action} did not succeed: readiness=${result.report.readiness.status}, result=${result.report.campaign.result}`,
        );
      }
      return;
    }
    if (subcommand === "fixture" && action === "create") {
      const fixturePath = flag(ctx, "path");
      if (!fixturePath) {
        throw new UsageError("missing required argument: --path <path>");
      }
      const remote = flag(ctx, "remote");
      const result = createExternalLiveFixture({
        path: fixturePath,
        ...(remote ? { remote } : {}),
      });
      out(
        ctx,
        result,
        (payload: typeof result) =>
          `fixture created at ${payload.path}\nbranch: ${payload.branch}\nremote: ${payload.remote ?? "(none)"}`,
      );
      return;
    }
    throw new UsageError("unknown e2e command (expected: preflight | fixture create | live prepare|run)");
  },

  worker: {
    list: async (ctx) => {
      const { items } = await ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/workers");
      out(ctx, items, (rows: Record<string, unknown>[]) => table(rows, ["id", "name", "status", "lastHeartbeatAt"]));
    },
    enroll: async (ctx) => {
      const name = requireArg(ctx, 1, "worker-name");
      const result = await ctx.client.post<{ id: string; token: string }>("/v1/workers/enroll", {
        name,
        capabilities: (flag(ctx, "capabilities") ?? "shell,git,node").split(","),
      });
      out(ctx, result, (r: { id: string; token: string }) =>
        `enrolled ${r.id}\ntoken (shown once, store securely): ${r.token}`,
      );
    },
    revoke: async (ctx) => {
      const id = requireArg(ctx, 1, "worker-id");
      await ctx.client.post(`/v1/workers/${id}/revoke`);
      out(ctx, { id, revoked: true }, () => `worker ${id} revoked`);
    },
  },

  pr: {
    list: async (ctx) => {
      const projectId = flag(ctx, "project");
      const { items } = await ctx.client.get<{ items: Record<string, unknown>[] }>(
        projectId ? `/v1/prs?projectId=${projectId}` : "/v1/prs",
      );
      out(ctx, items, (rows: Record<string, unknown>[]) => table(rows, ["id", "branch", "title", "state", "url"]));
    },
    show: async (ctx) => {
      const id = requireArg(ctx, 1, "pr-id");
      const pr = await ctx.client.get<Record<string, unknown>>(`/v1/prs/${id}`);
      out(ctx, pr, (p: Record<string, unknown>) => `${p.title}\nbranch: ${p.branch}\nstate: ${p.state}\nurl: ${p.url ?? "(local)"}`);
    },
  },
};

async function missionTransition(ctx: Ctx, to: string): Promise<void> {
  const missionId = requireArg(ctx, 1, "mission-id");
  const result = await ctx.client.post<Record<string, unknown>>(`/v1/missions/${missionId}/transition`, {
    to,
    reason: `requested via CLI`,
  });
  out(ctx, result, (m: Record<string, unknown>) => `mission ${m.id} -> ${m.state}`);
}

const USAGE = `avity — AvityOS command line

usage: avity <command> [subcommand] [args] [--json]

commands:
  init                                  write default config
  login --url <url> [--token-stdin|--token-file <path>]
                                        configure control plane access
  setup [--force]                       secure local operator bootstrap
  start|stop|restart [--service <name>] manage detached services
  status                                local service + control plane summary
  logs [--service <name>] [--max-bytes <n>]
  doctor                                stable host and readiness diagnostics
  project create <name> [--objective <text>] [--criterion <text> ...]
         [--repo <path> --remote <github-url> --branch <name>]
         [--autonomy <profile> --budget <usd> --warn-at <percent>]
  project update <id> [same options] [--no-repo] [--no-budget] [--clear-criteria]
  project list | show <id> | pause <id> [--reason <text>] | resume <id>
  clarification list <project-id> [--status open|answered|expired]
  clarification show <project-id>
  clarification answer <project-id> [logicalKey=answer...] [--answers-json <json>]
  objective submit <project-id> <text> [criteria...]
  plan show <project-id>
  brain show <project-id>                persisted AI planning state
  mission list <project-id>
  run list [--project <id>] | logs <run-id> | pause|resume|cancel <mission-id>
  intervention list | answer <id> [key=answer...|--decision approved|rejected]
  provider list | status
  providers status                      alias of provider status
  e2e preflight [--project <id>]        live E2E readiness (runnability only)
  e2e fixture create --path <path> [--remote <github-url>]
                                        create local external fixture repository
  e2e live prepare|run --project <id> [--confirm-project <id>]
                                        prepare or execute a public-API live campaign
       [--pr-policy draft|ready-for-review] [--allow-fault-injection]
       [--max-polls <n>] [--poll-interval-ms <n>]
  worker list | enroll <name> | revoke <id>
  pr list [--project <id>] | show <id>
`;

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const [command, sub] = args;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const commandName = command === "providers" ? "provider" : command;
  const entry = commands[commandName];
  if (!entry) {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  const handler: Handler | undefined =
    typeof entry === "function" ? entry : sub ? entry[sub] : undefined;
  if (!handler) {
    console.error(`unknown subcommand: ${command} ${sub ?? ""}\n\n${USAGE}`);
    return 2;
  }
  const ctx: Ctx = {
    client: new Client(loadConfig()),
    json,
    args: typeof entry === "function" ? args.slice(1) : args.slice(1),
  };
  try {
    await handler(ctx);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`usage error: ${redactText(err.message)}`);
      return 2;
    }
    if (err instanceof ApiError) {
      console.error(`error (${err.code}): ${err.message}`);
    } else {
      console.error(`error: ${redactText((err as Error).message)}`);
    }
    return 1;
  }
}

const invokedDirectly = process.argv[1]?.endsWith("main.js");
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
