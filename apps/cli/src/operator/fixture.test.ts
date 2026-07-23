import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";
import { createExternalLiveFixture, FixtureError } from "./fixture.js";

function runGit(repoPath: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function runPnpm(repoPath: string, script: "test" | "typecheck"): void {
  execFileSync("pnpm", ["--dir", repoPath, script], { encoding: "utf8", stdio: "pipe" });
}

afterEach(() => {
  delete process.env.AVITY_CONFIG;
  delete process.env.AVITY_DISABLE_KEYCHAIN;
});

describe("external live fixture generator", () => {
  it("creates an autonomous fixture repository with source, tests, and typecheck", () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "live-fixture");
    const result = createExternalLiveFixture({ path: fixturePath });

    expect(result.path).toBe(fixturePath);
    expect(result.branch).toBe("main");
    expect(existsSync(join(fixturePath, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(fixturePath, "test", "objectives.test.ts"))).toBe(true);
    expect(existsSync(join(fixturePath, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(fixturePath, "package.json"))).toBe(true);
    expect(runGit(fixturePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(runGit(fixturePath, ["status", "--porcelain"])).toBe("");
    expect(runGit(fixturePath, ["log", "-1", "--pretty=%s"])).toBe("chore: initialize live e2e fixture");

    const pkg = JSON.parse(readFileSync(join(fixturePath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.publish).toBeUndefined();
    expect(pkg.scripts?.prepublishOnly).toBeUndefined();
    expect(pkg.scripts?.prepare).toBeUndefined();

    const readme = readFileSync(join(fixturePath, "README.md"), "utf8");
    expect(readme).toContain("Mission normale");
    expect(readme).toContain("Mission rejet/correction");
    expect(readme).toContain("pnpm test");
    expect(readme).toContain("pnpm typecheck");

    runPnpm(fixturePath, "test");
    runPnpm(fixturePath, "typecheck");
    expect(runGit(fixturePath, ["status", "--porcelain"])).toBe("");
  });

  it("configures optional GitHub remote when valid", () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "with-remote");
    createExternalLiveFixture({
      path: fixturePath,
      remote: "https://github.com/example/live-e2e-fixture.git",
    });

    expect(runGit(fixturePath, ["remote", "get-url", "origin"])).toBe("https://github.com/example/live-e2e-fixture.git");
  });

  it("rejects non-GitHub remote URLs", () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "bad-remote");
    expect(() => createExternalLiveFixture({ path: fixturePath, remote: "https://gitlab.com/example/repo.git" })).toThrow(
      /GitHub/,
    );
  });

  it("refuses to overwrite existing directory (idempotent refusal)", () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "already-exists");
    createExternalLiveFixture({ path: fixturePath });

    expect(() => createExternalLiveFixture({ path: fixturePath })).toThrow(FixtureError);
    expect(() => createExternalLiveFixture({ path: fixturePath })).toThrow(/already exists/);
  });

  it("exposes the CLI command without breaking e2e preflight route", async () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "cli-fixture");

    const fixtureExitCode = await main(["e2e", "fixture", "create", "--path", fixturePath, "--json"]);
    expect(fixtureExitCode).toBe(0);

    const preflightExitCode = await main(["e2e", "preflight"]);
    expect(preflightExitCode).toBe(1);
  });
});
