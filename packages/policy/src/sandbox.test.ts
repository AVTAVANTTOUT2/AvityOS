import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxCommand, type SandboxCommandOptions } from "./sandbox.js";

const SANDBOX_AVAILABLE =
  (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) ||
  (process.platform === "linux" && ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].some(existsSync));

function nodeBin(): string {
  return realpathSync(process.execPath);
}

/** Run a Node snippet inside the sandbox and capture stdout + exit code. */
function runInSandbox(
  code: string,
  cwd: string,
  options: SandboxCommandOptions = {},
): { out: string; code: number | null } {
  const inv = sandboxCommand([nodeBin(), "-e", code], cwd, options);
  try {
    const out = execFileSync(inv.executable, inv.args, {
      cwd,
      env: inv.env,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number | null };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? null };
  } finally {
    inv.cleanup();
  }
}

/** Snippet that reads a file and prints its content, or prints DENIED on error. */
function readProbe(path: string): string {
  return `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)},'utf8'))}catch(e){process.stdout.write('DENIED:'+e.code)}`;
}

describe.skipIf(!SANDBOX_AVAILABLE)("sandbox read boundary", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  function ws(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "avity-sbx-ws-")));
    cleanups.push(dir);
    return dir;
  }

  it("runs the executable and its runtime dependencies (node --version)", () => {
    const inv = sandboxCommand([nodeBin(), "--version"], ws());
    try {
      const out = execFileSync(inv.executable, inv.args, {
        cwd: inv.env.HOME as string,
        env: inv.env,
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(out).toMatch(/^v\d+\./);
    } finally {
      inv.cleanup();
    }
  });

  it("allows reading files inside the workspace (content returned)", () => {
    const workspace = ws();
    writeFileSync(join(workspace, "in.txt"), "WORKSPACE_CONTENT");
    const r = runInSandbox(readProbe(join(workspace, "in.txt")), workspace);
    expect(r.out).toBe("WORKSPACE_CONTENT");
  });

  it("allows writing files inside the workspace", () => {
    const workspace = ws();
    const r = runInSandbox(
      "require('fs').writeFileSync(process.cwd()+'/out.txt','WRITTEN');process.stdout.write('OK')",
      workspace,
    );
    expect(r.out).toBe("OK");
    expect(readFileSync(join(workspace, "out.txt"), "utf8")).toBe("WRITTEN");
  });

  it("allows reading and writing the throwaway HOME (content returned)", () => {
    const workspace = ws();
    const r = runInSandbox(
      "const fs=require('fs');fs.writeFileSync(process.env.HOME+'/h.txt','HOME_OK');process.stdout.write(fs.readFileSync(process.env.HOME+'/h.txt','utf8'))",
      workspace,
    );
    expect(r.out).toBe("HOME_OK");
  });

  it("denies reading a secret in the real host HOME (content not returned)", () => {
    const workspace = ws();
    const canary = join(homedir(), `.avity-sbx-canary-${process.pid}-${Date.now()}.txt`);
    writeFileSync(canary, "SECRET_REAL_HOME");
    try {
      const r = runInSandbox(readProbe(canary), workspace);
      expect(r.out).not.toContain("SECRET_REAL_HOME");
      expect(r.out).toContain("DENIED");
    } finally {
      rmSync(canary, { force: true });
    }
  });

  it("denies reading a secret in /tmp (canonical) outside the workspace", () => {
    const workspace = ws();
    // A sibling temp file that is NOT the workspace: proves "read-only /tmp" is
    // not granted just because the workspace happens to live under /tmp.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "avity-sbx-outside-")));
    cleanups.push(outside);
    writeFileSync(join(outside, "secret.txt"), "SECRET_TMP_OUTSIDE");
    const r = runInSandbox(readProbe(join(outside, "secret.txt")), workspace);
    expect(r.out).not.toContain("SECRET_TMP_OUTSIDE");
    expect(r.out).toContain("DENIED");
  });

  it("denies reading a secret in a second repository", () => {
    const workspace = ws();
    const otherRepo = realpathSync(mkdtempSync(join(tmpdir(), "avity-sbx-otherrepo-")));
    cleanups.push(otherRepo);
    writeFileSync(join(otherRepo, "secret.txt"), "SECRET_OTHER_REPO");
    const r = runInSandbox(readProbe(join(otherRepo, "secret.txt")), workspace);
    expect(r.out).not.toContain("SECRET_OTHER_REPO");
    expect(r.out).toContain("DENIED");
  });

  it("denies reading another provider's credential in the real HOME", () => {
    const workspace = ws();
    const cred = join(homedir(), `.avity-sbx-othercred-${process.pid}-${Date.now()}`);
    writeFileSync(cred, "SECRET_OTHER_PROVIDER_TOKEN");
    try {
      const r = runInSandbox(readProbe(cred), workspace);
      expect(r.out).not.toContain("SECRET_OTHER_PROVIDER_TOKEN");
      expect(r.out).toContain("DENIED");
    } finally {
      rmSync(cred, { force: true });
    }
  });

  it("denies network by default and allows it only when opted in", () => {
    const workspace = ws();
    // Probe *external* reachability, not a local loopback bind: Linux
    // `--unshare-all` gives an isolated netns with a working loopback, so a
    // 127.0.0.1 bind succeeds even when external network is denied. A connect to
    // a public IP fails immediately (ENETUNREACH/EPERM) when denied and
    // connects when allowed (CI runners have outbound internet).
    const probe =
      "const net=require('net');const s=net.connect({host:'1.1.1.1',port:443});" +
      "s.setTimeout(9000);" +
      "s.on('connect',()=>{process.stdout.write('NETOK');s.destroy();process.exit(0)});" +
      "s.on('timeout',()=>{process.stdout.write('NETERR:timeout');s.destroy();process.exit(0)});" +
      "s.on('error',e=>{process.stdout.write('NETERR:'+e.code);process.exit(0)});";
    const denied = runInSandbox(probe, workspace, { allowNetwork: false });
    expect(denied.out).toContain("NETERR");
    const allowed = runInSandbox(probe, workspace, { allowNetwork: true });
    expect(allowed.out).toBe("NETOK");
  });

  it("grants an explicitly declared readable path and nothing adjacent to it", () => {
    const workspace = ws();
    const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "avity-sbx-data-")));
    cleanups.push(dataRoot);
    writeFileSync(join(dataRoot, "allowed.txt"), "DECLARED_DATA");
    const sibling = realpathSync(mkdtempSync(join(tmpdir(), "avity-sbx-sibling-")));
    cleanups.push(sibling);
    writeFileSync(join(sibling, "secret.txt"), "SIBLING_SECRET");

    const allowed = runInSandbox(readProbe(join(dataRoot, "allowed.txt")), workspace, {
      readablePaths: [dataRoot],
    });
    expect(allowed.out).toBe("DECLARED_DATA");

    // The sibling was not declared → still denied even though a peer temp dir is.
    const denied = runInSandbox(readProbe(join(sibling, "secret.txt")), workspace, {
      readablePaths: [dataRoot],
    });
    expect(denied.out).not.toContain("SIBLING_SECRET");
    expect(denied.out).toContain("DENIED");
  });
});

describe.skipIf(!SANDBOX_AVAILABLE)("sandboxCommand credential staging", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("stages only the declared credential file read-only into throwaway HOME", () => {
    const host = mkdtempSync(join(tmpdir(), "avity-cred-host-"));
    dirs.push(host);
    const workspace = mkdtempSync(join(tmpdir(), "avity-cred-ws-"));
    dirs.push(workspace);
    const source = join(host, "auth.json");
    writeFileSync(source, '{"token":"secret-cred"}\n', { mode: 0o600 });

    const invocation = sandboxCommand([nodeBin(), "-e", "process.exit(0)"], workspace, {
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
    const workspace = mkdtempSync(join(tmpdir(), "avity-cred-ws-"));
    dirs.push(workspace);
    const source = join(host, "auth.json");
    writeFileSync(source, "x\n");

    expect(() =>
      sandboxCommand([nodeBin(), "--version"], workspace, {
        credentialFiles: [{ sourcePath: source, homeRelativePath: "../escape.json" }],
      }),
    ).toThrow(/escapes sandbox HOME/);
  });
});

describe("sandboxCommand option validation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("rejects a relative readablePath (allowlist cannot be widened loosely)", () => {
    const workspace = mkdtempSync(join(tmpdir(), "avity-rel-ws-"));
    dirs.push(workspace);
    expect(() =>
      sandboxCommand([nodeBin(), "--version"], workspace, { readablePaths: ["relative/dir"] }),
    ).toThrow(/must be absolute/);
  });

  it("rejects a non-existent readablePath", () => {
    const workspace = mkdtempSync(join(tmpdir(), "avity-missing-ws-"));
    dirs.push(workspace);
    expect(() =>
      sandboxCommand([nodeBin(), "--version"], workspace, {
        readablePaths: [join(workspace, "does-not-exist")],
      }),
    ).toThrow(/does not exist/);
  });
});

describe("sandboxCommand availability", () => {
  it("throws a clear error when no OS sandbox primitive exists", () => {
    if (SANDBOX_AVAILABLE) return;
    const workspace = mkdtempSync(join(tmpdir(), "avity-nosbx-"));
    try {
      expect(() => sandboxCommand(["true"], workspace)).toThrow(/no supported OS sandbox/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
