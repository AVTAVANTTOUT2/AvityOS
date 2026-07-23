import {
  AnthropicAdapter,
  CommandProviderAdapter,
  FakeProviderAdapter,
  OpenAICompatibleAdapter,
  OpenAIResponsesAdapter,
  resolveCliProviderAuth,
  resolveCommandProviderAuth,
  CLAUDE_CODE_SANDBOX_POLICY,
  CODEX_SANDBOX_POLICY,
  CURSOR_SANDBOX_POLICY,
  type ResolvedCliAuth,
  type ProviderAdapter,
} from "@avityos/providers";
import { TeamRole, type TeamRole as TeamRoleName } from "@avityos/contracts";
import {
  detectRuntimeReadRoots,
  resolveExecutablePath,
} from "@avityos/policy";
import { fakeProviderAllowed, FIXTURE_PROVIDER_ID, resolveExecutionMode } from "./provider-policy.js";

export const PROVIDER_CHAIN_PREFERENCE_REAL = [
  "codex",
  "claude-code",
  "cursor",
  "command",
  "openai",
  "anthropic",
  "deepseek",
] as const;

export const PROVIDER_STATUS_ORDER = [
  ...PROVIDER_CHAIN_PREFERENCE_REAL,
  FIXTURE_PROVIDER_ID,
] as const;

type CliProviderId = "codex" | "claude-code" | "cursor" | "command";

export const DEFAULT_CLI_TOOLCHAIN_COMMANDS = [
  "git",
  "node",
  "npm",
  "npx",
  "pnpm",
  "rg",
  "python3",
  "swift",
  "xcodebuild",
  "make",
  "cmake",
  "cargo",
  "rustc",
  "go",
] as const;

const cliToolchainCache = new Map<string, readonly string[]>();
const BARE_TOOL_NAME = /^[A-Za-z0-9._+-]+$/;

function parseModelList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve only a curated set of repository tools and their exact runtime
 * roots. Never grant an entire PATH directory or package-manager prefix.
 */
export function resolveCliToolchainRuntimePaths(env: NodeJS.ProcessEnv): readonly string[] {
  const pathValue = env.PATH ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const extraCommands = parseModelList(env.AVITY_CLI_TOOLCHAIN_COMMANDS);
  const commands = [...new Set([...DEFAULT_CLI_TOOLCHAIN_COMMANDS, ...extraCommands])];
  const invalid = commands.filter((command) => !BARE_TOOL_NAME.test(command));
  if (invalid.length > 0) {
    throw new Error(
      `AVITY_CLI_TOOLCHAIN_COMMANDS accepts bare executable names only: ${invalid.join(", ")}`,
    );
  }

  const cacheKey = `${pathValue}\n${commands.join(",")}`;
  const cached = cliToolchainCache.get(cacheKey);
  if (cached) return cached;

  const roots = new Set<string>();
  for (const command of commands) {
    try {
      const executable = resolveExecutablePath(command, pathValue);
      for (const root of detectRuntimeReadRoots(executable)) roots.add(root);
    } catch {
      // Optional tool absent on this host: do not widen the sandbox or fail
      // providers that do not need it.
    }
  }
  const resolved = [...roots];
  cliToolchainCache.set(cacheKey, resolved);
  return resolved;
}

export function resolveProviderCliAuth(
  providerId: CliProviderId,
  env: NodeJS.ProcessEnv,
  options: { realHome?: string } = {},
): ResolvedCliAuth {
  if (providerId === "codex") {
    return resolveCliProviderAuth(CODEX_SANDBOX_POLICY, env, options);
  }
  if (providerId === "claude-code") {
    return resolveCliProviderAuth(CLAUDE_CODE_SANDBOX_POLICY, env, options);
  }
  if (providerId === "cursor") {
    return resolveCliProviderAuth(CURSOR_SANDBOX_POLICY, env, options);
  }
  return resolveCommandProviderAuth(env);
}

/**
 * Runtime provider registration from environment configuration. Only
 * providers with credentials/config present are registered; the fake
 * provider is available only in test/demo modes. Model names and base URLs
 * are configuration (ADR-0005) — nothing here pins a vendor's current alias.
 *
 * Environment:
 *   OPENAI_API_KEY   [+ AVITY_OPENAI_BASE_URL, AVITY_OPENAI_MODELS]
 *   DEEPSEEK_API_KEY [+ AVITY_DEEPSEEK_BASE_URL, AVITY_DEEPSEEK_MODELS]
 *   ANTHROPIC_API_KEY[+ AVITY_ANTHROPIC_BASE_URL, AVITY_ANTHROPIC_MODELS]
 *   CLAUDE_CODE_OAUTH_TOKEN (official `claude setup-token` automation token)
 *   AVITY_CLAUDE_CODE_BIN  path to the claude executable (non-interactive -p)
 *   AVITY_CODEX_BIN        path to the codex executable (`codex exec`)
 *   AVITY_CURSOR_BIN       path to the cursor-agent executable
 *   AVITY_COMMAND_BIN      optional generic non-interactive coding agent
 *   AVITY_COMMAND_ARGS_JSON JSON argv template for the generic agent
 *   AVITY_CLI_TOOLCHAIN_COMMANDS optional extra bare executable names whose
 *                                exact runtime roots CLI agents may read
 *   AVITY_PROVIDER_CHAIN   ordered fallback chain, e.g. "openai,anthropic,fake"
 *   AVITY_DEFAULT_MODELS   e.g. "openai=gpt-4o,anthropic=claude-sonnet-4-5"
 *   AVITY_REVIEW_MODELS    reviewer models per provider (distinct identity)
 *
 * CLI auth (sandboxed — never inherits process.env or the real HOME):
 *   Codex:        CODEX_API_KEY or readable ~/.codex/auth.json
 *   Claude Code:  ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or readable
 *                 ~/.claude/.credentials.json
 *   Cursor:       CURSOR_API_KEY or readable ~/.cursor/auth.json created by
 *                 `AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login`
 *   command:      names in AVITY_COMMAND_ENV_ALLOWLIST only
 */
export function buildProviders(
  env: NodeJS.ProcessEnv,
  options: {
    readonly realHome?: string;
    readonly cliToolchainRuntimePaths?: readonly string[];
  } = {},
): Map<string, ProviderAdapter> {
  const providers = new Map<string, ProviderAdapter>();
  // Fail-closed: the fixture provider is registered only in test/demo modes.
  // In production it is never present, so nothing can implicitly route to it.
  if (fakeProviderAllowed(resolveExecutionMode(env))) {
    providers.set(FIXTURE_PROVIDER_ID, new FakeProviderAdapter());
  }

  const models = parseModelList;
  const hasCliProvider = Boolean(
    env.AVITY_CLAUDE_CODE_BIN ||
    env.AVITY_CODEX_BIN ||
    env.AVITY_CURSOR_BIN ||
    env.AVITY_COMMAND_BIN,
  );
  const cliToolchainRuntimePaths = options.cliToolchainRuntimePaths ??
    (hasCliProvider ? resolveCliToolchainRuntimePaths(env) : []);

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
    const auth = resolveProviderCliAuth("claude-code", env, options);
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
        allowNetwork: CLAUDE_CODE_SANDBOX_POLICY.allowNetwork,
        env: auth.env,
        credentialFiles: auth.credentialFiles,
        runtimePaths: cliToolchainRuntimePaths,
        authError: auth.authenticated ? undefined : auth.reason,
      }),
    );
  }

  if (env.AVITY_CODEX_BIN) {
    const auth = resolveProviderCliAuth("codex", env, options);
    const codexModels = models(env.AVITY_CODEX_MODELS);
    providers.set(
      "codex",
      new CommandProviderAdapter("codex", {
        executable: env.AVITY_CODEX_BIN,
        args: [
          // CommandProviderAdapter already launches Codex inside the AvityOS
          // fail-closed OS sandbox. Asking Codex to create another Seatbelt /
          // bubblewrap sandbox makes its tool subprocesses fail under the
          // outer profile. Disable only Codex's nested sandbox; descendants
          // remain confined by the AvityOS sandbox for the entire process tree.
          "exec", "--sandbox", "danger-full-access",
          "-c", 'approval_policy="never"',
          "-c", 'shell_environment_policy.inherit="none"',
          "-c", `shell_environment_policy.set.PATH=${JSON.stringify(
            env.PATH ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
          )}`,
          "--ignore-user-config", "--ignore-rules", "--ephemeral", "-C", "{cwd}",
          ...(codexModels.length ? ["--model", "{model}"] : []),
          "{prompt}",
        ],
        models: codexModels,
        allowNetwork: CODEX_SANDBOX_POLICY.allowNetwork,
        env: auth.env,
        credentialFiles: auth.credentialFiles,
        runtimePaths: cliToolchainRuntimePaths,
        authError: auth.authenticated ? undefined : auth.reason,
      }),
    );
  }

  if (env.AVITY_CURSOR_BIN) {
    const auth = resolveProviderCliAuth("cursor", env, options);
    const cursorModels = models(env.AVITY_CURSOR_MODELS);
    const cursorEnv = auth.credentialFiles.length > 0
      ? { ...auth.env, AGENT_CLI_CREDENTIAL_STORE: "file" }
      : auth.env;
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
        allowNetwork: CURSOR_SANDBOX_POLICY.allowNetwork,
        env: cursorEnv,
        credentialFiles: auth.credentialFiles,
        runtimePaths: cliToolchainRuntimePaths,
        authError: auth.authenticated ? undefined : auth.reason,
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
    const auth = resolveProviderCliAuth("command", env);
    providers.set(
      "command",
      new CommandProviderAdapter("command", {
        executable: env.AVITY_COMMAND_BIN,
        args,
        models: models(env.AVITY_COMMAND_MODELS),
        workspaceEdits: env.AVITY_COMMAND_WORKSPACE_EDITS === "1",
        allowNetwork: auth.policy.allowNetwork,
        env: auth.env,
        credentialFiles: auth.credentialFiles,
        runtimePaths: cliToolchainRuntimePaths,
      }),
    );
  }

  return providers;
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
