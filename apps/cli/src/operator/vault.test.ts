import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EncryptedCredentialVault,
  FileCredentialVaultKeyStore,
} from "@avityos/credential-vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../main.js";
import {
  readPlaintextApiTokenFromConfig,
  scrubPlaintextApiTokenFromConfig,
} from "../client.js";
import { writeEnvFileAtomic } from "./env.js";
import { resolveOperatorPaths } from "./paths.js";
import { OperatorServiceLifecycle } from "./services.js";
import {
  filterKnownCredentialsForService,
  migrateProtectedEnvironmentsToVault,
  openOperatorVault,
  operatorVaultStatus,
  resolveOperatorVaultKeyStore,
} from "./vault.js";

function fixturePaths() {
  const root = mkdtempSync(join(tmpdir(), "avity-operator-vault-"));
  const repositoryRoot = join(root, "repository");
  mkdirSync(repositoryRoot, { mode: 0o700 });
  return resolveOperatorPaths({
    repositoryRoot,
    operatorHome: join(root, "operator"),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("operator credential vault", () => {
  it("migrates protected env files with existing precedence and no plaintext remnant", () => {
    const paths = fixturePaths();
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.serviceConfigDir, { recursive: true, mode: 0o700 });
    writeEnvFileAtomic(paths.serviceEnvPaths.controlPlane, {
      AVITY_DB_PATH: "/private/db.sqlite",
      DEEPSEEK_API_KEY: "service-provider-secret",
    });
    writeEnvFileAtomic(paths.serviceEnvPaths.worker, {
      AVITY_WORKER_ID: "worker-1",
      AVITY_WORKER_TOKEN: "worker-secret",
      CURSOR_API_KEY: "must-not-reach-worker",
    });
    writeEnvFileAtomic(paths.operatorEnvPath, {
      AVITY_API_TOKEN: "control-plane-secret",
      AVITY_CONTROL_PLANE_URL: "http://127.0.0.1:7717",
      DEEPSEEK_API_KEY: "operator-provider-secret",
    });
    const vault = new EncryptedCredentialVault(
      paths.credentialVaultPath,
      randomBytes(32),
    );

    const result = migrateProtectedEnvironmentsToVault(paths, vault);

    expect(result.migrated).toEqual([
      "AVITY_API_TOKEN",
      "AVITY_WORKER_TOKEN",
      "CURSOR_API_KEY",
      "DEEPSEEK_API_KEY",
    ]);
    expect(result.conflictsResolvedByExistingPrecedence).toEqual([
      "DEEPSEEK_API_KEY",
    ]);
    expect(vault.environmentFor("control-plane")).toEqual({
      AVITY_API_TOKEN: "control-plane-secret",
      CURSOR_API_KEY: "must-not-reach-worker",
      DEEPSEEK_API_KEY: "operator-provider-secret",
    });
    expect(vault.environmentFor("worker")).toEqual({
      AVITY_WORKER_TOKEN: "worker-secret",
    });
    expect(readFileSync(paths.operatorEnvPath, "utf8")).toBe(
      "AVITY_CONTROL_PLANE_URL=http://127.0.0.1:7717\n",
    );
    expect(readFileSync(paths.serviceEnvPaths.controlPlane, "utf8")).toBe(
      "AVITY_DB_PATH=/private/db.sqlite\n",
    );
    expect(readFileSync(paths.serviceEnvPaths.worker, "utf8")).toBe(
      "AVITY_WORKER_ID=worker-1\n",
    );
    const serializedVault = readFileSync(paths.credentialVaultPath, "utf8");
    expect(serializedVault).not.toContain("provider-secret");
    expect(serializedVault).not.toContain("worker-secret");
    expect(serializedVault).not.toContain("control-plane-secret");

    vault.set("DEEPSEEK_API_KEY", "rotated-vault-secret");
    writeEnvFileAtomic(paths.serviceEnvPaths.controlPlane, {
      DEEPSEEK_API_KEY: "stale-legacy-secret",
    });
    const repeated = migrateProtectedEnvironmentsToVault(paths, vault);
    expect(repeated.conflictsResolvedByExistingPrecedence).toEqual([
      "DEEPSEEK_API_KEY",
    ]);
    expect(vault.environmentFor("control-plane").DEEPSEEK_API_KEY).toBe(
      "rotated-vault-secret",
    );
    expect(readFileSync(paths.serviceEnvPaths.controlPlane, "utf8")).toBe("\n");
  });

  it("filters every known credential to its single service scope", () => {
    const environment = {
      AVITY_API_TOKEN: "api",
      AVITY_WORKER_TOKEN: "worker",
      CODEX_API_KEY: "codex",
      AVITY_VAULT_KEY_FILE: "/private/master.key",
      PATH: "/usr/bin",
    };
    expect(filterKnownCredentialsForService(environment, "control-plane")).toEqual({
      AVITY_API_TOKEN: "api",
      CODEX_API_KEY: "codex",
      PATH: "/usr/bin",
    });
    expect(filterKnownCredentialsForService(environment, "worker")).toEqual({
      AVITY_WORKER_TOKEN: "worker",
      PATH: "/usr/bin",
    });
    expect(filterKnownCredentialsForService(environment, "web")).toEqual({
      PATH: "/usr/bin",
    });
  });

  it("injects decrypted values in memory and overrides legacy credentials", async () => {
    const paths = fixturePaths();
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    writeEnvFileAtomic(paths.operatorEnvPath, {
      AVITY_API_TOKEN: "legacy-api",
      AVITY_CONTROL_PLANE_URL: "http://127.0.0.1:7717",
      AVITY_WORKER_ID: "worker-1",
      AVITY_WORKER_TOKEN: "legacy-worker",
      CODEX_API_KEY: "legacy-codex",
    });
    const spawned: Array<{ service: string; env: Record<string, string> }> = [];
    const lifecycle = new OperatorServiceLifecycle(paths, {
      isPidRunning: () => false,
      prepareLogFileForAppend: () => undefined,
      spawnDetached: (service, env) => {
        spawned.push({ service, env });
        return { pid: 41_000 + spawned.length };
      },
      loadVaultEnvironment: (service) =>
        service === "control-plane"
          ? { AVITY_API_TOKEN: "vault-api", CODEX_API_KEY: "vault-codex" }
          : { AVITY_WORKER_TOKEN: "vault-worker" },
    });

    await lifecycle.start(["control-plane", "web", "worker"]);

    expect(spawned[0]?.env).toMatchObject({
      AVITY_API_TOKEN: "vault-api",
      CODEX_API_KEY: "vault-codex",
    });
    expect(spawned[0]?.env).not.toHaveProperty("AVITY_WORKER_TOKEN");
    expect(spawned[0]?.env).not.toHaveProperty("AVITY_VAULT_KEY_FILE");
    expect(spawned[1]?.env).not.toHaveProperty("AVITY_API_TOKEN");
    expect(spawned[1]?.env).not.toHaveProperty("AVITY_WORKER_TOKEN");
    expect(spawned[1]?.env).not.toHaveProperty("CODEX_API_KEY");
    expect(spawned[2]?.env).toMatchObject({
      AVITY_WORKER_ID: "worker-1",
      AVITY_WORKER_TOKEN: "vault-worker",
    });
    expect(spawned[2]?.env).not.toHaveProperty("CODEX_API_KEY");
    expect(spawned[2]?.env).not.toHaveProperty("AVITY_VAULT_KEY_FILE");
  });

  it("selects Keychain on macOS and requires an explicit key file elsewhere", () => {
    expect(resolveOperatorVaultKeyStore({
      platform: "darwin",
      env: {},
    }).description).toBe("macOS Keychain");
    expect(() => resolveOperatorVaultKeyStore({
      platform: "linux",
      env: {},
    })).toThrow(/AVITY_VAULT_KEY_FILE/);
    const paths = fixturePaths();
    expect(operatorVaultStatus(paths, {
      platform: "linux",
      env: {},
    })).toEqual({
      initialized: false,
      path: paths.credentialVaultPath,
      keyStorage: null,
      snapshot: null,
    });
    expect(() => openOperatorVault(paths, {
      create: true,
      keyFile: join(paths.rootDir, "unsafe-master.key"),
      platform: "linux",
      env: {},
    })).toThrow(/outside both the repository and operator state/i);

    const external = join(paths.rootDir, "..", "external");
    mkdirSync(external, { mode: 0o700 });
    const linkedRepository = join(external, "linked-repository");
    symlinkSync(paths.repositoryRoot, linkedRepository);
    expect(() => openOperatorVault(paths, {
      create: true,
      keyFile: join(linkedRepository, "nested", "master.key"),
      platform: "linux",
      env: {},
    })).toThrow(/outside both the repository and operator state/i);
  });

  it("refuses migration from a permissive protected env file", () => {
    const paths = fixturePaths();
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.operatorEnvPath, "OPENAI_API_KEY=secret\n", {
      mode: 0o600,
    });
    chmodSync(paths.operatorEnvPath, 0o644);
    const vault = new EncryptedCredentialVault(
      paths.credentialVaultPath,
      randomBytes(32),
    );
    expect(() => migrateProtectedEnvironmentsToVault(paths, vault)).toThrow(
      /mode 0600/i,
    );

    const publicDirectory = join(paths.rootDir, "public-env");
    mkdirSync(publicDirectory, { mode: 0o755 });
    chmodSync(publicDirectory, 0o755);
    expect(() => writeEnvFileAtomic(
      join(publicDirectory, "operator.env"),
      { OPENAI_API_KEY: "secret" },
    )).toThrow(/directory .* private, writable/i);
    expect(lstatSync(publicDirectory).mode & 0o777).toBe(0o755);
  });

  it("advertises the vault CLI without credential values", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["help"])).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain(
      "vault set <credential-name> --stdin",
    );
    expect(await main([
      "vault",
      "set",
      "OPENAI_API_KEY",
      "argv-secret",
      "--stdin",
    ])).toBe(2);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "accepts no credential value in argv",
    );
  });

  it("scrubs a legacy plaintext CLI bearer from an owner-only config", () => {
    const paths = fixturePaths();
    const configPath = join(paths.rootDir, "cli.json");
    mkdirSync(paths.rootDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      configPath,
      `${JSON.stringify({
        controlPlaneUrl: "http://127.0.0.1:7717",
        apiToken: "legacy-cli-token",
        defaultProjectId: "project-1",
      })}\n`,
      { mode: 0o600 },
    );
    vi.stubEnv("AVITY_CONFIG", configPath);

    expect(readPlaintextApiTokenFromConfig()).toBe("legacy-cli-token");
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    const vault = new EncryptedCredentialVault(
      paths.credentialVaultPath,
      randomBytes(32),
    );
    const migration = migrateProtectedEnvironmentsToVault(paths, vault, {
      cliApiToken: readPlaintextApiTokenFromConfig(),
    });
    expect(migration.migrated).toEqual(["AVITY_API_TOKEN"]);
    expect(vault.environmentFor("control-plane")).toEqual({
      AVITY_API_TOKEN: "legacy-cli-token",
    });
    expect(scrubPlaintextApiTokenFromConfig()).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      controlPlaneUrl: "http://127.0.0.1:7717",
      defaultProjectId: "project-1",
    });
    expect(scrubPlaintextApiTokenFromConfig()).toBe(false);
  });

  it("rotates login credentials into an initialized vault, not operator.env", async () => {
    const paths = fixturePaths();
    const keyPath = join(paths.rootDir, "..", "master.key");
    const key = new FileCredentialVaultKeyStore(keyPath).create();
    const vault = new EncryptedCredentialVault(paths.credentialVaultPath, key);
    vault.initialize();
    const configPath = join(paths.rootDir, "cli.json");
    const tokenPath = join(paths.rootDir, "api-token");
    writeFileSync(tokenPath, "rotated-api-token\n", { mode: 0o600 });
    vi.stubEnv("AVITY_CONFIG", configPath);
    vi.stubEnv("AVITY_DISABLE_KEYCHAIN", "1");
    vi.stubEnv("AVITY_OPERATOR_HOME", paths.rootDir);
    vi.stubEnv("AVITY_REPOSITORY_ROOT", paths.repositoryRoot);
    vi.stubEnv("AVITY_VAULT_KEY_FILE", keyPath);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await main([
      "login",
      "--url",
      "http://127.0.0.1:7717",
      "--token-file",
      tokenPath,
    ])).toBe(0);

    expect(vault.environmentFor("control-plane")).toEqual({
      AVITY_API_TOKEN: "rotated-api-token",
    });
    expect(readFileSync(paths.credentialVaultPath, "utf8")).not.toContain(
      "rotated-api-token",
    );
    expect(readFileSync(configPath, "utf8")).not.toContain(
      "rotated-api-token",
    );
  });
});
