import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@avityos/contracts";
import { commitAll, git, initRepo } from "@avityos/git";
import { buildRepoSnapshot, detectRepositoryChecks } from "./snapshot.js";

let scratch: string;
let repo: string;

function projectFor(repoPath: string | null): Project {
  return {
    id: "prj_snapshot",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceId: "default",
    name: "Snapshot",
    status: "planning",
    repoPath,
    repoRemoteUrl: null,
    defaultBranch: "main",
    autonomyProfile: "autonomous_with_checkpoints",
    description: "",
  };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "avity-snapshot-"));
  repo = join(scratch, "repo");
  await git(scratch, "init", "-b", "main", repo);
  await initRepo(repo);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("bounded repository snapshot", () => {
  it("captures the real repository state, scripts and available checks", async () => {
    await writeFile(join(repo, "README.md"), "# Snapshot fixture\n\nDelivers the objective.\n");
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "node -e 'process.exit(0)'", build: "node -e ''" } }),
    );
    await writeFile(join(repo, "src.ts"), "export const x = 1;\n");
    await commitAll(repo, "chore: fixture");

    const snapshot = (await buildRepoSnapshot(projectFor(repo)))!;
    expect(snapshot.branch).toBe("main");
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.workingTreeClean).toBe(true);
    expect(snapshot.fileTree).toContain("README.md");
    expect(snapshot.fileTree).toContain("src.ts");
    expect(snapshot.languages).toContain("TypeScript");
    expect(snapshot.scripts.test).toContain("node -e");
    expect(snapshot.availableChecks.requiredChecks).toContain("test");
    expect(snapshot.availableChecks.checkCommands.test).toEqual(["npm", "run", "test"]);
    expect(snapshot.documents.some((doc) => doc.path === "README.md")).toBe(true);
    expect(snapshot.evidence.some((ref) => ref.ref === `commit:${snapshot.commit}`)).toBe(true);
    expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/);

    // deterministic: same repository state -> same hash
    const again = (await buildRepoSnapshot(projectFor(repo)))!;
    expect(again.hash).toBe(snapshot.hash);
  });

  it("excludes secret-shaped files, redacts content and never leaves the repository", async () => {
    // assembled at runtime so the fake credential never appears verbatim in
    // this repository's own sources (Gitleaks stays clean)
    const fakeApiKey = ["sk-", "verysecretkey", "1234567890"].join("");
    await writeFile(join(repo, "README.md"), `token setup: api_key = "${fakeApiKey}"\n`);
    await writeFile(join(repo, ".env"), "SECRET_TOKEN=super-secret-value\n");
    await mkdir(join(repo, "secrets"));
    await writeFile(join(repo, "secrets", "key.pem"), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
    await writeFile(join(scratch, "outside.md"), "outside the repository\n");
    await symlink(join(scratch, "outside.md"), join(repo, "ARCHITECTURE.md"));
    await git(repo, "add", "-A", "-f");
    await git(repo, "commit", "--no-verify", "-m", "chore: fixture with secrets");

    const snapshot = (await buildRepoSnapshot(projectFor(repo)))!;
    const serialized = JSON.stringify(snapshot);
    // secret-shaped paths are absent from the tree and never read
    expect(snapshot.fileTree).not.toContain(".env");
    expect(snapshot.fileTree.some((path) => path.startsWith("secrets/"))).toBe(false);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("PRIVATE KEY");
    // symlinked document escaping the repository is not followed
    expect(snapshot.documents.some((doc) => doc.path === "ARCHITECTURE.md")).toBe(false);
    expect(serialized).not.toContain("outside the repository");
    // credential patterns inside legitimate documents are redacted
    expect(serialized).not.toContain(fakeApiKey);
    expect(snapshot.documents.find((doc) => doc.path === "README.md")?.content).toContain("[REDACTED]");
  });

  it("returns null for a greenfield project and detects Swift checks", async () => {
    expect(await buildRepoSnapshot(projectFor(null))).toBeNull();
    await writeFile(join(repo, "Package.swift"), "// swift-tools-version:5.9\n");
    await commitAll(repo, "chore: swift");
    const checks = detectRepositoryChecks(repo);
    expect(checks.checkCommands.build).toEqual(["swift", "build"]);
    expect(checks.checkCommands.test).toEqual(["swift", "test"]);
  });
});
