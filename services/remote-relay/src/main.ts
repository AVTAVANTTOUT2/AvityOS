#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { buildRemoteRelayServer } from "./server.js";
import { SqliteRelayStore } from "./sqlite-store.js";

const VERSION = "0.1.0";

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

async function main(): Promise<void> {
  const accessToken = process.env.AVITY_RELAY_ACCESS_TOKEN ?? "";
  if (accessToken.length < 32 || accessToken.length > 4_096 || /\s/.test(accessToken)) {
    throw new Error("AVITY_RELAY_ACCESS_TOKEN must be 32-4096 non-whitespace characters");
  }
  const port = integerEnvironment("AVITY_RELAY_PORT", 7788, 1_024, 65_535);
  const ttlMs = integerEnvironment(
    "AVITY_RELAY_TTL_MS",
    7 * 24 * 60 * 60_000,
    1_000,
    30 * 24 * 60 * 60_000,
  );
  const maxItemsPerInbox = integerEnvironment(
    "AVITY_RELAY_MAX_ITEMS_PER_INBOX",
    100,
    1,
    100_000,
  );
  const maxTotalItems = integerEnvironment(
    "AVITY_RELAY_MAX_TOTAL_ITEMS",
    10_000,
    maxItemsPerInbox,
    1_000_000,
  );
  const maxBytesPerInbox = integerEnvironment(
    "AVITY_RELAY_MAX_BYTES_PER_INBOX",
    32 * 1024 * 1024,
    1_024,
    1024 * 1024 * 1024,
  );
  const maxTotalBytes = integerEnvironment(
    "AVITY_RELAY_MAX_TOTAL_BYTES",
    256 * 1024 * 1024,
    maxBytesPerInbox,
    4 * 1024 * 1024 * 1024,
  );
  const maxInboxStates = integerEnvironment(
    "AVITY_RELAY_MAX_INBOX_STATES",
    10_000,
    1,
    100_000,
  );
  const maxSeenMessages = integerEnvironment(
    "AVITY_RELAY_MAX_SEEN_MESSAGES",
    100_000,
    1,
    2_000_000,
  );
  const maxWaiters = integerEnvironment(
    "AVITY_RELAY_MAX_WAITERS",
    1_000,
    1,
    100_000,
  );
  const host = process.env.AVITY_RELAY_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("AVITY_RELAY_HOST must remain loopback; expose it through a local HTTPS reverse proxy");
  }
  const databasePath = process.env.AVITY_RELAY_DB_PATH ?? join(homedir(), ".avity", "relay.sqlite");
  const store = new SqliteRelayStore(databasePath, {
    ttlMs,
    maxItemsPerInbox,
    maxTotalItems,
    maxBytesPerInbox,
    maxTotalBytes,
    maxInboxStates,
    maxSeenMessages,
    maxWaiters,
  });
  const app = await buildRemoteRelayServer({
    accessToken,
    version: VERSION,
    store,
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    store.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await app.listen({ host, port });
  console.log(`AvityOS remote relay listening on ${host}:${port}`);
}

main().catch((error) => {
  console.error("remote relay failed to start:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
