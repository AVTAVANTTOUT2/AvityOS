import {
  AnthropicAdapter,
  CommandProviderAdapter,
  FakeProviderAdapter,
  OpenAICompatibleAdapter,
  type ProviderAdapter,
} from "@avityos/providers";

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
 *   AVITY_CURSOR_BIN       path to the cursor-agent executable
 *   AVITY_PROVIDER_CHAIN   ordered fallback chain, e.g. "openai,anthropic,fake"
 *   AVITY_DEFAULT_MODELS   e.g. "openai=gpt-4o,anthropic=claude-sonnet-4-5"
 *   AVITY_REVIEW_MODELS    reviewer models per provider (distinct identity)
 */
export function buildProviders(env: NodeJS.ProcessEnv): Map<string, ProviderAdapter> {
  const providers = new Map<string, ProviderAdapter>();
  providers.set("fake", new FakeProviderAdapter());

  const models = (value: string | undefined): string[] =>
    (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (env.OPENAI_API_KEY) {
    providers.set(
      "openai",
      new OpenAICompatibleAdapter("openai", {
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
    providers.set(
      "claude-code",
      new CommandProviderAdapter("claude-code", {
        executable: env.AVITY_CLAUDE_CODE_BIN,
        args: ["-p", "{prompt}", "--output-format", "text"],
      }),
    );
  }

  if (env.AVITY_CURSOR_BIN) {
    providers.set(
      "cursor",
      new CommandProviderAdapter("cursor", {
        executable: env.AVITY_CURSOR_BIN,
        args: ["-p", "{prompt}"],
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
