#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { ApiError, Client, CONFIG_PATH, loadConfig, saveConfig } from "./client.js";

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
    console.error(`missing required argument: <${name}>`);
    process.exit(2);
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

type Handler = (ctx: Ctx) => Promise<void>;

const commands: Record<string, Handler | Record<string, Handler>> = {
  init: async () => {
    const config = loadConfig();
    saveConfig(config);
    console.log(`wrote ${CONFIG_PATH} (control plane: ${config.controlPlaneUrl})`);
  },

  login: async (ctx) => {
    const config = loadConfig();
    const url = flag(ctx, "url");
    const token = flag(ctx, "token");
    if (url) config.controlPlaneUrl = url;
    if (token) config.apiToken = token;
    saveConfig(config);
    console.log(`saved credentials to ${CONFIG_PATH}`);
  },

  doctor: async (ctx) => {
    const checks: Record<string, unknown>[] = [];
    const nodeOk = Number(process.versions.node.split(".")[0]) >= 22;
    checks.push({ check: "node >= 22 (node:sqlite)", ok: nodeOk, detail: process.versions.node });
    try {
      execFileSync("git", ["--version"], { stdio: "pipe" });
      checks.push({ check: "git available", ok: true, detail: "" });
    } catch {
      checks.push({ check: "git available", ok: false, detail: "git not found in PATH" });
    }
    try {
      const health = await ctx.client.get<{ status: string; version: string }>("/v1/health");
      checks.push({ check: "control plane reachable", ok: health.status === "ok", detail: `v${health.version}` });
    } catch (err) {
      checks.push({ check: "control plane reachable", ok: false, detail: String((err as Error).message) });
    }
    out(ctx, checks, (c: Record<string, unknown>[]) => table(c, ["check", "ok", "detail"]));
    if (checks.some((c) => !c.ok)) process.exit(1);
  },

  status: async (ctx) => {
    const [projects, approvals, runs] = await Promise.all([
      ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/projects"),
      ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/approvals?status=open"),
      ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/runs"),
    ]);
    const active = runs.items.filter((r) => ["queued", "starting", "running"].includes(r.state as string));
    const data = {
      projects: projects.items.length,
      activeRuns: active.length,
      openInterventions: approvals.items.length,
    };
    out(ctx, data, (d: typeof data) =>
      `projects: ${d.projects}\nactive runs: ${d.activeRuns}\nopen interventions: ${d.openInterventions}`,
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
        `plan v${d.plan.version}: ${d.plan.summary}`,
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
        const pairs = ctx.args.slice(2).filter((a) => !a.startsWith("--"));
        const answers = pairs.map((p) => {
          const [questionId, ...rest] = p.split("=");
          return { questionId: questionId!, answer: rest.join("=") };
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
      const { items } = await ctx.client.get<{ items: Record<string, unknown>[] }>("/v1/providers");
      out(ctx, items, (rows: Record<string, unknown>[]) =>
        rows.map((r) => `${r.name}: ${r.healthy ? "healthy" : "unhealthy"}; models: ${(r.models as string[]).join(", ")}`).join("\n"),
      );
    },
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
  login --url <url> [--token <token>]   configure control plane access
  doctor                                environment and connectivity checks
  status                                global summary
  project create <name> [--objective <text>] [--criterion <text> ...]
         [--repo <path> --remote <github-url> --branch <name>]
         [--autonomy <profile> --budget <usd> --warn-at <percent>]
  project update <id> [same options] [--no-repo] [--no-budget] [--clear-criteria]
  project list | show <id>
  objective submit <project-id> <text> [criteria...]
  plan show <project-id>
  mission list <project-id>
  run list [--project <id>] | logs <run-id> | pause|resume|cancel <mission-id>
  intervention list | answer <id> [q=answer...|--decision approved|rejected]
  provider list | status
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
  const entry = commands[command];
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
    if (err instanceof ApiError) {
      console.error(`error (${err.code}): ${err.message}`);
    } else {
      console.error(`error: ${(err as Error).message}`);
    }
    return 1;
  }
}

const invokedDirectly = process.argv[1]?.endsWith("main.js");
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
