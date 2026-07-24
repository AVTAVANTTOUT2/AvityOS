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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const MAX_ENV_FILE_BYTES = 2 * 1024 * 1024;

export type EnvMap = Record<string, string>;

/**
 * Parse a strict KEY=VALUE environment file.
 */
export function parseEnvText(content: string): EnvMap {
  const map: EnvMap = {};
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`invalid env entry at line ${index + 1}`);
    }
    const key = line.slice(0, separator).trim();
    if (!ENV_KEY.test(key)) {
      throw new Error(`invalid env key at line ${index + 1}`);
    }
    const value = line.slice(separator + 1);
    map[key] = value;
  }
  return map;
}

export function serializeEnv(entries: EnvMap): string {
  const keys = Object.keys(entries).sort();
  const lines = keys.map((key) => {
    if (!ENV_KEY.test(key)) throw new Error(`invalid env key "${key}"`);
    const value = entries[key] ?? "";
    if (/[\u0000\r\n]/.test(value)) {
      throw new Error(`invalid multiline env value for "${key}"`);
    }
    return `${key}=${value}`;
  });
  return `${lines.join("\n")}\n`;
}

export function readEnvFile(path: string): EnvMap {
  const size = statSync(path).size;
  if (size > MAX_ENV_FILE_BYTES) {
    throw new Error(`environment file ${path} exceeds 2 MiB`);
  }
  const text = readFileSync(path, "utf8");
  return parseEnvText(text);
}

export function writeEnvFileAtomic(path: string, entries: EnvMap): void {
  const parent = dirname(path);
  const parentExisted = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
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
      `environment directory ${parent} must be private, writable, non-symlinked and owned by this user`,
    );
  }
  if (!parentExisted) chmodSync(parent, 0o700);
  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      (stats.mode & 0o777) !== 0o600 ||
      (expectedUid !== undefined && stats.uid !== expectedUid)
    ) {
      throw new Error(
        `environment path ${path} must be a mode 0600 regular file owned by this user`,
      );
    }
  }
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(descriptor, serializeEnv(entries), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
    try {
      const parentDescriptor = openSync(parent, "r");
      try {
        fsyncSync(parentDescriptor);
      } finally {
        closeSync(parentDescriptor);
      }
    } catch {
      // Directory fsync is unavailable on some filesystems. The temporary
      // file itself was already fsynced before the atomic rename.
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(tempPath);
    } catch {
      // The rename may already have completed or the temp never existed.
    }
    throw error;
  }
}
