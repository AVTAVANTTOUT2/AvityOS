import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMissionWorktree,
  changedFiles,
  commitAll,
  composeDependencyBaseline,
  currentBranch,
  DependencyCompositionError,
  git,
  hasConflicts,
  initRepo,
  isCleanWorkingTree,
  listWorktrees,
  missionBranchName,
  parseGitHubRemote,
  removeWorktree,
} from "./index.js";

let repo: string;
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "avity-git-"));
  repo = join(scratch, "repo");
  await git(scratch, "init", "-b", "main", repo);
  await initRepo(repo);
  await writeFile(join(repo, "README.md"), "# test\n");
  await commitAll(repo, "chore: initial commit");
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("git package", () => {
  it("parses supported GitHub remotes without accepting lookalike hosts", () => {
    expect(parseGitHubRemote("https://github.com/acme/widget.git")).toEqual({ owner: "acme", name: "widget" });
    expect(parseGitHubRemote("git@github.com:acme/widget.git")).toEqual({ owner: "acme", name: "widget" });
    expect(parseGitHubRemote("ssh://git@github.com/acme/widget.git")).toEqual({ owner: "acme", name: "widget" });
    expect(parseGitHubRemote("https://x-access-token:redacted@github.com/acme/widget.git")).toEqual({
      owner: "acme",
      name: "widget",
    });
    expect(parseGitHubRemote("https://github.example/acme/widget")).toBeNull();
  });
  it("derives predictable, safe branch names from missions", () => {
    expect(missionBranchName("m_42", "Implement User Login!")).toBe(
      "mission/m_42-implement-user-login",
    );
    expect(missionBranchName("m1", "Éléphant ça déraille")).toBe("mission/m1-elephant-ca-deraille");
    expect(missionBranchName("m1", "!!!")).toBe("mission/m1");
  });

  it("reports clean/dirty state and current branch", async () => {
    expect(await isCleanWorkingTree(repo)).toBe(true);
    expect(await currentBranch(repo)).toBe("main");
    await writeFile(join(repo, "dirty.txt"), "x");
    expect(await isCleanWorkingTree(repo)).toBe(false);
  });

  it("never executes repository-controlled commit hooks", async () => {
    const marker = join(scratch, "hook-ran");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, `#!/bin/sh\nprintf compromised > '${marker}'\n`);
    await chmod(hook, 0o755);
    await writeFile(join(repo, "safe.txt"), "validated\n");
    await commitAll(repo, "test: safe automated commit");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes inherited signing programs", async () => {
    const marker = join(scratch, "signing-program-ran");
    const signingProgram = join(scratch, "signing-program.sh");
    await writeFile(signingProgram, `#!/bin/sh\nprintf compromised > '${marker}'\nexit 1\n`);
    await chmod(signingProgram, 0o755);
    await git(repo, "config", "commit.gpgsign", "true");
    await git(repo, "config", "gpg.format", "ssh");
    await git(repo, "config", "gpg.ssh.program", signingProgram);
    await git(repo, "config", "user.signingkey", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPqiJsBjAsv4KymedFcUR891X1lgC90DW8yMtjcHJ/p0");
    await writeFile(join(repo, "signed.txt"), "validated\n");

    await commitAll(repo, "test: safe unsigned automated commit");

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes repository post-checkout hooks when adding a worktree", async () => {
    const marker = join(scratch, "post-checkout-ran");
    const hook = join(repo, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\nprintf compromised > '${marker}'\n`);
    await chmod(hook, 0o755);

    const wt = join(scratch, "wt-hooked");
    await addMissionWorktree(repo, wt, missionBranchName("m-hook", "demo"), "main");

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes repository pre-push hooks on automated pushes (independent of --no-verify)", async () => {
    const remote = join(scratch, "remote.git");
    await git(scratch, "init", "--bare", "-b", "main", remote);
    await git(repo, "remote", "add", "origin", remote);

    const marker = join(scratch, "pre-push-ran");
    const hook = join(repo, ".git", "hooks", "pre-push");
    await writeFile(hook, `#!/bin/sh\nprintf compromised > '${marker}'\nexit 1\n`);
    await chmod(hook, 0o755);

    // No --no-verify here: the neutralised core.hooksPath alone must stop the
    // hook, proving the guarantee does not rely on --no-verify.
    await git(repo, "push", "origin", "main");

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("overrides a repository-configured core.hooksPath pointing at malicious hooks", async () => {
    const marker = join(scratch, "custom-hooks-ran");
    const hooksDir = join(scratch, "evil-hooks");
    await git(repo, "config", "core.hooksPath", hooksDir);
    await mkdir(hooksDir, { recursive: true });
    const preCommit = join(hooksDir, "pre-commit");
    await writeFile(preCommit, `#!/bin/sh\nprintf compromised > '${marker}'\nexit 1\n`);
    await chmod(preCommit, 0o755);

    await writeFile(join(repo, "safe2.txt"), "validated\n");
    await commitAll(repo, "test: commit despite malicious repo hooksPath");

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates and removes isolated mission worktrees", async () => {
    const wt = join(scratch, "wt-m1");
    const branch = missionBranchName("m1", "demo");
    await addMissionWorktree(repo, wt, branch, "main");
    const listed = await listWorktrees(repo);
    expect(listed.some((w) => w.branch === branch)).toBe(true);

    await writeFile(join(wt, "feature.ts"), "export const x = 1;\n");
    await commitAll(wt, "feat: add feature");
    expect(await changedFiles(repo, "main", branch)).toEqual(["feature.ts"]);

    await removeWorktree(repo, wt);
    expect((await listWorktrees(repo)).some((w) => w.branch === branch)).toBe(false);
  });

  it("detects merge conflicts via dry run", async () => {
    const wt = join(scratch, "wt-m2");
    await addMissionWorktree(repo, wt, "mission/m2", "main");
    await writeFile(join(wt, "README.md"), "# conflicting change\n");
    await commitAll(wt, "docs: conflicting readme");
    await writeFile(join(repo, "README.md"), "# different change\n");
    await commitAll(repo, "docs: main readme");

    expect(await hasConflicts(repo, "main", "mission/m2")).toBe(true);

    const wt3 = join(scratch, "wt-m3");
    await addMissionWorktree(repo, wt3, "mission/m3", "main");
    await writeFile(join(wt3, "other.txt"), "safe\n");
    await commitAll(wt3, "feat: safe file");
    expect(await hasConflicts(repo, "main", "mission/m3")).toBe(false);
  });

  it("composes divergent dependency branches into an immutable baseline", async () => {
    const frontend = join(scratch, "wt-frontend");
    const backend = join(scratch, "wt-backend");
    await addMissionWorktree(repo, frontend, "mission/frontend", "main");
    await writeFile(join(frontend, "frontend.txt"), "frontend\n");
    const frontendCommit = await commitAll(frontend, "feat: frontend");
    await addMissionWorktree(repo, backend, "mission/backend", "main");
    await writeFile(join(backend, "backend.txt"), "backend\n");
    const backendCommit = await commitAll(backend, "feat: backend");

    const baseline = await composeDependencyBaseline(
      repo,
      "main",
      ["mission/frontend", "mission/backend"],
    );

    expect(await git(repo, "show", `${baseline}:frontend.txt`)).toBe("frontend\n");
    expect(await git(repo, "show", `${baseline}:backend.txt`)).toBe("backend\n");
    const parents = (await git(repo, "show", "-s", "--format=%P", baseline)).trim().split(" ");
    expect(parents).toEqual(expect.arrayContaining([frontendCommit, backendCommit]));
  });

  it("fails closed when dependency branches conflict", async () => {
    const first = join(scratch, "wt-first");
    const second = join(scratch, "wt-second");
    await addMissionWorktree(repo, first, "mission/first", "main");
    await writeFile(join(first, "README.md"), "# first\n");
    await commitAll(first, "docs: first");
    await addMissionWorktree(repo, second, "mission/second", "main");
    await writeFile(join(second, "README.md"), "# second\n");
    await commitAll(second, "docs: second");

    await expect(
      composeDependencyBaseline(repo, "main", ["mission/first", "mission/second"]),
    ).rejects.toBeInstanceOf(DependencyCompositionError);
  });

  it("never executes repository-configured merge drivers during dependency composition", async () => {
    const marker = join(scratch, "merge-driver-ran");
    const driver = join(scratch, "evil-merge-driver.sh");
    await writeFile(
      driver,
      `#!/bin/sh\nprintf compromised > '${marker}'\ncp "$2" "$1"\n`,
    );
    await chmod(driver, 0o755);
    await writeFile(join(repo, ".gitattributes"), "shared.txt merge=evil\n");
    await writeFile(join(repo, "shared.txt"), "base\n");
    await commitAll(repo, "test: configure merge target");
    await git(repo, "config", "merge.evil.driver", `${driver} %O %A %B`);

    const first = join(scratch, "wt-driver-first");
    const second = join(scratch, "wt-driver-second");
    await addMissionWorktree(repo, first, "mission/driver-first", "main");
    await writeFile(join(first, "shared.txt"), "first\n");
    await commitAll(first, "test: first driver input");
    await addMissionWorktree(repo, second, "mission/driver-second", "main");
    await writeFile(join(second, "shared.txt"), "second\n");
    await commitAll(second, "test: second driver input");

    await expect(
      composeDependencyBaseline(
        repo,
        "main",
        ["mission/driver-first", "mission/driver-second"],
      ),
    ).rejects.toBeInstanceOf(DependencyCompositionError);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
