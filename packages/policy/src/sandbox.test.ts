import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DARWIN_MACH_LOOKUP_ALLOWLIST,
  DARWIN_MACH_LOOKUP_ALLOWLIST_JUSTIFICATION,
  detectRuntimeReadRoots,
  FORBIDDEN_AUTO_RUNTIME_ROOTS,
  packageManagerRootsForPath,
  resolveShebangInterpreter,
  resolveSystemCaBundle,
  runtimeRootsFromOtoolOutputs,
  sandboxCommand,
  type SandboxCommandOptions,
} from "./sandbox.js";

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
      expect(inv.home.length).toBeLessThanOrEqual(48);
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
    mkdirSync(join(host, ".codex"), { recursive: true });
    const source = join(host, ".codex", "auth.json");
    writeFileSync(source, '{"token":"secret-cred"}\n', { mode: 0o600 });

    const invocation = sandboxCommand([nodeBin(), "-e", "process.exit(0)"], workspace, {
      credentialHome: host,
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
        credentialHome: host,
        credentialFiles: [{ sourcePath: source, homeRelativePath: "../escape.json" }],
      }),
    ).toThrow(/escapes sandbox HOME/);
  });

  it("refuses to stage when ~/.codex/auth.json is a symlink to another provider secret", () => {
    const host = mkdtempSync(join(tmpdir(), "avity-cred-symlink-"));
    dirs.push(host);
    const workspace = mkdtempSync(join(tmpdir(), "avity-cred-ws-"));
    dirs.push(workspace);
    mkdirSync(join(host, ".claude"), { recursive: true });
    mkdirSync(join(host, ".codex"), { recursive: true });
    const otherSecret = join(host, ".claude", ".credentials.json");
    writeFileSync(otherSecret, '{"stolen":"OTHER_PROVIDER_SECRET"}\n', { mode: 0o600 });
    const codexAuth = join(host, ".codex", "auth.json");
    symlinkSync(otherSecret, codexAuth);

    expect(() =>
      sandboxCommand([nodeBin(), "-e", "process.exit(0)"], workspace, {
        credentialHome: host,
        credentialFiles: [
          { sourcePath: codexAuth, homeRelativePath: ".codex/auth.json", readonly: true },
        ],
      }),
    ).toThrow(/must not be a symlink/);
  });
});

describe("sandboxCommand reserved env", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("rejects options.env that tries to replace sandbox-owned environment before launch", () => {
    if (!SANDBOX_AVAILABLE) return;
    const workspace = mkdtempSync(join(tmpdir(), "avity-env-ws-"));
    dirs.push(workspace);
    expect(() =>
      sandboxCommand([nodeBin(), "--version"], workspace, { env: { HOME: "/tmp/evil-home" } }),
    ).toThrow(/reserved variables/);
    expect(() =>
      sandboxCommand([nodeBin(), "--version"], workspace, { env: { TMPDIR: "/tmp/evil-tmp" } }),
    ).toThrow(/reserved variables/);
    expect(() =>
      sandboxCommand([nodeBin(), "--version"], workspace, { env: { PATH: "/evil/bin" } }),
    ).toThrow(/reserved variables/);
    expect(() =>
      sandboxCommand([nodeBin(), "--version"], workspace, {
        env: { SSL_CERT_FILE: join(workspace, "untrusted-ca.pem") },
      }),
    ).toThrow(/reserved variables/);
  });

  it("keeps HOME as the throwaway home and TMPDIR inside it", () => {
    if (!SANDBOX_AVAILABLE) return;
    const workspace = mkdtempSync(join(tmpdir(), "avity-env-keep-"));
    dirs.push(workspace);
    const inv = sandboxCommand(
      [nodeBin(), "-e", "process.stdout.write([process.env.HOME,process.env.TMPDIR].join('|'))"],
      workspace,
      { env: { CODEX_API_KEY: "x" } },
    );
    try {
      const out = execFileSync(inv.executable, inv.args, {
        cwd: workspace,
        env: inv.env,
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(inv.env.HOME).toBe(inv.home);
      expect(inv.env.TMPDIR).toBe(inv.home);
      expect(out).toBe(`${inv.home}|${inv.home}`);
      expect(inv.home).not.toBe(homedir());
    } finally {
      inv.cleanup();
    }
  });

  it("pins network-enabled commands to a readable system CA bundle", () => {
    if (!SANDBOX_AVAILABLE) return;
    const workspace = mkdtempSync(join(tmpdir(), "avity-env-ca-"));
    dirs.push(workspace);
    const expected = resolveSystemCaBundle();
    expect(expected).toBeDefined();

    const inv = sandboxCommand([nodeBin(), "--version"], workspace, {
      allowNetwork: true,
    });
    try {
      expect(inv.env.SSL_CERT_FILE).toBe(expected);
      expect(statSync(inv.env.SSL_CERT_FILE as string).isFile()).toBe(true);
    } finally {
      inv.cleanup();
    }
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

describe("runtime dependency grants", () => {
  it("resolves an env shebang interpreter through the supplied PATH", () => {
    const scratch = mkdtempSync(join(tmpdir(), "avity-shebang-"));
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const script = join(scratch, "tool");
    const interpreter = join(bin, "node");
    writeFileSync(script, "#!/usr/bin/env node\n");
    writeFileSync(interpreter, "");
    try {
      expect(resolveShebangInterpreter(script, bin)).toBe(
        realpathSync(interpreter),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("never auto-grants forbidden roots from simulated otool output", () => {
    const exe = "/opt/homebrew/Cellar/node/26.5.0/bin/node";
    const roots = runtimeRootsFromOtoolOutputs(exe, [
      {
        path: exe,
        otoolL: [
          `${exe}:`,
          "\t@rpath/libnode.147.dylib (compatibility version 0.0.0, current version 0.0.0)",
          "\t/opt/homebrew/opt/llhttp/lib/libllhttp.9.4.dylib (compatibility version 9.4.0, current version 9.4.2)",
          "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)",
        ].join("\n"),
        otoolLoadCommands: [
          "          cmd LC_RPATH",
          "      cmdsize 32",
          "         path @loader_path/../lib (offset 12)",
        ].join("\n"),
      },
      {
        path: "/opt/homebrew/Cellar/node/26.5.0/lib/libnode.147.dylib",
        otoolL: [
          "/opt/homebrew/Cellar/node/26.5.0/lib/libnode.147.dylib:",
          "\t/opt/homebrew/opt/brotli/lib/libbrotlidec.1.dylib (compatibility version 1.0.0, current version 1.0.0)",
        ].join("\n"),
      },
    ]);

    for (const forbidden of FORBIDDEN_AUTO_RUNTIME_ROOTS) {
      expect(roots).not.toContain(forbidden);
    }
    expect(roots).toContain("/opt/homebrew/Cellar/node/26.5.0");
    expect(roots).toContain("/opt/homebrew/opt/llhttp");
    expect(roots).toContain("/opt/homebrew/opt/llhttp/lib");
    expect(roots).toContain("/opt/homebrew/opt/brotli");
    expect(roots.some((r) => r.includes("/Cellar/git/"))).toBe(false);
    expect(roots.some((r) => r.includes("/opt/git"))).toBe(false);
  });

  it("packageManagerRootsForPath returns exact formula roots only", () => {
    expect(packageManagerRootsForPath("/opt/homebrew/Cellar/node/26.5.0/bin/node")).toEqual([
      "/opt/homebrew/Cellar/node/26.5.0",
    ]);
    expect(packageManagerRootsForPath("/opt/homebrew/opt/llhttp/lib/libllhttp.dylib")).toEqual([
      "/opt/homebrew/opt/llhttp",
    ]);
    expect(packageManagerRootsForPath("/opt/homebrew/bin/node")).toEqual([]);
  });

  it("detectRuntimeReadRoots for the real node never grants Homebrew/usr.local prefixes", () => {
    const roots = detectRuntimeReadRoots(nodeBin());
    for (const forbidden of FORBIDDEN_AUTO_RUNTIME_ROOTS) {
      expect(roots, `must not grant ${forbidden}`).not.toContain(forbidden);
    }
    expect(roots.some((r) => r === "/opt/homebrew" || r === "/usr/local")).toBe(false);
  });
});

describe("Mach allowlist documentation", () => {
  it("documents a justification for every allowlisted Mach service", () => {
    for (const name of DARWIN_MACH_LOOKUP_ALLOWLIST) {
      expect(DARWIN_MACH_LOOKUP_ALLOWLIST_JUSTIFICATION[name].length).toBeGreaterThan(10);
    }
  });
});

describe.skipIf(!SANDBOX_AVAILABLE || process.platform !== "darwin")("macOS Homebrew grant narrowing", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  it("starts a real Homebrew runtime and denies a sibling undeclared package canary", (ctx) => {
    const node = nodeBin();
    if (!node.includes("/opt/homebrew/") && !node.includes("/usr/local/")) {
      ctx.skip();
      return;
    }
    const roots = detectRuntimeReadRoots(node);
    expect(roots).not.toContain("/opt/homebrew");
    expect(roots).not.toContain("/usr/local");

    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "avity-brew-ws-")));
    cleanups.push(workspace);

    const prefix = node.includes("/opt/homebrew/") ? "/opt/homebrew" : "/usr/local";
    const cellar = join(prefix, "Cellar");
    if (!existsSync(cellar)) {
      ctx.skip();
      return;
    }

    const inv = sandboxCommand([node, "--version"], workspace);
    try {
      const out = execFileSync(inv.executable, inv.args, {
        cwd: workspace,
        env: inv.env,
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(out).toMatch(/^v\d+\./);

      const nodePackage = roots.find((r) => /\/Cellar\/node\/[^/]+$/.test(r) || /\/opt\/node$/.test(r));
      expect(nodePackage, `expected a node package root in ${roots.join(",")}`).toBeTruthy();

      const gitCellar = join(cellar, "git");
      if (existsSync(gitCellar)) {
        const canaryDir = realpathSync(gitCellar);
        if (!roots.some((r) => canaryDir === r || canaryDir.startsWith(r + "/"))) {
          const canary = join(canaryDir, `.avity-sibling-canary-${process.pid}`);
          try {
            writeFileSync(canary, "SECRET_SIBLING_FORMULA");
            const denied = runInSandbox(readProbe(canary), workspace);
            expect(denied.out).not.toContain("SECRET_SIBLING_FORMULA");
            expect(denied.out).toContain("DENIED");
          } catch {
            expect(roots.some((r) => r.includes("/Cellar/git/"))).toBe(false);
          } finally {
            rmSync(canary, { force: true });
          }
        }
      }
    } finally {
      inv.cleanup();
    }
  });
});

describe.skipIf(process.platform !== "darwin")("macOS Keychain canary", () => {
  const SERVICE = "avity.os.sandbox.keychain-canary";
  const ACCOUNT = `avity-os-canary-${process.pid}`;
  const SECRET = "CANARY_KEYCHAIN_SECRET_VALUE";

  function securityAvailable(): boolean {
    return existsSync("/usr/bin/security") && existsSync("/usr/bin/sandbox-exec");
  }

  function deleteCanary(): void {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE], {
        stdio: "ignore",
      });
    } catch {
      // absent is fine
    }
  }

  afterEach(() => {
    deleteCanary();
  });

  it("never returns a Keychain canary value from inside the sandbox", (ctx) => {
    if (!securityAvailable() || !SANDBOX_AVAILABLE) {
      ctx.skip();
      return;
    }

    let created = false;
    try {
      execFileSync(
        "/usr/bin/security",
        ["add-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w", SECRET, "-U"],
        { stdio: "ignore" },
      );
      created = true;
    } catch {
      ctx.skip();
      return;
    }

    try {
      const host = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"],
        { encoding: "utf8" },
      ).trim();
      expect(host).toBe(SECRET);

      const workspace = realpathSync(mkdtempSync(join(tmpdir(), "avity-kc-ws-")));
      const keychains = join(homedir(), "Library", "Keychains");
      // Grant Keychain files so the only remaining channel is Mach IPC.
      const inv = sandboxCommand(
        ["/usr/bin/security", "find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"],
        workspace,
        {
          readablePaths: existsSync(keychains) ? [keychains] : [],
          env: { CODEX_API_KEY: "irrelevant" },
        },
      );
      try {
        let out = "";
        let code: number | null = 0;
        try {
          out = execFileSync(inv.executable, inv.args, {
            cwd: workspace,
            // Outer HOME for default keychain path search; sandbox still applies
            // the Mach deny of SecurityServer / securityd.
            env: { ...inv.env, HOME: homedir() },
            encoding: "utf8",
            timeout: 15_000,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; status?: number | null };
          out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
          code = e.status ?? null;
        }
        expect(out).not.toContain(SECRET);
        expect(code === 0 && out.trim() === SECRET).toBe(false);
      } finally {
        inv.cleanup();
        rmSync(workspace, { recursive: true, force: true });
      }
    } finally {
      if (created) deleteCanary();
    }
  });

  it("denies pasteboard Mach IPC used for clipboard secret exfiltration", (ctx) => {
    if (!SANDBOX_AVAILABLE) {
      ctx.skip();
      return;
    }
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "avity-pb-ws-")));
    try {
      const inv = sandboxCommand(["/usr/bin/pbpaste"], workspace);
      try {
        let out = "";
        try {
          out = execFileSync(inv.executable, inv.args, {
            cwd: workspace,
            env: inv.env,
            encoding: "utf8",
            timeout: 10_000,
          });
        } catch (err) {
          const e = err as { stdout?: string; status?: number | null };
          out = e.stdout ?? "";
          expect(e.status === 0).toBe(false);
        }
        expect(out).not.toContain("CANARY_KEYCHAIN_SECRET_VALUE");
      } finally {
        inv.cleanup();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
