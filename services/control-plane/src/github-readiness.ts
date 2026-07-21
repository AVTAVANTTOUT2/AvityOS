import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hardenedGitArgs, missionBranchName, parseGitHubRemote } from "@avityos/git";

const execFileAsync = promisify(execFile);

/** Concrete repository the live publication workflow will push to. */
export interface RepositoryReadinessTarget {
  repoPath: string;
  remoteUrl: string;
}

export interface GitHubReadiness {
  gitAvailable: boolean;
  ghAvailable: boolean;
  credentialHintAvailable: boolean;
  ghAuthenticated: boolean;
  repositoryReadable: boolean;
  repositoryPushDryRunSucceeded: boolean;
  repositoryWriteRoleObserved: boolean;
}

export interface CommandResult {
  success: boolean;
  stdout: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd?: string,
) => Promise<CommandResult>;

async function runCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      cwd,
      timeout: 5_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LANG: process.env.LANG ?? "C.UTF-8",
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
        ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
        ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
        ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
      },
      maxBuffer: 1_024 * 1024,
    });

    return {
      success: true,
      stdout: String(stdout ?? ""),
    };
  } catch {
    return {
      success: false,
      stdout: "",
    };
  }
}

const WRITE_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

/** Same mission/* constructor the engine uses, with a fixed non-sensitive id. */
export const PREFLIGHT_PERMISSION_BRANCH = missionBranchName(
  "preflight-permission-check",
  "",
);

function githubRepositorySlug(remoteUrl: string): string | null {
  const parsed = parseGitHubRemote(remoteUrl);
  return parsed ? `${parsed.owner}/${parsed.name}` : null;
}

function readinessCacheKey(target?: RepositoryReadinessTarget): string {
  if (!target) return "<none>";
  return createHash("sha256")
    .update(`${target.repoPath}\0${target.remoteUrl}`)
    .digest("hex");
}

/**
 * Detect GitHub host readiness without exposing command output, tokens or URLs.
 * When the target is incomplete, repository fields stay false and no repo-scoped
 * commands are executed.
 */
export async function detectGitHubReadiness(
  target?: RepositoryReadinessTarget,
  run: CommandRunner = runCommand,
): Promise<GitHubReadiness> {
  const gitAvailable = (await run("git", ["--version"])).success;
  const ghAvailable = (await run("gh", ["--version"])).success;

  const credentialHintAvailable = Boolean(
    process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.SSH_AUTH_SOCK,
  );

  const ghAuthenticated =
    ghAvailable &&
    (await run("gh", ["auth", "status", "--hostname", "github.com"])).success;

  const hasConcreteTarget =
    Boolean(target?.repoPath) && Boolean(target?.remoteUrl?.trim());

  let repositoryReadable = false;
  let repositoryPushDryRunSucceeded = false;
  let repositoryWriteRoleObserved = false;

  if (!hasConcreteTarget || !target) {
    return {
      gitAvailable,
      ghAvailable,
      credentialHintAvailable,
      ghAuthenticated,
      repositoryReadable,
      repositoryPushDryRunSucceeded,
      repositoryWriteRoleObserved,
    };
  }

  repositoryPushDryRunSucceeded =
    gitAvailable &&
    (
      await run(
        "git",
        hardenedGitArgs(
          "push",
          "--dry-run",
          "--no-verify",
          target.remoteUrl,
          `HEAD:refs/heads/${PREFLIGHT_PERMISSION_BRANCH}`,
        ),
        target.repoPath,
      )
    ).success;

  const repoSlug = githubRepositorySlug(target.remoteUrl);

  if (repoSlug && ghAvailable && ghAuthenticated) {
    repositoryReadable = (
      await run(
        "gh",
        ["repo", "view", "--repo", repoSlug, "--json", "nameWithOwner"],
        target.repoPath,
      )
    ).success;

    const permissionResult = await run(
      "gh",
      [
        "repo",
        "view",
        "--repo",
        repoSlug,
        "--json",
        "viewerPermission",
        "--jq",
        ".viewerPermission",
      ],
      target.repoPath,
    );

    const permission = permissionResult.stdout.trim().toUpperCase();
    repositoryWriteRoleObserved =
      permissionResult.success && WRITE_PERMISSIONS.has(permission);
  }

  return {
    gitAvailable,
    ghAvailable,
    credentialHintAvailable,
    ghAuthenticated,
    repositoryReadable,
    repositoryPushDryRunSucceeded,
    repositoryWriteRoleObserved,
  };
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<GitHubReadiness>;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export function clearGitHubReadinessCache(): void {
  cache.clear();
}

/**
 * Cached GitHub readiness detection. Indexed by a hash of repo path + remote URL
 * so distinct publication targets never share a stale result.
 */
export function getCachedGitHubReadiness(
  target?: RepositoryReadinessTarget,
  now: () => number = Date.now,
  run: CommandRunner = runCommand,
): Promise<GitHubReadiness> {
  const cacheKey = readinessCacheKey(target);
  const current = now();
  const existing = cache.get(cacheKey);

  if (existing && existing.expiresAt > current) {
    return existing.value;
  }

  const value = detectGitHubReadiness(target, run);
  cache.set(cacheKey, {
    value,
    expiresAt: current + CACHE_TTL_MS,
  });

  // Never let a rejected detection stick in the cache for the whole TTL: a
  // transient failure (e.g. an injected runner that throws) would otherwise be
  // replayed as a rejection on every caller until it expired. Evict the entry
  // if it rejects, but only when it is still the exact promise we stored so a
  // newer detection is never clobbered.
  void value.catch(() => {
    if (cache.get(cacheKey)?.value === value) {
      cache.delete(cacheKey);
    }
  });

  return value;
}
