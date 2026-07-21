import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isInsideRoot } from "./confinement.js";

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
  /**
   * Explicit env vars only; never a copy of process.env. Must not contain the
   * reserved sandbox variables `HOME`, `TMPDIR`, or `PATH` — those are set
   * exclusively by this primitive.
   */
  env?: Record<string, string>;
  /**
   * Minimal credential files to stage into the throwaway HOME. Never stages the
   * full host HOME, SSH keys, or unrelated provider configs.
   */
  credentialFiles?: readonly SandboxCredentialFile[];
  /**
   * Real user HOME used to validate credential sources (must be a regular file
   * exactly at `join(credentialHome, homeRelativePath)`, never a symlink).
   * Defaults to `os.homedir()`. Tests may point this at a fixture HOME.
   */
  credentialHome?: string;
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
 * Environment variables owned exclusively by the sandbox. Provider policies and
 * `options.env` must never set or override these — a clear rejection avoids a
 * misleading configuration that appears to customise the throwaway HOME.
 */
export const RESERVED_SANDBOX_ENV_VARS = ["HOME", "TMPDIR", "PATH"] as const;
export type ReservedSandboxEnvVar = (typeof RESERVED_SANDBOX_ENV_VARS)[number];

/** Bounds for recursive Mach-O dependency scanning (no code from the binary runs). */
export const MACHO_SCAN_MAX_DEPTH = 6;
export const MACHO_SCAN_MAX_FILES = 64;
export const MACHO_SCAN_TIMEOUT_MS = 5_000;

/**
 * Filesystem roots that dependency detection must never emit as grants unless a
 * trusted policy explicitly lists them via `readablePaths` / `runtimePaths`.
 */
export const FORBIDDEN_AUTO_RUNTIME_ROOTS = [
  "/",
  "/opt",
  "/opt/homebrew",
  "/usr/local",
  "/usr",
  "/System",
  "/Library",
  "/private",
  "/var",
  "/tmp",
  "/private/tmp",
  "/private/var",
] as const;

/**
 * macOS Mach services allowed after sensitive denies. Validated against
 * sandbox-exec denial logs while starting Node, Git, Codex, Claude Code and
 * Cursor Agent (`--version`). Each entry is documented in
 * `DARWIN_MACH_LOOKUP_ALLOWLIST_JUSTIFICATION`.
 */
export const DARWIN_MACH_LOOKUP_ALLOWLIST = [
  "com.apple.logd",
  "com.apple.system.notification_center",
  "com.apple.diagnosticd",
  "com.apple.analyticsd",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.system.DirectoryService.libinfo_v1",
  "com.apple.system.DirectoryService.membership_v1",
  "com.apple.bsd.dirhelper",
  "com.apple.cfprefsd.agent",
  "com.apple.cfprefsd.daemon",
  "com.apple.distributed_notifications@1v3",
  "com.apple.CoreServices.coreservicesd",
  "com.apple.coreservices.launchservicesd",
  "com.apple.SystemConfiguration.DNSConfiguration",
  "com.apple.SystemConfiguration.configd",
  "com.apple.networkd",
] as const;

/** Human-readable justification for each allowlisted Mach service. */
export const DARWIN_MACH_LOOKUP_ALLOWLIST_JUSTIFICATION: Readonly<
  Record<(typeof DARWIN_MACH_LOOKUP_ALLOWLIST)[number], string>
> = {
  "com.apple.logd": "Unified logging used by libc/libsystem during process start",
  "com.apple.system.notification_center": "Darwin notifyd; required by many runtimes for init",
  "com.apple.diagnosticd": "Diagnostic channel probed at start; no user-secret IPC",
  "com.apple.analyticsd": "Analytics bootstrap probe; no user-secret IPC",
  "com.apple.system.opendirectoryd.libinfo": "POSIX getpw*/getgr* lookups for the sandbox uid",
  "com.apple.system.opendirectoryd.membership": "Group membership checks for the sandbox uid",
  "com.apple.system.DirectoryService.libinfo_v1": "Legacy DirectoryService libinfo (older runtimes)",
  "com.apple.system.DirectoryService.membership_v1": "Legacy DirectoryService membership",
  "com.apple.bsd.dirhelper": "Temporary-directory helper used by Foundation/BSD paths",
  "com.apple.cfprefsd.agent": "CFPreferences agent (per-user defaults; throwaway HOME isolates writes)",
  "com.apple.cfprefsd.daemon": "CFPreferences daemon companion",
  "com.apple.distributed_notifications@1v3": "Distributed notification centre bootstrap",
  "com.apple.CoreServices.coreservicesd": "CoreServices launch support for CLI frameworks",
  "com.apple.coreservices.launchservicesd": "Launch Services queries some CLIs perform at start",
  "com.apple.SystemConfiguration.DNSConfiguration": "DNS configuration when network is allowed",
  "com.apple.SystemConfiguration.configd": "SystemConfiguration configd for network stack init",
  "com.apple.networkd": "User-space network daemon used by CFNetwork when network is allowed",
};

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

  assertNoReservedSandboxEnv(options.env);

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
    stageCredentialFiles(home, options.credentialFiles ?? [], options.credentialHome ?? homedir());
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
    // Reserved vars are applied *after* provider env would have been merged —
    // and provider env is already rejected if it names them — so HOME/TMPDIR/PATH
    // always come from the sandbox.
    return {
      ...invocation,
      home,
      env: {
        ...options.env,
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: home,
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Reject provider env that tries to override sandbox-owned variables. */
export function assertNoReservedSandboxEnv(
  env: Readonly<Record<string, string>> | undefined,
): void {
  if (!env) return;
  const reserved = RESERVED_SANDBOX_ENV_VARS.filter((name) =>
    Object.prototype.hasOwnProperty.call(env, name),
  );
  if (reserved.length > 0) {
    throw new Error(
      `sandbox options.env must not set reserved variables [${reserved.join(", ")}]; ` +
        `HOME/TMPDIR/PATH are defined exclusively by the sandbox`,
    );
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
 * directories of the shared libraries it links against (recursively, bounded).
 * Never auto-grants `/`, `/opt`, `/opt/homebrew`, or `/usr/local`.
 */
export function detectRuntimeReadRoots(executable: string): string[] {
  const roots = new Set<string>();
  const exeDir = dirname(executable);
  roots.add(exeDir);
  const installRoot = safeInstallRoot(exeDir);
  if (installRoot) roots.add(installRoot);
  for (const root of packageManagerRootsForPath(executable)) roots.add(root);

  if (process.platform === "darwin") {
    for (const dir of scanMachODependencies(executable)) roots.add(dir);
  } else if (process.platform === "linux") {
    for (const dir of elfSharedObjectDirs(executable)) roots.add(dir);
  }

  return [...roots].filter((p) => !isForbiddenAutoRuntimeRoot(p));
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

export function isForbiddenAutoRuntimeRoot(path: string): boolean {
  const normalised = path.replace(/\/+$/, "") || "/";
  return (FORBIDDEN_AUTO_RUNTIME_ROOTS as readonly string[]).includes(normalised);
}

/**
 * Exact Homebrew / MacPorts-style package roots for a path. Matches
 * `.../Cellar/<formula>/<version>` and `.../opt/<formula>` only — never the
 * package-manager prefix itself (`/opt/homebrew`, `/usr/local`). Also includes
 * the matching `.../etc/<formula>` tree and well-known exact etc config files
 * for that formula when present (e.g. OpenSSL config, `gitconfig`).
 */
export function packageManagerRootsForPath(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const roots: string[] = [];
  const formulas: Array<{ prefix: string; formula: string }> = [];

  // /opt/homebrew/Cellar/<formula>/<version>/...
  // /usr/local/Cellar/<formula>/<version>/...
  for (const prefix of [
    ["opt", "homebrew", "Cellar"],
    ["usr", "local", "Cellar"],
  ] as const) {
    if (
      parts.length >= prefix.length + 2 &&
      parts[0] === prefix[0] &&
      parts[1] === prefix[1] &&
      parts[2] === prefix[2]
    ) {
      const formula = parts[prefix.length]!;
      const version = parts[prefix.length + 1]!;
      roots.push("/" + [...prefix, formula, version].join("/"));
      formulas.push({ prefix: "/" + [parts[0], parts[1]].join("/"), formula });
    }
  }

  // /opt/homebrew/opt/<formula>/...  (keg symlink root dyld often opens)
  // /usr/local/opt/<formula>/...
  for (const prefix of [
    ["opt", "homebrew", "opt"],
    ["usr", "local", "opt"],
  ] as const) {
    if (
      parts.length >= prefix.length + 1 &&
      parts[0] === prefix[0] &&
      parts[1] === prefix[1] &&
      parts[2] === prefix[2]
    ) {
      const formula = parts[prefix.length]!;
      roots.push("/" + [...prefix, formula].join("/"));
      formulas.push({ prefix: "/" + [parts[0], parts[1]].join("/"), formula });
    }
  }

  for (const { prefix, formula } of formulas) {
    for (const candidate of homebrewEtcCompanions(prefix, formula)) {
      if (existsSync(candidate)) roots.push(candidate);
    }
  }

  // OpenSSL's Homebrew etc tree commonly symlinks cert.pem into ca-certificates.
  for (const etcOpenSsl of [
    "/opt/homebrew/etc/openssl@3",
    "/usr/local/etc/openssl@3",
    "/opt/homebrew/etc/openssl@1.1",
    "/usr/local/etc/openssl@1.1",
  ]) {
    if (!roots.includes(etcOpenSsl) || !existsSync(etcOpenSsl)) continue;
    try {
      const cert = join(etcOpenSsl, "cert.pem");
      if (existsSync(cert)) {
        const target = realpathSync(cert);
        const caDir = dirname(target);
        if (!isForbiddenAutoRuntimeRoot(caDir)) roots.push(caDir);
      }
    } catch {
      // ignore unreadable cert link
    }
  }

  return [...new Set(roots)].filter((p) => !isForbiddenAutoRuntimeRoot(p));
}

/**
 * Exact etc companions for a Homebrew formula — never the whole `prefix/etc`.
 * Examples: `etc/openssl@3`, `etc/gitconfig` (file), `etc/git`.
 */
function homebrewEtcCompanions(prefix: string, formula: string): string[] {
  const etc = join(prefix, "etc");
  const base = formula.replace(/@.*$/, ""); // openssl@3 → also consider openssl*
  return [
    join(etc, formula),
    join(etc, `${formula}.conf`),
    join(etc, `${formula}.cfg`),
    join(etc, `${formula}rc`),
    join(etc, `${formula}config`),
    join(etc, `${base}config`),
    join(etc, `${base}.conf`),
  ];
}

export interface MachOScanLimits {
  maxDepth?: number;
  maxFiles?: number;
  timeoutMs?: number;
}

/**
 * Pure helper: compute runtime read grants from simulated `otool -L` / `otool -l`
 * outputs. Used by unit tests when Homebrew prefixes are not writable in CI.
 * Does not execute any bytes from the analysed binary.
 */
export function runtimeRootsFromOtoolOutputs(
  executablePath: string,
  scans: ReadonlyArray<{ path: string; otoolL: string; otoolLoadCommands?: string }>,
  limits: MachOScanLimits = {},
): string[] {
  const maxDepth = limits.maxDepth ?? MACHO_SCAN_MAX_DEPTH;
  const maxFiles = limits.maxFiles ?? MACHO_SCAN_MAX_FILES;
  const timeoutMs = limits.timeoutMs ?? MACHO_SCAN_TIMEOUT_MS;
  const started = Date.now();

  const byPath = new Map(scans.map((s) => [s.path, s]));
  const grants = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [{ path: executablePath, depth: 0 }];

  grants.add(dirname(executablePath));
  const installRoot = safeInstallRoot(dirname(executablePath));
  if (installRoot) grants.add(installRoot);
  for (const root of packageManagerRootsForPath(executablePath)) grants.add(root);

  while (queue.length > 0 && visited.size < maxFiles && Date.now() - started < timeoutMs) {
    const { path, depth } = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (depth > maxDepth) continue;

    const scan = byPath.get(path);
    if (!scan) continue;

    const rpaths = parseOtoolRpaths(scan.otoolLoadCommands ?? "");
    for (const lib of parseOtoolLDependencies(scan.otoolL)) {
      // Grant the exact open-path directories Homebrew dyld uses (opt keg + lib).
      if (lib.startsWith("/") && !isSystemMachOPath(lib)) {
        grants.add(dirname(lib));
        for (const root of packageManagerRootsForPath(lib)) grants.add(root);
      }
      if (isSystemMachOPath(lib)) continue;

      const resolved = resolveMachODependency(lib, path, rpaths, byPath);
      if (!resolved) continue;
      grants.add(dirname(resolved));
      for (const root of packageManagerRootsForPath(resolved)) grants.add(root);
      if (!visited.has(resolved) && depth + 1 <= maxDepth) {
        queue.push({ path: resolved, depth: depth + 1 });
      }
    }
  }

  return [...grants].filter((p) => !isForbiddenAutoRuntimeRoot(p));
}

/** Parse `otool -L` dependency lines into load paths (including `@rpath/...`). */
export function parseOtoolLDependencies(otoolL: string): string[] {
  const libs: string[] = [];
  for (const line of otoolL.split("\n").slice(1)) {
    const match = line.match(/^\s+(\S+)/);
    if (match?.[1]) libs.push(match[1]);
  }
  return libs;
}

/** Parse `LC_RPATH` entries from `otool -l` output. */
export function parseOtoolRpaths(otoolLoadCommands: string): string[] {
  const rpaths: string[] = [];
  const lines = otoolLoadCommands.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.includes("LC_RPATH")) continue;
    for (let j = i; j < Math.min(i + 10, lines.length); j++) {
      const match = lines[j]?.match(/path\s+(\S+)\s+\(/);
      if (match?.[1]) {
        rpaths.push(match[1]);
        break;
      }
    }
  }
  return rpaths;
}

function isSystemMachOPath(lib: string): boolean {
  return lib.startsWith("/usr/") || lib.startsWith("/System/") || lib.startsWith("/Library/");
}

function resolveMachODependency(
  lib: string,
  loader: string,
  rpaths: readonly string[],
  known: ReadonlyMap<string, { path: string }>,
): string | undefined {
  const candidates: string[] = [];
  if (lib.startsWith("@loader_path/")) {
    candidates.push(join(dirname(loader), lib.slice("@loader_path/".length)));
  } else if (lib.startsWith("@executable_path/")) {
    candidates.push(join(dirname(loader), lib.slice("@executable_path/".length)));
  } else if (lib.startsWith("@rpath/")) {
    const rest = lib.slice("@rpath/".length);
    for (const rp of rpaths) {
      let base = rp;
      if (base.startsWith("@loader_path")) {
        base = join(dirname(loader), base.slice("@loader_path".length).replace(/^\//, ""));
      } else if (base.startsWith("@executable_path")) {
        base = join(dirname(loader), base.slice("@executable_path".length).replace(/^\//, ""));
      }
      candidates.push(join(base, rest));
    }
  } else if (lib.startsWith("/")) {
    candidates.push(lib);
  } else {
    return undefined;
  }

  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // skip unreadable / missing
    }
  }
  return undefined;
}

/**
 * Bounded recursive Mach-O dependency scan via `otool` only (never runs the
 * binary). Grants exact library directories and exact package/formula roots.
 */
function scanMachODependencies(executable: string): string[] {
  const maxDepth = MACHO_SCAN_MAX_DEPTH;
  const maxFiles = MACHO_SCAN_MAX_FILES;
  const timeoutMs = MACHO_SCAN_TIMEOUT_MS;
  const started = Date.now();
  const grants = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [{ path: executable, depth: 0 }];

  while (queue.length > 0 && visited.size < maxFiles && Date.now() - started < timeoutMs) {
    const { path, depth } = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (depth > maxDepth) continue;

    let otoolL: string;
    let otoolLoad: string;
    try {
      otoolL = execFileSync("otool", ["-L", path], { encoding: "utf8", timeout: 2_000 });
      otoolLoad = execFileSync("otool", ["-l", path], { encoding: "utf8", timeout: 2_000 });
    } catch {
      continue; // not Mach-O or otool unavailable
    }

    const rpaths = parseOtoolRpaths(otoolLoad);
    for (const lib of parseOtoolLDependencies(otoolL)) {
      if (lib.startsWith("/") && !isSystemMachOPath(lib)) {
        try {
          grants.add(dirname(lib));
          for (const root of packageManagerRootsForPath(lib)) grants.add(root);
          if (existsSync(lib)) {
            const realLib = realpathSync(lib);
            grants.add(dirname(realLib));
            for (const root of packageManagerRootsForPath(realLib)) grants.add(root);
          }
        } catch {
          // skip
        }
      }
      if (isSystemMachOPath(lib)) continue;

      const resolved = resolveMachODependency(lib, path, rpaths, new Map());
      if (!resolved) continue;
      grants.add(dirname(resolved));
      for (const root of packageManagerRootsForPath(resolved)) grants.add(root);
      if (!visited.has(resolved) && depth + 1 <= maxDepth) {
        queue.push({ path: resolved, depth: depth + 1 });
      }
    }
  }

  return [...grants].filter((p) => !isForbiddenAutoRuntimeRoot(p));
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
      const dir = realpathSync(dirname(obj));
      if (!isForbiddenAutoRuntimeRoot(dir)) dirs.add(dir);
      for (const root of packageManagerRootsForPath(dir)) dirs.add(root);
    } catch {
      // referenced object missing at scan time → skip
    }
  }
  return [...dirs];
}

/**
 * Stage credential files into the throwaway HOME.
 *
 * Before copying: `lstat` the source, require a regular file, refuse symlinks,
 * resolve the canonical path, require it stays under the real HOME, and require
 * the source path to be exactly `join(realHome, homeRelativePath)` (the policy
 * entry). Cross-provider symlink traps therefore never copy the target secret.
 */
function stageCredentialFiles(
  home: string,
  files: readonly SandboxCredentialFile[],
  realHome: string,
): void {
  let realHomeCanonical: string;
  try {
    realHomeCanonical = realpathSync(realHome);
  } catch {
    throw new Error(`real HOME is not resolvable for credential staging: ${realHome}`);
  }

  for (const file of files) {
    if (typeof file.homeRelativePath !== "string" || file.homeRelativePath.trim().length === 0) {
      throw new Error("credential homeRelativePath must be a non-empty relative path");
    }
    if (isAbsolute(file.homeRelativePath) || file.homeRelativePath.split(/[\\/]+/).includes("..")) {
      throw new Error(`credential homeRelativePath escapes sandbox HOME: ${file.homeRelativePath}`);
    }

    // Compare on canonical parents so `/var/folders` vs `/private/var/folders`
    // does not spuriously reject a valid policy path. Do not yet follow a final
    // symlink — that is rejected explicitly below via lstat.
    const expectedSource = join(realHomeCanonical, ...file.homeRelativePath.split(/[\\/]+/));
    const providedSource = canonicalizeParent(file.sourcePath);
    if (providedSource !== expectedSource) {
      throw new Error(
        `credential sourcePath must be exactly the policy path under real HOME ` +
          `(${file.homeRelativePath}); got ${file.sourcePath}`,
      );
    }

    let st;
    try {
      st = lstatSync(file.sourcePath);
    } catch {
      throw new Error(`credential file missing or unreadable: ${file.sourcePath}`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `credential source must not be a symlink (refusing to stage target of ${file.sourcePath})`,
      );
    }
    if (!st.isFile()) {
      throw new Error(`credential source must be a regular file: ${file.sourcePath}`);
    }

    let canonical: string;
    try {
      canonical = realpathSync(file.sourcePath);
    } catch {
      throw new Error(`credential file missing or unreadable: ${file.sourcePath}`);
    }
    if (!isInsideRoot(realHomeCanonical, canonical)) {
      throw new Error(
        `credential canonical path escapes real HOME: ${canonical} (home=${realHomeCanonical})`,
      );
    }
    const rel = relative(realHomeCanonical, canonical).split(sep).join("/");
    if (rel !== file.homeRelativePath) {
      throw new Error(
        `credential canonical relative path ${JSON.stringify(rel)} does not match ` +
          `policy entry ${JSON.stringify(file.homeRelativePath)}`,
      );
    }

    const dest = join(home, file.homeRelativePath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file.sourcePath, dest);
    if (file.readonly !== false) {
      chmodSync(dest, 0o400);
    }
  }
}

/** `realpath` the parent of `path` and re-attach the final component (symlink-safe). */
function canonicalizeParent(path: string): string {
  const abs = resolve(path);
  return join(realpathSync(dirname(abs)), basename(abs));
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

/** Seatbelt fragment: deny sensitive Mach IPC, then allow only the validated list. */
function darwinMachLookupProfile(): string {
  const denySensitive = [
    '(global-name "com.apple.SecurityServer")',
    '(global-name "com.apple.SecurityServer.systemkeychain")',
    '(global-name-regex #"^com\\.apple\\.securityd")',
    '(global-name-regex #"^com\\.apple\\.SecurityServer")',
    '(global-name-regex #"com\\.apple\\.securityd")',
    '(global-name-regex #"^com\\.apple\\.kcproxy")',
    '(global-name "com.apple.ocspd")',
    '(global-name "com.apple.trustd")',
    '(global-name "com.apple.trustd.agent")',
    '(global-name "com.apple.pasteboard.1")',
    '(global-name "com.apple.pboard")',
    '(global-name-regex #"^com\\.apple\\.WindowServer")',
    '(global-name-regex #"^com\\.apple\\.coreservices\\.appleevents")',
    '(global-name "com.apple.lsd.open")',
    '(global-name "com.apple.lsd.authentication")',
  ].join("\n  ");
  const allow = DARWIN_MACH_LOOKUP_ALLOWLIST.map((name) => `(global-name "${name}")`).join("\n  ");
  return [
    `(deny mach-lookup\n  ${denySensitive}\n)`,
    `(allow mach-lookup\n  ${allow}\n)`,
  ].join("\n");
}

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
    //
    // Mach IPC: never `(allow mach-lookup)` wholesale. Sensitive services
    // (SecurityServer / securityd / Keychain, pasteboard, WindowServer,
    // AppleEvents) are denied first; only the validated allowlist remains.
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      darwinMachLookupProfile(),
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
