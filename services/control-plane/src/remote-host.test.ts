import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_BRIDGE_PROTOCOL_VERSION,
  REMOTE_CONTROL_REQUEST_CONTENT_TYPE,
  REMOTE_CONTROL_RESPONSE_CONTENT_TYPE,
  RemoteControlResponse,
  type RemoteDeviceCertificate,
  type RemoteEncryptedEnvelope,
  type RemoteRelayAckResult,
  type RemoteRelayInbox,
  type RemoteRelayPublishResult,
} from "@avityos/contracts";
import {
  RemoteBridgeStateStore,
  createRemotePairingRequest,
  generateRemoteDeviceIdentity,
  openRemoteEnvelope,
  openRemotePairingBootstrap,
  sealRemoteEnvelope,
  type RemoteRelayClient,
} from "@avityos/remote-bridge";
import {
  RemoteHostManager,
  type RemoteHostRelayFactory,
  type RemoteHostSecretConfiguration,
  type RemoteHostSecretStore,
} from "./remote-host.js";

const NOW = "2026-07-24T13:00:00.000Z";
const RELAY_URL = "https://relay.example/bridge";
const ADMIN_TOKEN = "relay-admin-token-".padEnd(32, "x");

class MemorySecretStore implements RemoteHostSecretStore {
  value: RemoteHostSecretConfiguration | null = null;

  load(): RemoteHostSecretConfiguration | null {
    return this.value;
  }

  save(configuration: RemoteHostSecretConfiguration): void {
    this.value = structuredClone(configuration);
  }
}

interface RelayDevice {
  certificate: RemoteDeviceCertificate;
  token: string;
  status: "active" | "revoked";
}

class AuthenticatedMemoryRelay {
  readonly devices = new Map<string, RelayDevice>();
  private readonly queues = new Map<
    string,
    { nextCursor: number; items: Array<{ cursor: number; envelope: RemoteEncryptedEnvelope }> }
  >();

  readonly factory: RemoteHostRelayFactory = {
    data: (_baseUrl, token) => this.client(token),
    admin: () => ({
      registerDevice: async (certificate, accessToken) => {
        this.devices.set(certificate.deviceId, {
          certificate,
          token: accessToken,
          status: "active",
        });
        return { status: "active" };
      },
      revokeDevice: async (accountId, deviceId) => {
        const device = this.devices.get(deviceId);
        if (!device || device.certificate.accountId !== accountId) {
          throw new Error("relay device not found");
        }
        device.status = "revoked";
        return { status: "revoked" };
      },
    }),
  };

  client(token: string): RemoteRelayClient {
    return {
      publish: async (envelope): Promise<RemoteRelayPublishResult> => {
        const sender = this.authenticate(token, envelope.senderDeviceId);
        const recipient = this.devices.get(envelope.recipientDeviceId);
        if (
          sender.certificate.accountId !== envelope.accountId ||
          !recipient ||
          recipient.status !== "active" ||
          recipient.certificate.accountId !== envelope.accountId
        ) {
          throw new Error("relay routing denied");
        }
        const queue = this.queues.get(envelope.recipientDeviceId) ?? {
          nextCursor: 0,
          items: [],
        };
        queue.nextCursor += 1;
        queue.items.push({ cursor: queue.nextCursor, envelope });
        this.queues.set(envelope.recipientDeviceId, queue);
        return {
          messageId: envelope.messageId,
          acceptedAt: NOW,
          duplicate: false,
        };
      },
      poll: async (input): Promise<RemoteRelayInbox> => {
        this.authenticate(token, input.deviceId);
        const queue = this.queues.get(input.deviceId);
        const items = (queue?.items ?? [])
          .filter((item) => item.cursor > input.afterCursor)
          .map((item) => ({
            cursor: item.cursor,
            receivedAt: NOW,
            envelope: item.envelope,
          }));
        return {
          items,
          nextCursor: items.at(-1)?.cursor ?? input.afterCursor,
        };
      },
      acknowledge: async (input): Promise<RemoteRelayAckResult> => {
        this.authenticate(token, input.deviceId);
        const queue = this.queues.get(input.deviceId);
        const before = queue?.items.length ?? 0;
        if (queue) {
          queue.items = queue.items.filter(
            (item) => item.cursor > input.throughCursor,
          );
        }
        return {
          throughCursor: input.throughCursor,
          deleted: before - (queue?.items.length ?? 0),
        };
      },
    };
  }

  private authenticate(token: string, deviceId: string): RelayDevice {
    const device = this.devices.get(deviceId);
    if (!device || device.token !== token || device.status !== "active") {
      throw new Error("relay authentication denied");
    }
    return device;
  }
}

interface PairedRemote {
  identity: ReturnType<typeof generateRemoteDeviceIdentity>;
  certificate: RemoteDeviceCertificate;
  hostCertificate: RemoteDeviceCertificate;
  accountSigningPublicKey: string;
  accessToken: string;
}

const managers: RemoteHostManager[] = [];
const stores: RemoteBridgeStateStore[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  for (const store of stores.splice(0)) store.close();
});

function createHarness(
  dispatch: ConstructorParameters<typeof RemoteHostManager>[0]["dispatch"] = async () => ({
    status: 200,
    body: { items: [] },
  }),
) {
  const stateStore = new RemoteBridgeStateStore(":memory:");
  const secretStore = new MemorySecretStore();
  const relay = new AuthenticatedMemoryRelay();
  const manager = new RemoteHostManager({
    stateStore,
    secretStore,
    relayFactory: relay.factory,
    dispatch,
    now: () => new Date(NOW),
    pollWaitMs: 0,
    autoStartConnector: false,
  });
  managers.push(manager);
  stores.push(stateStore);
  return { manager, stateStore, secretStore, relay };
}

async function configureAndPair(
  manager: RemoteHostManager,
): Promise<PairedRemote> {
  await manager.configure({
    relayUrl: RELAY_URL,
    relayAdminToken: ADMIN_TOKEN,
    deviceName: "Host Mac",
  });
  const bundleResponse = manager.createPairing();
  const bundle = JSON.parse(bundleResponse.pairingBundle) as {
    offer: {
      accountSigningPublicKey: string;
      hostCertificate: RemoteDeviceCertificate;
    };
    pairingSecret: string;
  };
  const identity = generateRemoteDeviceIdentity();
  const request = createRemotePairingRequest({
    offer: bundle.offer as Parameters<typeof createRemotePairingRequest>[0]["offer"],
    pairingSecret: bundle.pairingSecret,
    device: identity,
    name: "Remote Mac",
    now: NOW,
  });
  const accepted = await manager.acceptPairing(
    bundleResponse.sessionId,
    JSON.stringify(request),
  );
  const opened = openRemotePairingBootstrap({
    offer: bundle.offer as Parameters<typeof openRemotePairingBootstrap>[0]["offer"],
    bootstrap: JSON.parse(accepted.bootstrap),
    pairingSecret: bundle.pairingSecret,
    device: identity,
    now: NOW,
  });
  return {
    identity,
    certificate: opened.certificate,
    hostCertificate: bundle.offer.hostCertificate,
    accountSigningPublicKey: bundle.offer.accountSigningPublicKey,
    accessToken: opened.relayAccessToken,
  };
}

describe("native remote host lifecycle", () => {
  it("fails closed when the protected Keychain configuration is corrupt", async () => {
    const { manager, secretStore } = createHarness();
    secretStore.value = {
      relayUrl: RELAY_URL,
    } as RemoteHostSecretConfiguration;

    await manager.start();

    expect(manager.status()).toMatchObject({
      configured: false,
      connectorState: "degraded",
    });
    expect(manager.status().lastError).toMatch(/required|invalid/i);
  });

  it("bounds simultaneous one-time pairing sessions", async () => {
    const { manager } = createHarness();
    await manager.configure({
      relayUrl: RELAY_URL,
      relayAdminToken: ADMIN_TOKEN,
      deviceName: "Host Mac",
    });
    for (let index = 0; index < 8; index += 1) manager.createPairing();

    expect(() => manager.createPairing()).toThrow(/maximum of 8/i);
  });

  it("keeps durable secrets outside SQLite and pairs/revokes a device", async () => {
    const { manager, secretStore, relay } = createHarness();
    const paired = await configureAndPair(manager);

    expect(secretStore.value?.account.signingPrivateKey).toBeTruthy();
    expect(secretStore.value?.hostIdentity.agreementPrivateKey).toBeTruthy();
    expect(JSON.stringify(manager.status())).not.toContain(ADMIN_TOKEN);
    expect(manager.status()).toMatchObject({
      configured: true,
      connectorState: "stopped",
      relayUrl: RELAY_URL,
    });
    expect(manager.status().devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Host Mac", isHost: true, status: "active" }),
      expect.objectContaining({ name: "Remote Mac", isHost: false, status: "active" }),
    ]));
    expect(relay.devices.get(paired.certificate.deviceId)?.token)
      .toBe(paired.accessToken);

    await manager.revokeDevice(paired.certificate.deviceId);
    expect(manager.status().devices).toContainEqual(expect.objectContaining({
      deviceId: paired.certificate.deviceId,
      status: "revoked",
    }));
    expect(relay.devices.get(paired.certificate.deviceId)?.status).toBe("revoked");
    await expect(manager.revokeDevice(
      secretStore.value!.hostIdentity.deviceId,
    )).rejects.toThrow(/cannot revoke itself/i);
    await expect(manager.configure({
      relayUrl: "https://other-relay.example",
      relayAdminToken: ADMIN_TOKEN,
      deviceName: "Host Mac",
    })).rejects.toThrow(/migration.*reset/i);
  });

  it("decrypts only allowlisted control requests and returns an encrypted response", async () => {
    const dispatched: Array<{ method: string; path: string }> = [];
    const { manager, relay, stateStore } = createHarness(async (request) => {
      dispatched.push({ method: request.method, path: request.path });
      return { status: 200, body: { items: [{ id: "prj_demo" }] } };
    });
    const paired = await configureAndPair(manager);
    const remoteRelay = relay.client(paired.accessToken);
    const requestEnvelope = sealRemoteEnvelope({
      plaintext: JSON.stringify({
        protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
        requestId: `rreq_${"a".repeat(32)}`,
        method: "GET",
        path: "/v1/projects",
      }),
      contentType: REMOTE_CONTROL_REQUEST_CONTENT_TYPE,
      sequence: 1,
      senderIdentity: paired.identity,
      senderCertificate: paired.certificate,
      recipientCertificate: paired.hostCertificate,
      accountSigningPublicKey: paired.accountSigningPublicKey,
      sentAt: NOW,
    });
    await remoteRelay.publish(requestEnvelope);

    expect(await manager.processOnce()).toBe(1);
    expect(dispatched).toEqual([{ method: "GET", path: "/v1/projects" }]);
    const responseInbox = await remoteRelay.poll({
      accountId: paired.certificate.accountId,
      deviceId: paired.certificate.deviceId,
      afterCursor: 0,
      waitMs: 0,
    });
    expect(responseInbox.items).toHaveLength(1);
    const opened = openRemoteEnvelope({
      envelope: responseInbox.items[0]!.envelope,
      recipientIdentity: paired.identity,
      recipientCertificate: paired.certificate,
      senderCertificate: paired.hostCertificate,
      accountSigningPublicKey: paired.accountSigningPublicKey,
      lastAcceptedSequence: 0,
      now: NOW,
    });
    expect(opened.contentType).toBe(REMOTE_CONTROL_RESPONSE_CONTENT_TYPE);
    expect(RemoteControlResponse.parse(
      JSON.parse(opened.plaintext.toString("utf8")),
    )).toEqual({
      protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
      requestId: `rreq_${"a".repeat(32)}`,
      status: 200,
      body: { items: [{ id: "prj_demo" }] },
    });

    const deniedEnvelope = sealRemoteEnvelope({
      plaintext: JSON.stringify({
        protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
        requestId: `rreq_${"b".repeat(32)}`,
        method: "POST",
        path: "/v1/projects",
        body: { name: "must not be created" },
      }),
      contentType: REMOTE_CONTROL_REQUEST_CONTENT_TYPE,
      sequence: 2,
      senderIdentity: paired.identity,
      senderCertificate: paired.certificate,
      recipientCertificate: paired.hostCertificate,
      accountSigningPublicKey: paired.accountSigningPublicKey,
      sentAt: NOW,
    });
    await remoteRelay.publish(deniedEnvelope);
    await expect(manager.processOnce()).rejects.toThrow(/not allowed/i);
    expect(dispatched).toHaveLength(1);
    expect(stateStore.verifyAuditChain()).toBe(true);
  });
});
