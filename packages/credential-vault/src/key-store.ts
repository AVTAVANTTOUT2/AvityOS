import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  CredentialVaultError,
  decodeCredentialVaultKey,
  encodeCredentialVaultKey,
} from "./index.js";

export interface CredentialVaultKeyStore {
  readonly description: string;
  load(): Buffer | null;
  create(): Buffer;
}

function isMissingKeychainItem(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 44
  );
}

export type KeychainRunner = (
  args: readonly string[],
  input?: string,
) => string;

function defaultKeychainRunner(
  args: readonly string[],
  input?: string,
): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  };
  return execFileSync("/usr/bin/security", [...args], options);
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // The key file itself is fsynced. Directory fsync is best effort for
    // filesystems that do not support it.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class MacOSCredentialVaultKeyStore implements CredentialVaultKeyStore {
  readonly description = "macOS Keychain";

  constructor(
    private readonly service = "com.avityos.operator-vault",
    private readonly account = "master-key-v1",
    private readonly runner: KeychainRunner = defaultKeychainRunner,
  ) {}

  load(): Buffer | null {
    try {
      return decodeCredentialVaultKey(this.runner([
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        this.account,
        "-w",
      ]).trim());
    } catch (error) {
      if (isMissingKeychainItem(error)) return null;
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault key could not be loaded from Keychain",
      );
    }
  }

  create(): Buffer {
    const existing = this.load();
    if (existing) return existing;
    const key = randomBytes(32);
    const encoded = encodeCredentialVaultKey(key);
    try {
      this.runner([
        "add-generic-password",
        "-s",
        this.service,
        "-a",
        this.account,
        "-w",
      ], `${encoded}\n${encoded}\n`);
    } catch {
      const raced = this.load();
      if (raced) return raced;
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault key could not be created in Keychain",
      );
    }
    const persisted = this.load();
    if (!persisted || !persisted.equals(key)) {
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault Keychain write could not be verified",
      );
    }
    return persisted;
  }
}

export class FileCredentialVaultKeyStore implements CredentialVaultKeyStore {
  readonly description: string;

  constructor(readonly path: string) {
    if (!isAbsolute(path) || path === "/") {
      throw new CredentialVaultError(
        "invalid_input",
        "credential vault key file must be an absolute non-root path",
      );
    }
    this.description = `private key file ${path}`;
  }

  load(): Buffer | null {
    if (!existsSync(this.path)) return null;
    const stats = lstatSync(this.path);
    const expectedUid = process.getuid?.();
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      (stats.mode & 0o777) !== 0o600 ||
      (expectedUid !== undefined && stats.uid !== expectedUid)
    ) {
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault key must be a private regular file owned by this user",
      );
    }
    if (stats.size < 1 || stats.size > 256) {
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault key file size is invalid",
      );
    }
    return decodeCredentialVaultKey(readFileSync(this.path, "utf8").trim());
  }

  create(): Buffer {
    const existing = this.load();
    if (existing) return existing;
    const parent = dirname(this.path);
    const parentExisted = existsSync(parent);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStats = lstatSync(parent);
    const expectedUid = process.getuid?.();
    if (
      !parentStats.isDirectory() ||
      parentStats.isSymbolicLink() ||
      (parentStats.mode & 0o077) !== 0 ||
      (parentStats.mode & 0o200) === 0 ||
      (expectedUid !== undefined && parentStats.uid !== expectedUid)
    ) {
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault key directory must be private, writable, non-symlinked and owned by this user",
      );
    }
    if (!parentExisted) chmodSync(parent, 0o700);
    const key = randomBytes(32);
    let descriptor: number;
    try {
      descriptor = openSync(this.path, "wx", 0o600);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        const raced = this.load();
        if (raced) return raced;
      }
      throw error;
    }
    try {
      writeFileSync(descriptor, `${encodeCredentialVaultKey(key)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(this.path, 0o600);
    fsyncDirectory(parent);
    return key;
  }
}

export function loadOrCreateCredentialVaultKey(
  keyStore: CredentialVaultKeyStore,
): Buffer {
  return keyStore.load() ?? keyStore.create();
}
