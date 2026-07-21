import { describe, expect, it } from "vitest";
import type { CommandProviderAdapter } from "@avityos/providers";
import {
  CLAUDE_CODE_SANDBOX_POLICY,
  CODEX_SANDBOX_POLICY,
  CURSOR_SANDBOX_POLICY,
} from "@avityos/providers";
import { buildProviders, parseRoleProviderMap } from "./providers.js";

function adapter(name: string, env: NodeJS.ProcessEnv): CommandProviderAdapter {
  return buildProviders(env).get(name) as CommandProviderAdapter;
}

describe("runtime command-provider safety", () => {
  it("uses each supported CLI's non-interactive sandbox controls", () => {
    const providers = buildProviders({
      AVITY_CODEX_BIN: "codex",
      AVITY_CLAUDE_CODE_BIN: "claude",
      AVITY_CURSOR_BIN: "cursor-agent",
      CODEX_API_KEY: "ck",
      ANTHROPIC_API_KEY: "ak",
      CURSOR_API_KEY: "uk",
    });

    const codex = providers.get("codex") as CommandProviderAdapter;
    expect(codex.getConfig().args).toContain("workspace-write");
    expect(codex.getConfig().args).toContain('approval_policy="never"');
    expect(codex.getConfig().args).toContain("--ignore-user-config");
    expect(codex.getConfig().args).not.toContain("--ask-for-approval");

    const claude = providers.get("claude-code") as CommandProviderAdapter;
    expect(claude.getConfig().args).toEqual(
      expect.arrayContaining(["--safe-mode", "--no-session-persistence", "acceptEdits"]),
    );

    const cursor = providers.get("cursor") as CommandProviderAdapter;
    expect(cursor.getConfig().args).toEqual(
      expect.arrayContaining(["--sandbox", "enabled", "--skip-worktree-setup", "--workspace"]),
    );
  });

  it("applies a distinct auth policy per CLI provider", () => {
    const env = {
      AVITY_CODEX_BIN: "codex",
      AVITY_CLAUDE_CODE_BIN: "claude",
      AVITY_CURSOR_BIN: "cursor-agent",
      CODEX_API_KEY: "codex-only",
      ANTHROPIC_API_KEY: "claude-only",
      CURSOR_API_KEY: "cursor-only",
    };

    const codex = adapter("codex", env).getConfig();
    expect(codex.env).toEqual({ CODEX_API_KEY: "codex-only" });
    expect(codex.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(codex.env).not.toHaveProperty("CURSOR_API_KEY");
    expect(codex.allowNetwork).toBe(CODEX_SANDBOX_POLICY.allowNetwork);
    expect(codex.authError).toBeUndefined();

    const claude = adapter("claude-code", env).getConfig();
    expect(claude.env).toEqual({ ANTHROPIC_API_KEY: "claude-only" });
    expect(claude.env).not.toHaveProperty("CODEX_API_KEY");
    expect(claude.allowNetwork).toBe(CLAUDE_CODE_SANDBOX_POLICY.allowNetwork);

    const cursor = adapter("cursor", env).getConfig();
    expect(cursor.env).toEqual({ CURSOR_API_KEY: "cursor-only" });
    expect(cursor.env).not.toHaveProperty("CODEX_API_KEY");
    expect(cursor.allowNetwork).toBe(CURSOR_SANDBOX_POLICY.allowNetwork);
  });

  it("marks CLI providers unauthenticated when required secrets are missing", async () => {
    const cursor = adapter("cursor", { AVITY_CURSOR_BIN: "cursor-agent" });
    expect(await cursor.healthy()).toBe(false);
    expect(cursor.getConfig().authError).toMatch(/not authenticated/);
  });

  it("keeps a generic command reviewer-only unless explicitly trusted for edits", () => {
    const safe = buildProviders({ AVITY_COMMAND_BIN: "echo" }).get("command")!;
    const trusted = buildProviders({
      AVITY_COMMAND_BIN: "echo",
      AVITY_COMMAND_WORKSPACE_EDITS: "1",
    }).get("command")!;
    expect(safe.capabilities().workspaceEdits).toBe(false);
    expect(trusted.capabilities().workspaceEdits).toBe(true);
  });

  it("parses ordered provider routing per team role", () => {
    expect(parseRoleProviderMap("frontend=cursor|codex,backend=claude-code|codex")).toEqual(
      new Map([
        ["frontend", ["cursor", "codex"]],
        ["backend", ["claude-code", "codex"]],
      ]),
    );
  });
});
