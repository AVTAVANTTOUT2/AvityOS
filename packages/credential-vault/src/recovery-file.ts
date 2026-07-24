import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  CredentialVaultError,
  parseCredentialRecoveryEnvelope,
  type CredentialRecoveryEnvelope,
} from "./index.js";

const MAX_RECOVERY_FILE_BYTES = 16 * 1024;

function ensureRecoveryPath(path: string): void {
  if (!isAbsolute(path) || path === "/") {
    throw new CredentialVaultError(
      "invalid_input",
      "credential recovery path must be an absolute non-root path",
    );
  }
}

function ensurePrivateParent(path: string): string {
  const parent = dirname(path);
  const existed = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stats = lstatSync(parent);
  const expectedUid = process.getuid?.();
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.mode & 0o077) !== 0 ||
    (stats.mode & 0o200) === 0 ||
    (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new CredentialVaultError(
      "invalid_vault",
      "credential recovery directory must be private, writable, non-symlinked and owned by this user",
    );
  }
  if (!existed) chmodSync(parent, 0o700);
  return parent;
}

function assertPrivateRecoveryFile(path: string): void {
  const stats = lstatSync(path);
  const expectedUid = process.getuid?.();
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new CredentialVaultError(
      "invalid_vault",
      "credential recovery file must be a mode 0600 regular file owned by this user",
    );
  }
  if (stats.size < 1 || stats.size > MAX_RECOVERY_FILE_BYTES) {
    throw new CredentialVaultError(
      "invalid_vault",
      "credential recovery file size is outside the allowed range",
    );
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // The recovery file itself is always fsynced before rename.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readCredentialRecoveryFile(
  path: string,
): CredentialRecoveryEnvelope {
  ensureRecoveryPath(path);
  assertPrivateRecoveryFile(path);
  try {
    return parseCredentialRecoveryEnvelope(
      JSON.parse(readFileSync(path, "utf8")),
    );
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    throw new CredentialVaultError(
      "invalid_vault",
      "credential recovery file is not valid JSON",
    );
  }
}

export function writeCredentialRecoveryFileAtomic(
  path: string,
  envelopeValue: CredentialRecoveryEnvelope,
  options: { readonly replace?: boolean } = {},
): void {
  ensureRecoveryPath(path);
  const parent = ensurePrivateParent(path);
  const envelope = parseCredentialRecoveryEnvelope(envelopeValue);
  if (existsSync(path)) {
    assertPrivateRecoveryFile(path);
    if (!options.replace) {
      throw new CredentialVaultError(
        "invalid_input",
        "credential recovery file already exists; choose a new path",
      );
    }
  }
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECOVERY_FILE_BYTES) {
    throw new CredentialVaultError(
      "invalid_vault",
      "credential recovery envelope exceeds its file limit",
    );
  }
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(tempPath);
    } catch {
      // The temporary file may not exist or may already be committed.
    }
    throw error;
  }
}
