#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import { openDatabase } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine } from "./engine.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const dbPath = process.env.AVITY_DB_PATH ?? join(homedir(), ".avity", "avity.sqlite");
  const port = Number(process.env.AVITY_PORT ?? 7717);
  const host = process.env.AVITY_HOST ?? "127.0.0.1";

  const db = openDatabase(dbPath);
  const store = new Store(db);

  const providers = new Map<string, ProviderAdapter>();
  providers.set("fake", new FakeProviderAdapter());

  const engine = new Engine(store, providers, {
    ...DEFAULT_ENGINE_CONFIG,
    maxConcurrentRuns: Number(process.env.AVITY_MAX_CONCURRENT_RUNS ?? DEFAULT_ENGINE_CONFIG.maxConcurrentRuns),
    maxConcurrentRunsPerProject: Number(
      process.env.AVITY_MAX_CONCURRENT_RUNS_PER_PROJECT ?? DEFAULT_ENGINE_CONFIG.maxConcurrentRunsPerProject,
    ),
  });
  engine.start();

  const serverOpts: Parameters<typeof buildServer>[0] = { store, engine, version: VERSION };
  if (process.env.AVITY_API_TOKEN) serverOpts.apiToken = process.env.AVITY_API_TOKEN;
  const app = await buildServer(serverOpts);

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
