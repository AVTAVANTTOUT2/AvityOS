import {
  EncryptedCredentialVault,
  FileCredentialVaultKeyStore,
  MacOSCredentialVaultKeyStore,
  VaultSecretName,
  isVaultSecretName,
  loadOrCreateCredentialVaultKey,
  vaultSecretService,
  type CredentialVaultKeyStore,
  type CredentialVaultSnapshot,
  type VaultService,
} from "@avityos/credential-vault";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { OperatorPaths } from "./paths.js";
import { readEnvFile, writeEnvFileAtomic, type EnvMap } from "./env.js";

export interface OperatorVaultOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly keyFile?: string;
}

export interface OpenOperatorVaultResult {
  readonly vault: EncryptedCredentialVault;
  readonly keyStore: CredentialVaultKeyStore;
}

export interface OperatorVaultStatus {
  readonly initialized: boolean;
  readonly path: string;
  readonly keyStorage: string | null;
  readonly snapshot: CredentialVaultSnapshot | null;
}

export interface CredentialMigrationResult {
  readonly migrated: readonly string[];
  readonly conflictsResolvedByExistingPrecedence: readonly string[];
  readonly rewrittenFiles: readonly string[];
  readonly snapshot: CredentialVaultSnapshot;
}

export interface CredentialMigrationOptions {
  readonly cliApiToken?: string;
}

const VAULT_CONTROL_ENVIRONMENT = new Set([
  "AVITY_DISABLE_KEYCHAIN",
  "AVITY_VAULT_KEY_FILE",
]);

function environment(options: OperatorVaultOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function physicalPath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function isInside(path: string, parent: string): boolean {
  const rel = relative(physicalPath(parent), physicalPath(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertExternalKeyPath(paths: OperatorPaths, keyPathValue: string): void {
  if (
    isInside(keyPathValue, paths.repositoryRoot) ||
    isInside(keyPathValue, paths.rootDir)
  ) {
    throw new Error(
      "credential vault key file must stay outside both the repository and operator state directory",
    );
  }
}

export function resolveOperatorVaultKeyStore(
  options: OperatorVaultOptions = {},
): CredentialVaultKeyStore {
  const env = environment(options);
  const keyFile = options.keyFile ?? env.AVITY_VAULT_KEY_FILE;
  if (keyFile) return new FileCredentialVaultKeyStore(keyFile);
  const platform = options.platform ?? process.platform;
  if (platform === "darwin" && env.AVITY_DISABLE_KEYCHAIN !== "1") {
    return new MacOSCredentialVaultKeyStore();
  }
  throw new Error(
    "credential vault requires macOS Keychain or an absolute AVITY_VAULT_KEY_FILE",
  );
}

export function openOperatorVault(
  paths: OperatorPaths,
  options: OperatorVaultOptions & { readonly create: boolean },
): OpenOperatorVaultResult {
  const keyStore = resolveOperatorVaultKeyStore(options);
  if (keyStore instanceof FileCredentialVaultKeyStore) {
    assertExternalKeyPath(paths, keyStore.path);
  }
  const vaultExists = existsSync(paths.credentialVaultPath);
  const existingKey = keyStore.load();
  if (vaultExists && !existingKey) {
    throw new Error(
      "credential vault exists but its master key is unavailable; refusing to generate a replacement",
    );
  }
  const key = existingKey ??
    (options.create
      ? loadOrCreateCredentialVaultKey(keyStore)
      : null);
  if (!key) {
    throw new Error(
      `credential vault master key is unavailable in ${keyStore.description}`,
    );
  }
  if (keyStore instanceof FileCredentialVaultKeyStore) {
    // Re-evaluate after creation/loading so an ancestor symlink cannot place
    // the external key inside either protected tree.
    assertExternalKeyPath(paths, keyStore.path);
  }
  return {
    vault: new EncryptedCredentialVault(paths.credentialVaultPath, key),
    keyStore,
  };
}

export function operatorVaultStatus(
  paths: OperatorPaths,
  options: OperatorVaultOptions = {},
): OperatorVaultStatus {
  if (!existsSync(paths.credentialVaultPath)) {
    return {
      initialized: false,
      path: paths.credentialVaultPath,
      keyStorage: null,
      snapshot: null,
    };
  }
  const { vault, keyStore } = openOperatorVault(paths, {
    ...options,
    create: false,
  });
  return {
    initialized: true,
    path: paths.credentialVaultPath,
    keyStorage: keyStore.description,
    snapshot: vault.snapshot(),
  };
}

export function loadOperatorVaultEnvironment(
  paths: OperatorPaths,
  service: VaultService,
  options: OperatorVaultOptions = {},
): Record<string, string> {
  if (!existsSync(paths.credentialVaultPath)) return {};
  const { vault } = openOperatorVault(paths, { ...options, create: false });
  return vault.environmentFor(service);
}

export function filterKnownCredentialsForService(
  values: Readonly<Record<string, string>>,
  service: VaultService | "web",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([name]) => {
      if (VAULT_CONTROL_ENVIRONMENT.has(name)) return false;
      if (!isVaultSecretName(name)) return true;
      return service !== "web" && vaultSecretService(name) === service;
    }),
  );
}

function readPrivateEnvironment(path: string): EnvMap | null {
  if (!existsSync(path)) return null;
  const parent = dirname(path);
  const parentStats = lstatSync(parent);
  const expectedUid = process.getuid?.();
  if (
    parentStats.isSymbolicLink() ||
    !parentStats.isDirectory() ||
    (parentStats.mode & 0o077) !== 0 ||
    (parentStats.mode & 0o200) === 0 ||
    (expectedUid !== undefined && parentStats.uid !== expectedUid)
  ) {
    throw new Error(
      `protected environment directory ${parent} must be private, writable, non-symlinked and owned by this user`,
    );
  }
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new Error(
      `protected environment ${path} must be a mode 0600 regular file owned by this user`,
    );
  }
  return readEnvFile(path);
}

export function migrateProtectedEnvironmentsToVault(
  paths: OperatorPaths,
  vault: EncryptedCredentialVault,
  options: CredentialMigrationOptions = {},
): CredentialMigrationResult {
  const sources = [
    {
      path: paths.serviceEnvPaths.controlPlane,
      values: readPrivateEnvironment(paths.serviceEnvPaths.controlPlane),
    },
    {
      path: paths.serviceEnvPaths.worker,
      values: readPrivateEnvironment(paths.serviceEnvPaths.worker),
    },
    {
      path: paths.operatorEnvPath,
      values: readPrivateEnvironment(paths.operatorEnvPath),
    },
  ];
  const selected: Record<string, string> = {};
  const seenValues = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!source.values) continue;
    for (const name of VaultSecretName.options) {
      const value = source.values[name];
      if (!value) continue;
      const observed = seenValues.get(name) ?? new Set<string>();
      observed.add(value);
      seenValues.set(name, observed);
      // Sources are ordered by current precedence: service-specific first,
      // then operator.env, whose value already overrides at service launch.
      selected[name] = value;
    }
  }
  if (options.cliApiToken) {
    const operatorToken = selected.AVITY_API_TOKEN;
    if (operatorToken && operatorToken !== options.cliApiToken) {
      throw new Error(
        "legacy CLI apiToken conflicts with AVITY_API_TOKEN in the protected operator environment",
      );
    }
    selected.AVITY_API_TOKEN = options.cliApiToken;
    const observed = seenValues.get("AVITY_API_TOKEN") ?? new Set<string>();
    observed.add(options.cliApiToken);
    seenValues.set("AVITY_API_TOKEN", observed);
  }

  vault.initialize();
  const existing = {
    ...vault.environmentFor("control-plane"),
    ...vault.environmentFor("worker"),
  };
  const valuesToWrite = Object.fromEntries(
    Object.entries(selected).filter(([name]) => existing[name] === undefined),
  );
  const vaultConflicts = Object.entries(selected)
    .filter(([name, value]) =>
      existing[name] !== undefined && existing[name] !== value
    )
    .map(([name]) => name);
  const snapshot = Object.keys(valuesToWrite).length > 0
    ? vault.setMany(valuesToWrite)
    : vault.snapshot();
  for (const [name, value] of Object.entries(selected)) {
    const service = vaultSecretService(VaultSecretName.parse(name));
    const expected = existing[name] ?? value;
    if (vault.environmentFor(service)[name] !== expected) {
      throw new Error(`credential vault verification failed for ${name}`);
    }
  }

  const rewrittenFiles: string[] = [];
  for (const source of sources) {
    if (!source.values) continue;
    const next = Object.fromEntries(
      Object.entries(source.values).filter(([name]) => !isVaultSecretName(name)),
    );
    if (Object.keys(next).length !== Object.keys(source.values).length) {
      writeEnvFileAtomic(source.path, next);
      rewrittenFiles.push(source.path);
    }
  }

  return {
    migrated: Object.keys(selected).sort(),
    conflictsResolvedByExistingPrecedence: [
      ...new Set([
        ...[...seenValues.entries()]
          .filter(([, values]) => values.size > 1)
          .map(([name]) => name),
        ...vaultConflicts,
      ]),
    ]
      .sort(),
    rewrittenFiles,
    snapshot,
  };
}
