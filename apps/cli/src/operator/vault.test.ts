import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EncryptedCredentialVault,
  FileCredentialVaultKeyStore,
  encodeCredentialVaultKey,
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
  exportOperatorVaultRecovery,
  migrateProtectedEnvironmentsToVault,
  openOperatorVault,
  operatorVaultStatus,
  restoreOperatorVaultKeyFromRecovery,
  rotateOperatorApiToken,
  rotateOperatorServiceCredential,
  rotateOperatorVaultKey,
  resolveOperatorVaultKeyStore,
  verifyOperatorVaultRecovery,
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

  it("activates external credential rotations and rolls back without clobbering concurrency", async () => {
    const paths = fixturePaths();
    const keyPath = join(paths.rootDir, "..", "rotation-master.key");
    const key = new FileCredentialVaultKeyStore(keyPath).create();
    const vault = new EncryptedCredentialVault(paths.credentialVaultPath, key);
    vault.initialize();
    await expect(rotateOperatorServiceCredential(
      paths,
      "OPENAI_API_KEY",
      "not-yet-provisioned",
      { activate: async () => undefined },
      { keyFile: keyPath },
    )).rejects.toThrow(/not initialized/i);
    vault.set("DEEPSEEK_API_KEY", "first-provider-secret");
    await expect(rotateOperatorServiceCredential(
      paths,
      "DEEPSEEK_API_KEY",
      "first-provider-secret",
      { activate: async () => undefined },
      { keyFile: keyPath },
    )).rejects.toThrow(/unchanged/i);

    const activated: string[] = [];
    const rotated = await rotateOperatorServiceCredential(
      paths,
      "DEEPSEEK_API_KEY",
      "second-provider-secret",
      {
        activate: async (service, name) => {
          activated.push(`${service}:${name}`);
          expect(vault.environmentFor(service)[name]).toBe(
            "second-provider-secret",
          );
        },
      },
      { keyFile: keyPath },
    );
    expect(rotated).toMatchObject({
      name: "DEEPSEEK_API_KEY",
      service: "control-plane",
      previousGeneration: 1,
      generation: 2,
    });
    expect(JSON.stringify(rotated)).not.toMatch(/first-provider|second-provider/);
    expect(activated).toEqual(["control-plane:DEEPSEEK_API_KEY"]);

    let rollbackActivation = 0;
    await expect(rotateOperatorServiceCredential(
      paths,
      "DEEPSEEK_API_KEY",
      "rejected-provider-secret",
      {
        activate: async (service, name) => {
          rollbackActivation += 1;
          if (rollbackActivation === 1) throw new Error("probe failed");
          expect(vault.environmentFor(service)[name]).toBe(
            "second-provider-secret",
          );
        },
      },
      { keyFile: keyPath },
    )).rejects.toThrow(/previous credential restored/i);
    expect(rollbackActivation).toBe(2);
    expect(vault.environmentFor("control-plane").DEEPSEEK_API_KEY).toBe(
      "second-provider-secret",
    );

    let failedRollbackActivation = 0;
    await expect(rotateOperatorServiceCredential(
      paths,
      "DEEPSEEK_API_KEY",
      "unstartable-provider-secret",
      {
        activate: async () => {
          failedRollbackActivation += 1;
          throw new Error("service did not become ready");
        },
      },
      { keyFile: keyPath },
    )).rejects.toThrow(/rollback could not be activated/i);
    expect(failedRollbackActivation).toBe(2);
    expect(vault.environmentFor("control-plane").DEEPSEEK_API_KEY).toBe(
      "second-provider-secret",
    );

    await expect(rotateOperatorServiceCredential(
      paths,
      "DEEPSEEK_API_KEY",
      "third-provider-secret",
      {
        activate: async () => {
          vault.set("DEEPSEEK_API_KEY", "concurrent-provider-secret");
          throw new Error("probe failed");
        },
      },
      { keyFile: keyPath },
    )).rejects.toThrow(/rollback could not be activated.*changed concurrently/i);
    expect(vault.environmentFor("control-plane").DEEPSEEK_API_KEY).toBe(
      "concurrent-provider-secret",
    );
    await expect(rotateOperatorServiceCredential(
      paths,
      "AVITY_API_TOKEN",
      "unsupported-in-band-token",
      { activate: async () => undefined },
      { keyFile: keyPath },
    )).rejects.toThrow(/dedicated in-band token rotation/i);
  });

  it("coordinates durable two-phase API token rotation and ambiguous recovery", async () => {
    const paths = fixturePaths();
    const keyPath = join(paths.rootDir, "..", "api-rotation-master.key");
    const key = new FileCredentialVaultKeyStore(keyPath).create();
    const vault = new EncryptedCredentialVault(paths.credentialVaultPath, key);
    vault.initialize();
    vault.set("AVITY_API_TOKEN", "current-administrator-token");

    const calls: string[] = [];
    const rotated = await rotateOperatorApiToken(
      paths,
      "next-administrator-token",
      {
        status: async () => ({
          state: "stable",
          rotationId: null,
          tokenRole: "current",
        }),
        prepare: async (current, next) => {
          expect(current).toBe("current-administrator-token");
          expect(next).toBe("next-administrator-token");
          calls.push("prepare");
          return { rotationId: "atr_success" };
        },
        verify: async (token) => {
          calls.push(`verify:${token}`);
          expect(vault.environmentFor("control-plane").AVITY_API_TOKEN).toBe(
            token,
          );
        },
        commit: async (rotationId, token) => {
          calls.push(`commit:${rotationId}:${token}`);
        },
        abort: async () => {
          throw new Error("abort must not run");
        },
      },
      { keyFile: keyPath },
    );
    expect(rotated).toMatchObject({
      name: "AVITY_API_TOKEN",
      rotationId: "atr_success",
      previousGeneration: 1,
      generation: 2,
      resumed: false,
    });
    expect(JSON.stringify(rotated)).not.toMatch(
      /current-administrator|next-administrator/,
    );
    expect(calls).toEqual([
      "prepare",
      "verify:next-administrator-token",
      "commit:atr_success:next-administrator-token",
    ]);

    let verificationAttempt = 0;
    await expect(rotateOperatorApiToken(
      paths,
      "rejected-administrator-token",
      {
        status: async () => {
          throw new Error("status must not run");
        },
        prepare: async () => ({ rotationId: "atr_rollback" }),
        verify: async (token) => {
          verificationAttempt += 1;
          if (verificationAttempt === 1) throw new Error("new token rejected");
          expect(token).toBe("next-administrator-token");
        },
        commit: async () => {
          throw new Error("commit must not run");
        },
        abort: async (rotationId, token) => {
          expect(rotationId).toBe("atr_rollback");
          expect(token).toBe("next-administrator-token");
        },
      },
      { keyFile: keyPath },
    )).rejects.toThrow(/previous credential restored/i);
    expect(vault.environmentFor("control-plane").AVITY_API_TOKEN).toBe(
      "next-administrator-token",
    );

    await expect(rotateOperatorApiToken(
      paths,
      "commit-ambiguous-token",
      {
        status: async () => {
          throw new Error("status must not run");
        },
        prepare: async () => ({ rotationId: "atr_ambiguous" }),
        verify: async () => undefined,
        commit: async () => {
          throw new Error("response lost");
        },
        abort: async () => {
          throw new Error("ambiguous commit must not roll back");
        },
      },
      { keyFile: keyPath },
    )).rejects.toThrow(/finalization is ambiguous/i);
    expect(vault.environmentFor("control-plane").AVITY_API_TOKEN).toBe(
      "commit-ambiguous-token",
    );

    const resumed = await rotateOperatorApiToken(
      paths,
      "commit-ambiguous-token",
      {
        status: async () => ({
          state: "prepared",
          rotationId: "atr_ambiguous",
          tokenRole: "pending",
        }),
        prepare: async () => {
          throw new Error("prepare must not repeat");
        },
        verify: async (token) => {
          expect(token).toBe("commit-ambiguous-token");
        },
        commit: async (rotationId, token) => {
          expect(rotationId).toBe("atr_ambiguous");
          expect(token).toBe("commit-ambiguous-token");
        },
        abort: async () => {
          throw new Error("abort must not run");
        },
      },
      { keyFile: keyPath },
    );
    expect(resumed).toMatchObject({
      rotationId: "atr_ambiguous",
      previousGeneration: 5,
      generation: 5,
      resumed: true,
    });

    let concurrentAbort = false;
    await expect(rotateOperatorApiToken(
      paths,
      "candidate-after-resume",
      {
        status: async () => {
          throw new Error("status must not run");
        },
        prepare: async () => ({ rotationId: "atr_concurrent" }),
        verify: async () => {
          vault.set("AVITY_API_TOKEN", "concurrent-vault-token");
        },
        commit: async () => {
          throw new Error("commit must not run after a concurrent change");
        },
        abort: async (rotationId, token) => {
          concurrentAbort = true;
          expect(rotationId).toBe("atr_concurrent");
          expect(token).toBe("commit-ambiguous-token");
        },
      },
      { keyFile: keyPath },
    )).rejects.toThrow(/changed concurrently.*pending rotation aborted/i);
    expect(concurrentAbort).toBe(true);
    expect(vault.environmentFor("control-plane").AVITY_API_TOKEN).toBe(
      "concurrent-vault-token",
    );
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
    expect(output.mock.calls.flat().join("\n")).toContain(
      "vault credential-rotate <credential-name> --stdin",
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
    expect(await main([
      "vault",
      "credential-rotate",
      "OPENAI_API_KEY",
      "argv-secret",
      "--stdin",
    ])).toBe(2);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "vault credential-rotate accepts no credential value in argv",
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

  it("stores first login credentials in the vault and refuses rotation bypass", async () => {
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

    writeFileSync(tokenPath, "bypass-token\n", { mode: 0o600 });
    const error = vi.spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    expect(await main([
      "login",
      "--url",
      "http://127.0.0.1:7717",
      "--token-file",
      tokenPath,
    ])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toMatch(
      /use vault credential-rotate AVITY_API_TOKEN/i,
    );
    expect(vault.environmentFor("control-plane").AVITY_API_TOKEN).toBe(
      "rotated-api-token",
    );
  });

  it("exports, rotates, rolls back and restores a portable recovery key", () => {
    const paths = fixturePaths();
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    const external = mkdtempSync(join(tmpdir(), "avity-vault-recovery-"));
    chmodSync(external, 0o700);
    const keyPath = join(external, "master.key");
    const recoveryPath = join(external, "vault.recovery.json");
    const keyStore = new FileCredentialVaultKeyStore(keyPath);
    const firstKey = keyStore.create();
    const vault = new EncryptedCredentialVault(
      paths.credentialVaultPath,
      firstKey,
    );
    vault.initialize();
    vault.set("DEEPSEEK_API_KEY", "recovery-provider-secret");
    const passphrase = "portable recovery passphrase";

    const exported = exportOperatorVaultRecovery(
      paths,
      recoveryPath,
      passphrase,
      { keyFile: keyPath },
    );
    expect(exported.keyId).toBe(vault.keyId);
    expect(verifyOperatorVaultRecovery(
      paths,
      recoveryPath,
      passphrase,
    )).toEqual(exported);
    expect(readFileSync(recoveryPath, "utf8")).not.toContain(
      encodeCredentialVaultKey(firstKey),
    );
    expect(readFileSync(recoveryPath, "utf8")).not.toContain(
      "recovery-provider-secret",
    );

    const rotated = rotateOperatorVaultKey(
      paths,
      recoveryPath,
      passphrase,
      { keyFile: keyPath },
    );
    expect(rotated.previousKeyId).toBe(exported.keyId);
    expect(rotated.keyId).not.toBe(exported.keyId);
    expect(rotated.generation).toBe(exported.generation + 1);
    expect(verifyOperatorVaultRecovery(
      paths,
      recoveryPath,
      passphrase,
    ).keyId).toBe(rotated.keyId);
    expect(new EncryptedCredentialVault(
      paths.credentialVaultPath,
      keyStore.load()!,
    ).environmentFor("control-plane")).toEqual({
      DEEPSEEK_API_KEY: "recovery-provider-secret",
    });

    const beforeFailedRotation = keyStore.load()!;
    chmodSync(paths.configDir, 0o500);
    expect(() => rotateOperatorVaultKey(
      paths,
      recoveryPath,
      passphrase,
      { keyFile: keyPath },
    )).toThrow(/private, writable/i);
    chmodSync(paths.configDir, 0o700);
    expect(keyStore.load()).toEqual(beforeFailedRotation);
    expect(existsSync(`${recoveryPath}.next`)).toBe(false);
    expect(verifyOperatorVaultRecovery(
      paths,
      recoveryPath,
      passphrase,
    ).keyId).toBe(rotated.keyId);

    renameSync(keyPath, `${keyPath}.lost`);
    expect(() => restoreOperatorVaultKeyFromRecovery(
      paths,
      recoveryPath,
      passphrase,
      "0".repeat(64),
      { keyFile: keyPath },
    )).toThrow(/confirm-key-id/);
    const restored = restoreOperatorVaultKeyFromRecovery(
      paths,
      recoveryPath,
      passphrase,
      rotated.keyId,
      { keyFile: keyPath },
    );
    expect(restored.restored).toBe(true);
    expect(keyStore.load()).toEqual(beforeFailedRotation);
  });
});
