#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ProviderAdapter } from "@avityos/providers";
import { RemoteBridgeStateStore } from "@avityos/remote-bridge";
import {
  applyCampaignFaultInjection,
  resolveCampaignFault,
  type CampaignFaultConfig,
} from "./campaign-fault.js";
import { openDatabase } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine } from "./engine.js";
import {
  assertProviderChainAllowed,
  fakeProviderAllowed,
  FIXTURE_PROVIDER_ID,
  resolveExecutionMode,
} from "./provider-policy.js";
import {
  buildProviders,
  parseModelMap,
  parseRoleProviderMap,
  PROVIDER_CHAIN_PREFERENCE_REAL,
} from "./providers.js";
import { buildProviderStatus } from "./provider-status.js";
import { MacOSRemoteHostKeychainStore } from "./remote-host-keychain.js";
import {
  RemoteHostManager,
  type RemoteControlDispatcher,
} from "./remote-host.js";
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

  const executionMode = resolveExecutionMode(process.env);
  const baseProviders: Map<string, ProviderAdapter> = buildProviders(process.env);

  // Explicit chains are validated fail-closed: naming `fake` in production is a
  // hard error, never a silent drop. The implicit default only offers the
  // fixture as an offline fallback when the mode already permits it.
  const allowFixture = fakeProviderAllowed(executionMode);
  const defaultChainOrder = [
    ...PROVIDER_CHAIN_PREFERENCE_REAL,
    ...(allowFixture ? [FIXTURE_PROVIDER_ID] : []),
  ];
  let providerChain: string[];
  if (process.env.AVITY_PROVIDER_CHAIN) {
    const requested = process.env.AVITY_PROVIDER_CHAIN.split(",").map((s) => s.trim()).filter(Boolean);
    assertProviderChainAllowed(executionMode, requested);
    providerChain = requested.filter((name) => baseProviders.has(name));
  } else {
    providerChain = defaultChainOrder.filter((name) => baseProviders.has(name));
  }

  const defaultModels = parseModelMap(process.env.AVITY_DEFAULT_MODELS);
  const reviewModels = parseModelMap(process.env.AVITY_REVIEW_MODELS);
  const brainModels = parseModelMap(process.env.AVITY_BRAIN_MODELS);
  if (allowFixture) {
    if (!defaultModels.has(FIXTURE_PROVIDER_ID)) defaultModels.set(FIXTURE_PROVIDER_ID, "fake:code");
    if (!reviewModels.has(FIXTURE_PROVIDER_ID)) reviewModels.set(FIXTURE_PROVIDER_ID, "fake:review-approve");
    if (!brainModels.has(FIXTURE_PROVIDER_ID)) brainModels.set(FIXTURE_PROVIDER_ID, "fake:plan");
  }

  const campaignFault: CampaignFaultConfig | null = resolveCampaignFault(
    process.env,
    executionMode,
    new Set(baseProviders.keys()),
  );
  const providers: Map<string, ProviderAdapter> = applyCampaignFaultInjection(
    baseProviders,
    campaignFault,
  );

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
    // No implicit `fake` fallback in production: an empty chain stays empty so
    // missions block on "no provider" instead of silently running fixtures.
    providerChain.length ? providerChain : allowFixture ? [FIXTURE_PROVIDER_ID] : [],
    defaultModels,
    reviewModels,
    parseRoleProviderMap(process.env.AVITY_ROLE_PROVIDERS),
    brainModels,
  );
  engine.start();

  const providerStatus = buildProviderStatus({
    env: process.env,
    executionMode,
    providers: engine.providers,
    defaultModels,
    reviewModels,
    routing: engine.getProviderRoutingSnapshot(),
    campaignFault,
  });

  const allowedOrigins = process.env.AVITY_ALLOWED_ORIGINS
    ? process.env.AVITY_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    : [...DEFAULT_ALLOWED_ORIGINS];

  const apiToken = loadOrCreateApiToken();
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  let remoteStateStore: RemoteBridgeStateStore | null = null;
  let remoteHost: RemoteHostManager | undefined;
  if (process.platform === "darwin") {
    const remoteDatabasePath = process.env.AVITY_REMOTE_BRIDGE_DB_PATH ??
      join(homedir(), ".avity", "remote", "bridge.sqlite");
    const remoteDirectory = dirname(remoteDatabasePath);
    mkdirSync(remoteDirectory, { recursive: true, mode: 0o700 });
    chmodSync(remoteDirectory, 0o700);
    remoteStateStore = new RemoteBridgeStateStore(remoteDatabasePath);
    const dispatch: RemoteControlDispatcher = async (request) => {
      if (!app) throw new Error("control plane is not ready for remote dispatch");
      const response = await app.inject({
        method: request.method,
        url: request.path,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        payload: request.body === undefined
          ? undefined
          : JSON.stringify(request.body),
      });
      if (Buffer.byteLength(response.body) > 3 * 1024 * 1024) {
        throw new Error("local control-plane response exceeds remote bridge limit");
      }
      let body: unknown;
      try {
        body = JSON.parse(response.body);
      } catch {
        throw new Error("local control-plane response is not valid JSON");
      }
      return { status: response.statusCode, body };
    };
    remoteHost = new RemoteHostManager({
      stateStore: remoteStateStore,
      secretStore: new MacOSRemoteHostKeychainStore(),
      dispatch,
    });
  }

  app = await buildServer({
    store,
    engine,
    version: VERSION,
    apiToken,
    allowedOrigins,
    providerStatus,
    remoteHost,
  });

  const shutdown = async () => {
    await remoteHost?.stop();
    await engine.stop();
    await app?.close();
    remoteStateStore?.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port, host });
  await remoteHost?.start();
  console.log(`AvityOS control plane v${VERSION} listening on http://${host}:${port} (db: ${dbPath})`);
}

main().catch((err) => {
  console.error("control plane failed to start:", err);
  process.exit(1);
});
