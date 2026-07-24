import {
  EncryptedCredentialVault,
  FileCredentialVaultKeyStore,
  MacOSCredentialVaultKeyStore,
  VaultSecretName,
  credentialVaultKeyId,
  isVaultSecretName,
  loadOrCreateCredentialVaultKey,
  openCredentialRecovery,
  readCredentialRecoveryFile,
  sealCredentialRecovery,
  writeCredentialRecoveryFileAtomic,
  vaultSecretService,
  type CredentialVaultKeyStore,
  type CredentialVaultSnapshot,
  type VaultService,
} from "@avityos/credential-vault";
import {
  existsSync,
  lstatSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
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

export interface OperatorRecoveryResult {
  readonly path: string;
  readonly keyId: string;
  readonly generation: number;
  readonly entries: number;
}

export interface OperatorKeyRotationResult extends OperatorRecoveryResult {
  readonly previousKeyId: string;
  readonly keyStorage: string;
}

export interface OperatorRecoveryRestoreResult extends OperatorRecoveryResult {
  readonly keyStorage: string;
  readonly restored: boolean;
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

export function assertExternalOperatorPath(
  paths: OperatorPaths,
  pathValue: string,
  label: string,
): void {
  if (
    isInside(pathValue, paths.repositoryRoot) ||
    isInside(pathValue, paths.rootDir)
  ) {
    throw new Error(
      `${label} must stay outside both the repository and operator state directory`,
    );
  }
}

function assertExternalKeyPath(paths: OperatorPaths, keyPathValue: string): void {
  assertExternalOperatorPath(paths, keyPathValue, "credential vault key file");
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

export function exportOperatorVaultRecovery(
  paths: OperatorPaths,
  recoveryPath: string,
  passphrase: string,
  options: OperatorVaultOptions = {},
): OperatorRecoveryResult {
  assertExternalOperatorPath(
    paths,
    recoveryPath,
    "credential recovery file",
  );
  const { vault, keyStore } = openOperatorVault(paths, {
    ...options,
    create: false,
  });
  const key = keyStore.load();
  const snapshot = vault.snapshot();
  if (
    !key ||
    vault.keyId !== snapshot.keyId ||
    credentialVaultKeyId(key) !== snapshot.keyId
  ) {
    throw new Error("credential vault master key could not be verified");
  }
  writeCredentialRecoveryFileAtomic(
    recoveryPath,
    sealCredentialRecovery(key, passphrase),
  );
  return {
    path: recoveryPath,
    keyId: snapshot.keyId,
    generation: snapshot.generation,
    entries: snapshot.entries.length,
  };
}

export function verifyOperatorVaultRecovery(
  paths: OperatorPaths,
  recoveryPath: string,
  passphrase: string,
): OperatorRecoveryResult {
  assertExternalOperatorPath(
    paths,
    recoveryPath,
    "credential recovery file",
  );
  const envelope = readCredentialRecoveryFile(recoveryPath);
  const key = openCredentialRecovery(envelope, passphrase);
  const snapshot = new EncryptedCredentialVault(
    paths.credentialVaultPath,
    key,
  ).snapshot();
  if (snapshot.keyId !== envelope.keyId) {
    throw new Error("credential recovery key does not match the vault");
  }
  return {
    path: recoveryPath,
    keyId: snapshot.keyId,
    generation: snapshot.generation,
    entries: snapshot.entries.length,
  };
}

export function restoreOperatorVaultKeyFromRecovery(
  paths: OperatorPaths,
  recoveryPath: string,
  passphrase: string,
  confirmKeyId: string,
  options: OperatorVaultOptions = {},
): OperatorRecoveryRestoreResult {
  const verified = verifyOperatorVaultRecovery(
    paths,
    recoveryPath,
    passphrase,
  );
  if (confirmKeyId !== verified.keyId) {
    throw new Error(
      `recovery restore requires --confirm-key-id ${verified.keyId}`,
    );
  }
  const key = openCredentialRecovery(
    readCredentialRecoveryFile(recoveryPath),
    passphrase,
  );
  const keyStore = resolveOperatorVaultKeyStore(options);
  if (keyStore instanceof FileCredentialVaultKeyStore) {
    assertExternalKeyPath(paths, keyStore.path);
  }
  const current = keyStore.load();
  if (current?.equals(key)) {
    return {
      ...verified,
      keyStorage: keyStore.description,
      restored: false,
    };
  }
  keyStore.replace(current, key);
  const persisted = keyStore.load();
  if (!persisted?.equals(key)) {
    throw new Error("restored credential vault key could not be verified");
  }
  return {
    ...verified,
    keyStorage: keyStore.description,
    restored: true,
  };
}

export function rotateOperatorVaultKey(
  paths: OperatorPaths,
  recoveryPath: string,
  passphrase: string,
  options: OperatorVaultOptions = {},
): OperatorKeyRotationResult {
  const verified = verifyOperatorVaultRecovery(
    paths,
    recoveryPath,
    passphrase,
  );
  const { vault, keyStore } = openOperatorVault(paths, {
    ...options,
    create: false,
  });
  const current = keyStore.load();
  if (!current || vault.keyId !== verified.keyId) {
    throw new Error(
      "recovery file must authenticate the current vault key before rotation",
    );
  }
  const recoveredCurrent = openCredentialRecovery(
    readCredentialRecoveryFile(recoveryPath),
    passphrase,
  );
  if (!current.equals(recoveredCurrent)) {
    throw new Error(
      "recovery file does not contain the current key-store value",
    );
  }

  const next = randomBytes(32);
  const nextRecoveryPath = `${recoveryPath}.next`;
  if (existsSync(nextRecoveryPath)) {
    throw new Error(
      `staged recovery file already exists at ${nextRecoveryPath}; inspect it before retrying`,
    );
  }
  writeCredentialRecoveryFileAtomic(
    nextRecoveryPath,
    sealCredentialRecovery(next, passphrase),
  );

  keyStore.replace(current, next);
  let snapshot: CredentialVaultSnapshot;
  try {
    snapshot = vault.rotateMasterKey(next);
  } catch (error) {
    try {
      keyStore.replace(next, current);
      unlinkSync(nextRecoveryPath);
    } catch (rollbackError) {
      throw new Error(
        `vault rotation failed and key-store rollback also failed; preserve ${recoveryPath} and ${nextRecoveryPath}: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`,
        { cause: error },
      );
    }
    throw error;
  }

  try {
    writeCredentialRecoveryFileAtomic(
      recoveryPath,
      readCredentialRecoveryFile(nextRecoveryPath),
      { replace: true },
    );
    unlinkSync(nextRecoveryPath);
  } catch (error) {
    throw new Error(
      `vault key rotated but recovery promotion failed; preserve staged file ${nextRecoveryPath}`,
      { cause: error },
    );
  }
  const promoted = openCredentialRecovery(
    readCredentialRecoveryFile(recoveryPath),
    passphrase,
  );
  const persisted = keyStore.load();
  if (!promoted.equals(next) || !persisted?.equals(next)) {
    throw new Error("rotated key store/recovery verification failed");
  }
  const reopened = new EncryptedCredentialVault(
    paths.credentialVaultPath,
    promoted,
  ).snapshot();
  if (reopened.keyId !== snapshot.keyId) {
    throw new Error("rotated vault/recovery verification failed");
  }
  return {
    path: recoveryPath,
    previousKeyId: verified.keyId,
    keyId: snapshot.keyId,
    generation: snapshot.generation,
    entries: snapshot.entries.length,
    keyStorage: keyStore.description,
  };
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
