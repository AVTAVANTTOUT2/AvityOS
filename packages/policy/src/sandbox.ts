import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface SandboxCredentialFile {
  /** Absolute path to the host credential file (must already exist and be readable). */
  sourcePath: string;
  /**
   * Destination under the throwaway HOME (e.g. `.codex/auth.json`). Must be a
   * relative path with no `..` segments.
   */
  homeRelativePath: string;
  /** Prefer read-only staging (chmod 0400). Default: true. */
  readonly?: boolean;
}

export interface SandboxCommandOptions {
  allowNetwork?: boolean;
  /** Explicit env vars only; never a copy of process.env. */
  env?: Record<string, string>;
  /**
   * Minimal credential files to stage into the throwaway HOME. Never stages the
   * full host HOME, SSH keys, or unrelated provider configs.
   */
  credentialFiles?: readonly SandboxCredentialFile[];
}

export interface SandboxedCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Absolute path of the throwaway HOME created for this invocation. */
  home: string;
  cleanup(): void;
}

/**
 * Build a fail-closed OS-sandboxed invocation for an argv command.
 *
 * The workspace and an isolated temporary HOME are the only writable paths.
 * Network access is denied unless a mission explicitly opts into it. If the
 * host cannot provide the required primitive, the command is not executed.
 */
export function sandboxCommand(
  argv: readonly string[],
  cwd: string,
  options: SandboxCommandOptions = {},
): SandboxedCommand {
  const [executable, ...args] = argv;
  if (!executable) throw new Error("empty command");

  const workspace = realpathSync(cwd);
  const resolvedExecutable = resolveExecutablePath(executable);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "avity-sandbox-home-")));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(home, { recursive: true, force: true });
  };

  try {
    stageCredentialFiles(home, options.credentialFiles ?? []);
    const invocation = sandboxInvocation(
      resolvedExecutable,
      args,
      workspace,
      home,
      options.allowNetwork ?? false,
    );
    return {
      ...invocation,
      home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: home,
        ...options.env,
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Resolve a bare program name against PATH (or an absolute/relative path) to a
 * canonical absolute path *before* entering the OS sandbox. CLIs installed
 * under the user HOME (e.g. `~/.local/bin/codex`) cannot be found via PATH once
 * host HOME reads are denied.
 */
export function resolveExecutablePath(executable: string): string {
  if (executable.includes("/") || isAbsolute(executable)) {
    if (!existsSync(executable)) {
      throw new Error(`executable not found: ${executable}`);
    }
    return realpathSync(executable);
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, executable);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`executable not found on PATH: ${executable}`);
}

function stageCredentialFiles(home: string, files: readonly SandboxCredentialFile[]): void {
  for (const file of files) {
    if (typeof file.homeRelativePath !== "string" || file.homeRelativePath.trim().length === 0) {
      throw new Error("credential homeRelativePath must be a non-empty relative path");
    }
    if (isAbsolute(file.homeRelativePath) || file.homeRelativePath.split(/[\\/]+/).includes("..")) {
      throw new Error(`credential homeRelativePath escapes sandbox HOME: ${file.homeRelativePath}`);
    }
    if (!existsSync(file.sourcePath)) {
      throw new Error(`credential file missing or unreadable: ${file.sourcePath}`);
    }
    const dest = join(home, file.homeRelativePath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file.sourcePath, dest);
    if (file.readonly !== false) {
      chmodSync(dest, 0o400);
    }
  }
}

function sandboxInvocation(
  executable: string,
  args: string[],
  cwd: string,
  home: string,
  allowNetwork: boolean,
): { executable: string; args: string[] } {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    const quote = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const hostHome = realpathSync(homedir());
    const exeDir = dirname(executable);
    // Deny host-HOME *data* but keep *metadata* so path walking (realpath /
    // Node module resolution) can traverse /Users/<name>/… to reach an
    // explicitly allowed CLI install dir or workspace without exposing file
    // contents (SSH keys, tokens, other providers' configs).
    const profile = [
      "(version 1)",
      "(allow default)",
      `(deny file-read-data (subpath "${quote(hostHome)}"))`,
      `(allow file-read-metadata (subpath "${quote(hostHome)}"))`,
      `(allow file-read-data (literal "${quote(executable)}"))`,
      `(allow file-read-data (subpath "${quote(exeDir)}"))`,
      `(allow file-read-data (subpath "${quote(cwd)}"))`,
      `(allow file-read-data (subpath "${quote(home)}"))`,
      "(deny file-write*)",
      `(allow file-write* (subpath "${quote(cwd)}"))`,
      `(allow file-write* (subpath "${quote(home)}"))`,
      '(allow file-write* (subpath "/dev"))',
      ...(allowNetwork ? [] : ["(deny network*)"]),
    ].join("\n");
    return { executable: "/usr/bin/sandbox-exec", args: ["-p", profile, executable, ...args] };
  }

  const bwrap = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].find(existsSync);
  if (process.platform === "linux" && bwrap) {
    return {
      executable: bwrap,
      args: [
        "--die-with-parent", "--unshare-all", ...(allowNetwork ? ["--share-net"] : []),
        "--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/home", "--tmpfs", "/root",
        "--bind", cwd, cwd, "--bind", home, home,
        "--chdir", cwd, "--setenv", "HOME", home, "--setenv", "TMPDIR", home,
        executable, ...args,
      ],
    };
  }

  throw new Error("no supported OS sandbox is available; install bubblewrap on Linux or use a macOS worker");
}
