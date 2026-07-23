import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Engine, openDatabase, Store, buildServer, DEFAULT_ENGINE_CONFIG, clearGitHubReadinessCache, getCachedGitHubReadiness } from "@avityos/control-plane";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";

// Point the CLI at an isolated config before importing it.
const configDir = mkdtempSync(join(tmpdir(), "avity-cli-"));
process.env.AVITY_CONFIG = join(configDir, "cli.json");
process.env.AVITY_DISABLE_KEYCHAIN = "1";

const { main } = await import("./main.js");
const { CONFIG_PATH, loadConfig, saveConfig } = await import("./client.js");

let app: FastifyInstance;
let store: Store;
let engine: Engine;

let stdout: string[] = [];
let stderr: string[] = [];

function captureOutput(): void {
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void stderr.push(args.join(" ")));
}

beforeAll(async () => {
  const db = openDatabase(":memory:");
  store = new Store(db);
  const providers = new Map<string, ProviderAdapter>([["fake", new FakeProviderAdapter()]]);
  engine = new Engine(store, providers, { ...DEFAULT_ENGINE_CONFIG, tickMs: 30 });
  engine.start();
  clearGitHubReadinessCache();
  await getCachedGitHubReadiness(undefined, () => Date.now(), async () => ({
    success: false,
    stdout: "",
  }));
  app = await buildServer({ store, engine, version: "test" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  saveConfig({ controlPlaneUrl: `http://127.0.0.1:${port}` });
});

afterAll(async () => {
  await engine.stop();
  await app.close();
});

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  captureOutput();
  const code = await main(argv);
  vi.restoreAllMocks();
  return { code, out: stdout.join("\n"), err: stderr.join("\n") };
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("waitFor timed out");
}

describe("avity CLI", () => {
  it("stores fallback config with owner-only permissions", () => {
    const previous = loadConfig();
    saveConfig({ ...previous, apiToken: "test-token" });
    expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).apiToken).toBe("test-token");
    saveConfig(previous);
  });

  it("shows usage and exits 2 for unknown commands", async () => {
    expect((await run()).code).toBe(2);
    expect((await run("nonsense")).code).toBe(2);
    expect((await run("help")).code).toBe(0);
  });

  it("rejects invalid --max-bytes values with usage errors", async () => {
    const nanValue = await run("logs", "--max-bytes", "NaN");
    expect(nanValue.code).toBe(2);
    expect(nanValue.err).toContain("--max-bytes must be");

    const negativeValue = await run("logs", "--max-bytes", "-1");
    expect(negativeValue.code).toBe(2);
    expect(negativeValue.err).toContain("--max-bytes must be");

    const fractionalValue = await run("logs", "--max-bytes", "12.5");
    expect(fractionalValue.code).toBe(2);
    expect(fractionalValue.err).toContain("--max-bytes must be");
  });

  it("doctor reports healthy environment", async () => {
    const { code, out } = await run("doctor");
    expect(code).toBe(0);
    expect(out).toContain("control plane reachable");
  });

  it("drives a project from creation to completion", async () => {
    const created = await run("project", "create", "CLI Demo", "--json");
    expect(created.code).toBe(0);
    const project = JSON.parse(created.out) as { id: string };

    const submitted = await run(
      "objective", "submit", project.id,
      "Deliver the demo feature completely with tests and documentation evidence",
      "feature works end to end",
      "--json",
    );
    expect(submitted.code).toBe(0);

    await waitFor(() => store.getProject(project.id)?.status === "completed");

    const missions = await run("mission", "list", project.id, "--json");
    const items = JSON.parse(missions.out) as { state: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((m) => m.state === "completed")).toBe(true);

    const runsOut = await run("run", "list", "--project", project.id, "--json");
    expect((JSON.parse(runsOut.out) as unknown[]).length).toBeGreaterThan(0);

    const status = await run("status");
    expect(status.code).toBe(0);
    expect(status.out).toContain("projects:");

    // the persisted brain state is exposed, fixture provenance included
    const brain = await run("brain", "show", project.id, "--json");
    expect(brain.code).toBe(0);
    const state = JSON.parse(brain.out) as {
      status: string;
      runs: { step: string; state: string; provenance: string }[];
      plan: { version: number; provenance: string } | null;
      analysis: { summary: string } | null;
    };
    expect(state.runs.map((r) => r.step)).toEqual(["analysis", "architecture", "plan"]);
    expect(state.runs.every((r) => r.provenance === "fake_fixture")).toBe(true);
    expect(state.plan?.provenance).toBe("fake_fixture");
    expect(state.analysis?.summary).toBeTruthy();

    const brainHuman = await run("brain", "show", project.id);
    expect(brainHuman.code).toBe(0);
    expect(brainHuman.out).toContain("[fake_fixture]");

    const plan = await run("plan", "show", project.id);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("provenance: fake_fixture");
  });

  it("creates and idempotently updates every onboarding option", async () => {
    const repo = join(configDir, "onboarding-repo");
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "cli-test@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "CLI Test"]);
    execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
    execFileSync("git", ["-C", repo, "config", "core.fsmonitor", "false"]);
    execFileSync("git", ["-C", repo, "config", "core.untrackedCache", "false"]);
    writeFileSync(join(repo, "README.md"), "# CLI onboarding\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "--no-gpg-sign", "-m", "chore: init"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:example/cli-onboarding.git"]);

    const created = await run(
      "project", "create", "CLI Onboarding",
      "--repo", repo,
      "--remote", "https://github.com/example/cli-onboarding.git",
      "--branch", "main",
      "--autonomy", "maximum_autonomy",
      "--budget", "75",
      "--warn-at", "60",
      "--json",
    );
    expect(created.code).toBe(0);
    const project = JSON.parse(created.out) as { id: string };
    let configuration = store.getProjectConfiguration(project.id)!;
    expect(configuration.project.repoRemoteUrl).toBe("git@github.com:example/cli-onboarding.git");
    expect(configuration.objective).toBeNull();
    expect(configuration.budget).toMatchObject({ limitUsd: 75, warnAtFraction: 0.6 });

    const updateArgs = [
      "project", "update", project.id,
      "--objective", "Maybe deliver the revised CLI onboarding configuration",
      "--criterion", "updated criterion",
      "--budget", "100",
      "--warn-at", "70",
      "--json",
    ];
    const firstUpdate = await run(...updateArgs);
    expect(firstUpdate.code, firstUpdate.err || firstUpdate.out).toBe(0);
    const secondUpdate = await run(...updateArgs);
    expect(secondUpdate.code, secondUpdate.err || secondUpdate.out).toBe(0);
    configuration = store.getProjectConfiguration(project.id)!;
    expect(configuration.objective?.revision).toBe(1);
    expect(configuration.objective?.acceptanceCriteria).toEqual(["updated criterion"]);
    expect(configuration.budget).toMatchObject({ limitUsd: 100, warnAtFraction: 0.7 });
  });

  it("lists providers and workers, enrolls and revokes", async () => {
    const providers = await run("provider", "list", "--json");
    expect(JSON.parse(providers.out)[0].name).toBe("fake");

    const enrolled = await run("worker", "enroll", "test-worker", "--json");
    const worker = JSON.parse(enrolled.out) as { id: string; token: string };
    expect(worker.token.length).toBeGreaterThan(20);

    const revoked = await run("worker", "revoke", worker.id);
    expect(revoked.code).toBe(0);

    const list = await run("worker", "list", "--json");
    const listed = JSON.parse(list.out) as { id: string; status: string }[];
    expect(listed.find((w) => w.id === worker.id)?.status).toBe("revoked");
  });

  it("answers clarifications through intervention answer", async () => {
    const created = await run("project", "create", "Vague CLI", "--json");
    const project = JSON.parse(created.out) as { id: string };
    const submitted = await run("objective", "submit", project.id, "make something, maybe", "--json");
    const { clarificationId } = JSON.parse(submitted.out) as { clarificationId: string };
    expect(clarificationId).toBeTruthy();

    const answered = await run(
      "intervention", "answer", clarificationId,
      "acceptance-criteria=The CLI demo passes", "out-of-scope=nothing else",
    );
    expect(answered.code).toBe(0);
    await waitFor(() => store.getProject(project.id)?.status === "completed");
  });

  it("pauses and resumes a project atomically through the CLI", async () => {
    // Create without an objective so the project stays durably in `draft`:
    // this deterministically exercises the create/pause race (pausing before
    // the brain leaves `draft`) without depending on the fake pipeline's
    // speed, which otherwise completed the project before the pause landed.
    const created = await run("project", "create", "Pause CLI", "--json");
    expect(created.code, created.err || created.out).toBe(0);
    const project = JSON.parse(created.out) as { id: string };
    expect(store.getProject(project.id)?.status).toBe("draft");

    const paused = await run("project", "pause", project.id, "--reason", "operator break", "--json");
    expect(paused.code, paused.err || paused.out).toBe(0);
    expect(JSON.parse(paused.out)).toMatchObject({ status: "paused", generation: 1 });
    expect(store.getProject(project.id)?.status).toBe("paused");

    const resumed = await run("project", "resume", project.id, "--json");
    expect(resumed.code, resumed.err || resumed.out).toBe(0);
    expect(store.getProject(project.id)?.status).not.toBe("paused");
  });

  it("surfaces API errors with exit code 1", async () => {
    const missing = await run("project", "show", "prj_does_not_exist");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("not_found");
  });

  it("reports E2E preflight runnability for a fixture-only control plane", async () => {
    const result = await run("e2e", "preflight", "--json");
    expect(result.code, result.err || result.out).toBe(0);
    const report = JSON.parse(result.out) as {
      readiness: string;
      usesFakeFixtureOnly: boolean;
      github: {
        gitAvailable: boolean;
        ghAvailable: boolean;
        credentialHintAvailable: boolean;
        ghAuthenticated: boolean;
        repositoryReadable: boolean;
        repositoryPushDryRunSucceeded: boolean;
        repositoryWriteRoleObserved: boolean;
      };
      scenarios: { key: string; status: string }[];
      note: string;
    };
    expect(report.usesFakeFixtureOnly).toBe(true);
    expect(report.readiness).toBe("blocked_missing_tool");
    expect(report.scenarios).toHaveLength(10);
    const planning = report.scenarios.find((s) => s.key === "real_planning")!;
    expect(planning.status).toBe("blocked_missing_credentials");
    const merge = report.scenarios.find((s) => s.key === "no_autonomous_merge")!;
    expect(merge.status).toBe("ready");
    for (const scenario of report.scenarios) {
      expect([
        "ready",
        "blocked_operator_configuration",
        "blocked_missing_tool",
        "blocked_missing_credentials",
        "blocked_product_gap",
      ]).toContain(scenario.status);
    }
    expect(report.note).toMatch(/never guarantees/i);
  });

  it("builds the E2E preflight request with an encoded project id", async () => {
    const human = await run("e2e", "preflight");
    expect(human.code, human.err || human.out).toBe(0);
    expect(human.out).toMatch(/credential hint:/i);
    expect(human.out).toMatch(/gh authenticated:/i);
    expect(human.out).toMatch(/repository readable:/i);
    expect(human.out).toMatch(/repository push dry-run succeeded:/i);
    expect(human.out).toMatch(/repository write role observed:/i);
    expect(human.out).not.toMatch(/repository push verified:/i);
    expect(human.out).not.toMatch(/PR creation verified:/i);
    expect(human.out).not.toMatch(/repository access verified:/i);
    expect(human.out).not.toMatch(/sk-|ghp_|github_pat_/i);

    const missing = await run("e2e", "preflight", "--project", "prj_missing", "--json");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("not_found");
  });
});
