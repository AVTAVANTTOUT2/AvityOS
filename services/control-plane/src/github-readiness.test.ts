import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubReadinessCache,
  detectGitHubReadiness,
  getCachedGitHubReadiness,
  type CommandResult,
  type CommandRunner,
} from "./github-readiness.js";

afterEach(() => {
  clearGitHubReadinessCache();
  vi.unstubAllEnvs();
});

function runnerFrom(
  decisions: Record<string, CommandResult>,
  calls: {
    command: string;
    args: readonly string[];
    cwd?: string;
  }[] = [],
): CommandRunner {
  return async (command, args, cwd) => {
    calls.push({ command, args, cwd });

    const key = `${command} ${args.join(" ")}`;

    return (
      decisions[key] ?? {
        success: false,
        stdout: "",
      }
    );
  };
}

const PUSH_KEY =
  "git push --dry-run --no-verify origin HEAD:refs/heads/avity-preflight-permission-check";
const PERMISSION_KEY =
  "gh repo view --json viewerPermission --jq .viewerPermission";

describe("detectGitHubReadiness", () => {
  it("reports gitAvailable false when git --version fails", async () => {
    const readiness = await detectGitHubReadiness(
      undefined,
      runnerFrom({
        "gh --version": { success: true, stdout: "gh version" },
      }),
    );
    expect(readiness.gitAvailable).toBe(false);
  });

  it("reports ghAvailable false when gh --version fails", async () => {
    const readiness = await detectGitHubReadiness(
      undefined,
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
      }),
    );
    expect(readiness.ghAvailable).toBe(false);
  });

  it("reports ghAuthenticated false when gh auth status fails", async () => {
    const readiness = await detectGitHubReadiness(
      undefined,
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
        "gh --version": { success: true, stdout: "gh version" },
        "gh auth status --hostname github.com": { success: false, stdout: "" },
      }),
    );
    expect(readiness.ghAuthenticated).toBe(false);
  });

  it("reports ghAuthenticated true without requiring token env vars", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("SSH_AUTH_SOCK", "");
    const readiness = await detectGitHubReadiness(
      undefined,
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
        "gh --version": { success: true, stdout: "gh version" },
        "gh auth status --hostname github.com": { success: true, stdout: "" },
      }),
    );
    expect(readiness.ghAuthenticated).toBe(true);
    expect(readiness.credentialHintAvailable).toBe(false);
  });

  it("verifies repository push without requiring gh", async () => {
    const readiness = await detectGitHubReadiness(
      "/tmp/demo-repo",
      runnerFrom({
        "git --version": {
          success: true,
          stdout: "git version 2.50.0",
        },
        "gh --version": {
          success: false,
          stdout: "",
        },
        [PUSH_KEY]: {
          success: true,
          stdout: "",
        },
      }),
    );

    expect(readiness.gitAvailable).toBe(true);
    expect(readiness.ghAvailable).toBe(false);
    expect(readiness.repositoryPushVerified).toBe(true);
    expect(readiness.pullRequestCreationVerified).toBe(false);
  });

  it("does not verify PR creation for READ permission", async () => {
    const readiness = await detectGitHubReadiness(
      "/tmp/demo-repo",
      runnerFrom({
        "git --version": {
          success: true,
          stdout: "git version",
        },
        "gh --version": {
          success: true,
          stdout: "gh version",
        },
        "gh auth status --hostname github.com": {
          success: true,
          stdout: "",
        },
        "gh repo view --json nameWithOwner": {
          success: true,
          stdout: "owner/repo",
        },
        [PERMISSION_KEY]: {
          success: true,
          stdout: "READ\n",
        },
        [PUSH_KEY]: {
          success: false,
          stdout: "",
        },
      }),
    );

    expect(readiness.repositoryReadable).toBe(true);
    expect(readiness.pullRequestCreationVerified).toBe(false);
  });

  it.each(["WRITE", "MAINTAIN", "ADMIN"] as const)(
    "verifies PR creation for %s permission",
    async (permission) => {
      const readiness = await detectGitHubReadiness(
        "/tmp/demo-repo",
        runnerFrom({
          "git --version": { success: true, stdout: "git version" },
          "gh --version": { success: true, stdout: "gh version" },
          "gh auth status --hostname github.com": { success: true, stdout: "" },
          "gh repo view --json nameWithOwner": {
            success: true,
            stdout: "owner/repo",
          },
          [PERMISSION_KEY]: { success: true, stdout: `${permission}\n` },
          [PUSH_KEY]: { success: true, stdout: "" },
        }),
      );

      expect(readiness.pullRequestCreationVerified).toBe(true);
    },
  );

  it("does not verify PR creation for TRIAGE permission", async () => {
    const readiness = await detectGitHubReadiness(
      "/tmp/demo-repo",
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
        "gh --version": { success: true, stdout: "gh version" },
        "gh auth status --hostname github.com": { success: true, stdout: "" },
        "gh repo view --json nameWithOwner": {
          success: true,
          stdout: "owner/repo",
        },
        [PERMISSION_KEY]: { success: true, stdout: "TRIAGE\n" },
        [PUSH_KEY]: { success: false, stdout: "" },
      }),
    );

    expect(readiness.pullRequestCreationVerified).toBe(false);
  });

  it("does not verify PR creation when permission stdout is empty", async () => {
    const readiness = await detectGitHubReadiness(
      "/tmp/demo-repo",
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
        "gh --version": { success: true, stdout: "gh version" },
        "gh auth status --hostname github.com": { success: true, stdout: "" },
        "gh repo view --json nameWithOwner": {
          success: true,
          stdout: "owner/repo",
        },
        [PERMISSION_KEY]: { success: true, stdout: "" },
        [PUSH_KEY]: { success: false, stdout: "" },
      }),
    );

    expect(readiness.pullRequestCreationVerified).toBe(false);
  });

  it("never calls git push or gh repo view when repoPath is absent", async () => {
    const calls: {
      command: string;
      args: readonly string[];
      cwd?: string;
    }[] = [];
    const readiness = await detectGitHubReadiness(
      undefined,
      runnerFrom(
        {
          "git --version": { success: true, stdout: "git version" },
          "gh --version": { success: true, stdout: "gh version" },
          "gh auth status --hostname github.com": { success: true, stdout: "" },
        },
        calls,
      ),
    );

    expect(
      calls.some(
        (c) =>
          (c.command === "git" && c.args[0] === "push") ||
          (c.command === "gh" && c.args[0] === "repo"),
      ),
    ).toBe(false);
    expect(readiness.repositoryReadable).toBe(false);
    expect(readiness.repositoryPushVerified).toBe(false);
    expect(readiness.pullRequestCreationVerified).toBe(false);
  });

  it("returns only boolean readiness fields with no command output or secrets", async () => {
    const readiness = await detectGitHubReadiness(
      "/tmp/demo-repo",
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
        "gh --version": { success: true, stdout: "gh version" },
        "gh auth status --hostname github.com": { success: true, stdout: "" },
        "gh repo view --json nameWithOwner": {
          success: true,
          stdout: "owner/repo",
        },
        [PERMISSION_KEY]: { success: true, stdout: "WRITE\n" },
        [PUSH_KEY]: { success: true, stdout: "" },
      }),
    );
    expect(Object.keys(readiness).sort()).toEqual([
      "credentialHintAvailable",
      "ghAuthenticated",
      "ghAvailable",
      "gitAvailable",
      "pullRequestCreationVerified",
      "repositoryPushVerified",
      "repositoryReadable",
    ]);
    expect(JSON.stringify(readiness)).not.toMatch(
      /stdout|stderr|ghp_|github_pat_|sk-/i,
    );
  });
});

describe("getCachedGitHubReadiness", () => {
  it("reuses the cached promise within the TTL", async () => {
    const run: CommandRunner = async () => ({ success: true, stdout: "" });
    const now = 1_000;
    const first = getCachedGitHubReadiness(undefined, () => now, run);
    const second = getCachedGitHubReadiness(undefined, () => now + 10_000, run);
    expect(second).toBe(first);
    await first;
  });

  it("re-runs detection after the TTL expires", async () => {
    const run: CommandRunner = async () => ({ success: true, stdout: "" });
    let now = 1_000;
    const first = getCachedGitHubReadiness("/repo-a", () => now, run);
    await first;
    now = 1_000 + 30_001;
    const second = getCachedGitHubReadiness("/repo-a", () => now, run);
    expect(second).not.toBe(first);
    await second;
  });

  it("keeps distinct cache entries per repository path", async () => {
    const seenCwds: Array<string | undefined> = [];
    const run: CommandRunner = async (command, args, cwd) => {
      if (command === "gh" && args[0] === "repo") seenCwds.push(cwd);
      return { success: true, stdout: "WRITE" };
    };
    await getCachedGitHubReadiness("/repo-a", () => 1_000, run);
    await getCachedGitHubReadiness("/repo-b", () => 1_000, run);
    expect([...new Set(seenCwds)].sort()).toEqual(["/repo-a", "/repo-b"]);
  });
});
