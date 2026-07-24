import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  REMOTE_BRIDGE_PROTOCOL_VERSION,
  REMOTE_CONTROL_REQUEST_CONTENT_TYPE,
  REMOTE_CONTROL_RESPONSE_CONTENT_TYPE,
  RemoteControlRequest,
  RemoteControlResponse,
  RemoteAccountId,
  RemoteDeviceCertificate as RemoteDeviceCertificateSchema,
  RemoteDeviceId,
  RemoteHostStatus,
  RemotePairingRequest,
  ResolveApprovalRequest,
  type RemoteControlRequest as RemoteControlRequestType,
  type RemoteDeviceCertificate,
  type RemoteHostStatus as RemoteHostStatusType,
  type RemotePairingBootstrapResponse,
  type RemotePairingBundleResponse,
} from "@avityos/contracts";
import {
  RemoteBridgeStateStore,
  RemoteRelayAdminHttpClient,
  RemoteRelayHttpClient,
  acceptRemotePairingRequest,
  createDurableRemoteOutboundConnector,
  createRemotePairingBootstrap,
  createRemotePairingSession,
  generateRemoteAccountIdentity,
  generateRemoteDeviceIdentity,
  issueRemoteDeviceCertificate,
  type RemoteAccountIdentity,
  type RemoteDeviceIdentity,
  type RemoteOutboundConnector,
  type RemoteRelayClient,
} from "@avityos/remote-bridge";

const MAX_REMOTE_REQUEST_BYTES = 1024 * 1024;
const MAX_PAIRING_REQUEST_BYTES = 128 * 1024;
const MAX_ACTIVE_PAIRINGS = 8;
const DEFAULT_POLL_WAIT_MS = 25_000;
const KeyMaterial = z.string().min(40).max(2_048).regex(/^[A-Za-z0-9_-]+$/);

const RemoteHostSecretConfigurationSchema = z.object({
  relayUrl: z.string().trim().min(1).max(2_048),
  relayAdminToken: z.string().min(32).max(4_096).regex(/^\S+$/),
  hostDeviceToken: z.string().min(32).max(4_096).regex(/^\S+$/),
  account: z.object({
    accountId: RemoteAccountId,
    signingPublicKey: KeyMaterial,
    signingPrivateKey: KeyMaterial,
  }).strict(),
  hostIdentity: z.object({
    deviceId: RemoteDeviceId,
    signingPublicKey: KeyMaterial,
    signingPrivateKey: KeyMaterial,
    agreementPublicKey: KeyMaterial,
    agreementPrivateKey: KeyMaterial,
  }).strict(),
  hostCertificate: RemoteDeviceCertificateSchema,
}).strict();

export interface RemoteHostSecretConfiguration {
  readonly relayUrl: string;
  readonly relayAdminToken: string;
  readonly hostDeviceToken: string;
  readonly account: RemoteAccountIdentity;
  readonly hostIdentity: RemoteDeviceIdentity;
  readonly hostCertificate: RemoteDeviceCertificate;
}

export interface RemoteHostSecretStore {
  load(): RemoteHostSecretConfiguration | null;
  save(configuration: RemoteHostSecretConfiguration): void;
}

export interface RemoteHostRelayAdmin {
  registerDevice(
    certificate: RemoteDeviceCertificate,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  revokeDevice(
    accountId: string,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface RemoteHostRelayFactory {
  data(baseUrl: string, accessToken: string): RemoteRelayClient;
  admin(baseUrl: string, accessToken: string): RemoteHostRelayAdmin;
}

export interface RemoteControlDispatchResult {
  readonly status: number;
  readonly body: unknown;
}

export type RemoteControlDispatcher = (
  request: RemoteControlRequestType,
) => Promise<RemoteControlDispatchResult>;

export interface RemoteHostManagerOptions {
  readonly stateStore: RemoteBridgeStateStore;
  readonly secretStore: RemoteHostSecretStore;
  readonly dispatch: RemoteControlDispatcher;
  readonly relayFactory?: RemoteHostRelayFactory;
  readonly now?: () => Date;
  readonly pollWaitMs?: number;
  readonly autoStartConnector?: boolean;
}

interface PendingPairing {
  readonly pairingSecret: string;
  readonly expiresAt: string;
  requestFingerprint?: string;
  bootstrap?: string;
}

export class RemoteControlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteControlPolicyError";
  }
}

export const DEFAULT_REMOTE_HOST_RELAY_FACTORY: RemoteHostRelayFactory = {
  data: (baseUrl, accessToken) => new RemoteRelayHttpClient({
    baseUrl,
    accessToken,
  }),
  admin: (baseUrl, accessToken) => new RemoteRelayAdminHttpClient({
    baseUrl,
    accessToken,
  }),
};

function actionForRequest(request: RemoteControlRequestType): string {
  if (request.method === "GET") {
    if (request.path === "/v1/health") return "health.read";
    if (request.path === "/v1/projects") return "project.list";
    if (/^\/v1\/projects\/prj_[a-f0-9]{20}$/.test(request.path)) {
      return "project.read";
    }
    if (/^\/v1\/projects\/prj_[a-f0-9]{20}\/missions$/.test(request.path)) {
      return "mission.list";
    }
    if (request.path === "/v1/approvals?status=open") return "approval.list";
    if (request.path === "/v1/runs") return "run.list";
    if (request.path === "/v1/terminals") return "terminal.list";
    if (/^\/v1\/terminals\/trm_[a-f0-9]{20}$/.test(request.path)) {
      return "terminal.read";
    }
  }
  if (
    request.method === "POST" &&
    /^\/v1\/approvals\/apr_[a-f0-9]{20}\/resolve$/.test(request.path)
  ) {
    ResolveApprovalRequest.parse(request.body);
    return "approval.resolve";
  }
  throw new RemoteControlPolicyError(
    `remote control action is not allowed: ${request.method} ${request.path}`,
  );
}

function parseRemoteControlPayload(
  plaintext: Buffer,
  contentType: string,
): RemoteControlRequestType {
  if (contentType !== REMOTE_CONTROL_REQUEST_CONTENT_TYPE) {
    throw new RemoteControlPolicyError("unsupported remote control content type");
  }
  if (plaintext.byteLength > MAX_REMOTE_REQUEST_BYTES) {
    throw new RemoteControlPolicyError("remote control request exceeds 1 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new RemoteControlPolicyError("remote control request is not valid JSON");
  }
  return RemoteControlRequest.parse(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unexpected remote host error";
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function randomAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class RemoteHostManager {
  private readonly relayFactory: RemoteHostRelayFactory;
  private readonly now: () => Date;
  private readonly pollWaitMs: number;
  private readonly autoStartConnector: boolean;
  private readonly pendingPairings = new Map<string, PendingPairing>();
  private configuration: RemoteHostSecretConfiguration | null = null;
  private connector: RemoteOutboundConnector | null = null;
  private connectorAbort: AbortController | null = null;
  private connectorLoop: Promise<void> | null = null;
  private connectorState: RemoteHostStatusType["connectorState"] = "unconfigured";
  private lastError: string | null = null;

  constructor(private readonly options: RemoteHostManagerOptions) {
    this.relayFactory = options.relayFactory ?? DEFAULT_REMOTE_HOST_RELAY_FACTORY;
    this.now = options.now ?? (() => new Date());
    this.pollWaitMs = options.pollWaitMs ?? DEFAULT_POLL_WAIT_MS;
    this.autoStartConnector = options.autoStartConnector ?? true;
  }

  async start(): Promise<void> {
    try {
      const loaded = this.options.secretStore.load();
      this.configuration = loaded
        ? RemoteHostSecretConfigurationSchema.parse(loaded)
        : null;
      if (!this.configuration) {
        this.connectorState = "unconfigured";
        return;
      }
      this.buildConnector();
      this.lastError = null;
      if (this.autoStartConnector) this.startConnectorLoop();
    } catch (error) {
      this.connectorState = "degraded";
      this.lastError = safeError(error);
    }
  }

  async stop(): Promise<void> {
    this.connectorAbort?.abort();
    await this.connectorLoop;
    this.connectorAbort = null;
    this.connectorLoop = null;
    this.connector = null;
    this.connectorState = this.configuration ? "stopped" : "unconfigured";
  }

  status(): RemoteHostStatusType {
    const configuration = this.configuration;
    const devices = configuration
      ? this.options.stateStore.listDevices(configuration.account.accountId).map((device) => ({
          deviceId: device.certificate.deviceId,
          name: device.certificate.name,
          status: device.status,
          validUntil: device.certificate.validUntil,
          isHost: device.certificate.deviceId === configuration.hostIdentity.deviceId,
        }))
      : [];
    return RemoteHostStatus.parse({
      supported: true,
      configured: configuration !== null,
      connectorState: this.connectorState,
      relayUrl: configuration?.relayUrl ?? null,
      accountId: configuration?.account.accountId ?? null,
      hostDeviceId: configuration?.hostIdentity.deviceId ?? null,
      devices,
      lastError: this.lastError,
    });
  }

  async configure(input: {
    readonly relayUrl: string;
    readonly relayAdminToken: string;
    readonly deviceName: string;
  }): Promise<RemoteHostStatusType> {
    const stored = this.options.secretStore.load();
    const previous = this.configuration ?? (
      stored ? RemoteHostSecretConfigurationSchema.parse(stored) : null
    );
    if (previous && input.relayUrl !== previous.relayUrl) {
      throw new RemoteControlPolicyError(
        "relay migration requires an explicit reset and re-pairing workflow",
      );
    }
    const account = previous?.account ?? generateRemoteAccountIdentity();
    const hostIdentity = previous?.hostIdentity ?? generateRemoteDeviceIdentity();
    const hostDeviceToken = previous?.hostDeviceToken ?? randomAccessToken();
    const hostCertificate = issueRemoteDeviceCertificate({
      account,
      device: hostIdentity,
      name: input.deviceName,
      issuedAt: this.now(),
    });
    const admin = this.relayFactory.admin(input.relayUrl, input.relayAdminToken);
    // Validate remote authorization before replacing the durable local
    // configuration. Re-enrollment is intentionally idempotent and rotates
    // the host device credential on the relay.
    await admin.registerDevice(hostCertificate, hostDeviceToken);

    this.options.stateStore.registerAccount(
      account.accountId,
      account.signingPublicKey,
      this.now().getTime(),
    );
    this.options.stateStore.registerDevice(hostCertificate, this.now().getTime());
    const configuration: RemoteHostSecretConfiguration = {
      relayUrl: input.relayUrl,
      relayAdminToken: input.relayAdminToken,
      hostDeviceToken,
      account,
      hostIdentity,
      hostCertificate,
    };
    this.options.secretStore.save(configuration);
    this.configuration = configuration;
    await this.restartConnector();
    this.lastError = null;
    return this.status();
  }

  createPairing(): RemotePairingBundleResponse {
    const configuration = this.requireConfiguration();
    this.pruneExpiredPairings();
    if (this.pendingPairings.size >= MAX_ACTIVE_PAIRINGS) {
      throw new RemoteControlPolicyError(
        "remote host already has the maximum of 8 active pairing sessions",
      );
    }
    const pairing = createRemotePairingSession({
      account: configuration.account,
      hostIdentity: configuration.hostIdentity,
      hostCertificate: configuration.hostCertificate,
      now: this.now(),
    });
    const pairingBundle = JSON.stringify(pairing.bundle);
    this.options.stateStore.savePairingSession(pairing.session, this.now().getTime());
    this.pendingPairings.set(pairing.session.sessionId, {
      pairingSecret: pairing.bundle.pairingSecret,
      expiresAt: pairing.session.expiresAt,
    });
    return {
      sessionId: pairing.session.sessionId,
      expiresAt: pairing.session.expiresAt,
      pairingBundle,
    };
  }

  async acceptPairing(
    sessionId: string,
    requestJson: string,
  ): Promise<RemotePairingBootstrapResponse> {
    const configuration = this.requireConfiguration();
    this.pruneExpiredPairings();
    if (Buffer.byteLength(requestJson) > MAX_PAIRING_REQUEST_BYTES) {
      throw new RemoteControlPolicyError("pairing request exceeds 128 KiB");
    }
    const pending = this.pendingPairings.get(sessionId);
    if (!pending) {
      throw new RemoteControlPolicyError(
        "pairing session is not active in this host process",
      );
    }
    let requestValue: unknown;
    try {
      requestValue = JSON.parse(requestJson);
    } catch {
      throw new RemoteControlPolicyError("pairing request is not valid JSON");
    }
    const request = RemotePairingRequest.parse(requestValue);
    if (request.sessionId !== sessionId) {
      throw new RemoteControlPolicyError(
        "pairing request does not match the selected session",
      );
    }
    const requestFingerprint = fingerprint(JSON.stringify(request));
    if (pending.bootstrap) {
      if (pending.requestFingerprint !== requestFingerprint) {
        throw new RemoteControlPolicyError(
          "pairing session was already completed by another request",
        );
      }
      return { sessionId, bootstrap: pending.bootstrap };
    }
    const session = this.options.stateStore.getPairingSession(sessionId);
    if (!session) throw new RemoteControlPolicyError("pairing session not found");
    const accepted = acceptRemotePairingRequest({
      session,
      request,
      pairingSecret: pending.pairingSecret,
      account: configuration.account,
      now: this.now(),
    });
    const remoteDeviceToken = randomAccessToken();
    const admin = this.relayFactory.admin(
      configuration.relayUrl,
      configuration.relayAdminToken,
    );
    await admin.registerDevice(accepted.certificate, remoteDeviceToken);
    const bootstrap = JSON.stringify(createRemotePairingBootstrap({
      acceptance: accepted.acceptance,
      pairingSecret: pending.pairingSecret,
      relayUrl: configuration.relayUrl,
      relayAccessToken: remoteDeviceToken,
    }));
    try {
      this.options.stateStore.completePairingSession(
        sessionId,
        accepted.certificate,
        this.now().getTime(),
      );
    } catch (error) {
      await admin.revokeDevice(
        accepted.certificate.accountId,
        accepted.certificate.deviceId,
      ).catch(() => undefined);
      throw error;
    }
    pending.requestFingerprint = requestFingerprint;
    pending.bootstrap = bootstrap;
    return { sessionId, bootstrap };
  }

  async revokeDevice(deviceId: string): Promise<RemoteHostStatusType> {
    const configuration = this.requireConfiguration();
    if (deviceId === configuration.hostIdentity.deviceId) {
      throw new RemoteControlPolicyError("the active host device cannot revoke itself");
    }
    const certificate = this.options.stateStore.getDeviceCertificate(deviceId);
    if (!certificate || certificate.accountId !== configuration.account.accountId) {
      throw new RemoteControlPolicyError("remote device not found");
    }
    // Fail closed locally first. If the relay is temporarily unavailable, a
    // retry will still complete remote revocation while the connector already
    // refuses every message from the device.
    this.options.stateStore.revokeDevice(deviceId, this.now().getTime());
    const admin = this.relayFactory.admin(
      configuration.relayUrl,
      configuration.relayAdminToken,
    );
    await admin.revokeDevice(configuration.account.accountId, deviceId);
    return this.status();
  }

  async processOnce(): Promise<number> {
    if (!this.connector) this.buildConnector();
    this.connectorState = "connecting";
    try {
      const processed = await this.connector!.processOnce({ waitMs: 0 });
      this.connectorState = "online";
      this.lastError = null;
      return processed;
    } catch (error) {
      this.connectorState = "degraded";
      this.lastError = safeError(error);
      throw error;
    }
  }

  private requireConfiguration(): RemoteHostSecretConfiguration {
    const stored = this.options.secretStore.load();
    const configuration = this.configuration ?? (
      stored ? RemoteHostSecretConfigurationSchema.parse(stored) : null
    );
    if (!configuration) {
      throw new RemoteControlPolicyError("remote host is not configured");
    }
    this.configuration = configuration;
    return configuration;
  }

  private pruneExpiredPairings(): void {
    const now = this.now().getTime();
    for (const [sessionId, pairing] of this.pendingPairings) {
      if (new Date(pairing.expiresAt).getTime() < now) {
        this.pendingPairings.delete(sessionId);
      }
    }
  }

  private buildConnector(): void {
    const configuration = this.requireConfiguration();
    const relay = this.relayFactory.data(
      configuration.relayUrl,
      configuration.hostDeviceToken,
    );
    this.connector = createDurableRemoteOutboundConnector({
      relay,
      identity: configuration.hostIdentity,
      certificate: configuration.hostCertificate,
      accountSigningPublicKey: configuration.account.signingPublicKey,
      stateStore: this.options.stateStore,
      resolveSenderCertificate: (deviceId) => {
        const certificate = this.options.stateStore.getDeviceCertificate(deviceId);
        if (!certificate) throw new RemoteControlPolicyError("remote sender not found");
        return certificate;
      },
      classifyAction: (request) => {
        try {
          return actionForRequest(parseRemoteControlPayload(
            request.plaintext,
            request.contentType,
          ));
        } catch {
          return "remote.denied";
        }
      },
      handleRequest: async (request) => {
        const controlRequest = parseRemoteControlPayload(
          request.plaintext,
          request.contentType,
        );
        actionForRequest(controlRequest);
        const result = await this.options.dispatch(controlRequest);
        const response = RemoteControlResponse.parse({
          protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
          requestId: controlRequest.requestId,
          status: result.status,
          body: result.body,
        });
        return {
          plaintext: JSON.stringify(response),
          contentType: REMOTE_CONTROL_RESPONSE_CONTENT_TYPE,
        };
      },
      pollWaitMs: this.pollWaitMs,
      now: this.now,
    });
    this.connectorState = "stopped";
  }

  private async restartConnector(): Promise<void> {
    this.connectorAbort?.abort();
    await this.connectorLoop;
    this.connectorAbort = null;
    this.connectorLoop = null;
    this.buildConnector();
    if (this.autoStartConnector) this.startConnectorLoop();
  }

  private startConnectorLoop(): void {
    if (!this.connector || this.connectorLoop) return;
    const abort = new AbortController();
    this.connectorAbort = abort;
    this.connectorState = "connecting";
    this.connectorLoop = this.runConnectorLoop(abort.signal).finally(() => {
      if (this.connectorAbort === abort) {
        this.connectorAbort = null;
        this.connectorLoop = null;
      }
    });
  }

  private async runConnectorLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000;
    while (!signal.aborted) {
      try {
        await this.connector!.processOnce({ signal });
        this.connectorState = "online";
        this.lastError = null;
        backoffMs = 1_000;
      } catch (error) {
        if (signal.aborted) break;
        this.connectorState = "degraded";
        this.lastError = safeError(error);
        await delay(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }
}
