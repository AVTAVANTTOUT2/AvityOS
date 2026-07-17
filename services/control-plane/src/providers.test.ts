import { describe, expect, it } from "vitest";
import type { CommandProviderAdapter } from "@avityos/providers";
import { buildProviders, parseRoleProviderMap } from "./providers.js";

function argsOf(adapter: CommandProviderAdapter | undefined): readonly string[] {
  return (adapter as unknown as { config: { args: readonly string[] } }).config.args;
}

describe("runtime command-provider safety", () => {
  it("uses each supported CLI's non-interactive sandbox controls", () => {
    const providers = buildProviders({
      AVITY_CODEX_BIN: "codex",
      AVITY_CLAUDE_CODE_BIN: "claude",
      AVITY_CURSOR_BIN: "cursor-agent",
    });

    const codex = argsOf(providers.get("codex") as CommandProviderAdapter);
    expect(codex).toContain("workspace-write");
    expect(codex).toContain('approval_policy="never"');
    expect(codex).toContain("--ignore-user-config");
    expect(codex).not.toContain("--ask-for-approval");

    const claude = argsOf(providers.get("claude-code") as CommandProviderAdapter);
    expect(claude).toEqual(expect.arrayContaining(["--safe-mode", "--no-session-persistence", "acceptEdits"]));

    const cursor = argsOf(providers.get("cursor") as CommandProviderAdapter);
    expect(cursor).toEqual(expect.arrayContaining(["--sandbox", "enabled", "--skip-worktree-setup", "--workspace"]));
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
    expect(parseRoleProviderMap("frontend=cursor|codex,backend=claude-code|codex")).toEqual(new Map([
      ["frontend", ["cursor", "codex"]],
      ["backend", ["claude-code", "codex"]],
    ]));
  });
});
