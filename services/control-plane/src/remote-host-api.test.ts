import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProviderAdapter, type ProviderAdapter } from "@avityos/providers";
import type { FastifyInstance } from "fastify";
import { openDatabase, type DB } from "./db.js";
import { DEFAULT_ENGINE_CONFIG, Engine } from "./engine.js";
import type { RemoteHostManager } from "./remote-host.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";

const TOKEN = "remote-host-api-test-token";
const SESSION_ID = `rpair_${"a".repeat(32)}`;
const DEVICE_ID = `rdev_${"b".repeat(32)}`;

let app: FastifyInstance;
let db: DB;
let engine: Engine;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const store = new Store(db);
  const providers = new Map<string, ProviderAdapter>([
    ["fake", new FakeProviderAdapter()],
  ]);
  engine = new Engine(store, providers, DEFAULT_ENGINE_CONFIG);
  const status = {
    supported: true,
    configured: true,
    connectorState: "online" as const,
    relayUrl: "https://relay.example",
    accountId: `racc_${"c".repeat(32)}`,
    hostDeviceId: `rdev_${"d".repeat(32)}`,
    devices: [],
    lastError: null,
  };
  const remoteHost = {
    status: vi.fn(() => status),
    configure: vi.fn(async () => status),
    createPairing: vi.fn(() => ({
      sessionId: SESSION_ID,
      expiresAt: "2026-07-24T13:05:00.000Z",
      pairingBundle: "{}",
    })),
    acceptPairing: vi.fn(async () => ({
      sessionId: SESSION_ID,
      bootstrap: "{}",
    })),
    revokeDevice: vi.fn(async () => status),
  } as unknown as RemoteHostManager;
  app = await buildServer({
    store,
    engine,
    version: "test",
    apiToken: TOKEN,
    remoteHost,
  });
});

afterEach(async () => {
  await engine.stop();
  await app.close();
  db.close();
});

const auth = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

describe("remote host administration API", () => {
  it("validates, authenticates and disables caching for the complete pairing lifecycle", async () => {
    expect((await app.inject({
      method: "GET",
      url: "/v1/remote-host",
    })).statusCode).toBe(401);

    const status = await app.inject({
      method: "GET",
      url: "/v1/remote-host",
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json()).toMatchObject({
      supported: true,
      connectorState: "online",
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/remote-host/configure",
      headers: auth,
      payload: {
        relayUrl: "http://relay.example",
        relayAdminToken: "short",
        deviceName: "",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "validation_failed" },
    });

    const configured = await app.inject({
      method: "POST",
      url: "/v1/remote-host/configure",
      headers: auth,
      payload: {
        relayUrl: "https://relay.example",
        relayAdminToken: "admin-token-".padEnd(32, "x"),
        deviceName: "Host",
      },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.headers["cache-control"]).toBe("no-store");

    const pairing = await app.inject({
      method: "POST",
      url: "/v1/remote-host/pairing-sessions",
      headers: auth,
      payload: {},
    });
    expect(pairing.statusCode).toBe(201);
    expect(pairing.headers["cache-control"]).toBe("no-store");
    expect(pairing.json()).toMatchObject({ sessionId: SESSION_ID });

    const accepted = await app.inject({
      method: "POST",
      url: `/v1/remote-host/pairing-sessions/${SESSION_ID}/accept`,
      headers: auth,
      payload: { request: "{}" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(accepted.json()).toMatchObject({ bootstrap: "{}" });

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/remote-host/devices/${DEVICE_ID}/revoke`,
      headers: auth,
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.headers["cache-control"]).toBe("no-store");
  });
});
