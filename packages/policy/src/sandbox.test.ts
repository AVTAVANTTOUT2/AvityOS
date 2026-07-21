import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxCommand } from "./sandbox.js";

const SANDBOX_AVAILABLE =
  (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) ||
  (process.platform === "linux" && ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].some(existsSync));

describe.skipIf(!SANDBOX_AVAILABLE)("sandboxCommand credential staging", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("stages only the declared credential file read-only into throwaway HOME", () => {
    const host = mkdtempSync(join(tmpdir(), "avity-cred-host-"));
    dirs.push(host);
    const ws = mkdtempSync(join(tmpdir(), "avity-cred-ws-"));
    dirs.push(ws);
    const source = join(host, "auth.json");
    writeFileSync(source, '{"token":"secret-cred"}\n', { mode: 0o600 });

    const invocation = sandboxCommand(["node", "-e", "process.exit(0)"], ws, {
      credentialFiles: [{ sourcePath: source, homeRelativePath: ".codex/auth.json", readonly: true }],
    });
    try {
      const staged = join(invocation.home, ".codex", "auth.json");
      expect(existsSync(staged)).toBe(true);
      expect(readFileSync(staged, "utf8")).toContain("secret-cred");
      expect(statSync(staged).mode & 0o777).toBe(0o400);
      expect(existsSync(join(invocation.home, "auth.json"))).toBe(false);
    } finally {
      invocation.cleanup();
    }
  });

  it("rejects credential destinations that escape the throwaway HOME", () => {
    const host = mkdtempSync(join(tmpdir(), "avity-cred-bad-"));
    dirs.push(host);
    const ws = mkdtempSync(join(tmpdir(), "avity-cred-ws-"));
    dirs.push(ws);
    const source = join(host, "auth.json");
    writeFileSync(source, "x\n");

    expect(() =>
      sandboxCommand(["true"], ws, {
        credentialFiles: [{ sourcePath: source, homeRelativePath: "../escape.json" }],
      }),
    ).toThrow(/escapes sandbox HOME/);
  });
});

describe("sandboxCommand availability", () => {
  it("throws a clear error when no OS sandbox primitive exists", () => {
    if (SANDBOX_AVAILABLE) return;
    const ws = mkdtempSync(join(tmpdir(), "avity-nosbx-"));
    try {
      expect(() => sandboxCommand(["true"], ws)).toThrow(/no supported OS sandbox/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
