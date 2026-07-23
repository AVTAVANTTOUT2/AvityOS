import { afterEach, describe, expect, it, vi } from "vitest";
import { hardenedGitArgs, missionBranchName } from "@avityos/git";
import {
  clearGitHubReadinessCache,
  detectGitHubReadiness,
  getCachedGitHubReadiness,
  githubReadinessCommandTimeoutMs,
  LOCAL_READINESS_COMMAND_TIMEOUT_MS,
  PREFLIGHT_PERMISSION_BRANCH,
  REMOTE_READINESS_COMMAND_TIMEOUT_MS,
  type CommandResult,
  type CommandRunner,
  type RepositoryReadinessTarget,
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

const DEMO_TARGET: RepositoryReadinessTarget = {
  repoPath: "/tmp/demo-repo",
  remoteUrl: "git@github.com:acme/demo.git",
};

const PREFLIGHT_REF = `HEAD:refs/heads/${PREFLIGHT_PERMISSION_BRANCH}`;
// The preflight push must carry the same hook-neutralising hardening flags the
// rest of AvityOS forces onto automated git. Building the mock key through the
// shared primitive keeps this assertion honest if the hardening set changes.
const pushKey = (remoteUrl: string): string =>
  `git ${hardenedGitArgs("push", "--dry-run", "--no-verify", remoteUrl, PREFLIGHT_REF).join(" ")}`;
const PUSH_KEY = pushKey(DEMO_TARGET.remoteUrl);
const VIEW_KEY = "gh repo view acme/demo --json nameWithOwner";
const PERMISSION_KEY =
  "gh repo view acme/demo --json viewerPermission --jq .viewerPermission";

describe("githubReadinessCommandTimeoutMs", () => {
  it("allows remote GitHub operations more time than local binary checks", () => {
    expect(githubReadinessCommandTimeoutMs("git", ["--version"])).toBe(
      LOCAL_READINESS_COMMAND_TIMEOUT_MS,
    );
    expect(githubReadinessCommandTimeoutMs("gh", ["--version"])).toBe(
      LOCAL_READINESS_COMMAND_TIMEOUT_MS,
    );
    expect(githubReadinessCommandTimeoutMs("git", ["push", "--dry-run"])).toBe(
      REMOTE_READINESS_COMMAND_TIMEOUT_MS,
    );
    expect(
      githubReadinessCommandTimeoutMs("gh", ["repo", "view", "acme/demo"]),
    ).toBe(REMOTE_READINESS_COMMAND_TIMEOUT_MS);
  });
});

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
      DEMO_TARGET,
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
    expect(readiness.repositoryPushDryRunSucceeded).toBe(true);
    expect(readiness.repositoryWriteRoleObserved).toBe(false);
  });

  it("reports only that the configured push dry-run succeeded", async () => {
    const readiness = await detectGitHubReadiness(
      {
        repoPath: "/tmp/demo-repo",
        remoteUrl: "git@github.com:acme/repo.git",
      },
      runnerFrom({
        "git --version": {
          success: true,
          stdout: "git version",
        },
        "gh --version": {
          success: false,
          stdout: "",
        },
        [pushKey("git@github.com:acme/repo.git")]: {
          success: true,
          stdout: "",
        },
      }),
    );

    expect(readiness.repositoryPushDryRunSucceeded).toBe(true);
    expect("repositoryPushVerified" in readiness).toBe(false);
  });

  it("reports an observed write role without claiming PR creation was verified", async () => {
    const readiness = await detectGitHubReadiness(
      {
        repoPath: "/tmp/demo-repo",
        remoteUrl: "git@github.com:acme/repo.git",
      },
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
        "gh repo view acme/repo --json nameWithOwner": {
          success: true,
          stdout: "acme/repo",
        },
        "gh repo view acme/repo --json viewerPermission --jq .viewerPermission": {
          success: true,
          stdout: "WRITE\n",
        },
        [pushKey("git@github.com:acme/repo.git")]: {
          success: true,
          stdout: "",
        },
      }),
    );

    expect(readiness.repositoryWriteRoleObserved).toBe(true);
    expect("pullRequestCreationVerified" in readiness).toBe(false);
  });

  it("verifies push against the configured project remote rather than origin", async () => {
    const calls: {
      command: string;
      args: readonly string[];
      cwd?: string;
    }[] = [];

    const target = {
      repoPath: "/tmp/demo-repo",
      remoteUrl: "git@github.com:acme/actual-target.git",
    };

    await detectGitHubReadiness(
      target,
      runnerFrom(
        {
          "git --version": {
            success: true,
            stdout: "git version",
          },
          "gh --version": {
            success: false,
            stdout: "",
          },
          [pushKey(target.remoteUrl)]: {
            success: true,
            stdout: "",
          },
        },
        calls,
      ),
    );

    const pushCall = calls.find(
      (call) => call.command === "git" && call.args.includes("push"),
    );

    expect(pushCall).toBeDefined();
    expect(pushCall?.args).toContain("git@github.com:acme/actual-target.git");
    expect(pushCall?.args).not.toContain("origin");
    expect(pushCall?.args).toContain(
      `HEAD:refs/heads/${missionBranchName("preflight-permission-check", "")}`,
    );
  });

  it("does not claim push readiness from origin when the configured remote is inaccessible", async () => {
    const calls: {
      command: string;
      args: readonly string[];
      cwd?: string;
    }[] = [];

    const readiness = await detectGitHubReadiness(
      {
        repoPath: "/tmp/demo-repo",
        remoteUrl: "git@github.com:acme/inaccessible-target.git",
      },
      async (command, args, cwd) => {
        calls.push({ command, args, cwd });

        if (command === "git" && args[0] === "--version") {
          return {
            success: true,
            stdout: "git version",
          };
        }

        if (command === "git" && args.includes("origin")) {
          return {
            success: true,
            stdout: "",
          };
        }

        if (
          command === "git" &&
          args.includes("git@github.com:acme/inaccessible-target.git")
        ) {
          return {
            success: false,
            stdout: "",
          };
        }

        return {
          success: false,
          stdout: "",
        };
      },
    );

    expect(readiness.repositoryPushDryRunSucceeded).toBe(false);

    expect(
      calls.some(
        (call) => call.command === "git" && call.args.includes("origin"),
      ),
    ).toBe(false);
  });

  it("does not verify PR creation for READ permission", async () => {
    const readiness = await detectGitHubReadiness(
      DEMO_TARGET,
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
        [VIEW_KEY]: {
          success: true,
          stdout: "acme/demo",
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
    expect(readiness.repositoryWriteRoleObserved).toBe(false);
  });

  it.each(["WRITE", "MAINTAIN", "ADMIN"] as const)(
    "verifies PR creation for %s permission",
    async (permission) => {
      const readiness = await detectGitHubReadiness(
        DEMO_TARGET,
        runnerFrom({
          "git --version": { success: true, stdout: "git version" },
          "gh --version": { success: true, stdout: "gh version" },
          "gh auth status --hostname github.com": { success: true, stdout: "" },
          [VIEW_KEY]: {
            success: true,
            stdout: "acme/demo",
          },
          [PERMISSION_KEY]: { success: true, stdout: `${permission}\n` },
          [PUSH_KEY]: { success: true, stdout: "" },
        }),
      );

      expect(readiness.repositoryWriteRoleObserved).toBe(true);
    },
  );

  it("does not verify PR creation for TRIAGE permission", async () => {
    const readiness = await detectGitHubReadiness(
      DEMO_TARGET,
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
        "gh --version": { success: true, stdout: "gh version" },
        "gh auth status --hostname github.com": { success: true, stdout: "" },
        [VIEW_KEY]: {
          success: true,
          stdout: "acme/demo",
        },
        [PERMISSION_KEY]: { success: true, stdout: "TRIAGE\n" },
        [PUSH_KEY]: { success: false, stdout: "" },
      }),
    );

    expect(readiness.repositoryWriteRoleObserved).toBe(false);
  });

  it("does not verify PR creation when permission stdout is empty", async () => {
    const readiness = await detectGitHubReadiness(
      DEMO_TARGET,
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
        "gh --version": { success: true, stdout: "gh version" },
        "gh auth status --hostname github.com": { success: true, stdout: "" },
        [VIEW_KEY]: {
          success: true,
          stdout: "acme/demo",
        },
        [PERMISSION_KEY]: { success: true, stdout: "" },
        [PUSH_KEY]: { success: false, stdout: "" },
      }),
    );

    expect(readiness.repositoryWriteRoleObserved).toBe(false);
  });

  it("targets gh checks at the configured GitHub repository slug", async () => {
    const calls: {
      command: string;
      args: readonly string[];
      cwd?: string;
    }[] = [];

    await detectGitHubReadiness(
      {
        repoPath: "/tmp/demo-repo",
        remoteUrl: "https://github.com/acme/target.git",
      },
      runnerFrom(
        {
          "git --version": { success: true, stdout: "git version" },
          "gh --version": { success: true, stdout: "gh version" },
          "gh auth status --hostname github.com": { success: true, stdout: "" },
          "gh repo view acme/target --json nameWithOwner": {
            success: true,
            stdout: "acme/target",
          },
          "gh repo view acme/target --json viewerPermission --jq .viewerPermission":
            {
              success: true,
              stdout: "WRITE\n",
            },
          [pushKey("https://github.com/acme/target.git")]:
            {
              success: true,
              stdout: "",
            },
        },
        calls,
      ),
    );

    const viewCalls = calls.filter(
      (call) => call.command === "gh" && call.args[0] === "repo",
    );
    expect(viewCalls.length).toBeGreaterThan(0);
    for (const call of viewCalls) {
      expect(call.args.slice(0, 3)).toEqual(["repo", "view", "acme/target"]);
    }
  });

  it("allows git push verification for a non-GitHub remote but blocks gh checks", async () => {
    const readiness = await detectGitHubReadiness(
      {
        repoPath: "/tmp/demo-repo",
        remoteUrl: "git@gitlab.example:acme/target.git",
      },
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
        "gh --version": { success: true, stdout: "gh version" },
        "gh auth status --hostname github.com": { success: true, stdout: "" },
        [pushKey("git@gitlab.example:acme/target.git")]:
          {
            success: true,
            stdout: "",
          },
      }),
    );

    expect(readiness.repositoryPushDryRunSucceeded).toBe(true);
    expect(readiness.repositoryReadable).toBe(false);
    expect(readiness.repositoryWriteRoleObserved).toBe(false);
  });

  it("never calls git push or gh repo view when the target is incomplete", async () => {
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
          (c.command === "git" && c.args.includes("push")) ||
          (c.command === "gh" && c.args[0] === "repo"),
      ),
    ).toBe(false);
    expect(readiness.repositoryReadable).toBe(false);
    expect(readiness.repositoryPushDryRunSucceeded).toBe(false);
    expect(readiness.repositoryWriteRoleObserved).toBe(false);
  });

  it("never claims repository readiness when remoteUrl is missing", async () => {
    const calls: {
      command: string;
      args: readonly string[];
      cwd?: string;
    }[] = [];
    const readiness = await detectGitHubReadiness(
      { repoPath: "/tmp/demo-repo", remoteUrl: "   " },
      runnerFrom(
        {
          "git --version": { success: true, stdout: "git version" },
          "gh --version": { success: true, stdout: "gh version" },
          "gh auth status --hostname github.com": { success: true, stdout: "" },
        },
        calls,
      ),
    );

    expect(calls.some((c) => c.command === "git" && c.args.includes("push"))).toBe(
      false,
    );
    expect(readiness.repositoryPushDryRunSucceeded).toBe(false);
    expect(readiness.repositoryReadable).toBe(false);
    expect(readiness.repositoryWriteRoleObserved).toBe(false);
  });

  it("returns only boolean readiness fields with no command output or secrets", async () => {
    const readiness = await detectGitHubReadiness(
      DEMO_TARGET,
      runnerFrom({
        "git --version": { success: true, stdout: "git version" },
        "gh --version": { success: true, stdout: "gh version" },
        "gh auth status --hostname github.com": { success: true, stdout: "" },
        [VIEW_KEY]: {
          success: true,
          stdout: "acme/demo",
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
      "repositoryPushDryRunSucceeded",
      "repositoryReadable",
      "repositoryWriteRoleObserved",
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
    const target = {
      repoPath: "/repo-a",
      remoteUrl: "git@github.com:acme/a.git",
    };
    const first = getCachedGitHubReadiness(target, () => now, run);
    await first;
    now = 1_000 + 30_001;
    const second = getCachedGitHubReadiness(target, () => now, run);
    expect(second).not.toBe(first);
    await second;
  });

  it("retries incomplete repository readiness after a short negative TTL", async () => {
    let now = 1_000;
    let attempts = 0;
    const run: CommandRunner = async () => {
      attempts += 1;
      return { success: false, stdout: "" };
    };
    const target = {
      repoPath: "/repo-flaky",
      remoteUrl: "git@github.com:acme/flaky.git",
    };

    const first = getCachedGitHubReadiness(target, () => now, run);
    await first;
    const attemptsAfterFirstProbe = attempts;

    now += 4_999;
    const cached = getCachedGitHubReadiness(target, () => now, run);
    expect(cached).toBe(first);
    await cached;
    expect(attempts).toBe(attemptsAfterFirstProbe);

    now += 2;
    const retried = getCachedGitHubReadiness(target, () => now, run);
    expect(retried).not.toBe(first);
    await retried;
    expect(attempts).toBeGreaterThan(attemptsAfterFirstProbe);
  });

  it("keeps distinct cache entries per repository path", async () => {
    const seenCwds: Array<string | undefined> = [];
    const run: CommandRunner = async (command, args, cwd) => {
      if (command === "gh" && args[0] === "repo") seenCwds.push(cwd);
      return { success: true, stdout: "WRITE" };
    };
    await getCachedGitHubReadiness(
      { repoPath: "/repo-a", remoteUrl: "git@github.com:acme/a.git" },
      () => 1_000,
      run,
    );
    await getCachedGitHubReadiness(
      { repoPath: "/repo-b", remoteUrl: "git@github.com:acme/b.git" },
      () => 1_000,
      run,
    );
    expect([...new Set(seenCwds)].sort()).toEqual(["/repo-a", "/repo-b"]);
  });

  it("uses separate cache entries for the same repo path with different remotes", async () => {
    const seenRemotes: string[] = [];
    const run: CommandRunner = async (command, args) => {
      if (command === "git" && args.includes("push")) {
        const remote = args.find((arg) => arg.includes("github.com"));
        if (remote) seenRemotes.push(remote);
      }
      return { success: true, stdout: "WRITE" };
    };

    const targetA = {
      repoPath: "/tmp/repo",
      remoteUrl: "git@github.com:acme/a.git",
    };
    const targetB = {
      repoPath: "/tmp/repo",
      remoteUrl: "git@github.com:acme/b.git",
    };

    const first = getCachedGitHubReadiness(targetA, () => 1_000, run);
    const second = getCachedGitHubReadiness(targetB, () => 1_000, run);
    expect(second).not.toBe(first);
    await Promise.all([first, second]);
    expect(seenRemotes.sort()).toEqual([
      "git@github.com:acme/a.git",
      "git@github.com:acme/b.git",
    ]);
  });

  it("evicts a rejected detection instead of replaying it for the whole TTL", async () => {
    let attempts = 0;
    // A runner that rejects (rather than returning success:false) on its first
    // use and succeeds afterwards. detectGitHubReadiness normally swallows
    // failures, but an injected runner that throws makes the returned promise
    // reject, which must not be cached.
    const run: CommandRunner = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient detection failure");
      }
      return { success: true, stdout: "" };
    };
    const now = 5_000;
    const target = {
      repoPath: "/repo-flaky",
      remoteUrl: "git@github.com:acme/flaky.git",
    };

    const first = getCachedGitHubReadiness(target, () => now, run);
    await expect(first).rejects.toThrow("transient detection failure");

    // The rejected promise must have been evicted, so a second call within the
    // TTL runs a fresh detection instead of replaying the cached rejection.
    const second = getCachedGitHubReadiness(target, () => now, run);
    expect(second).not.toBe(first);
    await expect(second).resolves.toMatchObject({ gitAvailable: true });
  });

  it("does not evict a newer detection when an older rejected promise settles", async () => {
    const target = {
      repoPath: "/repo-race",
      remoteUrl: "git@github.com:acme/race.git",
    };

    let rejectFirst: (reason: unknown) => void = () => {};
    const first = getCachedGitHubReadiness(
      target,
      () => 1_000,
      () =>
        new Promise<CommandResult>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );

    // A second detection after the TTL replaces the cache entry before the
    // first promise rejects.
    const second = getCachedGitHubReadiness(
      target,
      () => 1_000 + 30_001,
      async () => ({ success: true, stdout: "" }),
    );
    expect(second).not.toBe(first);

    // Now let the first (older, evicted) promise reject. Its eviction guard
    // must leave the newer cached entry untouched.
    rejectFirst(new Error("late failure"));
    await expect(first).rejects.toThrow("late failure");
    await second;

    const third = getCachedGitHubReadiness(target, () => 1_000 + 30_001, async () => ({
      success: true,
      stdout: "",
    }));
    expect(third).toBe(second);
  });
});
