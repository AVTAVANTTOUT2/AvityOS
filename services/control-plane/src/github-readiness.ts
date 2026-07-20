import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitHubReadiness {
  gitAvailable: boolean;
  ghAvailable: boolean;
  credentialHintAvailable: boolean;
  ghAuthenticated: boolean;
  repositoryReadable: boolean;
  repositoryPushVerified: boolean;
  pullRequestCreationVerified: boolean;
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

/**
 * Detect GitHub host readiness without exposing command output, tokens or URLs.
 * When `repoPath` is absent, repository fields stay false and no repo-scoped
 * commands are executed.
 */
export async function detectGitHubReadiness(
  repoPath?: string,
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

  const repositoryReadable =
    Boolean(repoPath) &&
    ghAvailable &&
    ghAuthenticated &&
    (await run("gh", ["repo", "view", "--json", "nameWithOwner"], repoPath)).success;

  const repositoryPushVerified =
    Boolean(repoPath) &&
    gitAvailable &&
    (
      await run(
        "git",
        [
          "push",
          "--dry-run",
          "--no-verify",
          "origin",
          "HEAD:refs/heads/avity-preflight-permission-check",
        ],
        repoPath,
      )
    ).success;

  let pullRequestCreationVerified = false;

  if (repoPath && ghAvailable && ghAuthenticated) {
    const permissionResult = await run(
      "gh",
      ["repo", "view", "--json", "viewerPermission", "--jq", ".viewerPermission"],
      repoPath,
    );

    const permission = permissionResult.stdout.trim().toUpperCase();

    pullRequestCreationVerified =
      permissionResult.success && WRITE_PERMISSIONS.has(permission);
  }

  return {
    gitAvailable,
    ghAvailable,
    credentialHintAvailable,
    ghAuthenticated,
    repositoryReadable,
    repositoryPushVerified,
    pullRequestCreationVerified,
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
 * Cached GitHub readiness detection. Indexed by repository path so distinct
 * projects do not share a stale verification result.
 */
export function getCachedGitHubReadiness(
  repoPath?: string,
  now: () => number = Date.now,
  run: CommandRunner = runCommand,
): Promise<GitHubReadiness> {
  const cacheKey = repoPath ?? "<none>";
  const current = now();
  const existing = cache.get(cacheKey);

  if (existing && existing.expiresAt > current) {
    return existing.value;
  }

  const value = detectGitHubReadiness(repoPath, run);
  cache.set(cacheKey, {
    value,
    expiresAt: current + CACHE_TTL_MS,
  });
  return value;
}
