import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_SANDBOX_POLICY,
  CODEX_SANDBOX_POLICY,
  CURSOR_SANDBOX_POLICY,
  CommandProviderAdapter,
  resolveCliProviderAuth,
  resolveCommandProviderAuth,
} from "./index.js";
import type { RunEvent } from "./types.js";

async function drain(events: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

const SANDBOX_AVAILABLE =
  (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) ||
  (process.platform === "linux" && ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].some(existsSync));

describe("CLI provider sandbox auth policies", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  it("codex policy forwards only CODEX_API_KEY and not other providers' secrets", () => {
    const resolved = resolveCliProviderAuth(CODEX_SANDBOX_POLICY, {
      CODEX_API_KEY: "codex-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      CURSOR_API_KEY: "cursor-secret",
      OPENAI_API_KEY: "openai-secret",
    });
    expect(resolved.authenticated).toBe(true);
    expect(resolved.env).toEqual({ CODEX_API_KEY: "codex-secret" });
    expect(resolved.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(resolved.env).not.toHaveProperty("CURSOR_API_KEY");
    expect(resolved.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(resolved.credentialFiles).toEqual([]);
    expect(CODEX_SANDBOX_POLICY.allowNetwork).toBe(true);
  });

  it("codex policy stages only ~/.codex/auth.json when no env key is present", () => {
    const home = mkdtempSync(join(tmpdir(), "avity-codex-home-"));
    homes.push(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    const auth = join(home, ".codex", "auth.json");
    writeFileSync(auth, '{"tokens":{}}\n', { mode: 0o600 });

    const resolved = resolveCliProviderAuth(
      CODEX_SANDBOX_POLICY,
      { ANTHROPIC_API_KEY: "should-not-leak" },
      { realHome: home },
    );
    expect(resolved.authenticated).toBe(true);
    expect(resolved.env).toEqual({});
    expect(resolved.credentialFiles).toEqual([
      { sourcePath: auth, homeRelativePath: ".codex/auth.json", readonly: true },
    ]);
  });

  it("claude-code policy forwards only ANTHROPIC_API_KEY", () => {
    const resolved = resolveCliProviderAuth(CLAUDE_CODE_SANDBOX_POLICY, {
      ANTHROPIC_API_KEY: "claude-secret",
      CODEX_API_KEY: "codex-secret",
      CURSOR_API_KEY: "cursor-secret",
    });
    expect(resolved.authenticated).toBe(true);
    expect(resolved.env).toEqual({ ANTHROPIC_API_KEY: "claude-secret" });
    expect(resolved.credentialFiles).toEqual([]);
  });

  it("claude-code policy stages only .claude/.credentials.json when present", () => {
    const home = mkdtempSync(join(tmpdir(), "avity-claude-home-"));
    homes.push(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    const creds = join(home, ".claude", ".credentials.json");
    writeFileSync(creds, '{"claudeAiOauth":{}}\n', { mode: 0o600 });

    const resolved = resolveCliProviderAuth(CLAUDE_CODE_SANDBOX_POLICY, {}, { realHome: home });
    expect(resolved.authenticated).toBe(true);
    expect(resolved.credentialFiles[0]?.homeRelativePath).toBe(".claude/.credentials.json");
  });

  it("cursor policy forwards only CURSOR_API_KEY and never stages unrelated HOME files", () => {
    const home = mkdtempSync(join(tmpdir(), "avity-cursor-home-"));
    homes.push(home);
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".cursor", "cli-config.json"), '{"authInfo":{}}\n');
    writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE\n");

    const resolved = resolveCliProviderAuth(
      CURSOR_SANDBOX_POLICY,
      { CURSOR_API_KEY: "cursor-secret", CODEX_API_KEY: "nope" },
      { realHome: home },
    );
    expect(resolved.authenticated).toBe(true);
    expect(resolved.env).toEqual({ CURSOR_API_KEY: "cursor-secret" });
    expect(resolved.credentialFiles).toEqual([]);
  });

  it("returns a clear auth error when required credentials are absent", () => {
    const home = mkdtempSync(join(tmpdir(), "avity-empty-home-"));
    homes.push(home);
    const resolved = resolveCliProviderAuth(CURSOR_SANDBOX_POLICY, {}, { realHome: home });
    expect(resolved.authenticated).toBe(false);
    expect(resolved.reason).toMatch(/not authenticated/);
    expect(resolved.reason).toMatch(/CURSOR_API_KEY/);
  });

  it("returns a clear error when a credential file exists but is unreadable", () => {
    const home = mkdtempSync(join(tmpdir(), "avity-unreadable-"));
    homes.push(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    const auth = join(home, ".codex", "auth.json");
    writeFileSync(auth, "secret\n", { mode: 0o600 });
    // Simulate unreadable by pointing the policy at a path we revoke after create.
    chmodSync(auth, 0o000);

    let resolved;
    try {
      resolved = resolveCliProviderAuth(CODEX_SANDBOX_POLICY, {}, { realHome: home });
    } finally {
      chmodSync(auth, 0o600);
    }
    // On some hosts the owner can still read mode 000; accept either unreadable
    // or authenticated-via-file, but never a silent empty success without material.
    if (!resolved.authenticated) {
      expect(resolved.reason).toMatch(/unreadable|not authenticated/);
    } else {
      expect(resolved.credentialFiles.length).toBe(1);
    }
  });

  it("command policy forwards only the explicit allowlist", () => {
    const resolved = resolveCommandProviderAuth({
      AVITY_COMMAND_ENV_ALLOWLIST: "MY_AGENT_TOKEN,OTHER",
      MY_AGENT_TOKEN: "t1",
      OTHER: "t2",
      CODEX_API_KEY: "should-not-leak",
      ANTHROPIC_API_KEY: "should-not-leak",
      AVITY_COMMAND_ALLOW_NETWORK: "1",
    });
    expect(resolved.env).toEqual({ MY_AGENT_TOKEN: "t1", OTHER: "t2" });
    expect(resolved.policy.allowNetwork).toBe(true);
    expect(resolved.credentialFiles).toEqual([]);
  });
});

describe("CommandProviderAdapter auth fail-closed", () => {
  it("emits a clear auth error and does not spawn when authError is set", async () => {
    const adapter = new CommandProviderAdapter("cursor", {
      executable: "cursor-agent",
      args: ["--version"],
      authError: "cursor is not authenticated for sandboxed execution",
    });
    expect(await adapter.healthy()).toBe(false);
    const events = await drain(
      adapter.startRun({ runId: "r", model: "default", systemPrompt: "", userPrompt: "" }).events,
    );
    expect(events).toEqual([
      {
        type: "error",
        category: "auth",
        message: "cursor is not authenticated for sandboxed execution",
      },
    ]);
  });
});

describe.skipIf(!SANDBOX_AVAILABLE)("CommandProviderAdapter credential exposure", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("exposes only staged credentials inside throwaway HOME, not the real HOME", async () => {
    const host = mkdtempSync(join(tmpdir(), "avity-stage-host-"));
    dirs.push(host);
    const ws = mkdtempSync(join(tmpdir(), "avity-stage-ws-"));
    dirs.push(ws);
    mkdirSync(join(host, ".codex"), { recursive: true });
    const auth = join(host, ".codex", "auth.json");
    writeFileSync(auth, '{"ok":true}\n', { mode: 0o600 });
    const canary = join(homedir(), ".avity-cli-auth-canary-should-not-exist");

    const adapter = new CommandProviderAdapter("codex", {
      executable: "node",
      args: [
        "-e",
        [
          "const fs=require('fs');",
          "const path=require('path');",
          "const home=process.env.HOME;",
          "const staged=path.join(home,'.codex','auth.json');",
          "const mode=fs.statSync(staged).mode & 0o777;",
          "const body=fs.readFileSync(staged,'utf8');",
          "let realCanary='missing';",
          `try{realCanary=fs.readFileSync(${JSON.stringify(canary)},'utf8')}catch(e){realCanary='blocked'}`,
          "console.log(JSON.stringify({home,mode,body:body.trim(),realCanary,hasCodexEnv:!!process.env.CODEX_API_KEY,hasAnthropic:!!process.env.ANTHROPIC_API_KEY}));",
        ].join(""),
      ],
      env: { CODEX_API_KEY: "only-codex" },
      credentialFiles: [{ sourcePath: auth, homeRelativePath: ".codex/auth.json", readonly: true }],
      allowNetwork: false,
    });

    const events = await drain(
      adapter.startRun({ runId: "r", model: "default", systemPrompt: "", userPrompt: "", cwd: ws }).events,
    );
    const completed = events.find((e) => e.type === "completed") as { resultText: string } | undefined;
    expect(completed).toBeDefined();
    const payload = JSON.parse(completed!.resultText) as {
      home: string;
      mode: number;
      body: string;
      realCanary: string;
      hasCodexEnv: boolean;
      hasAnthropic: boolean;
    };
    expect(payload.home).not.toBe(homedir());
    expect(payload.home).toContain("avity-sandbox-home-");
    expect(payload.mode).toBe(0o400);
    expect(payload.body).toBe('{"ok":true}');
    expect(payload.realCanary).toBe("blocked");
    expect(payload.hasCodexEnv).toBe(true);
    expect(payload.hasAnthropic).toBe(false);
  });
});
