import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A hooks directory that can never contain an executable hook. Git resolves a
 * hook as `${core.hooksPath}/<name>`; because `/dev/null` is not a directory,
 * every lookup fails and no repository-controlled hook program is ever run.
 * Repositories AvityOS operates on are untrusted, so hooks — which are
 * arbitrary executables committed into or configured on the repo — must never
 * execute with control-plane authority.
 */
const NULL_HOOKS_PATH = "/dev/null";

/**
 * Configuration flags forced onto *every* automated git invocation. `-c`
 * overrides win over inherited local/global/system config and any dangerous
 * value an untrusted repository (or the ambient user config) might set:
 *
 *   core.hooksPath        → /dev/null so no pre-commit/post-checkout/pre-push/…
 *                           hook can run (defends worktree add, commit, push).
 *   commit.gpgsign        → off so an attacker-controlled signing program is
 *                           never spawned as a side effect of committing.
 *   core.fsmonitor        → off so no fsmonitor hook program is launched.
 *   core.untrackedCache   → off for deterministic, side-effect-free status.
 *
 * Centralising the list here means a future git call added through {@link git}
 * inherits the hardening automatically and cannot silently forget it.
 */
export const GIT_HARDENING_FLAGS: readonly string[] = [
  "-c", `core.hooksPath=${NULL_HOOKS_PATH}`,
  "-c", "commit.gpgsign=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
];

/**
 * Prefix an argv for a git subcommand with the mandatory hardening flags.
 * Callers that must invoke `git` through their own process runner (rather than
 * {@link git}) use this so they share the exact same neutralisation guarantees.
 */
export function hardenedGitArgs(...args: string[]): string[] {
  return [...GIT_HARDENING_FLAGS, ...args];
}

function scopedGitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
  // These are the only inherited authentication channels. Repository code
  // never receives the control plane's unrelated provider/API credentials.
  for (const name of ["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

export interface GitHubRepository {
  owner: string;
  name: string;
}

export interface PublishedPullRequest {
  number: number;
  url: string;
  state: "draft" | "open" | "merged" | "closed";
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/**
 * Thin, injection-safe git runner. Arguments are always passed as an argv
 * array (never through a shell), and every mutation is scoped to an explicit
 * repository directory.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const gitArgs = [...GIT_HARDENING_FLAGS, ...args];
  try {
    const { stdout } = await execFileAsync("git", gitArgs, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: scopedGitEnvironment(),
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; code?: number };
    throw new GitError(gitArgs, e.stderr ?? String(err), e.code ?? null);
  }
}

export function parseGitHubRemote(remoteUrl: string): GitHubRepository | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(trimmed);
  if (https) return { owner: https[1]!, name: https[2]! };
  // Credentialed HTTPS (CI/agent insteadOf rewrites). Owner/name only — never
  // treat the embedded secret as part of the repository identity.
  const httpsAuth = /^https?:\/\/[^/@]+(?::[^@]*)?@github\.com\/([^/]+)\/([^/]+)$/i.exec(trimmed);
  if (httpsAuth) return { owner: httpsAuth[1]!, name: httpsAuth[2]! };
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(trimmed);
  if (scp) return { owner: scp[1]!, name: scp[2]! };
  const ssh = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i.exec(trimmed);
  return ssh ? { owner: ssh[1]!, name: ssh[2]! } : null;
}

async function gh(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: 8 * 1024 * 1024,
    env: scopedGitEnvironment({ GH_PROMPT_DISABLED: "1" }),
  });
  return stdout;
}

/** Push a validated mission branch and create or update its GitHub draft PR. */
export async function publishGitHubPullRequest(input: {
  repoPath: string;
  remoteUrl: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<PublishedPullRequest> {
  const repository = parseGitHubRemote(input.remoteUrl);
  if (!repository) throw new Error(`unsupported GitHub remote URL: ${input.remoteUrl}`);
  const repo = `${repository.owner}/${repository.name}`;

  // `--no-verify` skips pre-push/pre-receive on top of the neutralised
  // core.hooksPath: defence in depth for the one command that reaches out to a
  // remote and would otherwise run a repository-controlled pre-push hook.
  await git(input.repoPath, "push", "--no-verify", input.remoteUrl, `${input.branch}:${input.branch}`);
  const listed = JSON.parse(
    await gh("pr", "list", "--repo", repo, "--head", input.branch, "--state", "all", "--limit", "1", "--json", "number,url,state,isDraft"),
  ) as { number: number; url: string; state: string; isDraft: boolean }[];

  let item = listed[0];
  if (!item) {
    const url = (await gh(
      "pr", "create", "--repo", repo, "--base", input.baseBranch, "--head", input.branch,
      "--title", input.title, "--body", input.body, "--draft",
    )).trim();
    const number = Number(url.split("/").pop());
    if (!Number.isInteger(number)) throw new Error(`could not parse pull request number from ${url}`);
    return { number, url, state: "draft" };
  }

  if (item.state === "MERGED") return { number: item.number, url: item.url, state: "merged" };
  if (item.state === "CLOSED") {
    await gh("pr", "reopen", String(item.number), "--repo", repo);
    item = { ...item, state: "OPEN" };
  }
  await gh("pr", "edit", String(item.number), "--repo", repo, "--title", input.title, "--body", input.body);
  return { number: item.number, url: item.url, state: item.isDraft ? "draft" : "open" };
}

/** Mark an approved draft PR ready for human/project-policy integration. */
export async function markGitHubPullRequestReady(remoteUrl: string, number: number): Promise<void> {
  const repository = parseGitHubRemote(remoteUrl);
  if (!repository) throw new Error(`unsupported GitHub remote URL: ${remoteUrl}`);
  await gh("pr", "ready", String(number), "--repo", `${repository.owner}/${repository.name}`);
}

/** Branch name derived from a mission: predictable, filesystem-safe. */
export function missionBranchName(missionId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `mission/${missionId}${slug ? `-${slug}` : ""}`;
}

export async function isCleanWorkingTree(repoPath: string): Promise<boolean> {
  const out = await git(repoPath, "status", "--porcelain");
  return out.trim().length === 0;
}

export async function currentBranch(repoPath: string): Promise<string> {
  return (await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD")).trim();
}

export async function headCommit(repoPath: string): Promise<string> {
  return (await git(repoPath, "rev-parse", "HEAD")).trim();
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** Create an isolated worktree + branch for a mission off the given base ref. */
export async function addMissionWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<WorktreeInfo> {
  await git(repoPath, "worktree", "add", "-b", branch, worktreePath, baseRef);
  return { path: worktreePath, branch };
}

export async function removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<void> {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.splice(2, 0, "--force");
  await git(repoPath, ...args);
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const out = await git(repoPath, "worktree", "list", "--porcelain");
  const result: WorktreeInfo[] = [];
  let path = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line.startsWith("branch ")) {
      result.push({ path, branch: line.slice("branch ".length).replace("refs/heads/", "") });
    }
  }
  return result;
}

export async function commitAll(repoPath: string, message: string): Promise<string> {
  await git(repoPath, "add", "-A");
  // Validation is an explicit AvityOS checkpoint. Repository-controlled Git
  // hooks and inherited signing programs are untrusted executable code and
  // must not run with control-plane authority during the commit side effect.
  await git(repoPath, "commit", "--no-verify", "--no-gpg-sign", "-m", message);
  return headCommit(repoPath);
}

/** Files changed on `branch` relative to `baseRef` — used to enforce mission path scopes. */
export async function changedFiles(repoPath: string, baseRef: string, ref = "HEAD"): Promise<string[]> {
  const out = await git(repoPath, "diff", "--name-only", `${baseRef}...${ref}`);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** True when merging `branch` into `baseRef` would conflict (dry run via merge-tree). */
export async function hasConflicts(repoPath: string, baseRef: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, "merge-tree", "--write-tree", baseRef, branch);
    return false;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return true;
    throw err;
  }
}

export async function initRepo(repoPath: string, defaultBranch = "main"): Promise<void> {
  await git(repoPath, "init", "-b", defaultBranch);
  await git(repoPath, "config", "user.email", "avityos@local");
  await git(repoPath, "config", "user.name", "AvityOS");
  await git(repoPath, "config", "commit.gpgsign", "false");
  await git(repoPath, "config", "core.fsmonitor", "false");
  await git(repoPath, "config", "core.untrackedCache", "false");
}
