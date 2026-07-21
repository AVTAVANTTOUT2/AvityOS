import { execFileSync } from "node:child_process";
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
import { basename, dirname, isAbsolute, join } from "node:path";

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
  /**
   * Additional absolute, canonical paths the provider policy explicitly needs
   * to *read* (e.g. a data directory a specific CLI requires). These are the
   * only extra read grants beyond workspace, throwaway HOME, the executable and
   * its detected runtime. Each is validated (absolute + must exist) and passed
   * by allowlist; nothing here can be widened by the prompt or the untrusted
   * repository, because it is supplied by trusted control-plane policy code.
   */
  readablePaths?: readonly string[];
  /**
   * Additional absolute, canonical runtime roots (interpreters, shared-library
   * trees) the executable needs. Treated exactly like `readablePaths` for the
   * read boundary; kept as a separate field so provider policies can document
   * *why* a path is granted (runtime vs. data).
   */
  runtimePaths?: readonly string[];
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
 * Reads are denied by default and re-granted by an explicit allowlist: the
 * workspace, an isolated temporary HOME, the resolved executable and its
 * detected runtime, a minimal set of system files needed to start, CA trust
 * when network is allowed, and any paths the provider policy declares. There is
 * **no** general read access to the host filesystem — a secret in another repo,
 * `/tmp`, `/opt`, `/Volumes`, the real HOME, or another provider's credentials
 * is not readable. Writes are limited to the workspace and throwaway HOME.
 * Network is denied unless a mission explicitly opts into it. If the host cannot
 * provide the required primitive, the command is not executed.
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
    const extraReadable = [
      ...validateExtraPaths(options.readablePaths ?? [], "readablePaths"),
      ...validateExtraPaths(options.runtimePaths ?? [], "runtimePaths"),
    ];
    const runtimeReadable = detectRuntimeReadRoots(resolvedExecutable);
    const invocation = sandboxInvocation(
      resolvedExecutable,
      args,
      workspace,
      home,
      options.allowNetwork ?? false,
      [...runtimeReadable, ...extraReadable],
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

/**
 * Validate caller-declared extra read paths. Each must be absolute and must
 * already exist; the canonical (symlink-resolved) form is returned so the
 * allowlist cannot be widened by a symlink planted in an allowed location.
 */
function validateExtraPaths(paths: readonly string[], field: string): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || !isAbsolute(p)) {
      throw new Error(`${field} entries must be absolute paths, got ${JSON.stringify(p)}`);
    }
    if (!existsSync(p)) {
      throw new Error(`${field} path does not exist: ${p}`);
    }
    out.push(realpathSync(p));
  }
  return out;
}

/**
 * Determine the minimal read roots an executable needs to start: its own
 * directory, its install root (the parent of a `bin/` directory), and the
 * directories of the shared libraries it links against. This keeps HOME-
 * installed CLIs working without exposing the whole HOME (only the resolved
 * install subtree is granted) and captures package-manager runtimes (e.g.
 * Homebrew) without granting all of `/opt` or `/usr/local` wholesale — only the
 * detected prefix that actually backs the binary.
 */
function detectRuntimeReadRoots(executable: string): string[] {
  const roots = new Set<string>();
  const exeDir = dirname(executable);
  roots.add(exeDir);
  const installRoot = safeInstallRoot(exeDir);
  if (installRoot) roots.add(installRoot);

  if (process.platform === "darwin") {
    for (const dir of machODylibDirs(executable)) roots.add(dir);
  } else if (process.platform === "linux") {
    for (const dir of elfSharedObjectDirs(executable)) roots.add(dir);
  }
  return [...roots];
}

/**
 * Install root for a `.../<pkg>/bin/<exe>` layout: `.../<pkg>` (which holds the
 * sibling `lib/`). Returns `undefined` — never widening the allowlist — when the
 * parent would be the filesystem root or a shallow top-level directory (e.g.
 * `/bin/sh` → parent `/`, `/usr/bin/x` → parent `/usr`). Those cases are already
 * covered by the system read roots and must not grant a broad tree.
 */
function safeInstallRoot(exeDir: string): string | undefined {
  if (basename(exeDir) !== "bin") return undefined;
  const parent = dirname(exeDir);
  const depth = parent.split("/").filter(Boolean).length;
  return depth >= 2 ? parent : undefined;
}

/** Discover the directories of an executable's linked dylibs via `otool -L`. */
function machODylibDirs(executable: string): string[] {
  const dirs = new Set<string>();
  let out: string;
  try {
    out = execFileSync("otool", ["-L", executable], { encoding: "utf8", timeout: 5_000 });
  } catch {
    return []; // not a Mach-O, or otool unavailable → rely on exeDir + system roots
  }
  for (const line of out.split("\n")) {
    const match = line.match(/^\s+(\/[^\s]+)\s/);
    const lib = match?.[1];
    if (!lib) continue;
    // Package-manager prefixes back many transitive libs (e.g. Homebrew node
    // pulls `/opt/homebrew/opt/*/lib/*`): grant the detected prefix, not all of
    // `/opt` or `/usr/local`.
    if (lib.startsWith("/opt/homebrew/")) {
      dirs.add("/opt/homebrew");
      continue;
    }
    if (lib.startsWith("/usr/local/")) {
      dirs.add("/usr/local");
      continue;
    }
    // System trees are already granted by the base profile.
    if (lib.startsWith("/usr/") || lib.startsWith("/System/") || lib.startsWith("/Library/")) {
      continue;
    }
    try {
      dirs.add(realpathSync(dirname(lib)));
    } catch {
      // referenced dylib missing at scan time → skip
    }
  }
  return [...dirs];
}

/** Discover the directories of an executable's shared objects via `ldd`. */
function elfSharedObjectDirs(executable: string): string[] {
  const dirs = new Set<string>();
  let out: string;
  try {
    out = execFileSync("ldd", [executable], { encoding: "utf8", timeout: 5_000 });
  } catch {
    return []; // static binary, not ELF, or ldd unavailable
  }
  for (const line of out.split("\n")) {
    const match = line.match(/=>\s+(\/[^\s]+)/) ?? line.match(/^\s*(\/[^\s]+)\s+\(0x/);
    const obj = match?.[1];
    if (!obj) continue;
    try {
      dirs.add(realpathSync(dirname(obj)));
    } catch {
      // referenced object missing at scan time → skip
    }
  }
  return [...dirs];
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

/**
 * macOS read roots that hold no user data and are needed for any binary to
 * start (dyld shared cache, system frameworks/libraries, timezone/locale, the
 * loader's view of `/`). CA trust and DNS config live under `/private/etc`
 * (`/etc` is a symlink to it) and are only relevant when network is allowed,
 * but they carry no user secrets so they are always granted. Notably absent:
 * `/private/tmp` (= `/tmp`), `/private/var/folders` (per-user temp), the host
 * HOME, `/Applications`, `/Volumes`, `/opt`, `/mnt`, `/media`.
 */
const DARWIN_SYSTEM_READ_ROOTS = [
  "/usr/lib",
  "/usr/bin",
  "/usr/share",
  "/usr/libexec",
  "/System",
  "/Library",
  "/private/etc",
  "/private/var/db",
];

function sandboxInvocation(
  executable: string,
  args: string[],
  cwd: string,
  home: string,
  allowNetwork: boolean,
  extraReadRoots: readonly string[],
): { executable: string; args: string[] } {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    const quote = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const readSubpaths = [
      ...DARWIN_SYSTEM_READ_ROOTS.filter(existsSync),
      cwd,
      home,
      ...extraReadRoots,
    ];
    // Fail-closed read policy: deny everything, then re-grant an explicit
    // allowlist. `file-read-metadata` is allowed globally so the loader can
    // traverse path components (including reaching a CLI installed under the
    // host HOME) without exposing file *contents*; read-data is granted only on
    // the allowlisted subpaths. Reading the root directory node itself is
    // required by the loader, hence the `(literal "/")` grant.
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow signal)",
      "(allow file-read-metadata)",
      '(allow file-read-data (literal "/"))',
      // Device nodes (/dev/null, /dev/urandom, /dev/tty, …) are needed by the
      // loader, the runtime and tools such as `git` (which opens /dev/null
      // O_RDWR). Device nodes carry no user data; disk devices remain
      // unreadable to a non-root uid.
      '(allow file-read* (subpath "/dev"))',
      ...readSubpaths.map((p) => `(allow file-read* (subpath "${quote(p)}"))`),
      `(allow file-write* (subpath "${quote(cwd)}"))`,
      `(allow file-write* (subpath "${quote(home)}"))`,
      '(allow file-write* (subpath "/dev"))',
      ...(allowNetwork ? ["(allow network*)"] : ["(deny network*)"]),
    ].join("\n");
    return { executable: "/usr/bin/sandbox-exec", args: ["-p", profile, executable, ...args] };
  }

  const bwrap = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].find(existsSync);
  if (process.platform === "linux" && bwrap) {
    // Fail-closed file namespace: nothing from the host is visible unless bound
    // below. Replaces the previous `--ro-bind / /`, which exposed the entire
    // host filesystem read-only (other repos, /srv, /opt, /var, /mnt, /media,
    // /tmp, host /proc & /run). Only system runtime trees, the executable's
    // runtime, the workspace and the throwaway HOME are mounted; a private
    // /proc (from --unshare-all's PID namespace) plus a minimal /dev avoid
    // leaking host process/device state. The namespace root (a bwrap tmpfs) is
    // remounted read-only last, so — as on macOS — only the workspace, the
    // throwaway HOME and /dev are writable; a stray write elsewhere fails
    // (EROFS) instead of silently succeeding into the ephemeral root tmpfs.
    const systemRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc"];
    const systemBinds: string[] = [];
    for (const root of systemRoots) systemBinds.push("--ro-bind-try", root, root);

    // `extraReadRoots` already includes the executable's directory, its safe
    // install root and detected shared-object dirs (see detectRuntimeReadRoots).
    // These, the workspace and HOME may live under /tmp, so they must be bound
    // *after* the `--dir /tmp` placeholder below — otherwise a later mount could
    // shadow them.
    const runtimeBinds: string[] = [];
    for (const root of new Set<string>(extraReadRoots)) {
      runtimeBinds.push("--ro-bind-try", root, root);
    }
    // DNS: `/etc/resolv.conf` is often a symlink into `/run` (systemd-resolved),
    // which we deliberately do not expose. When network is allowed, bind just
    // the resolved target file so name resolution works without mounting /run.
    if (allowNetwork) {
      try {
        const resolv = realpathSync("/etc/resolv.conf");
        runtimeBinds.push("--ro-bind-try", resolv, resolv);
      } catch {
        // no resolv.conf on this host → nothing to bind
      }
    }
    return {
      executable: bwrap,
      args: [
        "--die-with-parent",
        "--unshare-all",
        ...(allowNetwork ? ["--share-net"] : []),
        ...systemBinds,
        "--proc", "/proc",
        "--dev", "/dev",
        // Ensure /tmp exists (read-only after the root remount) so tools that
        // probe for it don't fail; real temp writes go to TMPDIR=HOME.
        "--dir", "/tmp",
        ...runtimeBinds,
        "--bind", cwd, cwd,
        "--bind", home, home,
        // Freeze the root tmpfs read-only *after* every mountpoint exists; the
        // workspace/HOME/dev binds are separate mounts and keep their rw flag.
        "--remount-ro", "/",
        "--chdir", cwd,
        "--setenv", "HOME", home,
        "--setenv", "TMPDIR", home,
        executable,
        ...args,
      ],
    };
  }

  throw new Error("no supported OS sandbox is available; install bubblewrap on Linux or use a macOS worker");
}
