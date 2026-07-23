import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve, join } from "node:path";

export interface FixtureCreateOptions {
  readonly path: string;
  readonly remote?: string;
}

export interface FixtureCreateResult {
  readonly path: string;
  readonly branch: "main";
  readonly remote: string | null;
}

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

interface GitRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function runGit(args: readonly string[], options?: GitRunOptions): string {
  try {
    return execFileSync("git", [...args], {
      cwd: options?.cwd,
      env: options?.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const details = error as { stderr?: string; message?: string };
    const stderr = typeof details.stderr === "string" ? details.stderr.trim() : "";
    throw new FixtureError(`git command failed (${args.join(" ")}): ${stderr || details.message || "unknown error"}`);
  }
}

function validateGitHubRemote(remote: string): string {
  const trimmed = remote.trim();
  const httpsPattern = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
  const sshPattern = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
  if (!httpsPattern.test(trimmed) && !sshPattern.test(trimmed)) {
    throw new FixtureError(`remote must target GitHub (received: ${remote})`);
  }
  return trimmed;
}

function ensurePathIsCreatable(targetPath: string): void {
  if (existsSync(targetPath)) {
    throw new FixtureError(`fixture path already exists: ${targetPath}`);
  }
  const parent = resolve(targetPath, "..");
  mkdirSync(parent, { recursive: true });
  const parentEntries = readdirSync(parent);
  if (!parentEntries.includes(basename(targetPath))) {
    return;
  }
  throw new FixtureError(`fixture path already exists: ${targetPath}`);
}

function writeFixtureFiles(repoPath: string): void {
  mkdirSync(join(repoPath, "src"), { recursive: true });
  mkdirSync(join(repoPath, "test"), { recursive: true });
  mkdirSync(join(repoPath, "scripts"), { recursive: true });

  writeFileSync(
    join(repoPath, "package.json"),
    `${JSON.stringify({
      name: "avity-live-e2e-fixture",
      private: true,
      version: "0.0.1",
      type: "module",
      scripts: {
        test: "node --test test/objectives.test.js",
        typecheck: "node scripts/typecheck.mjs",
      },
    }, null, 2)}\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        strict: true,
      },
      include: ["src"],
    }, null, 2)}\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "src", "index.ts"),
    `export interface LiveObjective {\n  readonly mission: "normal" | "correction";\n  readonly title: string;\n  readonly acceptanceCriteria: readonly string[];\n}\n\nexport function listObjectives(): readonly LiveObjective[] {\n  return [\n    {\n      mission: "normal",\n      title: "Mission normale",\n      acceptanceCriteria: [\n        "Feature complete avec tests et preuve de validation",\n        "Aucune publication automatique ni push déclenché",\n      ],\n    },\n    {\n      mission: "correction",\n      title: "Mission rejet/correction",\n      acceptanceCriteria: [\n        "Corriger les retours reviewer sans changer le scope",\n        "Conserver l'historique local et fournir revalidation tests/typecheck",\n      ],\n    },\n  ] as const;\n}\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "src", "index.js"),
    `export function listObjectives() {\n  return [\n    {\n      mission: "normal",\n      title: "Mission normale",\n      acceptanceCriteria: [\n        "Feature complete avec tests et preuve de validation",\n        "Aucune publication automatique ni push declenche",\n      ],\n    },\n    {\n      mission: "correction",\n      title: "Mission rejet/correction",\n      acceptanceCriteria: [\n        "Corriger les retours reviewer sans changer le scope",\n        "Conserver l'historique local et fournir revalidation tests/typecheck",\n      ],\n    },\n  ];\n}\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "test", "objectives.test.js"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\n\nimport { listObjectives } from "../src/index.js";\n\ntest("fixture objectives cover normal and correction missions", () => {\n  const objectives = listObjectives();\n  assert.equal(objectives.length, 2);\n  assert.deepEqual(objectives.map((item) => item.mission), ["normal", "correction"]);\n  for (const objective of objectives) {\n    assert.ok(objective.title.length > 0);\n    assert.ok(objective.acceptanceCriteria.length >= 2);\n  }\n});\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "test", "objectives.test.ts"),
    `import { strict as assert } from "node:assert";\nimport test from "node:test";\n\nimport { listObjectives } from "../src/index.js";\n\ntest("fixture objectives cover normal and correction missions", () => {\n  const objectives = listObjectives();\n  assert.deepEqual(objectives.map((item) => item.mission), ["normal", "correction"]);\n  for (const objective of objectives) {\n    assert.ok(objective.title.length > 0);\n    assert.ok(objective.acceptanceCriteria.length >= 2);\n  }\n});\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "scripts", "typecheck.mjs"),
    `import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\n\nconst source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");\nassert.ok(source.includes("export interface LiveObjective"), "LiveObjective interface missing");\nassert.ok(source.includes("export function listObjectives"), "listObjectives export missing");\nassert.ok(source.includes("mission: \\"normal\\""), "normal mission missing");\nassert.ok(source.includes("mission: \\"correction\\""), "correction mission missing");\n`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(repoPath, "README.md"),
    `# Avity Live E2E Fixture\n\nDepot fixture local pour campagne live, autonome et sans dependance externe.\n\n## Objectifs\n\n### Mission normale\n- Executer \`pnpm test\` puis \`pnpm typecheck\`.\n- Livrer une preuve locale sans push automatique.\n\n### Mission rejet/correction\n- Simuler un rejet reviewer, corriger localement, puis rerun \`pnpm test\` et \`pnpm typecheck\`.\n- Conserver un historique Git local propre et verifiable.\n\n## Contraintes\n- Aucune publication automatique (\`publish\`, \`prepublishOnly\`, \`prepare\` absents).\n- Aucun provider reel ni secret requis.\n- Usage exclusivement local.\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, ".gitignore"),
    "node_modules/\npnpm-lock.yaml\n",
    { mode: 0o644 },
  );
}

function initializeGitRepository(repoPath: string, remote: string | undefined): void {
  runGit(["init", "-b", "main", repoPath]);
  runGit(["-C", repoPath, "config", "--local", "user.email", "fixture-bot@example.invalid"]);
  runGit(["-C", repoPath, "config", "--local", "user.name", "Avity Fixture Bot"]);
  runGit(["-C", repoPath, "config", "--local", "commit.gpgSign", "false"]);
  runGit(["-C", repoPath, "config", "--local", "core.hooksPath", ".git/hooks-disabled"]);
  mkdirSync(join(repoPath, ".git", "hooks-disabled"), { recursive: true });
  runGit(["-C", repoPath, "add", "."]);
  runGit(["-C", repoPath, "commit", "--no-gpg-sign", "-m", "chore: initialize live e2e fixture"], {
    env: { ...process.env, HUSKY: "0" },
  });
  if (remote) {
    runGit(["-C", repoPath, "remote", "add", "origin", remote]);
  }
}

export function createExternalLiveFixture(options: FixtureCreateOptions): FixtureCreateResult {
  const targetPath = resolve(options.path);
  ensurePathIsCreatable(targetPath);
  const remote = options.remote ? validateGitHubRemote(options.remote) : undefined;
  mkdirSync(targetPath, { recursive: true, mode: 0o755 });
  writeFixtureFiles(targetPath);
  initializeGitRepository(targetPath, remote);
  return {
    path: targetPath,
    branch: "main",
    remote: remote ?? null,
  };
}
