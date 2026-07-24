import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  EncryptedCredentialVault,
  openCredentialRecovery,
  readCredentialRecoveryFile,
} from "@avityos/credential-vault";
import type { OperatorPaths } from "./paths.js";
import {
  assertExternalOperatorPath,
  verifyOperatorVaultRecovery,
} from "./vault.js";

const BACKUP_SCHEMA_VERSION = 1 as const;
const DATABASE_FILE_NAME = "avity.sqlite";
const VAULT_FILE_NAME = "credentials.vault";
const MANIFEST_FILE_NAME = "backup-manifest.json";
const MAX_DATABASE_BACKUP_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

interface BackupFileDescriptor {
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface OperatorBackupManifest {
  readonly schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  readonly bundleId: string;
  readonly createdAt: string;
  readonly recoveryKeyId: string;
  readonly database: BackupFileDescriptor & {
    readonly migrationVersion: number;
    readonly projectCount: number;
    readonly auditEntries: number;
    readonly auditHeadHash: string | null;
  };
  readonly vault: BackupFileDescriptor & {
    readonly generation: number;
    readonly entries: number;
  };
}

export interface OperatorBackupVerification {
  readonly path: string;
  readonly manifest: OperatorBackupManifest;
  readonly databaseIntegrity: "ok";
  readonly foreignKeys: "ok";
  readonly auditChain: "ok";
  readonly recoveryKey: "verified";
}

export interface OperatorBackupRestoreResult extends OperatorBackupVerification {
  readonly databasePath: string;
  readonly vaultPath: string;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\u0000") !== wanted.join("\u0000")) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseFileDescriptor(
  value: unknown,
  expectedName: string,
  extras: readonly string[],
  label: string,
): Record<string, unknown> & BackupFileDescriptor {
  const record = objectValue(value, label);
  assertExactKeys(record, ["name", "sizeBytes", "sha256", ...extras], label);
  if (record.name !== expectedName) throw new Error(`${label} filename is invalid`);
  const sizeBytes = nonnegativeInteger(record.sizeBytes, `${label}.sizeBytes`);
  if (
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  ) {
    throw new Error(`${label}.sha256 is invalid`);
  }
  return { ...record, name: expectedName, sizeBytes, sha256: record.sha256 };
}

export function parseOperatorBackupManifest(
  value: unknown,
): OperatorBackupManifest {
  const record = objectValue(value, "backup manifest");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "bundleId",
      "createdAt",
      "recoveryKeyId",
      "database",
      "vault",
    ],
    "backup manifest",
  );
  if (record.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error("backup manifest schema version is unsupported");
  }
  if (
    typeof record.bundleId !== "string" ||
    !/^bkp_[a-f0-9]{32}$/.test(record.bundleId)
  ) {
    throw new Error("backup manifest bundle id is invalid");
  }
  if (
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    new Date(record.createdAt).toISOString() !== record.createdAt
  ) {
    throw new Error("backup manifest timestamp is invalid");
  }
  if (
    typeof record.recoveryKeyId !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.recoveryKeyId)
  ) {
    throw new Error("backup manifest recovery key id is invalid");
  }
  const database = parseFileDescriptor(
    record.database,
    DATABASE_FILE_NAME,
    ["migrationVersion", "projectCount", "auditEntries", "auditHeadHash"],
    "backup database",
  );
  const vault = parseFileDescriptor(
    record.vault,
    VAULT_FILE_NAME,
    ["generation", "entries"],
    "backup vault",
  );
  const auditHeadHash = database.auditHeadHash;
  if (
    auditHeadHash !== null &&
    (typeof auditHeadHash !== "string" || !/^[a-f0-9]{64}$/.test(auditHeadHash))
  ) {
    throw new Error("backup database audit head hash is invalid");
  }
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    bundleId: record.bundleId,
    createdAt: record.createdAt,
    recoveryKeyId: record.recoveryKeyId,
    database: {
      name: DATABASE_FILE_NAME,
      sizeBytes: database.sizeBytes,
      sha256: database.sha256,
      migrationVersion: nonnegativeInteger(
        database.migrationVersion,
        "backup database migrationVersion",
      ),
      projectCount: nonnegativeInteger(
        database.projectCount,
        "backup database projectCount",
      ),
      auditEntries: nonnegativeInteger(
        database.auditEntries,
        "backup database auditEntries",
      ),
      auditHeadHash: auditHeadHash as string | null,
    },
    vault: {
      name: VAULT_FILE_NAME,
      sizeBytes: vault.sizeBytes,
      sha256: vault.sha256,
      generation: nonnegativeInteger(
        vault.generation,
        "backup vault generation",
      ),
      entries: nonnegativeInteger(vault.entries, "backup vault entries"),
    },
  };
}

function assertPrivateDirectory(path: string, create: boolean): void {
  const existed = existsSync(path);
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) throw new Error(`private directory is missing: ${path}`);
  const stats = lstatSync(path);
  const expectedUid = process.getuid?.();
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.mode & 0o077) !== 0 ||
    (stats.mode & 0o200) === 0 ||
    (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new Error(
      `backup directory ${path} must be private, writable, non-symlinked and owned by this user`,
    );
  }
  if (create && !existed) chmodSync(path, 0o700);
}

function assertPrivateFile(
  path: string,
  label: string,
  maxBytes: number,
): number {
  const stats = lstatSync(path);
  const expectedUid = process.getuid?.();
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new Error(
      `${label} ${path} must be a mode 0600 regular file owned by this user`,
    );
  }
  if (stats.size < 1 || stats.size > maxBytes) {
    throw new Error(`${label} size is outside the allowed range`);
  }
  return stats.size;
}

function writePrivateFile(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function copyPrivateFile(
  sourcePath: string,
  destinationPath: string,
  label: string,
  maxBytes: number,
): void {
  const expectedSize = assertPrivateFile(sourcePath, label, maxBytes);
  const source = openSync(sourcePath, "r");
  let destination: number | undefined;
  let total = 0;
  try {
    destination = openSync(destinationPath, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const count = readSync(source, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds its size limit`);
      }
      let written = 0;
      while (written < count) {
        written += writeSync(
          destination,
          buffer,
          written,
          count - written,
          null,
        );
      }
    }
    if (total !== expectedSize) {
      throw new Error(`${label} changed while copying`);
    }
    fsyncSync(destination);
  } finally {
    if (destination !== undefined) closeSync(destination);
    closeSync(source);
  }
  chmodSync(destinationPath, 0o600);
}

function sha256File(path: string, maxBytes: number): {
  readonly sha256: string;
  readonly sizeBytes: number;
} {
  const sizeBytes = assertPrivateFile(path, "backup file", maxBytes);
  const descriptor = openSync(path, "r");
  const hash = createHash("sha256");
  let total = 0;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error("backup file exceeds its size limit");
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  if (total !== sizeBytes) throw new Error("backup file changed while hashing");
  return { sha256: hash.digest("hex"), sizeBytes };
}

function inspectDatabase(path: string): {
  readonly migrationVersion: number;
  readonly projectCount: number;
  readonly auditEntries: number;
  readonly auditHeadHash: string | null;
} {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (
      integrity.length !== 1 ||
      Object.values(integrity[0] ?? {})[0] !== "ok"
    ) {
      throw new Error("database integrity_check failed");
    }
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) throw new Error("database foreign_key_check failed");
    const requiredTables = new Set([
      "schema_migrations",
      "projects",
      "events",
      "audit_entries",
    ]);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as Array<{ name: string }>;
    for (const table of tables) requiredTables.delete(table.name);
    if (requiredTables.size > 0) {
      throw new Error(
        `database is missing required tables: ${[...requiredTables].join(", ")}`,
      );
    }
    const migrations = db.prepare(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    ).all() as Array<{ version: number }>;
    if (
      migrations.length < 1 ||
      migrations.some((row, index) => row.version !== index + 1)
    ) {
      throw new Error("database migration history is not contiguous");
    }
    const projects = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
      count: number;
    };
    const auditRows = db.prepare(
      "SELECT id, created_at, actor, action, detail, entry_hash, previous_hash FROM audit_entries ORDER BY rowid ASC",
    ).all() as Array<Record<string, string | null>>;
    let previousHash: string | null = null;
    for (const row of auditRows) {
      const expected: string = createHash("sha256")
        .update(
          `${previousHash ?? ""}|${row.id}|${row.created_at}|${row.actor}|${row.action}|${row.detail}`,
        )
        .digest("hex");
      if (
        row.entry_hash !== expected ||
        (row.previous_hash ?? null) !== previousHash
      ) {
        throw new Error("database audit chain is invalid");
      }
      previousHash = expected;
    }
    return {
      migrationVersion: migrations.at(-1)!.version,
      projectCount: Number(projects.count),
      auditEntries: auditRows.length,
      auditHeadHash: previousHash,
    };
  } finally {
    db.close();
  }
}

function manifestAt(path: string): OperatorBackupManifest {
  const manifestPath = join(path, MANIFEST_FILE_NAME);
  assertPrivateFile(manifestPath, "backup manifest", MAX_MANIFEST_BYTES);
  try {
    return parseOperatorBackupManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
  } catch (error) {
    throw new Error(
      `backup manifest validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function verifyFiles(
  root: string,
  manifest: OperatorBackupManifest,
  recoveryKey: Uint8Array,
  locations: {
    readonly databasePath?: string;
    readonly vaultPath?: string;
  } = {},
): void {
  const databasePath = locations.databasePath ?? join(root, DATABASE_FILE_NAME);
  const vaultPath = locations.vaultPath ?? join(root, VAULT_FILE_NAME);
  const databaseHash = sha256File(databasePath, MAX_DATABASE_BACKUP_BYTES);
  const vaultHash = sha256File(vaultPath, 2 * 1024 * 1024);
  if (
    databaseHash.sha256 !== manifest.database.sha256 ||
    databaseHash.sizeBytes !== manifest.database.sizeBytes ||
    vaultHash.sha256 !== manifest.vault.sha256 ||
    vaultHash.sizeBytes !== manifest.vault.sizeBytes
  ) {
    throw new Error("backup file hash/size does not match the manifest");
  }
  const database = inspectDatabase(databasePath);
  if (
    database.migrationVersion !== manifest.database.migrationVersion ||
    database.projectCount !== manifest.database.projectCount ||
    database.auditEntries !== manifest.database.auditEntries ||
    database.auditHeadHash !== manifest.database.auditHeadHash
  ) {
    throw new Error("backup database metadata does not match the manifest");
  }
  const vault = new EncryptedCredentialVault(vaultPath, recoveryKey).snapshot();
  if (
    vault.keyId !== manifest.recoveryKeyId ||
    vault.generation !== manifest.vault.generation ||
    vault.entries.length !== manifest.vault.entries
  ) {
    throw new Error("backup vault metadata does not match the manifest");
  }
}

export function createOperatorBackup(options: {
  readonly paths: OperatorPaths;
  readonly databasePath: string;
  readonly outputPath: string;
  readonly recoveryPath: string;
  readonly recoveryPassphrase: string;
}): OperatorBackupVerification {
  const { paths, databasePath, outputPath, recoveryPath, recoveryPassphrase } =
    options;
  if (!isAbsolute(databasePath) || databasePath === "/") {
    throw new Error("backup database path must be absolute and non-root");
  }
  if (!isAbsolute(outputPath) || outputPath === "/") {
    throw new Error("operator backup destination must be absolute and non-root");
  }
  assertExternalOperatorPath(paths, outputPath, "operator backup");
  if (existsSync(outputPath)) throw new Error("operator backup destination exists");
  const recovery = verifyOperatorVaultRecovery(
    paths,
    recoveryPath,
    recoveryPassphrase,
  );
  const recoveryKey = openCredentialRecovery(
    readCredentialRecoveryFile(recoveryPath),
    recoveryPassphrase,
  );
  assertPrivateFile(databasePath, "source database", MAX_DATABASE_BACKUP_BYTES);

  const parent = dirname(outputPath);
  assertPrivateDirectory(parent, false);
  const staging = join(
    parent,
    `.${basename(outputPath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(staging, { mode: 0o700 });
  const databaseCopy = join(staging, DATABASE_FILE_NAME);
  const vaultCopy = join(staging, VAULT_FILE_NAME);
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const destinationLiteral = databaseCopy.replaceAll("'", "''");
      source.exec(`VACUUM INTO '${destinationLiteral}'`);
    } finally {
      source.close();
    }
    chmodSync(databaseCopy, 0o600);
    assertPrivateFile(
      databaseCopy,
      "database snapshot",
      MAX_DATABASE_BACKUP_BYTES,
    );
    const databaseDescriptor = openSync(databaseCopy, "r");
    try {
      fsyncSync(databaseDescriptor);
    } finally {
      closeSync(databaseDescriptor);
    }
    copyPrivateFile(
      paths.credentialVaultPath,
      vaultCopy,
      "credential vault",
      2 * 1024 * 1024,
    );

    const databaseMetadata = inspectDatabase(databaseCopy);
    const databaseHash = sha256File(databaseCopy, MAX_DATABASE_BACKUP_BYTES);
    const vaultHash = sha256File(vaultCopy, 2 * 1024 * 1024);
    const vaultSnapshot = new EncryptedCredentialVault(
      vaultCopy,
      recoveryKey,
    ).snapshot();
    if (vaultSnapshot.keyId !== recovery.keyId) {
      throw new Error("recovery file no longer matches the vault snapshot");
    }
    const manifest: OperatorBackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      bundleId: `bkp_${randomBytes(16).toString("hex")}`,
      createdAt: new Date().toISOString(),
      recoveryKeyId: recovery.keyId,
      database: {
        name: DATABASE_FILE_NAME,
        ...databaseHash,
        ...databaseMetadata,
      },
      vault: {
        name: VAULT_FILE_NAME,
        ...vaultHash,
        generation: vaultSnapshot.generation,
        entries: vaultSnapshot.entries.length,
      },
    };
    writePrivateFile(
      join(staging, MANIFEST_FILE_NAME),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    );
    verifyFiles(staging, manifest, recoveryKey);
    syncDirectory(staging);
    renameSync(staging, outputPath);
    chmodSync(outputPath, 0o700);
    syncDirectory(parent);
    return {
      path: outputPath,
      manifest,
      databaseIntegrity: "ok",
      foreignKeys: "ok",
      auditChain: "ok",
      recoveryKey: "verified",
    };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true });
    throw error;
  }
}

export function verifyOperatorBackup(options: {
  readonly paths: OperatorPaths;
  readonly backupPath: string;
  readonly recoveryPath: string;
  readonly recoveryPassphrase: string;
}): OperatorBackupVerification {
  const { paths, backupPath, recoveryPath, recoveryPassphrase } = options;
  if (!isAbsolute(backupPath) || backupPath === "/") {
    throw new Error("operator backup path must be absolute and non-root");
  }
  assertExternalOperatorPath(paths, backupPath, "operator backup");
  assertExternalOperatorPath(paths, recoveryPath, "credential recovery file");
  assertPrivateDirectory(backupPath, false);
  const manifest = manifestAt(backupPath);
  const recoveryKey = openCredentialRecovery(
    readCredentialRecoveryFile(recoveryPath),
    recoveryPassphrase,
  );
  verifyFiles(backupPath, manifest, recoveryKey);
  return {
    path: backupPath,
    manifest,
    databaseIntegrity: "ok",
    foreignKeys: "ok",
    auditChain: "ok",
    recoveryKey: "verified",
  };
}

export function restoreOperatorBackup(options: {
  readonly paths: OperatorPaths;
  readonly backupPath: string;
  readonly destinationPath: string;
  readonly recoveryPath: string;
  readonly recoveryPassphrase: string;
  readonly confirmBundleId: string;
}): OperatorBackupRestoreResult {
  const verified = verifyOperatorBackup(options);
  if (options.confirmBundleId !== verified.manifest.bundleId) {
    throw new Error(
      `backup restore requires --confirm-bundle-id ${verified.manifest.bundleId}`,
    );
  }
  assertExternalOperatorPath(
    options.paths,
    options.destinationPath,
    "restore destination",
  );
  if (!isAbsolute(options.destinationPath) || options.destinationPath === "/") {
    throw new Error("restore destination must be absolute and non-root");
  }
  if (existsSync(options.destinationPath)) {
    throw new Error("restore destination already exists; replacement is refused");
  }
  const parent = dirname(options.destinationPath);
  assertPrivateDirectory(parent, false);
  const staging = join(
    parent,
    `.${basename(options.destinationPath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  const restoredVaultDirectory = join(staging, "operator", "config");
  mkdirSync(restoredVaultDirectory, { recursive: true, mode: 0o700 });
  chmodSync(staging, 0o700);
  chmodSync(join(staging, "operator"), 0o700);
  chmodSync(restoredVaultDirectory, 0o700);

  const databasePath = join(staging, DATABASE_FILE_NAME);
  const vaultPath = join(restoredVaultDirectory, VAULT_FILE_NAME);
  try {
    copyPrivateFile(
      join(options.backupPath, DATABASE_FILE_NAME),
      databasePath,
      "backup database",
      MAX_DATABASE_BACKUP_BYTES,
    );
    copyPrivateFile(
      join(options.backupPath, VAULT_FILE_NAME),
      vaultPath,
      "backup credential vault",
      2 * 1024 * 1024,
    );
    writePrivateFile(
      join(staging, MANIFEST_FILE_NAME),
      Buffer.from(`${JSON.stringify(verified.manifest, null, 2)}\n`, "utf8"),
    );

    const recoveryKey = openCredentialRecovery(
      readCredentialRecoveryFile(options.recoveryPath),
      options.recoveryPassphrase,
    );
    verifyFiles(staging, verified.manifest, recoveryKey, {
      databasePath,
      vaultPath,
    });
    syncDirectory(restoredVaultDirectory);
    syncDirectory(join(staging, "operator"));
    syncDirectory(staging);
    renameSync(staging, options.destinationPath);
    syncDirectory(parent);
    const finalDatabasePath = join(
      options.destinationPath,
      DATABASE_FILE_NAME,
    );
    const finalVaultPath = join(
      options.destinationPath,
      "operator",
      "config",
      VAULT_FILE_NAME,
    );
    return {
      ...verified,
      path: options.destinationPath,
      databasePath: finalDatabasePath,
      vaultPath: finalVaultPath,
    };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true });
    throw error;
  }
}
