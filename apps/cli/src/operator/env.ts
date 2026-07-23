import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

export type EnvMap = Record<string, string>;

/**
 * Parse a strict KEY=VALUE environment file.
 */
export function parseEnvText(content: string): EnvMap {
  const map: EnvMap = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`invalid env entry "${rawLine}"`);
    }
    const key = line.slice(0, separator).trim();
    if (!ENV_KEY.test(key)) {
      throw new Error(`invalid env key "${key}"`);
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
    return `${key}=${entries[key] ?? ""}`;
  });
  return `${lines.join("\n")}\n`;
}

export function readEnvFile(path: string): EnvMap {
  const text = readFileSync(path, "utf8");
  return parseEnvText(text);
}

export function writeEnvFileAtomic(path: string, entries: EnvMap): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, serializeEnv(entries), { mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}
