import {
  AnthropicAdapter,
  CommandProviderAdapter,
  FakeProviderAdapter,
  OpenAICompatibleAdapter,
  OpenAIResponsesAdapter,
  type ProviderAdapter,
} from "@avityos/providers";
import { TeamRole, type TeamRole as TeamRoleName } from "@avityos/contracts";
import { fakeProviderAllowed, FIXTURE_PROVIDER_ID, resolveExecutionMode } from "./provider-policy.js";

/**
 * Runtime provider registration from environment configuration. Only
 * providers with credentials/config present are registered; the fake
 * provider is always available so the platform works offline. Model names
 * and base URLs are configuration (ADR-0005) — nothing here pins a vendor's
 * current alias.
 *
 * Environment:
 *   OPENAI_API_KEY   [+ AVITY_OPENAI_BASE_URL, AVITY_OPENAI_MODELS]
 *   DEEPSEEK_API_KEY [+ AVITY_DEEPSEEK_BASE_URL, AVITY_DEEPSEEK_MODELS]
 *   ANTHROPIC_API_KEY[+ AVITY_ANTHROPIC_BASE_URL, AVITY_ANTHROPIC_MODELS]
 *   AVITY_CLAUDE_CODE_BIN  path to the claude executable (non-interactive -p)
 *   AVITY_CODEX_BIN        path to the codex executable (`codex exec`)
 *   AVITY_CURSOR_BIN       path to the cursor-agent executable
 *   AVITY_COMMAND_BIN      optional generic non-interactive coding agent
 *   AVITY_COMMAND_ARGS_JSON JSON argv template for the generic agent
 *   AVITY_PROVIDER_CHAIN   ordered fallback chain, e.g. "openai,anthropic,fake"
 *   AVITY_DEFAULT_MODELS   e.g. "openai=gpt-4o,anthropic=claude-sonnet-4-5"
 *   AVITY_REVIEW_MODELS    reviewer models per provider (distinct identity)
 */
export function buildProviders(env: NodeJS.ProcessEnv): Map<string, ProviderAdapter> {
  const providers = new Map<string, ProviderAdapter>();
  // Fail-closed: the fixture provider is registered only in test/demo modes.
  // In production it is never present, so nothing can implicitly route to it.
  if (fakeProviderAllowed(resolveExecutionMode(env))) {
    providers.set(FIXTURE_PROVIDER_ID, new FakeProviderAdapter());
  }

  const models = (value: string | undefined): string[] =>
    (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (env.OPENAI_API_KEY) {
    providers.set(
      "openai",
      new OpenAIResponsesAdapter({
        baseUrl: env.AVITY_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY,
        models: models(env.AVITY_OPENAI_MODELS),
      }),
    );
  }

  if (env.DEEPSEEK_API_KEY) {
    providers.set(
      "deepseek",
      new OpenAICompatibleAdapter("deepseek", {
        baseUrl: env.AVITY_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        apiKey: env.DEEPSEEK_API_KEY,
        models: models(env.AVITY_DEEPSEEK_MODELS),
      }),
    );
  }

  if (env.ANTHROPIC_API_KEY) {
    providers.set(
      "anthropic",
      new AnthropicAdapter({
        baseUrl: env.AVITY_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
        apiKey: env.ANTHROPIC_API_KEY,
        models: models(env.AVITY_ANTHROPIC_MODELS),
      }),
    );
  }

  if (env.AVITY_CLAUDE_CODE_BIN) {
    const claudeModels = models(env.AVITY_CLAUDE_CODE_MODELS);
    providers.set(
      "claude-code",
      new CommandProviderAdapter("claude-code", {
        executable: env.AVITY_CLAUDE_CODE_BIN,
        args: [
          "--safe-mode",
          "--no-session-persistence",
          "--permission-mode", "acceptEdits",
          "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash(git *),Bash(pnpm *),Bash(npm *),Bash(node *),Bash(swift *)",
          ...(claudeModels.length ? ["--model", "{model}"] : []),
          "-p", "{prompt}", "--output-format", "text",
        ],
        models: claudeModels,
        // Reaches the Anthropic API from inside the sandbox: network required.
        allowNetwork: true,
        env: env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {},
      }),
    );
  }

  if (env.AVITY_CODEX_BIN) {
    const codexModels = models(env.AVITY_CODEX_MODELS);
    providers.set(
      "codex",
      new CommandProviderAdapter("codex", {
        executable: env.AVITY_CODEX_BIN,
        args: [
          "exec", "--sandbox", "workspace-write",
          "-c", 'approval_policy="never"',
          "-c", 'shell_environment_policy.inherit="none"',
          "--ignore-user-config", "--ignore-rules", "--ephemeral", "-C", "{cwd}",
          ...(codexModels.length ? ["--model", "{model}"] : []),
          "{prompt}",
        ],
        models: codexModels,
        // Reaches the model API from inside the sandbox: network required.
        allowNetwork: true,
        env: env.CODEX_API_KEY ? { CODEX_API_KEY: env.CODEX_API_KEY } : {},
      }),
    );
  }

  if (env.AVITY_CURSOR_BIN) {
    const cursorModels = models(env.AVITY_CURSOR_MODELS);
    providers.set(
      "cursor",
      new CommandProviderAdapter("cursor", {
        executable: env.AVITY_CURSOR_BIN,
        args: [
          "--sandbox", "enabled", "--force", "--trust", "--skip-worktree-setup",
          "--workspace", "{cwd}",
          ...(cursorModels.length ? ["--model", "{model}"] : []),
          "-p", "{prompt}",
        ],
        models: cursorModels,
        // Reaches the model API from inside the sandbox: network required.
        allowNetwork: true,
        env: env.CURSOR_API_KEY ? { CURSOR_API_KEY: env.CURSOR_API_KEY } : {},
      }),
    );
  }

  if (env.AVITY_COMMAND_BIN) {
    let args: string[] = ["{prompt}"];
    if (env.AVITY_COMMAND_ARGS_JSON) {
      const parsed = JSON.parse(env.AVITY_COMMAND_ARGS_JSON) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error("AVITY_COMMAND_ARGS_JSON must be a JSON array of strings");
      }
      args = parsed;
    }
    providers.set(
      "command",
      new CommandProviderAdapter("command", {
        executable: env.AVITY_COMMAND_BIN,
        args,
        models: models(env.AVITY_COMMAND_MODELS),
        workspaceEdits: env.AVITY_COMMAND_WORKSPACE_EDITS === "1",
        // Generic agents stay network-denied unless explicitly opted in.
        allowNetwork: env.AVITY_COMMAND_ALLOW_NETWORK === "1",
        env: parseCommandEnvAllowlist(env),
      }),
    );
  }

  return providers;
}

/**
 * Explicit secret allowlist for the generic command adapter. Only the names
 * listed in AVITY_COMMAND_ENV_ALLOWLIST (comma-separated) are forwarded, and
 * only when present. Nothing else from the control-plane environment reaches
 * the sandboxed agent.
 */
function parseCommandEnvAllowlist(env: NodeJS.ProcessEnv): Record<string, string> {
  const allowlist = (env.AVITY_COMMAND_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const result: Record<string, string> = {};
  for (const name of allowlist) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** Parse "name=model,name2=model2" pairs into a map. */
export function parseModelMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (value ?? "").split(",")) {
    const [name, ...rest] = pair.split("=");
    if (name?.trim() && rest.length) map.set(name.trim(), rest.join("=").trim());
  }
  return map;
}

/** Parse "frontend=cursor|codex,backend=claude-code|codex" team routing. */
export function parseRoleProviderMap(value: string | undefined): Map<TeamRoleName, string[]> {
  const map = new Map<TeamRoleName, string[]>();
  for (const pair of (value ?? "").split(",")) {
    const [role, ...rest] = pair.split("=");
    const providers = rest.join("=").split("|").map((item) => item.trim()).filter(Boolean);
    const parsedRole = TeamRole.safeParse(role?.trim());
    if (parsedRole.success && providers.length) map.set(parsedRole.data, providers);
  }
  return map;
}
