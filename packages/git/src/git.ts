import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; code?: number };
    throw new GitError(args, e.stderr ?? String(err), e.code ?? null);
  }
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
  await git(repoPath, "commit", "-m", message);
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
}
