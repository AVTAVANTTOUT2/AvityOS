import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxedCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
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
  options: { allowNetwork?: boolean; env?: Record<string, string> } = {},
): SandboxedCommand {
  const [executable, ...args] = argv;
  if (!executable) throw new Error("empty command");

  const workspace = realpathSync(cwd);
  const home = mkdtempSync(join(tmpdir(), "avity-sandbox-home-"));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(home, { recursive: true, force: true });
  };

  try {
    const invocation = sandboxInvocation(executable, args, workspace, home, options.allowNetwork ?? false);
    return {
      ...invocation,
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

function sandboxInvocation(
  executable: string,
  args: string[],
  cwd: string,
  home: string,
  allowNetwork: boolean,
): { executable: string; args: string[] } {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    const quote = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const profile = [
      "(version 1)",
      "(allow default)",
      // Toolchains remain readable, but the host user's home (SSH keys,
      // AvityOS token and unrelated repositories) is hidden. The mission
      // workspace is added back through the narrower allow below.
      `(deny file-read* (subpath "${quote(homedir())}"))`,
      `(allow file-read* (subpath "${quote(cwd)}"))`,
      `(allow file-read* (subpath "${quote(home)}"))`,
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
