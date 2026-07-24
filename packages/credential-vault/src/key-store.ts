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
  renameSync,
  unlinkSync,
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
  replace(expected: Uint8Array | null, next: Uint8Array): Buffer;
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
    try {
      return this.replace(null, key);
    } catch {
      const raced = this.load();
      if (raced) return raced;
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault key could not be created in Keychain",
      );
    }
  }

  replace(expectedValue: Uint8Array | null, nextValue: Uint8Array): Buffer {
    const expected = expectedValue === null
      ? null
      : decodeCredentialVaultKey(encodeCredentialVaultKey(expectedValue));
    const next = decodeCredentialVaultKey(encodeCredentialVaultKey(nextValue));
    const current = this.load();
    if (
      (expected === null && current !== null) ||
      (expected !== null && (current === null || !current.equals(expected)))
    ) {
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault Keychain item changed before replacement",
      );
    }
    const encoded = encodeCredentialVaultKey(next);
    try {
      this.runner([
        "add-generic-password",
        ...(current ? ["-U"] : []),
        "-s",
        this.service,
        "-a",
        this.account,
        "-w",
      ], `${encoded}\n${encoded}\n`);
    } catch {
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault key could not be replaced in Keychain",
      );
    }
    const persisted = this.load();
    if (!persisted || !persisted.equals(next)) {
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
    const key = randomBytes(32);
    try {
      return this.replace(null, key);
    } catch (error) {
      const raced = this.load();
      if (raced) return raced;
      throw error;
    }
  }

  private ensureWritableParent(): string {
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
    return parent;
  }

  replace(expectedValue: Uint8Array | null, nextValue: Uint8Array): Buffer {
    const expected = expectedValue === null
      ? null
      : decodeCredentialVaultKey(encodeCredentialVaultKey(expectedValue));
    const next = decodeCredentialVaultKey(encodeCredentialVaultKey(nextValue));
    const current = this.load();
    if (
      (expected === null && current !== null) ||
      (expected !== null && (current === null || !current.equals(expected)))
    ) {
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault key file changed before replacement",
      );
    }
    const parent = this.ensureWritableParent();
    if (current === null) {
      const descriptor = openSync(this.path, "wx", 0o600);
      try {
        writeFileSync(
          descriptor,
          `${encodeCredentialVaultKey(next)}\n`,
          "utf8",
        );
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(this.path, 0o600);
      fsyncDirectory(parent);
    } else {
      const tempPath = `${this.path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      let descriptor: number | undefined;
      try {
        descriptor = openSync(tempPath, "wx", 0o600);
        writeFileSync(
          descriptor,
          `${encodeCredentialVaultKey(next)}\n`,
          "utf8",
        );
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        // Re-read immediately before the rename. A concurrent replacement
        // changes the expected value and fails closed.
        const beforeRename = this.load();
        if (!beforeRename || !beforeRename.equals(current)) {
          throw new CredentialVaultError(
            "invalid_key",
            "credential vault key file changed during replacement",
          );
        }
        renameSync(tempPath, this.path);
        chmodSync(this.path, 0o600);
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
    const persisted = this.load();
    if (!persisted || !persisted.equals(next)) {
      throw new CredentialVaultError(
        "invalid_key",
        "credential vault key file replacement could not be verified",
      );
    }
    return persisted;
  }
}

export function loadOrCreateCredentialVaultKey(
  keyStore: CredentialVaultKeyStore,
): Buffer {
  return keyStore.load() ?? keyStore.create();
}
