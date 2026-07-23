import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface FixtureCreateOptions {
  readonly path: string;
  readonly remote?: string;
}

export interface FixtureCreateResult {
  readonly path: string;
  readonly branch: "main";
  readonly remote: string | null;
}

export interface FixtureCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FixtureCommandRunner {
  run(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }): FixtureCommandResult;
}

export interface FixtureDependencies {
  readonly commandRunner?: FixtureCommandRunner;
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

const defaultCommandRunner: FixtureCommandRunner = {
  run(command, args, options) {
    try {
      const stdout = execFileSync(command, [...args], {
        cwd: options?.cwd,
        env: options?.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (error) {
      const details = error as { status?: number; stdout?: string; stderr?: string };
      return {
        exitCode: details.status ?? 1,
        stdout: details.stdout ?? "",
        stderr: details.stderr ?? "",
      };
    }
  },
};

function runGit(
  commandRunner: FixtureCommandRunner,
  args: readonly string[],
  options?: GitRunOptions,
): string {
  const result = commandRunner.run("git", [...args], options);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new FixtureError(`git command failed (git ${args.join(" ")}): ${stderr || `exit code ${result.exitCode}`}`);
  }
  return result.stdout.trim();
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
  mkdirSync(resolve(targetPath, ".."), { recursive: true });
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
        lint: "node scripts/lint.mjs",
        typecheck: "node scripts/lint.mjs",
        acceptance: "node scripts/acceptance.mjs",
      },
    }, null, 2)}\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "src", "objectives.ts"),
    `export interface LiveObjective {\n  readonly mission: "normal" | "correction";\n  readonly title: string;\n  readonly acceptanceCriteria: readonly string[];\n}\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "src", "index.ts"),
    `export interface LiveObjective {\n  readonly mission: "normal" | "correction";\n  readonly title: string;\n  readonly acceptanceCriteria: readonly string[];\n}\n\nexport function listObjectives(): readonly LiveObjective[] {\n  return [\n    {\n      mission: "normal",\n      title: "Mission normale",\n      acceptanceCriteria: ["Feature complete avec preuves", "Aucune publication automatique ni push declenche"],\n    },\n    {\n      mission: "correction",\n      title: "Mission rejet/correction",\n      acceptanceCriteria: [\n        "Corriger une implementation rejetee sans changer le scope",\n        "Retablir l'invariant: sortie EXACTE 'FIX: INC-<digits> <summary>'",\n      ],\n    },\n  ] as const;\n}\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "src", "index.js"),
    `export function listObjectives() {\n  return [\n    {\n      mission: "normal",\n      title: "Mission normale",\n      acceptanceCriteria: [\n        "Feature complete avec preuves",\n        "Aucune publication automatique ni push declenche",\n      ],\n    },\n    {\n      mission: "correction",\n      title: "Mission rejet/correction",\n      acceptanceCriteria: [\n        "Corriger une implementation rejetee sans changer le scope",\n        "Retablir l'invariant: sortie EXACTE 'FIX: INC-<digits> <summary>'",\n      ],\n    },\n  ];\n}\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "src", "solution.js"),
    `export function formatCorrectionSummary(input) {\n  const issueId = String(input.issueId ?? "").trim();\n  const summary = String(input.summary ?? "").trim();\n  if (!/^INC-\\d+$/.test(issueId)) {\n    throw new Error("issueId must match INC-<digits>");\n  }\n  if (!summary) {\n    throw new Error("summary must be non-empty");\n  }\n  return \`FIX: \${issueId} \${summary}\`;\n}\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "test", "objectives.test.js"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\n\nimport { listObjectives } from "../src/index.js";\nimport { formatCorrectionSummary } from "../src/solution.js";\n\ntest("fixture objectives cover normal and correction missions", () => {\n  const objectives = listObjectives();\n  assert.equal(objectives.length, 2);\n  assert.deepEqual(objectives.map((item) => item.mission), ["normal", "correction"]);\n  for (const objective of objectives) {\n    assert.ok(objective.title.length > 0);\n    assert.ok(objective.acceptanceCriteria.length >= 2);\n  }\n});\n\ntest("default correction implementation satisfies acceptance invariant", () => {\n  assert.equal(\n    formatCorrectionSummary({ issueId: "INC-404", summary: "retry worker bootstrap" }),\n    "FIX: INC-404 retry worker bootstrap",\n  );\n});\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "test", "objectives.test.ts"),
    `import { strict as assert } from "node:assert";\nimport test from "node:test";\n\nimport { listObjectives } from "../src/index.js";\n\ntest("fixture objectives cover normal and correction missions", () => {\n  const objectives = listObjectives();\n  assert.deepEqual(objectives.map((item) => item.mission), ["normal", "correction"]);\n  for (const objective of objectives) {\n    assert.ok(objective.title.length > 0);\n    assert.ok(objective.acceptanceCriteria.length >= 2);\n  }\n});\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, "scripts", "lint.mjs"),
    `import { execFileSync } from "node:child_process";\n\nconst files = ["src/index.js", "src/solution.js", "test/objectives.test.js", "scripts/acceptance.mjs"];\nfor (const file of files) {\n  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });\n}\n`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(repoPath, "scripts", "acceptance.mjs"),
    `import assert from "node:assert/strict";\nimport { formatCorrectionSummary } from "../src/solution.js";\n\nconst actual = formatCorrectionSummary({ issueId: "INC-404", summary: "retry worker bootstrap" });\nassert.equal(actual, "FIX: INC-404 retry worker bootstrap");\n`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(repoPath, "README.md"),
    `# Avity Live E2E Fixture\n\nDepot fixture local pour campagne live, autonome et sans dependance externe.\n\n## Objectifs\n\n### Mission normale\n- Executer \`pnpm test\`, \`pnpm lint\`, puis \`pnpm acceptance\`.\n- Conserver \`pnpm typecheck\` comme alias de lint syntaxique Node (pas de verification TypeScript semantique).\n- Livrer une preuve locale sans push automatique.\n\n### Mission rejet/correction\n- Le check d'acceptation exige exactement: \`FIX: INC-<digits> <summary>\`.\n- Pour provoquer un rejet deterministe, corriger \`src/solution.js\` de facon defectueuse (ex: omettre \`issueId\`) puis lancer \`pnpm acceptance\`.\n- Corriger ensuite \`src/solution.js\` pour retablir l'invariant, puis relancer \`pnpm acceptance\`, \`pnpm test\` et \`pnpm lint\`.\n\n## Contraintes\n- Aucune publication automatique (\`publish\`, \`prepublishOnly\`, \`prepare\` absents).\n- Aucun provider reel ni secret requis.\n- Usage exclusivement local.\n`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(repoPath, ".gitignore"),
    "node_modules/\npnpm-lock.yaml\n",
    { mode: 0o644 },
  );
}

function initializeGitRepository(
  repoPath: string,
  remote: string | undefined,
  commandRunner: FixtureCommandRunner,
): void {
  runGit(commandRunner, ["init", "-b", "main", repoPath]);
  runGit(commandRunner, ["-C", repoPath, "config", "--local", "user.email", "fixture-bot@example.invalid"]);
  runGit(commandRunner, ["-C", repoPath, "config", "--local", "user.name", "Avity Fixture Bot"]);
  runGit(commandRunner, ["-C", repoPath, "config", "--local", "commit.gpgSign", "false"]);
  runGit(commandRunner, ["-C", repoPath, "config", "--local", "core.hooksPath", ".git/hooks-disabled"]);
  mkdirSync(join(repoPath, ".git", "hooks-disabled"), { recursive: true });
  runGit(commandRunner, ["-C", repoPath, "add", "."]);
  runGit(commandRunner, ["-C", repoPath, "commit", "--no-gpg-sign", "-m", "chore: initialize live e2e fixture"], {
    env: { ...process.env, HUSKY: "0" },
  });
  if (remote) {
    runGit(commandRunner, ["-C", repoPath, "remote", "add", "origin", remote]);
  }
}

function rollbackNewDirectory(targetPath: string): void {
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }
}

export function createExternalLiveFixture(
  options: FixtureCreateOptions,
  dependencies?: FixtureDependencies,
): FixtureCreateResult {
  const commandRunner = dependencies?.commandRunner ?? defaultCommandRunner;
  const targetPath = resolve(options.path);
  ensurePathIsCreatable(targetPath);
  const remote = options.remote ? validateGitHubRemote(options.remote) : undefined;
  let createdByInvocation = false;
  try {
    mkdirSync(targetPath, { recursive: false, mode: 0o755 });
    createdByInvocation = true;
    writeFixtureFiles(targetPath);
    initializeGitRepository(targetPath, remote, commandRunner);
    return {
      path: targetPath,
      branch: "main",
      remote: remote ?? null,
    };
  } catch (error) {
    if (createdByInvocation) {
      rollbackNewDirectory(targetPath);
    }
    if (error instanceof FixtureError) {
      throw error;
    }
    throw new FixtureError(error instanceof Error ? error.message : "fixture generation failed");
  }
}
