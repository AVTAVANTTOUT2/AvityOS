import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMissionWorktree,
  changedFiles,
  commitAll,
  currentBranch,
  git,
  hasConflicts,
  initRepo,
  isCleanWorkingTree,
  listWorktrees,
  missionBranchName,
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
});
