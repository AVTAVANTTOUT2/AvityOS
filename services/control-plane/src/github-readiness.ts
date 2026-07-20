import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitHubReadiness {
  gitAvailable: boolean;
  ghAvailable: boolean;
  credentialHintAvailable: boolean;
  ghAuthenticated: boolean;
  repositoryAccessVerified: boolean;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd?: string,
) => Promise<boolean>;

async function commandSucceeds(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<boolean> {
  try {
    await execFileAsync(command, [...args], {
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
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect GitHub host readiness without exposing command output, tokens or URLs.
 * When `repoPath` is absent, repository access is never claimed as verified.
 */
export async function detectGitHubReadiness(
  repoPath?: string,
  run: CommandRunner = commandSucceeds,
): Promise<GitHubReadiness> {
  const gitAvailable = await run("git", ["--version"]);
  const ghAvailable = await run("gh", ["--version"]);

  const credentialHintAvailable = Boolean(
    process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.SSH_AUTH_SOCK,
  );

  const ghAuthenticated =
    ghAvailable &&
    (await run("gh", ["auth", "status", "--hostname", "github.com"]));

  const repositoryAccessVerified =
    Boolean(repoPath) &&
    gitAvailable &&
    ghAvailable &&
    ghAuthenticated &&
    (await run("gh", ["repo", "view", "--json", "nameWithOwner"], repoPath));

  return {
    gitAvailable,
    ghAvailable,
    credentialHintAvailable,
    ghAuthenticated,
    repositoryAccessVerified,
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
  run: CommandRunner = commandSucceeds,
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
