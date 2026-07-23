import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";
import { createExternalLiveFixture, FixtureError, type FixtureCommandRunner } from "./fixture.js";

function runGit(repoPath: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function runPnpm(repoPath: string, script: "test" | "typecheck" | "lint" | "acceptance"): void {
  execFileSync("pnpm", ["--dir", repoPath, script], { encoding: "utf8", stdio: "pipe" });
}

afterEach(() => {
  delete process.env.AVITY_CONFIG;
  delete process.env.AVITY_DISABLE_KEYCHAIN;
});

describe("external live fixture generator", () => {
  it("creates an autonomous fixture repository with source, tests, lint, and acceptance checks", () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "live-fixture");
    const result = createExternalLiveFixture({ path: fixturePath });

    expect(result.path).toBe(fixturePath);
    expect(result.branch).toBe("main");
    expect(existsSync(join(fixturePath, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(fixturePath, "test", "objectives.test.ts"))).toBe(true);
    expect(existsSync(join(fixturePath, "scripts", "lint.mjs"))).toBe(true);
    expect(existsSync(join(fixturePath, "scripts", "acceptance.mjs"))).toBe(true);
    expect(existsSync(join(fixturePath, "src", "solution.js"))).toBe(true);
    expect(existsSync(join(fixturePath, "package.json"))).toBe(true);
    expect(runGit(fixturePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(runGit(fixturePath, ["status", "--porcelain"])).toBe("");
    expect(runGit(fixturePath, ["log", "-1", "--pretty=%s"])).toBe("chore: initialize live e2e fixture");

    const pkg = JSON.parse(readFileSync(join(fixturePath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.lint).toBe("node scripts/lint.mjs");
    expect(pkg.scripts?.typecheck).toBe("node scripts/lint.mjs");
    expect(pkg.scripts?.acceptance).toBe("node scripts/acceptance.mjs");
    expect(pkg.scripts?.publish).toBeUndefined();
    expect(pkg.scripts?.prepublishOnly).toBeUndefined();
    expect(pkg.scripts?.prepare).toBeUndefined();

    const readme = readFileSync(join(fixturePath, "README.md"), "utf8");
    expect(readme).toContain("Mission normale");
    expect(readme).toContain("Mission rejet/correction");
    expect(readme).toContain("pnpm lint");
    expect(readme).toContain("pnpm acceptance");
    expect(readme).toContain("pnpm test");
    expect(readme).toContain("pnpm typecheck");
    expect(readme).toContain("src/solution.js");

    runPnpm(fixturePath, "test");
    runPnpm(fixturePath, "lint");
    runPnpm(fixturePath, "acceptance");
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

  it("rolls back only newly created directory when a post-mkdir git step fails", () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "rollback-on-failure");
    const failingRunner: FixtureCommandRunner = {
      run(command, args, options) {
        const rendered = `${command} ${args.join(" ")}`;
        if (rendered.includes(" commit ")) {
          return { exitCode: 1, stdout: "", stderr: "simulated commit failure" };
        }
        return {
          exitCode: 0,
          stdout: execFileSync(command, [...args], {
            cwd: options?.cwd,
            env: options?.env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
          stderr: "",
        };
      },
    };

    expect(() => createExternalLiveFixture({ path: fixturePath }, { commandRunner: failingRunner })).toThrow(/commit failure/);
    expect(existsSync(fixturePath)).toBe(false);
  });

  it("fails acceptance on defective correction implementation then passes after fix", () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "acceptance-fixture");
    createExternalLiveFixture({ path: fixturePath });

    const brokenPath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "acceptance-broken");
    cpSync(fixturePath, brokenPath, { recursive: true });
    writeFileSync(
      join(brokenPath, "src", "solution.js"),
      "export function formatCorrectionSummary(input) {\n  return `FIX: ${input.summary}`;\n}\n",
      "utf8",
    );
    expect(() => runPnpm(brokenPath, "acceptance")).toThrow();

    writeFileSync(
      join(brokenPath, "src", "solution.js"),
      "export function formatCorrectionSummary(input) {\n  const issueId = String(input.issueId ?? '').trim();\n  const summary = String(input.summary ?? '').trim();\n  return `FIX: ${issueId} ${summary}`.trim();\n}\n",
      "utf8",
    );
    runPnpm(brokenPath, "acceptance");
  });

  it("exposes the CLI command without breaking e2e preflight route", async () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), "avity-fixture-parent-")), "cli-fixture");

    const fixtureExitCode = await main(["e2e", "fixture", "create", "--path", fixturePath, "--json"]);
    expect(fixtureExitCode).toBe(0);

    const preflightExitCode = await main(["e2e", "preflight"]);
    expect(preflightExitCode).toBe(1);
  });
});
