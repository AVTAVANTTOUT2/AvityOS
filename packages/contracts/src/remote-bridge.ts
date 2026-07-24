import { z } from "zod";
import { Timestamp } from "./entities.js";

export const REMOTE_BRIDGE_PROTOCOL_VERSION = 1 as const;

const OpaqueKey = z.string().min(40).max(2_048).regex(/^[A-Za-z0-9_-]+$/);
const CipherMaterial = z.string().min(16).max(4 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+$/);
const Ciphertext = z.string().min(1).max(4 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+$/);

export const RemoteAccountId = z.string().regex(/^racc_[a-f0-9]{32}$/);
export type RemoteAccountId = z.infer<typeof RemoteAccountId>;

export const RemoteDeviceId = z.string().regex(/^rdev_[a-f0-9]{32}$/);
export type RemoteDeviceId = z.infer<typeof RemoteDeviceId>;

export const RemotePairingSessionId = z.string().regex(/^rpair_[a-f0-9]{32}$/);
export type RemotePairingSessionId = z.infer<typeof RemotePairingSessionId>;

export const RemoteBridgeMessageId = z.string().regex(/^rmsg_[a-f0-9]{32}$/);
export type RemoteBridgeMessageId = z.infer<typeof RemoteBridgeMessageId>;

export const RemoteDevicePublicIdentity = z.object({
  deviceId: RemoteDeviceId,
  signingPublicKey: OpaqueKey,
  agreementPublicKey: OpaqueKey,
}).strict();
export type RemoteDevicePublicIdentity = z.infer<typeof RemoteDevicePublicIdentity>;

export const RemoteDeviceCertificate = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  accountId: RemoteAccountId,
  deviceId: RemoteDeviceId,
  name: z.string().trim().min(1).max(120),
  signingPublicKey: OpaqueKey,
  agreementPublicKey: OpaqueKey,
  issuedAt: Timestamp,
  validUntil: Timestamp,
  signature: OpaqueKey,
}).strict();
export type RemoteDeviceCertificate = z.infer<typeof RemoteDeviceCertificate>;

export const RemotePairingOffer = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  sessionId: RemotePairingSessionId,
  accountId: RemoteAccountId,
  accountSigningPublicKey: OpaqueKey,
  hostCertificate: RemoteDeviceCertificate,
  expiresAt: Timestamp,
}).strict();
export type RemotePairingOffer = z.infer<typeof RemotePairingOffer>;

export const RemotePairingSession = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  sessionId: RemotePairingSessionId,
  accountId: RemoteAccountId,
  hostDeviceId: RemoteDeviceId,
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  consumedAt: Timestamp.nullable(),
}).strict();
export type RemotePairingSession = z.infer<typeof RemotePairingSession>;

export const RemotePairingRequestPayload = z.object({
  device: RemoteDevicePublicIdentity,
  name: z.string().trim().min(1).max(120),
  requestedAt: Timestamp,
}).strict();
export type RemotePairingRequestPayload = z.infer<typeof RemotePairingRequestPayload>;

export const RemotePairingRequest = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  sessionId: RemotePairingSessionId,
  nonce: CipherMaterial,
  ciphertext: Ciphertext,
  authTag: CipherMaterial,
}).strict();
export type RemotePairingRequest = z.infer<typeof RemotePairingRequest>;

export const RemotePairingAcceptance = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  sessionId: RemotePairingSessionId,
  nonce: CipherMaterial,
  ciphertext: Ciphertext,
  authTag: CipherMaterial,
}).strict();
export type RemotePairingAcceptance = z.infer<typeof RemotePairingAcceptance>;

export const RemotePairingBootstrapPayload = z.object({
  acceptance: RemotePairingAcceptance,
  relayUrl: z.string().trim().min(1).max(2_048),
  relayAccessToken: z.string().min(32).max(4_096).regex(/^\S+$/),
}).strict();
export type RemotePairingBootstrapPayload = z.infer<typeof RemotePairingBootstrapPayload>;

/**
 * Encrypted out-of-band bootstrap returned by the host after it accepts a
 * pairing request. The relay URL, per-device bearer and signed certificate
 * remain opaque until the requesting device opens it with the pairing secret.
 */
export const RemotePairingBootstrap = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  sessionId: RemotePairingSessionId,
  nonce: CipherMaterial,
  ciphertext: Ciphertext,
  authTag: CipherMaterial,
}).strict();
export type RemotePairingBootstrap = z.infer<typeof RemotePairingBootstrap>;

export const REMOTE_CONTROL_REQUEST_CONTENT_TYPE =
  "application/vnd.avityos.remote-control-request+json" as const;
export const REMOTE_CONTROL_RESPONSE_CONTENT_TYPE =
  "application/vnd.avityos.remote-control-response+json" as const;
export const REMOTE_CERTIFICATE_RENEWAL_PATH =
  "/v1/remote/certificates/renew" as const;

export const RemoteControlRequest = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  requestId: z.string().regex(/^rreq_[a-f0-9]{32}$/),
  method: z.enum(["GET", "POST"]),
  path: z.string().min(1).max(2_048).regex(/^\/v1\/[^\s]*$/),
  body: z.unknown().optional(),
}).strict();
export type RemoteControlRequest = z.infer<typeof RemoteControlRequest>;

export const RemoteControlResponse = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  requestId: z.string().regex(/^rreq_[a-f0-9]{32}$/),
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
}).strict();
export type RemoteControlResponse = z.infer<typeof RemoteControlResponse>;

export const RemoteCertificateRenewalRequest = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
}).strict();
export type RemoteCertificateRenewalRequest = z.infer<
  typeof RemoteCertificateRenewalRequest
>;

export const RemoteCertificateRenewalResponse = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  deviceCertificate: RemoteDeviceCertificate,
  hostCertificate: RemoteDeviceCertificate,
}).strict();
export type RemoteCertificateRenewalResponse = z.infer<
  typeof RemoteCertificateRenewalResponse
>;

export const RemoteEncryptedEnvelope = z.object({
  protocolVersion: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  messageId: RemoteBridgeMessageId,
  accountId: RemoteAccountId,
  senderDeviceId: RemoteDeviceId,
  recipientDeviceId: RemoteDeviceId,
  sequence: z.number().int().positive().safe(),
  sentAt: Timestamp,
  contentType: z.string().trim().min(1).max(120),
  ephemeralPublicKey: OpaqueKey,
  salt: CipherMaterial,
  nonce: CipherMaterial,
  ciphertext: Ciphertext,
  authTag: CipherMaterial,
  signature: OpaqueKey,
}).strict();
export type RemoteEncryptedEnvelope = z.infer<typeof RemoteEncryptedEnvelope>;

export const RemoteRelayCursor = z.number().int().nonnegative().safe();
export type RemoteRelayCursor = z.infer<typeof RemoteRelayCursor>;

export const RemoteRelayItem = z.object({
  cursor: z.number().int().positive().safe(),
  receivedAt: Timestamp,
  envelope: RemoteEncryptedEnvelope,
}).strict();
export type RemoteRelayItem = z.infer<typeof RemoteRelayItem>;

export const RemoteRelayInbox = z.object({
  items: z.array(RemoteRelayItem).max(100),
  nextCursor: RemoteRelayCursor,
}).strict();
export type RemoteRelayInbox = z.infer<typeof RemoteRelayInbox>;

export const RemoteRelayPublishResult = z.object({
  messageId: RemoteBridgeMessageId,
  acceptedAt: Timestamp,
  duplicate: z.boolean(),
}).strict();
export type RemoteRelayPublishResult = z.infer<typeof RemoteRelayPublishResult>;

export const RemoteRelayAckRequest = z.object({
  throughCursor: z.number().int().positive().safe(),
}).strict();
export type RemoteRelayAckRequest = z.infer<typeof RemoteRelayAckRequest>;

export const RemoteRelayAckResult = z.object({
  throughCursor: z.number().int().positive().safe(),
  deleted: z.number().int().nonnegative().safe(),
}).strict();
export type RemoteRelayAckResult = z.infer<typeof RemoteRelayAckResult>;

export const RemoteRelayDeviceAccessToken = z.string()
  .min(32)
  .max(4_096)
  .regex(/^\S+$/);
export type RemoteRelayDeviceAccessToken = z.infer<typeof RemoteRelayDeviceAccessToken>;

export const RemoteRelayRegisterDeviceRequest = z.object({
  certificate: RemoteDeviceCertificate,
  accessToken: RemoteRelayDeviceAccessToken,
}).strict();
export type RemoteRelayRegisterDeviceRequest = z.infer<typeof RemoteRelayRegisterDeviceRequest>;

export const RemoteRelayUpdateDeviceCertificateRequest = z.object({
  certificate: RemoteDeviceCertificate,
}).strict();
export type RemoteRelayUpdateDeviceCertificateRequest = z.infer<
  typeof RemoteRelayUpdateDeviceCertificateRequest
>;

export const RemoteRelayDeviceRecord = z.object({
  accountId: RemoteAccountId,
  deviceId: RemoteDeviceId,
  status: z.enum(["active", "revoked"]),
  updatedAt: Timestamp,
}).strict();
export type RemoteRelayDeviceRecord = z.infer<typeof RemoteRelayDeviceRecord>;
