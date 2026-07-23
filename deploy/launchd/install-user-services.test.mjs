#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PLACEHOLDERS,
  assertNoSecretsInPlist,
  escapeXml,
  installUserServices,
  isOwnerOnlyMode,
  renderPlistTemplate,
} from "./install-user-services.mjs";

test("escapeXml escapes plist-sensitive characters", () => {
  assert.equal(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

test("renderPlistTemplate replaces placeholders and escapes XML", () => {
  const rendered = renderPlistTemplate(
    `<string>${PLACEHOLDERS.AVITY_ROOT}/deploy &amp; launch</string>`,
    {
      avityRoot: `/Users/op/AvityOS & Co`,
      avityLogDir: `/Users/op/.avity/logs`,
      home: `/Users/op`,
    },
  );
  assert.match(rendered, /\/Users\/op\/AvityOS &amp; Co\/deploy &amp; launch/);
  assert.doesNotMatch(rendered, /__AVITY_/);
});

test("assertNoSecretsInPlist rejects obvious secret markers", () => {
  assert.throws(() => assertNoSecretsInPlist("<string>ghp_abc</string>"), /forbidden secret marker/);
});

test("installUserServices writes owner-only log dir and chmod-644 plists", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "avity-launchd-"));
  const home = join(tempRoot, "home");
  const repo = join(tempRoot, "repo");
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(repo, "deploy", "launchd"), { recursive: true });

  const template = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>WorkingDirectory</key><string>${PLACEHOLDERS.AVITY_ROOT}</string>
  <key>StandardOutPath</key><string>${PLACEHOLDERS.AVITY_LOG_DIR}/out.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>AVITY_ENV_FILE</key><string>${PLACEHOLDERS.HOME}/.config/avityos/control-plane.env</string>
  </dict>
</dict></plist>`;
  writeFileSync(join(repo, "deploy", "launchd", "com.avityos.control-plane.plist.example"), template);
  writeFileSync(join(repo, "deploy", "launchd", "com.avityos.worker.plist.example"), template);
  writeFileSync(join(repo, "deploy", "launchd", "env.example"), "AVITY_ROOT=/tmp/example\n");

  const result = installUserServices({
    repositoryRoot: repo,
    home,
    launchAgentsDir,
    templateDir: join(repo, "deploy", "launchd"),
    seedEnvExamples: true,
  });

  assert.equal(result.written.length, 2);
  const plist = readFileSync(join(launchAgentsDir, "com.avityos.control-plane.plist"), "utf8");
  assert.match(plist, new RegExp(`<string>${repo.replaceAll("&", "&amp;")}</string>`));
  assert.match(plist, /<string>.*\/\.config\/avityos\/control-plane\.env<\/string>/);
  assert.doesNotMatch(plist, /__AVITY_/);
  assert.doesNotMatch(plist, /ghp_|API_KEY|TOKEN=/);

  const logDirStat = statSync(join(home, ".avity", "logs"));
  assert.equal(logDirStat.mode & 0o777, 0o700);

  for (const path of result.written) {
    const plistStat = statSync(path);
    assert.equal(plistStat.mode & 0o777, 0o644);
  }

  for (const envPath of result.envExamples) {
    assert.ok(isOwnerOnlyMode(envPath));
    const contents = readFileSync(envPath, "utf8");
    assert.match(contents, /AVITY_ROOT=/);
  }

  rmSync(tempRoot, { recursive: true, force: true });
});

test("installUserServices dry-run does not write files", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "avity-launchd-dry-"));
  const home = join(tempRoot, "home");
  const repo = join(tempRoot, "repo");
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(repo, "deploy", "launchd"), { recursive: true });
  const template = `<string>${PLACEHOLDERS.AVITY_ROOT}</string>`;
  writeFileSync(join(repo, "deploy", "launchd", "com.avityos.control-plane.plist.example"), template);
  writeFileSync(join(repo, "deploy", "launchd", "com.avityos.worker.plist.example"), template);
  writeFileSync(join(repo, "deploy", "launchd", "env.example"), "# example\n");

  const result = installUserServices({
    repositoryRoot: repo,
    home,
    launchAgentsDir,
    templateDir: join(repo, "deploy", "launchd"),
    dryRun: true,
    seedEnvExamples: false,
  });

  assert.equal(result.written.length, 2);
  assert.throws(() => readFileSync(join(launchAgentsDir, "com.avityos.control-plane.plist")), Error);
  rmSync(tempRoot, { recursive: true, force: true });
});
