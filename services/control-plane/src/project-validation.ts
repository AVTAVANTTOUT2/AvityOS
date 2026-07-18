import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { git, parseGitHubRemote } from "@avityos/git";

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectValidationError";
  }
}

export interface RepositoryConfiguration {
  repoPath: string | null;
  repoRemoteUrl: string | null;
  defaultBranch: string;
}

/**
 * Resolve and verify all client-supplied repository data before it crosses a
 * persistence or execution boundary. The returned path and remote are the
 * canonical server-observed values, never unchecked client strings.
 */
export async function validateRepositoryConfiguration(
  input: RepositoryConfiguration,
): Promise<RepositoryConfiguration> {
  if (!input.repoPath) {
    if (input.repoRemoteUrl) {
      throw new ProjectValidationError("a GitHub remote requires a local repository path");
    }
    return { repoPath: null, repoRemoteUrl: null, defaultBranch: input.defaultBranch };
  }

  let candidate: string;
  try {
    candidate = realpathSync(resolve(input.repoPath));
    if (!statSync(candidate).isDirectory()) {
      throw new ProjectValidationError(`repository path is not a directory: ${candidate}`);
    }
    accessSync(candidate, constants.R_OK | constants.W_OK);
  } catch (error) {
    if (error instanceof ProjectValidationError) throw error;
    throw new ProjectValidationError(`repository path does not exist or is not accessible: ${resolve(input.repoPath)}`);
  }

  let repoPath: string;
  try {
    const inside = (await git(candidate, "rev-parse", "--is-inside-work-tree")).trim();
    if (inside !== "true") throw new Error("not a working tree");
    repoPath = realpathSync((await git(candidate, "rev-parse", "--show-toplevel")).trim());
    accessSync(repoPath, constants.R_OK | constants.W_OK);
  } catch {
    throw new ProjectValidationError(`path is not an accessible Git working tree: ${candidate}`);
  }

  try {
    await git(repoPath, "check-ref-format", "--branch", input.defaultBranch);
    await git(repoPath, "rev-parse", "--verify", `refs/heads/${input.defaultBranch}^{commit}`);
  } catch {
    throw new ProjectValidationError(
      `default branch '${input.defaultBranch}' is invalid or does not exist locally in ${repoPath}`,
    );
  }

  if (!input.repoRemoteUrl) {
    return { repoPath, repoRemoteUrl: null, defaultBranch: input.defaultBranch };
  }

  const requested = parseGitHubRemote(input.repoRemoteUrl);
  if (!requested) throw new ProjectValidationError("remote must be a supported GitHub HTTPS or SSH URL");

  let configuredRemote: string | null = null;
  try {
    const names = (await git(repoPath, "remote")).split("\n").map((name) => name.trim()).filter(Boolean);
    for (const name of names) {
      const url = (await git(repoPath, "remote", "get-url", name)).trim();
      const parsed = parseGitHubRemote(url);
      if (
        parsed &&
        parsed.owner.toLowerCase() === requested.owner.toLowerCase() &&
        parsed.name.toLowerCase() === requested.name.toLowerCase()
      ) {
        configuredRemote = url;
        break;
      }
    }
  } catch {
    throw new ProjectValidationError(`Git remotes could not be read from ${repoPath}`);
  }

  if (!configuredRemote) {
    throw new ProjectValidationError(
      `GitHub remote ${requested.owner}/${requested.name} is not configured in ${repoPath}`,
    );
  }
  return { repoPath, repoRemoteUrl: configuredRemote, defaultBranch: input.defaultBranch };
}
