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

export interface OperatorServiceCredentialRotationResult {
  readonly name: VaultSecretName;
  readonly service: VaultService;
  readonly previousGeneration: number;
  readonly generation: number;
  readonly resumed: false;
}

export interface OperatorServiceCredentialRotationDependencies {
  readonly activate: (
    service: VaultService,
    name: VaultSecretName,
  ) => Promise<void>;
}

export interface ApiTokenRotationStatus {
  readonly state: "stable" | "prepared";
  readonly rotationId: string | null;
  readonly tokenRole: "current" | "pending";
}

export interface OperatorApiTokenRotationDependencies {
  readonly status: (token: string) => Promise<ApiTokenRotationStatus>;
  readonly prepare: (
    currentToken: string,
    nextToken: string,
  ) => Promise<{ readonly rotationId: string }>;
  readonly verify: (token: string) => Promise<void>;
  readonly commit: (rotationId: string, nextToken: string) => Promise<void>;
  readonly abort: (rotationId: string, currentToken: string) => Promise<void>;
}

export interface OperatorApiTokenRotationResult {
  readonly name: "AVITY_API_TOKEN";
  readonly service: "control-plane";
  readonly rotationId: string | null;
  readonly previousGeneration: number;
  readonly generation: number;
  readonly resumed: boolean;
}

const VAULT_CONTROL_ENVIRONMENT = new Set([
  "AVITY_DISABLE_KEYCHAIN",
  "AVITY_VAULT_KEY_FILE",
]);

const SERVICE_ACTIVATED_CREDENTIALS = new Set<VaultSecretName>([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
  "CURSOR_API_KEY",
  "DEEPSEEK_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
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

/**
 * Rotate an external service credential and prove that the owning service
 * starts with it. A failed activation restores the previous encrypted value
 * with compare-and-swap, then activates that rollback. AvityOS API/worker
 * bearers are intentionally excluded because they require a server-side
 * two-phase token protocol.
 */
export async function rotateOperatorServiceCredential(
  paths: OperatorPaths,
  nameValue: string,
  nextValue: string,
  dependencies: OperatorServiceCredentialRotationDependencies,
  options: OperatorVaultOptions = {},
): Promise<OperatorServiceCredentialRotationResult> {
  const name = VaultSecretName.parse(nameValue);
  if (!SERVICE_ACTIVATED_CREDENTIALS.has(name)) {
    throw new Error(
      `${name} requires a dedicated in-band token rotation protocol`,
    );
  }
  const { vault } = openOperatorVault(paths, {
    ...options,
    create: false,
  });
  const service = vaultSecretService(name);
  const previousValue = vault.environmentFor(service)[name];
  if (!previousValue) {
    throw new Error(
      `credential ${name} is not initialized; store it before rotating`,
    );
  }
  if (previousValue === nextValue) {
    throw new Error(`credential ${name} is unchanged`);
  }

  const staged = vault.compareAndSwap(name, previousValue, nextValue);
  try {
    await dependencies.activate(service, name);
    if (vault.environmentFor(service)[name] !== nextValue) {
      throw new Error(`credential ${name} changed during activation`);
    }
  } catch (activationError) {
    try {
      vault.compareAndSwap(name, nextValue, previousValue);
      await dependencies.activate(service, name);
      if (vault.environmentFor(service)[name] !== previousValue) {
        throw new Error(`credential ${name} rollback verification failed`);
      }
    } catch (rollbackError) {
      throw new Error(
        `credential ${name} activation failed and rollback could not be activated: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`,
        { cause: activationError },
      );
    }
    throw new Error(
      `credential ${name} activation failed; previous credential restored`,
      { cause: activationError },
    );
  }

  return {
    name,
    service,
    previousGeneration: staged.generation - 1,
    generation: staged.generation,
    resumed: false,
  };
}

/**
 * Coordinate the encrypted operator vault with the control plane's durable
 * current/pending token authority. No service restart is required: the new
 * bearer proves itself while both hashes are accepted, then commits.
 *
 * A failure before commit restores the old vault value and aborts the pending
 * server state. Once commit is attempted, an ambiguous response never rolls
 * the vault back because the server may already have revoked the old token.
 */
export async function rotateOperatorApiToken(
  paths: OperatorPaths,
  nextValue: string,
  dependencies: OperatorApiTokenRotationDependencies,
  options: OperatorVaultOptions = {},
): Promise<OperatorApiTokenRotationResult> {
  const { vault } = openOperatorVault(paths, {
    ...options,
    create: false,
  });
  const previousValue =
    vault.environmentFor("control-plane").AVITY_API_TOKEN;
  if (!previousValue) {
    throw new Error(
      "credential AVITY_API_TOKEN is not initialized; store it before rotating",
    );
  }
  const before = vault.snapshot();
  if (previousValue === nextValue) {
    const status = await dependencies.status(nextValue);
    if (
      status.state === "prepared" &&
      status.tokenRole === "pending" &&
      status.rotationId
    ) {
      await dependencies.verify(nextValue);
      await dependencies.commit(status.rotationId, nextValue);
      return {
        name: "AVITY_API_TOKEN",
        service: "control-plane",
        rotationId: status.rotationId,
        previousGeneration: before.generation,
        generation: before.generation,
        resumed: true,
      };
    }
    if (status.state === "stable" && status.tokenRole === "current") {
      await dependencies.verify(nextValue);
      return {
        name: "AVITY_API_TOKEN",
        service: "control-plane",
        rotationId: null,
        previousGeneration: before.generation,
        generation: before.generation,
        resumed: true,
      };
    }
    throw new Error(
      "another API token rotation is prepared; abort or complete it before retrying",
    );
  }

  const prepared = await dependencies.prepare(previousValue, nextValue);
  let staged: CredentialVaultSnapshot;
  try {
    staged = vault.compareAndSwap(
      "AVITY_API_TOKEN",
      previousValue,
      nextValue,
    );
  } catch (stagingError) {
    try {
      await dependencies.abort(prepared.rotationId, previousValue);
    } catch (abortError) {
      throw new Error(
        `API token vault staging failed and prepared rotation could not be aborted: ${
          abortError instanceof Error ? abortError.message : String(abortError)
        }`,
        { cause: stagingError },
      );
    }
    throw stagingError;
  }

  try {
    await dependencies.verify(nextValue);
  } catch (verificationError) {
    try {
      vault.compareAndSwap("AVITY_API_TOKEN", nextValue, previousValue);
      await dependencies.abort(prepared.rotationId, previousValue);
      await dependencies.verify(previousValue);
    } catch (rollbackError) {
      throw new Error(
        `API token verification failed and rollback could not be certified: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`,
        { cause: verificationError },
      );
    }
    throw new Error(
      "API token verification failed; previous credential restored",
      { cause: verificationError },
    );
  }

  if (
    vault.environmentFor("control-plane").AVITY_API_TOKEN !== nextValue
  ) {
    try {
      await dependencies.abort(prepared.rotationId, previousValue);
    } catch (abortError) {
      throw new Error(
        `API token changed concurrently and prepared rotation could not be aborted: ${
          abortError instanceof Error ? abortError.message : String(abortError)
        }`,
      );
    }
    throw new Error(
      "API token changed concurrently after verification; pending rotation aborted without overwriting the newer vault value",
    );
  }

  try {
    await dependencies.commit(prepared.rotationId, nextValue);
  } catch (commitError) {
    throw new Error(
      "new API token is active and stored, but commit finalization is ambiguous; rerun the same rotation to resume safely",
      { cause: commitError },
    );
  }

  return {
    name: "AVITY_API_TOKEN",
    service: "control-plane",
    rotationId: prepared.rotationId,
    previousGeneration: staged.generation - 1,
    generation: staged.generation,
    resumed: false,
  };
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
