#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import { openDatabase } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine } from "./engine.js";
import { buildProviders, parseModelMap, parseRoleProviderMap } from "./providers.js";
import { buildServer, DEFAULT_ALLOWED_ORIGINS } from "./server.js";
import { Store } from "./store.js";

const VERSION = "0.1.0";

/**
 * First-run authentication: the API always requires a bearer token. The
 * token comes from AVITY_API_TOKEN, or is generated once and persisted at
 * ~/.avity/api-token (0600). It is printed exactly once, on generation.
 */
function loadOrCreateApiToken(): string {
  if (process.env.AVITY_API_TOKEN) return process.env.AVITY_API_TOKEN;
  const tokenPath = process.env.AVITY_API_TOKEN_PATH ?? join(homedir(), ".avity", "api-token");
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  console.log(`generated API token (stored at ${tokenPath}):`);
  console.log(`  ${token}`);
  console.log("configure clients with it: avity login --token <token>");
  return token;
}

async function main(): Promise<void> {
  const dbPath = process.env.AVITY_DB_PATH ?? join(homedir(), ".avity", "avity.sqlite");
  const port = Number(process.env.AVITY_PORT ?? 7717);
  const host = process.env.AVITY_HOST ?? "127.0.0.1";

  const db = openDatabase(dbPath);
  const store = new Store(db);

  const providers: Map<string, ProviderAdapter> = buildProviders(process.env);
  if (!providers.has("fake")) providers.set("fake", new FakeProviderAdapter());

  const providerChain = process.env.AVITY_PROVIDER_CHAIN
    ? process.env.AVITY_PROVIDER_CHAIN.split(",").map((s) => s.trim()).filter((name) => providers.has(name))
    : ["codex", "claude-code", "cursor", "command", "openai", "anthropic", "deepseek", "fake"].filter((name) =>
        providers.has(name),
      );

  const defaultModels = parseModelMap(process.env.AVITY_DEFAULT_MODELS);
  if (!defaultModels.has("fake")) defaultModels.set("fake", "fake:code");
  const reviewModels = parseModelMap(process.env.AVITY_REVIEW_MODELS);
  if (!reviewModels.has("fake")) reviewModels.set("fake", "fake:review-approve");

  const engine = new Engine(
    store,
    providers,
    {
      ...DEFAULT_ENGINE_CONFIG,
      maxConcurrentRuns: Number(process.env.AVITY_MAX_CONCURRENT_RUNS ?? DEFAULT_ENGINE_CONFIG.maxConcurrentRuns),
      maxConcurrentRunsPerProject: Number(
        process.env.AVITY_MAX_CONCURRENT_RUNS_PER_PROJECT ?? DEFAULT_ENGINE_CONFIG.maxConcurrentRunsPerProject,
      ),
    },
    providerChain.length ? providerChain : ["fake"],
    defaultModels,
    reviewModels,
    parseRoleProviderMap(process.env.AVITY_ROLE_PROVIDERS),
  );
  engine.start();

  const allowedOrigins = process.env.AVITY_ALLOWED_ORIGINS
    ? process.env.AVITY_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    : [...DEFAULT_ALLOWED_ORIGINS];

  const app = await buildServer({
    store,
    engine,
    version: VERSION,
    apiToken: loadOrCreateApiToken(),
    allowedOrigins,
  });

  const shutdown = async () => {
    await engine.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port, host });
  console.log(`AvityOS control plane v${VERSION} listening on http://${host}:${port} (db: ${dbPath})`);
}

main().catch((err) => {
  console.error("control plane failed to start:", err);
  process.exit(1);
});
