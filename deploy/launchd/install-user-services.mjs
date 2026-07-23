#!/usr/bin/env node
/**
 * Generate user LaunchAgent plists from AvityOS templates without manual placeholder editing.
 * Secrets stay in external chmod-600 env files referenced by the plists — never embedded here.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLACEHOLDERS = Object.freeze({
  AVITY_ROOT: "__AVITY_ROOT__",
  AVITY_LOG_DIR: "__AVITY_LOG_DIR__",
  HOME: "__HOME__",
});

export const TEMPLATE_FILES = Object.freeze([
  "com.avityos.control-plane.plist.example",
  "com.avityos.worker.plist.example",
]);

const SECRET_KEY_PATTERN =
  /(?:^|[^A-Z0-9_])(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)(?:[^A-Z0-9_]|$)/i;

/**
 * Escape a string for safe inclusion in plist XML text nodes.
 * @param {string} value
 * @returns {string}
 */
export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Replace known placeholders with XML-escaped absolute paths.
 * @param {string} template
 * @param {{ avityRoot: string; avityLogDir: string; home: string }} paths
 * @returns {string}
 */
export function renderPlistTemplate(template, paths) {
  const replacements = {
    [PLACEHOLDERS.AVITY_ROOT]: escapeXml(paths.avityRoot),
    [PLACEHOLDERS.AVITY_LOG_DIR]: escapeXml(paths.avityLogDir),
    [PLACEHOLDERS.HOME]: escapeXml(paths.home),
  };
  let rendered = template;
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, replacement);
  }
  if (Object.values(PLACEHOLDERS).some((placeholder) => rendered.includes(placeholder))) {
    throw new Error("plist template still contains unresolved placeholders after rendering");
  }
  return rendered;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isOwnerOnlyMode(path) {
  try {
    const mode = statSync(path).mode & 0o777;
    return (mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} rendered
 */
export function assertNoSecretsInPlist(rendered) {
  if (SECRET_KEY_PATTERN.test(rendered)) {
    throw new Error("rendered plist appears to contain secret key names; secrets must stay in env files");
  }
  for (const marker of ["sk-", "ghp_", "gho_", "github_pat_", "Bearer "]) {
    if (rendered.includes(marker)) {
      throw new Error(`rendered plist contains forbidden secret marker: ${marker}`);
    }
  }
}

/**
 * @param {{
 *   repositoryRoot?: string;
 *   home?: string;
 *   logDir?: string;
 *   launchAgentsDir?: string;
 *   templateDir?: string;
 *   dryRun?: boolean;
 *   seedEnvExamples?: boolean;
 * }} [options]
 * @returns {{
 *   avityRoot: string;
 *   avityLogDir: string;
 *   home: string;
 *   launchAgentsDir: string;
 *   written: string[];
 *   envExamples: string[];
 * }}
 */
export function installUserServices(options = {}) {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const avityRoot = resolve(options.repositoryRoot ?? join(moduleDir, "..", ".."));
  const home = resolve(options.home ?? homedir());
  const avityLogDir = resolve(options.logDir ?? join(home, ".avity", "logs"));
  const launchAgentsDir = resolve(options.launchAgentsDir ?? join(home, "Library", "LaunchAgents"));
  const templateDir = resolve(options.templateDir ?? moduleDir);
  const dryRun = options.dryRun === true;
  const seedEnvExamples = options.seedEnvExamples !== false;

  if (!existsSync(avityRoot)) {
    throw new Error(`repository root does not exist: ${avityRoot}`);
  }

  const paths = { avityRoot, avityLogDir, home };
  const written = [];
  const envExamples = [];

  if (!dryRun) {
    mkdirSync(launchAgentsDir, { recursive: true, mode: 0o700 });
    mkdirSync(avityLogDir, { recursive: true, mode: 0o700 });
    chmodSync(launchAgentsDir, 0o700);
    chmodSync(avityLogDir, 0o700);
  }

  for (const templateName of TEMPLATE_FILES) {
    const templatePath = join(templateDir, templateName);
    if (!existsSync(templatePath)) {
      throw new Error(`missing plist template: ${templatePath}`);
    }
    const template = readFileSync(templatePath, "utf8");
    const rendered = renderPlistTemplate(template, paths);
    assertNoSecretsInPlist(rendered);
    const outputName = templateName.replace(/\.example$/, "");
    const outputPath = join(launchAgentsDir, outputName);
    if (!dryRun) {
      writeFileSync(outputPath, rendered, { encoding: "utf8", mode: 0o644 });
      chmodSync(outputPath, 0o644);
    }
    written.push(outputPath);
  }

  if (seedEnvExamples && !dryRun) {
    const configDir = join(home, ".config", "avityos");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    chmodSync(configDir, 0o700);
    const envExamplePath = join(templateDir, "env.example");
    if (!existsSync(envExamplePath)) {
      throw new Error(`missing env example: ${envExamplePath}`);
    }
    for (const targetName of ["control-plane.env", "worker.env"]) {
      const targetPath = join(configDir, targetName);
      if (existsSync(targetPath)) {
        if (!isOwnerOnlyMode(targetPath)) {
          chmodSync(targetPath, 0o600);
        }
        continue;
      }
      copyFileSync(envExamplePath, targetPath);
      chmodSync(targetPath, 0o600);
      envExamples.push(targetPath);
    }
  }

  return {
    avityRoot,
    avityLogDir,
    home,
    launchAgentsDir,
    written,
    envExamples,
  };
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  return {
    dryRun: flags.has("--dry-run"),
    noSeedEnv: flags.has("--no-seed-env"),
    repositoryRoot: positional[0],
    help: flags.has("--help") || flags.has("-h"),
  };
}

function printUsage() {
  console.log(`usage: node deploy/launchd/install-user-services.mjs [repository-root] [--dry-run] [--no-seed-env]

Generate ~/Library/LaunchAgents/com.avityos.*.plist from templates.
Secrets belong in ~/.config/avityos/*.env (chmod 600), never in plists.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }
  const result = installUserServices({
    ...(args.repositoryRoot ? { repositoryRoot: args.repositoryRoot } : {}),
    dryRun: args.dryRun,
    seedEnvExamples: !args.noSeedEnv,
  });
  for (const path of result.written) {
    console.log(args.dryRun ? `would write ${path}` : `wrote ${path}`);
  }
  for (const path of result.envExamples) {
    console.log(`seeded env example ${path} (chmod 600)`);
  }
  console.log("next: edit ~/.config/avityos/*.env, chmod 600, plutil -lint, launchctl bootstrap");
  return 0;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
