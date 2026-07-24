import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";

describe("persistent database file security", () => {
  it("protects the database directory, database and WAL sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-db-security-"));
    chmodSync(root, 0o755);
    const databasePath = join(root, "avity.sqlite");
    const db = openDatabase(databasePath);
    try {
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(lstatSync(databasePath).mode & 0o777).toBe(0o600);
      for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
        if (existsSync(sidecar)) {
          expect(lstatSync(sidecar).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      db.close();
    }
  });

  it("refuses a symbolic-link database before opening it", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-db-symlink-"));
    chmodSync(root, 0o700);
    const target = join(root, "target.sqlite");
    writeFileSync(target, "do-not-touch", { mode: 0o600 });
    const databasePath = join(root, "avity.sqlite");
    symlinkSync(target, databasePath);
    expect(() => openDatabase(databasePath)).toThrow(/non-symlinked/);
  });

  it("refuses relative persistent paths without changing the working directory", () => {
    expect(() => openDatabase("relative.sqlite")).toThrow(
      /absolute and non-root/,
    );
  });

  it("applies the worker certificate-fingerprint migration on a fresh database", () => {
    const db = openDatabase(":memory:");
    try {
      const versions = db.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all() as { version: number }[];
      const workerColumns = db.prepare(
        "PRAGMA table_info(workers)",
      ).all() as { name: string }[];
      expect(versions.at(-1)?.version).toBe(9);
      expect(workerColumns.map((column) => column.name)).toContain(
        "mtls_fingerprint",
      );
    } finally {
      db.close();
    }
  });
});
