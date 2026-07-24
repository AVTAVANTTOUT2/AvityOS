import { afterEach, describe, expect, it } from "vitest";
import {
  RemoteOutboundConnector,
  RemoteRelayHttpClient,
  RemoteRelayHttpError,
  generateRemoteAccountIdentity,
  generateRemoteDeviceIdentity,
  issueRemoteDeviceCertificate,
  openRemoteEnvelope,
  sealRemoteEnvelope,
} from "@avityos/remote-bridge";
import { buildRemoteRelayServer } from "./server.js";
import {
  InMemoryRelayStore,
  RemoteRelayCapacityError,
} from "./store.js";

const ACCESS_TOKEN = "relay-test-token-".padEnd(32, "x");
const NOW = "2026-07-24T10:00:00.000Z";
const runningServers: Array<Awaited<ReturnType<typeof buildRemoteRelayServer>>> = [];

function tamperBase64Url(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

function setupDevices() {
  const account = generateRemoteAccountIdentity();
  const host = generateRemoteDeviceIdentity();
  const remote = generateRemoteDeviceIdentity();
  const other = generateRemoteDeviceIdentity();
  const hostCertificate = issueRemoteDeviceCertificate({
    account,
    device: host,
    name: "Host",
    issuedAt: NOW,
  });
  const remoteCertificate = issueRemoteDeviceCertificate({
    account,
    device: remote,
    name: "Remote",
    issuedAt: NOW,
  });
  const otherCertificate = issueRemoteDeviceCertificate({
    account,
    device: other,
    name: "Other",
    issuedAt: NOW,
  });
  return {
    account,
    host,
    remote,
    other,
    hostCertificate,
    remoteCertificate,
    otherCertificate,
  };
}

async function startRelay(store = new InMemoryRelayStore()) {
  const app = await buildRemoteRelayServer({
    accessToken: ACCESS_TOKEN,
    version: "test",
    store,
  });
  runningServers.push(app);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, baseUrl, store };
}

describe("ciphertext-only relay and outbound connector", () => {
  it("round-trips a request and response without exposing plaintext to the relay", async () => {
    const { baseUrl, store } = await startRelay();
    const setup = setupDevices();
    const fetchCalls: Array<{ url: string; authorization: string | null }> = [];
    const trackedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      fetchCalls.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
      });
      return fetch(request);
    };
    const remoteRelay = new RemoteRelayHttpClient({
      baseUrl,
      accessToken: ACCESS_TOKEN,
      fetchImpl: trackedFetch,
    });
    const hostRelay = new RemoteRelayHttpClient({
      baseUrl,
      accessToken: ACCESS_TOKEN,
    });
    const plaintext = "remote-control-secret-never-visible";
    const requestEnvelope = sealRemoteEnvelope({
      plaintext,
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });

    const firstPublish = await remoteRelay.publish(requestEnvelope);
    const duplicatePublish = await remoteRelay.publish(requestEnvelope);
    expect(firstPublish.duplicate).toBe(false);
    expect(duplicatePublish).toMatchObject({
      acceptedAt: firstPublish.acceptedAt,
      duplicate: true,
    });
    const relayView = await hostRelay.poll({
      accountId: setup.account.accountId,
      deviceId: setup.host.deviceId,
      afterCursor: 0,
      waitMs: 0,
    });
    expect(JSON.stringify(relayView)).not.toContain(plaintext);
    expect(relayView.items).toHaveLength(1);
    expect(store.stats().queuedEnvelopes).toBe(1);

    const connector = new RemoteOutboundConnector({
      relay: hostRelay,
      identity: setup.host,
      certificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      resolveSenderCertificate: (deviceId) => {
        expect(deviceId).toBe(setup.remote.deviceId);
        return setup.remoteCertificate;
      },
      handleRequest: (request) => {
        expect(request.plaintext.toString("utf8")).toBe(plaintext);
        return {
          plaintext: `ack:${request.plaintext.toString("utf8")}`,
          contentType: "text/plain",
        };
      },
      pollWaitMs: 0,
      now: () => new Date(NOW),
    });
    expect(await connector.processOnce()).toBe(1);
    expect(connector.state).toMatchObject({
      relayCursor: 1,
      deliveryPending: false,
    });

    const responseInbox = await remoteRelay.poll({
      accountId: setup.account.accountId,
      deviceId: setup.remote.deviceId,
      afterCursor: 0,
      waitMs: 0,
    });
    expect(responseInbox.items).toHaveLength(1);
    expect(JSON.stringify(responseInbox)).not.toContain(plaintext);
    const openedResponse = openRemoteEnvelope({
      envelope: responseInbox.items[0]!.envelope,
      recipientIdentity: setup.remote,
      recipientCertificate: setup.remoteCertificate,
      senderCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      lastAcceptedSequence: 0,
      now: NOW,
    });
    expect(openedResponse.plaintext.toString("utf8")).toBe(`ack:${plaintext}`);

    const wrongInbox = await remoteRelay.poll({
      accountId: setup.account.accountId,
      deviceId: setup.other.deviceId,
      afterCursor: 0,
      waitMs: 0,
    });
    expect(wrongInbox.items).toEqual([]);
    expect(fetchCalls.every((call) => !call.url.includes(ACCESS_TOKEN))).toBe(true);
    expect(fetchCalls.every((call) => call.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
  });

  it("authenticates, rejects plaintext and conflicts on a reused message id", async () => {
    const { baseUrl } = await startRelay();
    const health = await fetch(`${baseUrl}/v1/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    const fakeHealthPrefix = await fetch(`${baseUrl}/v1/health-private`);
    expect(fakeHealthPrefix.status).toBe(401);

    const unauthorized = await fetch(`${baseUrl}/v1/relay/envelopes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plaintext: "do-not-echo-this" }),
    });
    expect(unauthorized.status).toBe(401);

    const plaintextAttempt = await fetch(`${baseUrl}/v1/relay/envelopes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ plaintext: "do-not-echo-this" }),
    });
    expect(plaintextAttempt.status).toBe(400);
    expect(await plaintextAttempt.text()).not.toContain("do-not-echo-this");

    const setup = setupDevices();
    const client = new RemoteRelayHttpClient({ baseUrl, accessToken: ACCESS_TOKEN });
    const envelope = sealRemoteEnvelope({
      plaintext: "ciphertext",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    await client.publish(envelope);
    await expect(client.publish({
      ...envelope,
      ciphertext: tamperBase64Url(envelope.ciphertext),
    })).rejects.toMatchObject<Partial<RemoteRelayHttpError>>({ status: 409 });
  });

  it("wakes long polls and enforces queue capacity and expiry", async () => {
    let now = new Date(NOW).getTime();
    const store = new InMemoryRelayStore({
      maxItemsPerInbox: 1,
      ttlMs: 1_000,
      now: () => now,
    });
    const { baseUrl } = await startRelay(store);
    const setup = setupDevices();
    const client = new RemoteRelayHttpClient({ baseUrl, accessToken: ACCESS_TOKEN });
    const first = sealRemoteEnvelope({
      plaintext: "one",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    const waiting = client.poll({
      accountId: setup.account.accountId,
      deviceId: setup.host.deviceId,
      afterCursor: 0,
      waitMs: 1_000,
    });
    await client.publish(first);
    expect((await waiting).items).toHaveLength(1);

    const second = sealRemoteEnvelope({
      plaintext: "two",
      contentType: "text/plain",
      sequence: 2,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    expect(() => store.publish(second)).toThrow(RemoteRelayCapacityError);
    now += 1_001;
    expect(store.list(setup.account.accountId, setup.host.deviceId, 0, 25).items).toEqual([]);
    expect(store.stats().queuedEnvelopes).toBe(0);
  });

  it("bounds total queue, cursor, deduplication and long-poll metadata", async () => {
    const setup = setupDevices();
    const first = sealRemoteEnvelope({
      plaintext: "one",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    const secondRecipient = sealRemoteEnvelope({
      plaintext: "two",
      contentType: "text/plain",
      sequence: 2,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.otherCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });

    const totalStore = new InMemoryRelayStore({
      maxItemsPerInbox: 1,
      maxTotalItems: 1,
    });
    totalStore.publish(first);
    expect(() => totalStore.publish(secondRecipient)).toThrow(/total queue capacity/i);

    const cursorStore = new InMemoryRelayStore({
      maxItemsPerInbox: 1,
      maxTotalItems: 10,
      maxInboxStates: 1,
      maxSeenMessages: 10,
    });
    cursorStore.publish(first);
    cursorStore.acknowledge(setup.account.accountId, setup.host.deviceId, 1);
    expect(() => cursorStore.publish(secondRecipient)).toThrow(/inbox-state capacity/i);

    const seenStore = new InMemoryRelayStore({
      maxItemsPerInbox: 1,
      maxTotalItems: 10,
      maxSeenMessages: 1,
    });
    seenStore.publish(first);
    seenStore.acknowledge(setup.account.accountId, setup.host.deviceId, 1);
    expect(() => seenStore.publish(secondRecipient)).toThrow(/deduplication capacity/i);

    const waiterStore = new InMemoryRelayStore({ maxWaiters: 1 });
    const controller = new AbortController();
    const firstWaiter = waiterStore.waitForItems({
      accountId: setup.account.accountId,
      deviceId: setup.host.deviceId,
      afterCursor: 0,
      waitMs: 1_000,
      signal: controller.signal,
    });
    await expect(waiterStore.waitForItems({
      accountId: setup.account.accountId,
      deviceId: setup.other.deviceId,
      afterCursor: 0,
      waitMs: 1_000,
    })).rejects.toThrow(/long-poll capacity/i);
    controller.abort();
    await firstWaiter;

    const byteStore = new InMemoryRelayStore({
      maxBytesPerInbox: 1_024,
      maxTotalBytes: 1_024,
    });
    const oversized = sealRemoteEnvelope({
      plaintext: "x".repeat(2_000),
      contentType: "text/plain",
      sequence: 3,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    expect(() => byteStore.publish(oversized)).toThrow(/inbox byte capacity/i);
  });
});
