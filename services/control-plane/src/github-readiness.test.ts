import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubReadinessCache,
  detectGitHubReadiness,
  getCachedGitHubReadiness,
  type CommandRunner,
} from "./github-readiness.js";

afterEach(() => {
  clearGitHubReadinessCache();
  vi.unstubAllEnvs();
});

function runnerFrom(
  decisions: Record<string, boolean>,
  calls: { command: string; args: readonly string[]; cwd?: string }[] = [],
): CommandRunner {
  return async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    const key = `${command} ${args.join(" ")}`;
    return decisions[key] ?? false;
  };
}

describe("detectGitHubReadiness", () => {
  it("reports gitAvailable false when git --version fails", async () => {
    const readiness = await detectGitHubReadiness(
      undefined,
      runnerFrom({ "gh --version": true }),
    );
    expect(readiness.gitAvailable).toBe(false);
  });

  it("reports ghAvailable false when gh --version fails", async () => {
    const readiness = await detectGitHubReadiness(
      undefined,
      runnerFrom({ "git --version": true }),
    );
    expect(readiness.ghAvailable).toBe(false);
  });

  it("reports ghAuthenticated false when gh auth status fails", async () => {
    const readiness = await detectGitHubReadiness(
      undefined,
      runnerFrom({
        "git --version": true,
        "gh --version": true,
        "gh auth status --hostname github.com": false,
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
        "git --version": true,
        "gh --version": true,
        "gh auth status --hostname github.com": true,
      }),
    );
    expect(readiness.ghAuthenticated).toBe(true);
    expect(readiness.credentialHintAvailable).toBe(false);
  });

  it("reports repositoryAccessVerified true when gh repo view succeeds", async () => {
    const readiness = await detectGitHubReadiness(
      "/tmp/demo-repo",
      runnerFrom({
        "git --version": true,
        "gh --version": true,
        "gh auth status --hostname github.com": true,
        "gh repo view --json nameWithOwner": true,
      }),
    );
    expect(readiness.repositoryAccessVerified).toBe(true);
  });

  it("never calls gh repo view when repoPath is absent", async () => {
    const calls: { command: string; args: readonly string[]; cwd?: string }[] = [];
    await detectGitHubReadiness(
      undefined,
      runnerFrom(
        {
          "git --version": true,
          "gh --version": true,
          "gh auth status --hostname github.com": true,
        },
        calls,
      ),
    );
    expect(calls.some((c) => c.command === "gh" && c.args[0] === "repo")).toBe(false);
  });

  it("returns only boolean readiness fields with no command output", async () => {
    const readiness = await detectGitHubReadiness(
      "/tmp/demo-repo",
      runnerFrom({
        "git --version": true,
        "gh --version": true,
        "gh auth status --hostname github.com": true,
        "gh repo view --json nameWithOwner": true,
      }),
    );
    expect(Object.keys(readiness).sort()).toEqual([
      "credentialHintAvailable",
      "ghAuthenticated",
      "ghAvailable",
      "gitAvailable",
      "repositoryAccessVerified",
    ]);
    expect(JSON.stringify(readiness)).not.toMatch(/stdout|stderr|sk-|ghp_/i);
  });
});

describe("getCachedGitHubReadiness", () => {
  it("reuses the cached promise within the TTL", async () => {
    const run: CommandRunner = async () => true;
    const now = 1_000;
    const first = getCachedGitHubReadiness(undefined, () => now, run);
    const second = getCachedGitHubReadiness(undefined, () => now + 10_000, run);
    expect(second).toBe(first);
    await first;
  });

  it("re-runs detection after the TTL expires", async () => {
    const run: CommandRunner = async () => true;
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
      return true;
    };
    await getCachedGitHubReadiness("/repo-a", () => 1_000, run);
    await getCachedGitHubReadiness("/repo-b", () => 1_000, run);
    expect(seenCwds).toEqual(["/repo-a", "/repo-b"]);
  });
});
