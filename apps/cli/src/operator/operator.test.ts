import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../main.js";
import {
  ensureOperatorSetup,
  type SetupCommandRunner,
} from "./setup.js";
import { resolveOperatorPaths } from "./paths.js";
import { redactValue } from "./redact.js";
import { OperatorServiceLifecycle } from "./services.js";
import { collectDoctorReport } from "./diagnostics.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AVITY_CONFIG;
  delete process.env.AVITY_DISABLE_KEYCHAIN;
});

describe("operator setup", () => {
  it("creates owner-only directories/files and stays idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "avity-operator-"));
    const paths = resolveOperatorPaths({ repositoryRoot: root, operatorHome: join(root, ".operator") });
    const runs: string[] = [];
    const runner: SetupCommandRunner = {
      run(command, args) {
        runs.push(`${command} ${args.join(" ")}`.trim());
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await ensureOperatorSetup({ paths, runner, force: false, env: { ...process.env, AVITY_API_TOKEN: "keep-me" } });
    const first = readFileSync(paths.operatorEnvPath, "utf8");
    await ensureOperatorSetup({ paths, runner, force: false, env: { ...process.env, AVITY_API_TOKEN: "new-token" } });
    const second = readFileSync(paths.operatorEnvPath, "utf8");

    expect(first).toEqual(second);
    expect(statSync(paths.rootDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.operatorEnvPath).mode & 0o777).toBe(0o600);
    expect(runs.some((line) => line.includes("pnpm") && line.includes("build"))).toBe(true);
  });

  it("preserves existing token/config unless force is explicit", async () => {
    const root = mkdtempSync(join(tmpdir(), "avity-operator-"));
    const paths = resolveOperatorPaths({ repositoryRoot: root, operatorHome: join(root, ".operator") });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.operatorEnvPath, "AVITY_API_TOKEN=keep-token\n", { mode: 0o600 });
    const runner: SetupCommandRunner = {
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };

    await ensureOperatorSetup({ paths, runner, force: false, env: { ...process.env, AVITY_API_TOKEN: "replace-token" } });
    expect(readFileSync(paths.operatorEnvPath, "utf8")).toContain("keep-token");
  });
});

describe("operator diagnostics", () => {
  it("returns stable JSON and blocked statuses for missing tools/sandbox/auth", async () => {
    const report = await collectDoctorReport({
      commandProbe: async (tool) => ({ ok: tool === "node", detail: tool === "node" ? "22.6.0" : `${tool} missing` }),
      providerProbe: async () => ({ codex: { binary: false, auth: false }, claudeCode: { binary: false, auth: false }, cursorAgent: { binary: false, auth: false } }),
      serviceProbe: async () => ({ controlPlane: "stopped", web: "stopped", worker: "stopped" }),
      apiProbe: async () => ({ health: false, providersStatus: false }),
      sandboxProbe: async () => ({ ok: false, detail: "sandbox missing" }),
      nodeVersion: "22.6.0",
      platform: "linux",
    });

    expect(report.version).toBe(1);
    expect(report.readiness).toBe("blocked_missing_tool");
    expect(report.checks.map((c) => c.id)).toEqual([
      "node",
      "pnpm",
      "git",
      "gh",
      "sandbox",
      "providers",
      "services",
      "control_plane",
    ]);
  });
});

describe("operator services", () => {
  it("recovers stale pid files and redacts bounded logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "avity-operator-"));
    const paths = resolveOperatorPaths({ repositoryRoot: root, operatorHome: join(root, ".operator") });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.services.controlPlane.pidFilePath, "999999\n", { mode: 0o600 });
    writeFileSync(paths.services.controlPlane.logFilePath, "token=ghp_secret\nnormal line\n", { mode: 0o600 });

    const lifecycle = new OperatorServiceLifecycle(paths, {
      isPidRunning: () => false,
      spawnDetached: () => ({ pid: 12345 }),
      terminatePid: async () => true,
    });
    const before = await lifecycle.status();
    const logs = lifecycle.readLogs("control-plane", { maxBytes: 1024 });
    expect(before.controlPlane.state).toBe("stale");
    expect(logs).not.toContain("ghp_secret");
  });
});

describe("login hardening", () => {
  it("rejects legacy --token while preserving non-sensitive options", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "avity-cli-login-"));
    process.env.AVITY_CONFIG = join(configDir, "cli.json");
    process.env.AVITY_DISABLE_KEYCHAIN = "1";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["login", "--url", "http://127.0.0.1:7717", "--token", "secret"]);
    expect(code).toBe(2);
    expect(errSpy.mock.calls.map((x) => x.join(" ")).join("\n")).toContain("stdin");
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("secret"));
  });
});

describe("redaction", () => {
  it("recursively redacts nested secret-looking keys and token patterns", () => {
    const redacted = redactValue({
      apiToken: "ghp_abc123secret",
      nested: [{ authorization: "Bearer sk-live-secret" }, { ok: true }],
    }) as { apiToken: string; nested: Array<{ authorization?: string; ok?: boolean }> };
    expect(redacted.apiToken).toBe("[REDACTED]");
    expect(redacted.nested[0]?.authorization).toBe("[REDACTED]");
  });
});
