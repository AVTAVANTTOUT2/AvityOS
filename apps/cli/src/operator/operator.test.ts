import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../main.js";
import {
  ensureOperatorSetup,
  readProtectedTokenFromFile,
  type SetupCommandRunner,
} from "./setup.js";
import { resolveOperatorPaths } from "./paths.js";
import { redactValue } from "./redact.js";
import { OperatorServiceLifecycle, boundLogFileForAppend } from "./services.js";
import { collectDoctorReport, probeProviderReadiness } from "./diagnostics.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AVITY_CONFIG;
  delete process.env.AVITY_DISABLE_KEYCHAIN;
  delete process.env.AVITY_REPOSITORY_ROOT;
  delete process.env.AVITY_OPERATOR_HOME;
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
  it("detects the same sandbox-portable auth material as the control plane", async () => {
    const home = mkdtempSync(join(tmpdir(), "avity-doctor-auth-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), '{"tokens":{}}\n', { mode: 0o600 });
    writeFileSync(join(home, ".cursor", "auth.json"), '{"accessToken":"test"}\n', { mode: 0o600 });
    const probed: string[] = [];

    const result = await probeProviderReadiness(
      {
        AVITY_CODEX_BIN: "/custom/codex",
        AVITY_CLAUDE_CODE_BIN: "/custom/claude",
        AVITY_CURSOR_BIN: "/custom/cursor",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      },
      {
        realHome: home,
        probeBinary: async (binary) => {
          probed.push(binary);
          return true;
        },
      },
    );

    expect(probed).toEqual(["/custom/codex", "/custom/claude", "/custom/cursor"]);
    expect(result).toEqual({
      codex: { binary: true, auth: true },
      claudeCode: { binary: true, auth: true },
      cursorAgent: { binary: true, auth: true },
    });
  });

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

  it("blocks explicitly on unsupported host platform for sandbox", async () => {
    const report = await collectDoctorReport({
      commandProbe: async () => ({ ok: true, detail: "ok" }),
      providerProbe: async () => ({
        codex: { binary: true, auth: true },
        claudeCode: { binary: true, auth: true },
        cursorAgent: { binary: true, auth: true },
      }),
      serviceProbe: async () => ({ controlPlane: "running", web: "running", worker: "running" }),
      apiProbe: async () => ({ health: true, providersStatus: true }),
      nodeVersion: "22.6.0",
      platform: "win32",
    });

    const sandboxCheck = report.checks.find((check) => check.id === "sandbox");
    expect(report.readiness).toBe("blocked_operator_configuration");
    expect(sandboxCheck?.ok).toBe(false);
    expect(sandboxCheck?.detail).toContain("unsupported platform");
  });

  it("requires sandbox-exec on macOS and bwrap on Linux", async () => {
    const baseDeps = {
      commandProbe: async () => ({ ok: true, detail: "ok" }),
      providerProbe: async () => ({
        codex: { binary: true, auth: true },
        claudeCode: { binary: true, auth: true },
        cursorAgent: { binary: true, auth: true },
      }),
      serviceProbe: async () => ({ controlPlane: "running", web: "running", worker: "running" }) as const,
      apiProbe: async () => ({ health: true, providersStatus: true }),
      nodeVersion: "22.6.0",
    };

    const darwinBlocked = await collectDoctorReport({
      ...baseDeps,
      platform: "darwin",
      sandboxBinaryProbe: async (binary) => ({ ok: false, detail: `${binary} missing` }),
    });
    const linuxReady = await collectDoctorReport({
      ...baseDeps,
      platform: "linux",
      sandboxBinaryProbe: async (binary) => ({ ok: binary === "bwrap", detail: `${binary} available` }),
    });

    expect(darwinBlocked.readiness).toBe("blocked_operator_configuration");
    expect(darwinBlocked.checks.find((check) => check.id === "sandbox")?.detail).toContain("sandbox-exec");
    expect(linuxReady.readiness).toBe("ready");
    expect(linuxReady.checks.find((check) => check.id === "sandbox")?.detail).toContain("bwrap");
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

  it("bounds oversized log files deterministically before append", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-operator-"));
    const logPath = join(root, "service.log");
    writeFileSync(logPath, "0123456789ABCDEFGHIJ", { mode: 0o600 });

    boundLogFileForAppend(logPath, 8);

    expect(readFileSync(logPath, "utf8")).toBe("CDEFGHIJ");
  });

  it("prepares bounded logs before spawning a service", async () => {
    const root = mkdtempSync(join(tmpdir(), "avity-operator-"));
    const paths = resolveOperatorPaths({ repositoryRoot: root, operatorHome: join(root, ".operator") });
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.operatorEnvPath, "AVITY_CONTROL_PLANE_URL=http://127.0.0.1:7717\n", { mode: 0o600 });
    const prepareLogFileForAppend = vi.fn();
    const spawnDetached = vi.fn(() => ({ pid: 12345 }));
    const lifecycle = new OperatorServiceLifecycle(paths, {
      isPidRunning: () => false,
      spawnDetached,
      terminatePid: async () => true,
      prepareLogFileForAppend,
    });

    await lifecycle.start(["web"]);

    expect(prepareLogFileForAppend).toHaveBeenCalledWith("web");
    expect(spawnDetached).toHaveBeenCalledWith("web", expect.objectContaining({
      AVITY_CONTROL_PLANE_URL: "http://127.0.0.1:7717",
    }));
  });

  it("loads only the protected service environment and reloads it on restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "avity-operator-"));
    const paths = resolveOperatorPaths({
      repositoryRoot: root,
      operatorHome: join(root, ".operator"),
      serviceConfigDir: join(root, ".service-config"),
    });
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.serviceConfigDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      paths.operatorEnvPath,
      [
        "AVITY_API_TOKEN=current-operator-token",
        "AVITY_CONTROL_PLANE_URL=http://127.0.0.1:7717",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(
      paths.serviceEnvPaths.controlPlane,
      [
        "AVITY_API_TOKEN=stale-service-token",
        "DEEPSEEK_API_KEY=protected-provider-token",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(
      paths.serviceEnvPaths.worker,
      "CURSOR_API_KEY=worker-only-token\n",
      { mode: 0o600 },
    );
    const spawnDetached = vi.fn(() => ({ pid: 12345 }));
    const lifecycle = new OperatorServiceLifecycle(paths, {
      isPidRunning: () => false,
      spawnDetached,
      terminatePid: async () => true,
      prepareLogFileForAppend: () => {},
    });

    await lifecycle.start(["control-plane"]);

    expect(spawnDetached).toHaveBeenNthCalledWith(1, "control-plane", expect.objectContaining({
      AVITY_API_TOKEN: "current-operator-token",
      DEEPSEEK_API_KEY: "protected-provider-token",
    }));
    writeFileSync(
      paths.serviceEnvPaths.controlPlane,
      "DEEPSEEK_API_KEY=refreshed-provider-token\n",
      { mode: 0o600 },
    );

    await lifecycle.restart(["control-plane"]);
    await lifecycle.start(["web"]);

    expect(spawnDetached).toHaveBeenNthCalledWith(2, "control-plane", expect.objectContaining({
      AVITY_API_TOKEN: "current-operator-token",
      DEEPSEEK_API_KEY: "refreshed-provider-token",
    }));
    expect(spawnDetached).toHaveBeenNthCalledWith(3, "web", expect.not.objectContaining({
      DEEPSEEK_API_KEY: expect.anything(),
      CURSOR_API_KEY: expect.anything(),
    }));
  });

  it("refuses a service environment readable by group or other users", async () => {
    const root = mkdtempSync(join(tmpdir(), "avity-operator-"));
    const paths = resolveOperatorPaths({
      repositoryRoot: root,
      operatorHome: join(root, ".operator"),
      serviceConfigDir: join(root, ".service-config"),
    });
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.serviceConfigDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.operatorEnvPath, "AVITY_API_TOKEN=current-token\n", { mode: 0o600 });
    writeFileSync(paths.serviceEnvPaths.controlPlane, "DEEPSEEK_API_KEY=protected-token\n", {
      mode: 0o600,
    });
    chmodSync(paths.serviceEnvPaths.controlPlane, 0o640);
    const spawnDetached = vi.fn(() => ({ pid: 12345 }));
    const lifecycle = new OperatorServiceLifecycle(paths, {
      isPidRunning: () => false,
      spawnDetached,
      terminatePid: async () => true,
      prepareLogFileForAppend: () => {},
    });

    await expect(lifecycle.start(["control-plane"])).rejects.toThrow(/overly permissive mode 640/);
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it("never includes a malformed protected environment value in an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "avity-operator-"));
    const paths = resolveOperatorPaths({
      repositoryRoot: root,
      operatorHome: join(root, ".operator"),
      serviceConfigDir: join(root, ".service-config"),
    });
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.serviceConfigDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.operatorEnvPath, "AVITY_API_TOKEN=current-token\n", { mode: 0o600 });
    writeFileSync(
      paths.serviceEnvPaths.controlPlane,
      "provider-secret-that-must-not-reach-stderr\n",
      { mode: 0o600 },
    );
    const lifecycle = new OperatorServiceLifecycle(paths, {
      isPidRunning: () => false,
      spawnDetached: () => ({ pid: 12345 }),
      terminatePid: async () => true,
      prepareLogFileForAppend: () => {},
    });

    const error = await lifecycle.start(["control-plane"]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("invalid env entry at line 1");
    expect(String(error)).not.toContain("provider-secret");
  });

  it("start → status running → stop → status stopped for worker with credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "avity-operator-"));
    const paths = resolveOperatorPaths({ repositoryRoot: root, operatorHome: join(root, ".operator") });
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      paths.operatorEnvPath,
      [
        "AVITY_CONTROL_PLANE_URL=http://127.0.0.1:7717",
        "AVITY_API_TOKEN=test-api-token",
        "AVITY_WORKER_ID=wrk_test",
        "AVITY_WORKER_TOKEN=tok_test",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const livePids = new Set<number>();
    let nextPid = 40_000;
    const lifecycle = new OperatorServiceLifecycle(paths, {
      isPidRunning: (pid) => livePids.has(pid),
      spawnDetached: () => {
        const pid = nextPid++;
        livePids.add(pid);
        return { pid };
      },
      terminatePid: async (pid) => {
        livePids.delete(pid);
        return true;
      },
    });

    await lifecycle.start(["worker"]);
    const started = await lifecycle.status();
    expect(started.worker.state).toBe("running");
    expect(started.worker.pid).toBeTypeOf("number");

    await lifecycle.stop(["worker"]);
    const stopped = await lifecycle.status();
    expect(stopped.worker.state).toBe("stopped");
    expect(stopped.worker.pid).toBeNull();
  });
});

describe("operator token-file hardening", () => {
  it("requires token file mode exactly 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-token-file-"));
    const tokenPath = join(root, "token.txt");
    writeFileSync(tokenPath, "secret-token\n", { mode: 0o700 });

    expect(() => readProtectedTokenFromFile(tokenPath)).toThrow(/mode 0600/);
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

  it("warns with strict env parsing errors during token synchronization", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "avity-cli-login-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "avity-cli-repo-"));
    const operatorHome = join(repoRoot, ".operator");
    const paths = resolveOperatorPaths({ repositoryRoot: repoRoot, operatorHome });
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.operatorEnvPath, "INVALID-LINE-WITHOUT-EQUALS\n", { mode: 0o600 });
    const tokenFilePath = join(configDir, "token.txt");
    writeFileSync(tokenFilePath, "sync-token-value\n", { mode: 0o600 });
    process.env.AVITY_REPOSITORY_ROOT = repoRoot;
    process.env.AVITY_OPERATOR_HOME = operatorHome;
    process.env.AVITY_CONFIG = join(configDir, "cli.json");
    process.env.AVITY_DISABLE_KEYCHAIN = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const code = await main(["login", "--url", "http://127.0.0.1:7717", "--token-file", tokenFilePath]);

    expect(code).toBe(0);
    expect(existsSync(join(configDir, "cli.json"))).toBe(true);
    const warning = warnSpy.mock.calls.map((x) => x.join(" ")).join("\n");
    expect(warning).toContain("operator env sync skipped");
    expect(warning).not.toContain("sync-token-value");
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
