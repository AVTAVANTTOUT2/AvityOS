import { describe, expect, it } from "vitest";
import type {
  RemoteEncryptedEnvelope,
  RemoteRelayAckResult,
  RemoteRelayInbox,
  RemoteRelayPublishResult,
} from "@avityos/contracts";
import {
  RemoteOutboundConnector,
  RemoteRelayHttpClient,
  createDurableRemoteOutboundConnector,
  generateRemoteAccountIdentity,
  generateRemoteDeviceIdentity,
  issueRemoteDeviceCertificate,
  openRemoteEnvelope,
  sealRemoteEnvelope,
  type RemoteConnectorPersistedState,
  type RemoteRelayClient,
} from "./index.js";

const NOW = "2026-07-24T10:00:00.000Z";
const ACCESS_TOKEN = "client-test-token-".padEnd(32, "x");

function setupDevices() {
  const account = generateRemoteAccountIdentity();
  const host = generateRemoteDeviceIdentity();
  const remote = generateRemoteDeviceIdentity();
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
  return { account, host, remote, hostCertificate, remoteCertificate };
}

describe("remote relay HTTP client", () => {
  it("requires safe transport and keeps bearer credentials out of URLs", async () => {
    expect(() => new RemoteRelayHttpClient({
      baseUrl: "http://relay.example",
      accessToken: ACCESS_TOKEN,
    })).toThrow(/HTTPS/i);
    expect(() => new RemoteRelayHttpClient({
      baseUrl: `https://user:password@relay.example`,
      accessToken: ACCESS_TOKEN,
    })).toThrow(/credentials/i);
    expect(() => new RemoteRelayHttpClient({
      baseUrl: "https://relay.example",
      accessToken: "x".repeat(31) + " ",
    })).toThrow(/non-whitespace/i);

    const setup = setupDevices();
    const envelope = sealRemoteEnvelope({
      plaintext: "opaque",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    let requestUrl = "";
    let authorization = "";
    const client = new RemoteRelayHttpClient({
      baseUrl: "https://relay.example/bridge",
      accessToken: ACCESS_TOKEN,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requestUrl = request.url;
        authorization = request.headers.get("authorization") ?? "";
        return new Response(JSON.stringify({
          messageId: envelope.messageId,
          acceptedAt: NOW,
          duplicate: false,
        }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.publish(envelope);
    expect(requestUrl).toBe("https://relay.example/bridge/v1/relay/envelopes");
    expect(requestUrl).not.toContain(ACCESS_TOKEN);
    expect(authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });
});

describe("outbound connector delivery state", () => {
  it("fails closed for locally revoked host and sender devices", async () => {
    const setup = setupDevices();
    const inbound = sealRemoteEnvelope({
      plaintext: "must-not-run",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    const relay: RemoteRelayClient = {
      async publish(envelope): Promise<RemoteRelayPublishResult> {
        return { messageId: envelope.messageId, acceptedAt: NOW, duplicate: false };
      },
      async poll(): Promise<RemoteRelayInbox> {
        return {
          items: [{ cursor: 1, receivedAt: NOW, envelope: inbound }],
          nextCursor: 1,
        };
      },
      async acknowledge(input): Promise<RemoteRelayAckResult> {
        return { throughCursor: input.throughCursor, deleted: 1 };
      },
    };
    const activeDevices = new Set([setup.host.deviceId, setup.remote.deviceId]);
    const stateStore = {
      isDeviceActive: (deviceId: string) => activeDevices.has(deviceId),
      loadConnectorState: () => null,
      saveConnectorState: () => undefined,
      appendRemoteAction: () => undefined,
    };
    const connectorOptions = {
      relay,
      identity: setup.host,
      certificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      resolveSenderCertificate: () => setup.remoteCertificate,
      handleRequest: () => {
        throw new Error("handler must not run");
      },
      classifyAction: () => "project.pause",
      stateStore,
      pollWaitMs: 0,
      now: () => new Date(NOW),
    };

    activeDevices.delete(setup.host.deviceId);
    expect(() => createDurableRemoteOutboundConnector(connectorOptions)).toThrow(
      /local remote-bridge device is not active/i,
    );

    activeDevices.add(setup.host.deviceId);
    const connector = createDurableRemoteOutboundConnector(connectorOptions);
    activeDevices.delete(setup.remote.deviceId);
    await expect(connector.processOnce()).rejects.toThrow(
      /remote sender device is not active/i,
    );
  });

  it("retries an ambiguous acknowledgement without rerunning the handler or response", async () => {
    const setup = setupDevices();
    const inbound = sealRemoteEnvelope({
      plaintext: "perform-local-action",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    let acknowledged = false;
    let acknowledgementAttempts = 0;
    const published: RemoteEncryptedEnvelope[] = [];
    const relay: RemoteRelayClient = {
      async publish(envelope): Promise<RemoteRelayPublishResult> {
        published.push(envelope);
        return {
          messageId: envelope.messageId,
          acceptedAt: NOW,
          duplicate: false,
        };
      },
      async poll(input): Promise<RemoteRelayInbox> {
        return {
          items: !acknowledged && input.afterCursor < 1
            ? [{ cursor: 1, receivedAt: NOW, envelope: inbound }]
            : [],
          nextCursor: !acknowledged && input.afterCursor < 1 ? 1 : input.afterCursor,
        };
      },
      async acknowledge(input): Promise<RemoteRelayAckResult> {
        acknowledgementAttempts += 1;
        if (acknowledgementAttempts === 1) {
          throw new Error("simulated response loss after relay acknowledgement");
        }
        acknowledged = true;
        return { throughCursor: input.throughCursor, deleted: 0 };
      },
    };
    let handlerCalls = 0;
    const auditActions: string[] = [];
    let persistedState: RemoteConnectorPersistedState | null = null;
    const connector = new RemoteOutboundConnector({
      relay,
      identity: setup.host,
      certificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      resolveSenderCertificate: () => setup.remoteCertificate,
      handleRequest: () => {
        handlerCalls += 1;
        return { plaintext: "completed", contentType: "text/plain" };
      },
      pollWaitMs: 0,
      now: () => new Date(NOW),
      persistState: (state) => {
        persistedState = structuredClone(state);
      },
      classifyAction: () => "project.pause",
      recordAudit: (event) => {
        auditActions.push(`${event.action}:${event.outcome}`);
        expect(JSON.stringify(event)).not.toContain("perform-local-action");
      },
    });

    await expect(connector.processOnce()).rejects.toThrow(/simulated response loss/i);
    expect(connector.state.deliveryPending).toBe(true);
    expect(handlerCalls).toBe(1);
    expect(published).toHaveLength(1);
    expect(auditActions).toEqual(["project.pause:accepted"]);

    expect(persistedState).not.toBeNull();
    const restartedConnector = new RemoteOutboundConnector({
      relay,
      identity: setup.host,
      certificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      resolveSenderCertificate: () => setup.remoteCertificate,
      handleRequest: () => {
        handlerCalls += 1;
        return { plaintext: "must-not-run", contentType: "text/plain" };
      },
      initialPersistedState: persistedState!,
      persistState: (state) => {
        persistedState = structuredClone(state);
      },
      classifyAction: () => "must-not-classify",
      recordAudit: (event) => {
        auditActions.push(`${event.action}:${event.outcome}`);
      },
      pollWaitMs: 0,
      now: () => new Date(NOW),
    });
    expect(await restartedConnector.processOnce()).toBe(1);
    expect(restartedConnector.state).toMatchObject({
      relayCursor: 1,
      deliveryPending: false,
    });
    expect(handlerCalls).toBe(1);
    expect(published).toHaveLength(1);
    expect(acknowledgementAttempts).toBe(2);
    expect(auditActions).toEqual(["project.pause:accepted"]);

    const opened = openRemoteEnvelope({
      envelope: published[0],
      recipientIdentity: setup.remote,
      recipientCertificate: setup.remoteCertificate,
      senderCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      lastAcceptedSequence: 0,
      now: NOW,
    });
    expect(opened.plaintext.toString("utf8")).toBe("completed");
  });

  it("rejects a missing relay cursor before decrypting or running the handler", async () => {
    const setup = setupDevices();
    const inbound = sealRemoteEnvelope({
      plaintext: "must-not-run",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: setup.remote,
      senderCertificate: setup.remoteCertificate,
      recipientCertificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    let handlerCalls = 0;
    let acknowledgementCalls = 0;
    const relay: RemoteRelayClient = {
      async publish(envelope): Promise<RemoteRelayPublishResult> {
        return { messageId: envelope.messageId, acceptedAt: NOW, duplicate: false };
      },
      async poll(): Promise<RemoteRelayInbox> {
        return {
          items: [{ cursor: 2, receivedAt: NOW, envelope: inbound }],
          nextCursor: 2,
        };
      },
      async acknowledge(input): Promise<RemoteRelayAckResult> {
        acknowledgementCalls += 1;
        return { throughCursor: input.throughCursor, deleted: 0 };
      },
    };
    const connector = new RemoteOutboundConnector({
      relay,
      identity: setup.host,
      certificate: setup.hostCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      resolveSenderCertificate: () => setup.remoteCertificate,
      handleRequest: () => {
        handlerCalls += 1;
        return null;
      },
      pollWaitMs: 0,
      now: () => new Date(NOW),
    });

    await expect(connector.processOnce()).rejects.toThrow(/missing or reordered cursor/i);
    expect(handlerCalls).toBe(0);
    expect(acknowledgementCalls).toBe(0);
  });
});
