import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  REMOTE_BRIDGE_PROTOCOL_VERSION,
  RemoteDeviceCertificate,
  RemoteEncryptedEnvelope,
  RemotePairingAcceptance,
  RemotePairingBootstrap,
  RemotePairingBootstrapPayload,
  RemotePairingOffer,
  RemotePairingRequest,
  RemotePairingRequestPayload,
  RemotePairingSession,
  type RemoteEncryptedEnvelope as RemoteEncryptedEnvelopeType,
  type RemoteDeviceCertificate as RemoteDeviceCertificateType,
  type RemotePairingAcceptance as RemotePairingAcceptanceType,
  type RemotePairingBootstrap as RemotePairingBootstrapType,
  type RemotePairingOffer as RemotePairingOfferType,
  type RemotePairingRequest as RemotePairingRequestType,
  type RemotePairingSession as RemotePairingSessionType,
} from "@avityos/contracts";
import type { RemoteRelayClient } from "./relay-client.js";
import {
  RemoteBridgeSecurityError,
  canonicalJson,
  decode,
  importPublicKey,
  validDate,
  verifyRemoteDeviceCertificate,
} from "./security.js";

export * from "./relay-client.js";
export {
  RemoteBridgeSecurityError,
  verifyRemoteDeviceCertificate,
} from "./security.js";
export * from "./state.js";

const PAIRING_REQUEST_CONTEXT = "avityos-remote-pairing-request-v1";
const PAIRING_ACCEPTANCE_CONTEXT = "avityos-remote-pairing-acceptance-v1";
const PAIRING_BOOTSTRAP_CONTEXT = "avityos-remote-pairing-bootstrap-v1";
const ENVELOPE_CONTEXT = "avityos-remote-envelope-v1";
const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_CERTIFICATE_TTL_MS = 365 * 24 * 60 * 60_000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface RemoteAccountIdentity {
  readonly accountId: string;
  readonly signingPublicKey: string;
  readonly signingPrivateKey: string;
}

export interface RemoteDeviceIdentity {
  readonly deviceId: string;
  readonly signingPublicKey: string;
  readonly signingPrivateKey: string;
  readonly agreementPublicKey: string;
  readonly agreementPrivateKey: string;
}

export interface RemotePairingBundle {
  readonly offer: RemotePairingOfferType;
  /** High-entropy out-of-band secret. Never send this through the relay. */
  readonly pairingSecret: string;
}

export interface CreatedPairingSession {
  readonly session: RemotePairingSessionType;
  readonly bundle: RemotePairingBundle;
}

export interface AcceptedPairing {
  readonly session: RemotePairingSessionType;
  readonly certificate: RemoteDeviceCertificateType;
  readonly acceptance: RemotePairingAcceptanceType;
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function exportPublicKey(key: KeyObject): string {
  return encode(key.export({ format: "der", type: "spki" }));
}

function exportPrivateKey(key: KeyObject): string {
  return encode(key.export({ format: "der", type: "pkcs8" }));
}

function importPrivateKey(value: string): KeyObject {
  try {
    return createPrivateKey({ key: decode(value, "private key"), format: "der", type: "pkcs8" });
  } catch {
    throw new RemoteBridgeSecurityError("invalid private key");
  }
}

function createId(prefix: "racc" | "rdev" | "rpair" | "rmsg"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function iso(input: Date | string | number): string {
  return validDate(input, "timestamp").toISOString();
}

function maxClockSkew(value: number | undefined): number {
  const skew = value ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > 24 * 60 * 60_000) {
    throw new RemoteBridgeSecurityError("maximum clock skew must be between 0 and 24 hours");
  }
  return skew;
}

function pairingAad(
  sessionId: string,
  direction: "request" | "acceptance" | "bootstrap",
): Buffer {
  return Buffer.from(canonicalJson({
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    sessionId,
    direction,
  }));
}

function derivePairingKey(pairingSecret: string, sessionId: string, context: string): Buffer {
  const secret = decode(pairingSecret, "pairing secret");
  if (secret.length < 32) throw new RemoteBridgeSecurityError("pairing secret is too short");
  return Buffer.from(hkdfSync(
    "sha256",
    secret,
    Buffer.from(sessionId),
    Buffer.from(context),
    32,
  ));
}

function encryptJson(value: unknown, key: Buffer, aad: Buffer): {
  nonce: string;
  ciphertext: string;
  authTag: string;
} {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(value))),
    cipher.final(),
  ]);
  return {
    nonce: encode(nonce),
    ciphertext: encode(ciphertext),
    authTag: encode(cipher.getAuthTag()),
  };
}

function decryptJson(
  input: { nonce: string; ciphertext: string; authTag: string },
  key: Buffer,
  aad: Buffer,
): unknown {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decode(input.nonce, "nonce"));
    decipher.setAAD(aad);
    decipher.setAuthTag(decode(input.authTag, "authentication tag"));
    const plaintext = Buffer.concat([
      decipher.update(decode(input.ciphertext, "ciphertext")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    throw new RemoteBridgeSecurityError("encrypted payload authentication failed");
  }
}

function assertIdentityMatchesCertificate(
  identity: RemoteDeviceIdentity,
  certificate: RemoteDeviceCertificateType,
): void {
  if (
    identity.deviceId !== certificate.deviceId ||
    identity.signingPublicKey !== certificate.signingPublicKey ||
    identity.agreementPublicKey !== certificate.agreementPublicKey
  ) {
    throw new RemoteBridgeSecurityError("device identity does not match its certificate");
  }
}

function assertAccountKeyPair(account: RemoteAccountIdentity): void {
  const derivedPublicKey = exportPublicKey(createPublicKey(
    importPrivateKey(account.signingPrivateKey),
  ));
  if (derivedPublicKey !== account.signingPublicKey) {
    throw new RemoteBridgeSecurityError("account signing key pair does not match");
  }
}

function assertDeviceKeyPairs(identity: RemoteDeviceIdentity): void {
  const derivedSigningPublicKey = exportPublicKey(createPublicKey(
    importPrivateKey(identity.signingPrivateKey),
  ));
  const derivedAgreementPublicKey = exportPublicKey(createPublicKey(
    importPrivateKey(identity.agreementPrivateKey),
  ));
  if (
    derivedSigningPublicKey !== identity.signingPublicKey ||
    derivedAgreementPublicKey !== identity.agreementPublicKey
  ) {
    throw new RemoteBridgeSecurityError("device key pair does not match");
  }
}

export function generateRemoteAccountIdentity(): RemoteAccountIdentity {
  const signing = generateKeyPairSync("ed25519");
  return {
    accountId: createId("racc"),
    signingPublicKey: exportPublicKey(signing.publicKey),
    signingPrivateKey: exportPrivateKey(signing.privateKey),
  };
}

export function generateRemoteDeviceIdentity(): RemoteDeviceIdentity {
  const signing = generateKeyPairSync("ed25519");
  const agreement = generateKeyPairSync("x25519");
  return {
    deviceId: createId("rdev"),
    signingPublicKey: exportPublicKey(signing.publicKey),
    signingPrivateKey: exportPrivateKey(signing.privateKey),
    agreementPublicKey: exportPublicKey(agreement.publicKey),
    agreementPrivateKey: exportPrivateKey(agreement.privateKey),
  };
}

export function issueRemoteDeviceCertificate(input: {
  readonly account: RemoteAccountIdentity;
  readonly device: Pick<RemoteDeviceIdentity, "deviceId" | "signingPublicKey" | "agreementPublicKey">;
  readonly name: string;
  readonly issuedAt?: Date | string | number;
  readonly validUntil?: Date | string | number;
}): RemoteDeviceCertificateType {
  assertAccountKeyPair(input.account);
  const issuedAt = validDate(
    input.issuedAt ?? Date.now(),
    "certificate issue timestamp",
  );
  const validUntil = validDate(
    input.validUntil ?? issuedAt.getTime() + DEFAULT_CERTIFICATE_TTL_MS,
    "certificate expiration timestamp",
  );
  if (validUntil.getTime() <= issuedAt.getTime()) {
    throw new RemoteBridgeSecurityError("device certificate validity must be positive");
  }
  const unsigned = {
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    accountId: input.account.accountId,
    deviceId: input.device.deviceId,
    name: input.name,
    signingPublicKey: input.device.signingPublicKey,
    agreementPublicKey: input.device.agreementPublicKey,
    issuedAt: iso(issuedAt),
    validUntil: iso(validUntil),
  };
  const signature = encode(sign(
    null,
    Buffer.from(canonicalJson(unsigned)),
    importPrivateKey(input.account.signingPrivateKey),
  ));
  return RemoteDeviceCertificate.parse({ ...unsigned, signature });
}

export function createRemotePairingSession(input: {
  readonly account: RemoteAccountIdentity;
  readonly hostIdentity: RemoteDeviceIdentity;
  readonly hostCertificate: RemoteDeviceCertificateType;
  readonly now?: Date | string | number;
  readonly ttlMs?: number;
}): CreatedPairingSession {
  const now = validDate(input.now ?? Date.now(), "pairing session timestamp");
  const ttlMs = input.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 30 * 60_000) {
    throw new RemoteBridgeSecurityError("pairing ttl must be between 30 seconds and 30 minutes");
  }
  assertAccountKeyPair(input.account);
  assertDeviceKeyPairs(input.hostIdentity);
  const hostCertificate = verifyRemoteDeviceCertificate(
    input.hostCertificate,
    input.account.signingPublicKey,
    now,
  );
  assertIdentityMatchesCertificate(input.hostIdentity, hostCertificate);
  if (hostCertificate.accountId !== input.account.accountId) {
    throw new RemoteBridgeSecurityError("host certificate belongs to another account");
  }

  const sessionId = createId("rpair");
  const pairingSecret = encode(randomBytes(32));
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const session = RemotePairingSession.parse({
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    sessionId,
    accountId: input.account.accountId,
    hostDeviceId: input.hostIdentity.deviceId,
    secretHash: createHash("sha256").update(pairingSecret).digest("hex"),
    createdAt: now.toISOString(),
    expiresAt,
    consumedAt: null,
  });
  const offer = RemotePairingOffer.parse({
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    sessionId,
    accountId: input.account.accountId,
    accountSigningPublicKey: input.account.signingPublicKey,
    hostCertificate,
    expiresAt,
  });
  return { session, bundle: { offer, pairingSecret } };
}

export function createRemotePairingRequest(input: {
  readonly offer: RemotePairingOfferType;
  readonly pairingSecret: string;
  readonly device: RemoteDeviceIdentity;
  readonly name: string;
  readonly now?: Date | string | number;
}): RemotePairingRequestType {
  const now = validDate(input.now ?? Date.now(), "pairing request timestamp");
  assertDeviceKeyPairs(input.device);
  const offer = RemotePairingOffer.parse(input.offer);
  if (now.getTime() > new Date(offer.expiresAt).getTime()) {
    throw new RemoteBridgeSecurityError("pairing offer expired");
  }
  const hostCertificate = verifyRemoteDeviceCertificate(
    offer.hostCertificate,
    offer.accountSigningPublicKey,
    now,
  );
  if (hostCertificate.accountId !== offer.accountId) {
    throw new RemoteBridgeSecurityError("pairing offer account does not match its host certificate");
  }
  const key = derivePairingKey(input.pairingSecret, offer.sessionId, PAIRING_REQUEST_CONTEXT);
  const payload = RemotePairingRequestPayload.parse({
    device: {
      deviceId: input.device.deviceId,
      signingPublicKey: input.device.signingPublicKey,
      agreementPublicKey: input.device.agreementPublicKey,
    },
    name: input.name,
    requestedAt: now.toISOString(),
  });
  const encrypted = encryptJson(payload, key, pairingAad(offer.sessionId, "request"));
  return RemotePairingRequest.parse({
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    sessionId: offer.sessionId,
    ...encrypted,
  });
}

export function acceptRemotePairingRequest(input: {
  readonly session: RemotePairingSessionType;
  readonly request: RemotePairingRequestType;
  readonly pairingSecret: string;
  readonly account: RemoteAccountIdentity;
  readonly now?: Date | string | number;
  readonly certificateTtlMs?: number;
}): AcceptedPairing {
  const now = validDate(input.now ?? Date.now(), "pairing acceptance timestamp");
  assertAccountKeyPair(input.account);
  const session = RemotePairingSession.parse(input.session);
  const request = RemotePairingRequest.parse(input.request);
  if (session.consumedAt) throw new RemoteBridgeSecurityError("pairing session already consumed");
  const createdAt = new Date(session.createdAt).getTime();
  const expiresAt = new Date(session.expiresAt).getTime();
  if (expiresAt <= createdAt) {
    throw new RemoteBridgeSecurityError("pairing session validity is invalid");
  }
  if (now.getTime() < createdAt) {
    throw new RemoteBridgeSecurityError("pairing session is not active yet");
  }
  if (now.getTime() > expiresAt) {
    throw new RemoteBridgeSecurityError("pairing session expired");
  }
  if (
    session.sessionId !== request.sessionId ||
    session.accountId !== input.account.accountId
  ) {
    throw new RemoteBridgeSecurityError("pairing request does not match the session");
  }
  const suppliedHash = Buffer.from(createHash("sha256").update(input.pairingSecret).digest("hex"));
  const expectedHash = Buffer.from(session.secretHash);
  if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
    throw new RemoteBridgeSecurityError("pairing secret is invalid");
  }
  const key = derivePairingKey(input.pairingSecret, session.sessionId, PAIRING_REQUEST_CONTEXT);
  const payload = RemotePairingRequestPayload.parse(decryptJson(
    request,
    key,
    pairingAad(session.sessionId, "request"),
  ));
  const requestedAt = new Date(payload.requestedAt).getTime();
  if (
    requestedAt < createdAt - DEFAULT_MAX_CLOCK_SKEW_MS ||
    requestedAt > now.getTime() + DEFAULT_MAX_CLOCK_SKEW_MS
  ) {
    throw new RemoteBridgeSecurityError("pairing request timestamp is outside the session window");
  }
  const certificate = issueRemoteDeviceCertificate({
    account: input.account,
    device: payload.device,
    name: payload.name,
    issuedAt: now,
    validUntil: now.getTime() + (input.certificateTtlMs ?? DEFAULT_CERTIFICATE_TTL_MS),
  });
  const acceptanceKey = derivePairingKey(
    input.pairingSecret,
    session.sessionId,
    PAIRING_ACCEPTANCE_CONTEXT,
  );
  const acceptance = RemotePairingAcceptance.parse({
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    sessionId: session.sessionId,
    ...encryptJson(
      certificate,
      acceptanceKey,
      pairingAad(session.sessionId, "acceptance"),
    ),
  });
  return {
    session: RemotePairingSession.parse({ ...session, consumedAt: now.toISOString() }),
    certificate,
    acceptance,
  };
}

export function openRemotePairingAcceptance(input: {
  readonly offer: RemotePairingOfferType;
  readonly acceptance: RemotePairingAcceptanceType;
  readonly pairingSecret: string;
  readonly device: RemoteDeviceIdentity;
  readonly now?: Date | string | number;
}): RemoteDeviceCertificateType {
  const now = validDate(input.now ?? Date.now(), "pairing acceptance timestamp");
  assertDeviceKeyPairs(input.device);
  const offer = RemotePairingOffer.parse(input.offer);
  const acceptance = RemotePairingAcceptance.parse(input.acceptance);
  if (now.getTime() > new Date(offer.expiresAt).getTime()) {
    throw new RemoteBridgeSecurityError("pairing offer expired");
  }
  const hostCertificate = verifyRemoteDeviceCertificate(
    offer.hostCertificate,
    offer.accountSigningPublicKey,
    now,
  );
  if (hostCertificate.accountId !== offer.accountId) {
    throw new RemoteBridgeSecurityError("pairing offer account does not match its host certificate");
  }
  if (acceptance.sessionId !== offer.sessionId) {
    throw new RemoteBridgeSecurityError("pairing acceptance does not match the offer");
  }
  const key = derivePairingKey(
    input.pairingSecret,
    offer.sessionId,
    PAIRING_ACCEPTANCE_CONTEXT,
  );
  const certificate = verifyRemoteDeviceCertificate(
    decryptJson(acceptance, key, pairingAad(offer.sessionId, "acceptance")),
    offer.accountSigningPublicKey,
    now,
  );
  if (certificate.accountId !== offer.accountId) {
    throw new RemoteBridgeSecurityError("paired device certificate belongs to another account");
  }
  assertIdentityMatchesCertificate(input.device, certificate);
  return certificate;
}

export function createRemotePairingBootstrap(input: {
  readonly acceptance: RemotePairingAcceptanceType;
  readonly pairingSecret: string;
  readonly relayUrl: string;
  readonly relayAccessToken: string;
}): RemotePairingBootstrapType {
  const acceptance = RemotePairingAcceptance.parse(input.acceptance);
  const payload = RemotePairingBootstrapPayload.parse({
    acceptance,
    relayUrl: input.relayUrl,
    relayAccessToken: input.relayAccessToken,
  });
  const key = derivePairingKey(
    input.pairingSecret,
    acceptance.sessionId,
    PAIRING_BOOTSTRAP_CONTEXT,
  );
  return RemotePairingBootstrap.parse({
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    sessionId: acceptance.sessionId,
    ...encryptJson(
      payload,
      key,
      pairingAad(acceptance.sessionId, "bootstrap"),
    ),
  });
}

export function openRemotePairingBootstrap(input: {
  readonly offer: RemotePairingOfferType;
  readonly bootstrap: RemotePairingBootstrapType;
  readonly pairingSecret: string;
  readonly device: RemoteDeviceIdentity;
  readonly now?: Date | string | number;
}): {
  readonly certificate: RemoteDeviceCertificateType;
  readonly relayUrl: string;
  readonly relayAccessToken: string;
} {
  const offer = RemotePairingOffer.parse(input.offer);
  const bootstrap = RemotePairingBootstrap.parse(input.bootstrap);
  if (
    bootstrap.sessionId !== offer.sessionId ||
    new Date(offer.expiresAt).getTime() < validDate(
      input.now ?? Date.now(),
      "pairing bootstrap timestamp",
    ).getTime()
  ) {
    throw new RemoteBridgeSecurityError(
      "pairing bootstrap does not match an active offer",
    );
  }
  const key = derivePairingKey(
    input.pairingSecret,
    bootstrap.sessionId,
    PAIRING_BOOTSTRAP_CONTEXT,
  );
  const payload = RemotePairingBootstrapPayload.parse(decryptJson(
    bootstrap,
    key,
    pairingAad(bootstrap.sessionId, "bootstrap"),
  ));
  if (payload.acceptance.sessionId !== bootstrap.sessionId) {
    throw new RemoteBridgeSecurityError(
      "pairing bootstrap acceptance does not match its session",
    );
  }
  return {
    certificate: openRemotePairingAcceptance({
      offer,
      acceptance: payload.acceptance,
      pairingSecret: input.pairingSecret,
      device: input.device,
      now: input.now,
    }),
    relayUrl: payload.relayUrl,
    relayAccessToken: payload.relayAccessToken,
  };
}

function envelopeHeader(envelope: Omit<RemoteEncryptedEnvelopeType, "ciphertext" | "authTag" | "signature">) {
  return envelope;
}

function envelopeSignedPayload(envelope: Omit<RemoteEncryptedEnvelopeType, "signature">): Buffer {
  return Buffer.from(canonicalJson(envelope));
}

function envelopeKey(input: {
  readonly sharedSecret: Uint8Array;
  readonly salt: Uint8Array;
  readonly accountId: string;
  readonly senderDeviceId: string;
  readonly recipientDeviceId: string;
  readonly messageId: string;
}): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    input.sharedSecret,
    input.salt,
    Buffer.from([
      ENVELOPE_CONTEXT,
      input.accountId,
      input.senderDeviceId,
      input.recipientDeviceId,
      input.messageId,
    ].join("|")),
    32,
  ));
}

export function sealRemoteEnvelope(input: {
  readonly plaintext: Uint8Array | string;
  readonly contentType: string;
  readonly sequence: number;
  readonly senderIdentity: RemoteDeviceIdentity;
  readonly senderCertificate: RemoteDeviceCertificateType;
  readonly recipientCertificate: RemoteDeviceCertificateType;
  readonly accountSigningPublicKey: string;
  readonly sentAt?: Date | string | number;
  readonly messageId?: string;
}): RemoteEncryptedEnvelopeType {
  const sentAt = validDate(input.sentAt ?? Date.now(), "envelope timestamp");
  assertDeviceKeyPairs(input.senderIdentity);
  const senderCertificate = verifyRemoteDeviceCertificate(
    input.senderCertificate,
    input.accountSigningPublicKey,
    sentAt,
  );
  const recipientCertificate = verifyRemoteDeviceCertificate(
    input.recipientCertificate,
    input.accountSigningPublicKey,
    sentAt,
  );
  assertIdentityMatchesCertificate(input.senderIdentity, senderCertificate);
  if (senderCertificate.accountId !== recipientCertificate.accountId) {
    throw new RemoteBridgeSecurityError("devices belong to different accounts");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0) {
    throw new RemoteBridgeSecurityError("envelope sequence must be a positive safe integer");
  }

  const ephemeral = generateKeyPairSync("x25519");
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: importPublicKey(recipientCertificate.agreementPublicKey),
  });
  const messageId = input.messageId ?? createId("rmsg");
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const header = envelopeHeader({
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    messageId,
    accountId: senderCertificate.accountId,
    senderDeviceId: senderCertificate.deviceId,
    recipientDeviceId: recipientCertificate.deviceId,
    sequence: input.sequence,
    sentAt: sentAt.toISOString(),
    contentType: input.contentType,
    ephemeralPublicKey: exportPublicKey(ephemeral.publicKey),
    salt: encode(salt),
    nonce: encode(nonce),
  });
  const key = envelopeKey({
    sharedSecret,
    salt,
    accountId: header.accountId,
    senderDeviceId: header.senderDeviceId,
    recipientDeviceId: header.recipientDeviceId,
    messageId,
  });
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(header)));
  const plaintext = typeof input.plaintext === "string"
    ? Buffer.from(input.plaintext)
    : Buffer.from(input.plaintext);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const unsigned = {
    ...header,
    ciphertext: encode(ciphertext),
    authTag: encode(cipher.getAuthTag()),
  };
  const signature = encode(sign(
    null,
    envelopeSignedPayload(unsigned),
    importPrivateKey(input.senderIdentity.signingPrivateKey),
  ));
  return RemoteEncryptedEnvelope.parse({ ...unsigned, signature });
}

export function assertFreshRemoteSequence(sequence: number, lastAcceptedSequence: number): void {
  if (!Number.isSafeInteger(lastAcceptedSequence) || lastAcceptedSequence < 0) {
    throw new RemoteBridgeSecurityError("last accepted sequence is invalid");
  }
  if (sequence <= lastAcceptedSequence) {
    throw new RemoteBridgeSecurityError("remote envelope replay or reordering detected");
  }
}

export function openRemoteEnvelope(input: {
  readonly envelope: unknown;
  readonly recipientIdentity: RemoteDeviceIdentity;
  readonly recipientCertificate: RemoteDeviceCertificateType;
  readonly senderCertificate: RemoteDeviceCertificateType;
  readonly accountSigningPublicKey: string;
  readonly lastAcceptedSequence: number;
  readonly now?: Date | string | number;
  readonly maxClockSkewMs?: number;
}): {
  readonly plaintext: Buffer;
  readonly contentType: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly sentAt: string;
} {
  const now = validDate(input.now ?? Date.now(), "envelope verification timestamp");
  const allowedClockSkew = maxClockSkew(input.maxClockSkewMs);
  assertDeviceKeyPairs(input.recipientIdentity);
  const envelope = RemoteEncryptedEnvelope.parse(input.envelope);
  const senderCertificate = verifyRemoteDeviceCertificate(
    input.senderCertificate,
    input.accountSigningPublicKey,
    now,
  );
  const recipientCertificate = verifyRemoteDeviceCertificate(
    input.recipientCertificate,
    input.accountSigningPublicKey,
    now,
  );
  assertIdentityMatchesCertificate(input.recipientIdentity, recipientCertificate);
  if (
    envelope.accountId !== senderCertificate.accountId ||
    envelope.accountId !== recipientCertificate.accountId ||
    envelope.senderDeviceId !== senderCertificate.deviceId ||
    envelope.recipientDeviceId !== recipientCertificate.deviceId
  ) {
    throw new RemoteBridgeSecurityError("remote envelope routing does not match device certificates");
  }
  const sentAt = new Date(envelope.sentAt).getTime();
  if (sentAt > now.getTime() + allowedClockSkew) {
    throw new RemoteBridgeSecurityError("remote envelope timestamp is in the future");
  }
  const { signature, ...unsigned } = envelope;
  const authentic = verify(
    null,
    envelopeSignedPayload(unsigned),
    importPublicKey(senderCertificate.signingPublicKey),
    decode(signature, "envelope signature"),
  );
  if (!authentic) throw new RemoteBridgeSecurityError("remote envelope signature is invalid");
  assertFreshRemoteSequence(envelope.sequence, input.lastAcceptedSequence);

  try {
    const sharedSecret = diffieHellman({
      privateKey: importPrivateKey(input.recipientIdentity.agreementPrivateKey),
      publicKey: importPublicKey(envelope.ephemeralPublicKey),
    });
    const key = envelopeKey({
      sharedSecret,
      salt: decode(envelope.salt, "salt"),
      accountId: envelope.accountId,
      senderDeviceId: envelope.senderDeviceId,
      recipientDeviceId: envelope.recipientDeviceId,
      messageId: envelope.messageId,
    });
    const {
      ciphertext: _ciphertext,
      authTag: _authTag,
      signature: _signature,
      ...header
    } = envelope;
    const decipher = createDecipheriv("aes-256-gcm", key, decode(envelope.nonce, "nonce"));
    decipher.setAAD(Buffer.from(canonicalJson(header)));
    decipher.setAuthTag(decode(envelope.authTag, "authentication tag"));
    const plaintext = Buffer.concat([
      decipher.update(decode(envelope.ciphertext, "ciphertext")),
      decipher.final(),
    ]);
    return {
      plaintext,
      contentType: envelope.contentType,
      messageId: envelope.messageId,
      sequence: envelope.sequence,
      sentAt: envelope.sentAt,
    };
  } catch (error) {
    if (error instanceof RemoteBridgeSecurityError) throw error;
    throw new RemoteBridgeSecurityError("remote envelope decryption failed");
  }
}

export interface RemoteConnectorRequest {
  readonly plaintext: Buffer;
  readonly contentType: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly sentAt: string;
  readonly senderDeviceId: string;
}

export interface RemoteConnectorResponse {
  readonly plaintext: Uint8Array | string;
  readonly contentType: string;
}

export interface RemoteConnectorAuditEvent {
  readonly accountId: string;
  readonly localDeviceId: string;
  readonly remoteDeviceId: string;
  readonly messageId: string;
  readonly contentType: string;
  readonly action: string;
  readonly outcome: "accepted" | "failed";
  readonly errorCode?: string;
  readonly createdAt: string;
}

export interface RemoteOutboundConnectorOptions {
  readonly relay: RemoteRelayClient;
  readonly identity: RemoteDeviceIdentity;
  readonly certificate: RemoteDeviceCertificateType;
  readonly accountSigningPublicKey: string;
  readonly resolveSenderCertificate: (
    deviceId: string,
  ) => RemoteDeviceCertificateType | Promise<RemoteDeviceCertificateType>;
  readonly handleRequest: (
    request: RemoteConnectorRequest,
  ) => RemoteConnectorResponse | null | Promise<RemoteConnectorResponse | null>;
  readonly initialRelayCursor?: number;
  readonly initialInboundSequences?: ReadonlyMap<string, number>;
  readonly initialOutboundSequences?: ReadonlyMap<string, number>;
  readonly initialPersistedState?: RemoteConnectorPersistedState;
  readonly persistState?: (
    state: RemoteConnectorPersistedState,
  ) => void | Promise<void>;
  readonly classifyAction?: (
    request: RemoteConnectorRequest,
  ) => string | Promise<string>;
  readonly recordAudit?: (
    event: RemoteConnectorAuditEvent,
  ) => void | Promise<void>;
  readonly pollWaitMs?: number;
  readonly now?: () => Date;
}

export interface RemoteConnectorPendingDeliveryState {
  readonly relayCursor: number;
  readonly senderDeviceId: string;
  readonly inboundSequence: number;
  readonly responseEnvelope: RemoteEncryptedEnvelopeType | null;
  readonly outboundSequence: number | null;
  readonly responsePublished: boolean;
  readonly sequencesCommitted: boolean;
}

export interface RemoteConnectorPersistedState {
  readonly relayCursor: number;
  readonly inboundSequences: readonly (readonly [string, number])[];
  readonly outboundSequences: readonly (readonly [string, number])[];
  readonly pending: RemoteConnectorPendingDeliveryState | null;
}

interface PendingRemoteDelivery extends RemoteConnectorPendingDeliveryState {
  responsePublished: boolean;
  sequencesCommitted: boolean;
}

function validatedSequenceMap(
  input: ReadonlyMap<string, number> | undefined,
  label: string,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [deviceId, sequence] of input ?? []) {
    if (!/^rdev_[a-f0-9]{32}$/.test(deviceId)) {
      throw new RemoteBridgeSecurityError(`${label} contains an invalid device id`);
    }
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RemoteBridgeSecurityError(`${label} contains an invalid sequence`);
    }
    result.set(deviceId, sequence);
  }
  return result;
}

function validatedAuditIdentifier(value: string, label: string, maximum = 200): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)
  ) {
    throw new RemoteBridgeSecurityError(`invalid remote audit ${label}`);
  }
  return normalized;
}

function safeAuditErrorCode(error: unknown): string {
  const candidate = error instanceof Error ? error.name : "unknown_error";
  try {
    return validatedAuditIdentifier(candidate, "error code", 120);
  } catch {
    return "handler_error";
  }
}

/**
 * Long-polling host connector. It exposes no listener: every network operation
 * is an outbound fetch to the relay, and application plaintext exists only
 * between local decryption and the supplied local handler.
 *
 * Durable replay cursors and crash recovery are enabled when a persisted state
 * and persistence callback are supplied. Prefer
 * `createDurableRemoteOutboundConnector` for the fail-closed production path.
 */
export class RemoteOutboundConnector {
  private relayCursor: number;
  private readonly inboundSequences: Map<string, number>;
  private readonly outboundSequences: Map<string, number>;
  private readonly pollWaitMs: number;
  private readonly now: () => Date;
  private readonly certificate: RemoteDeviceCertificateType;
  private pending: PendingRemoteDelivery | null = null;

  constructor(private readonly options: RemoteOutboundConnectorOptions) {
    this.now = options.now ?? (() => new Date());
    const initialNow = validDate(this.now(), "connector clock");
    this.certificate = verifyRemoteDeviceCertificate(
      options.certificate,
      options.accountSigningPublicKey,
      initialNow,
    );
    assertIdentityMatchesCertificate(options.identity, this.certificate);
    assertDeviceKeyPairs(options.identity);
    if (
      options.initialPersistedState &&
      (
        options.initialRelayCursor !== undefined ||
        options.initialInboundSequences !== undefined ||
        options.initialOutboundSequences !== undefined
      )
    ) {
      throw new RemoteBridgeSecurityError("persisted connector state conflicts with legacy initial state");
    }
    this.relayCursor = options.initialPersistedState?.relayCursor ?? options.initialRelayCursor ?? 0;
    if (!Number.isSafeInteger(this.relayCursor) || this.relayCursor < 0) {
      throw new RemoteBridgeSecurityError("initial relay cursor is invalid");
    }
    this.inboundSequences = validatedSequenceMap(
      options.initialPersistedState
        ? new Map(options.initialPersistedState.inboundSequences)
        : options.initialInboundSequences,
      "initial inbound sequences",
    );
    this.outboundSequences = validatedSequenceMap(
      options.initialPersistedState
        ? new Map(options.initialPersistedState.outboundSequences)
        : options.initialOutboundSequences,
      "initial outbound sequences",
    );
    if (options.initialPersistedState?.pending) {
      const pending = options.initialPersistedState.pending;
      if (
        !Number.isSafeInteger(pending.relayCursor) ||
        pending.relayCursor <= this.relayCursor ||
        !/^rdev_[a-f0-9]{32}$/.test(pending.senderDeviceId) ||
        !Number.isSafeInteger(pending.inboundSequence) ||
        pending.inboundSequence <= 0 ||
        (
          pending.outboundSequence !== null &&
          (!Number.isSafeInteger(pending.outboundSequence) || pending.outboundSequence <= 0)
        )
      ) {
        throw new RemoteBridgeSecurityError("persisted pending delivery is invalid");
      }
      this.pending = {
        ...pending,
        responseEnvelope: pending.responseEnvelope
          ? RemoteEncryptedEnvelope.parse(pending.responseEnvelope)
          : null,
      };
    }
    this.pollWaitMs = options.pollWaitMs ?? 25_000;
    if (!Number.isSafeInteger(this.pollWaitMs) || this.pollWaitMs < 0 || this.pollWaitMs > 25_000) {
      throw new RemoteBridgeSecurityError("connector poll wait must be between 0 and 25 seconds");
    }
  }

  get state(): {
    readonly relayCursor: number;
    readonly inboundSequences: ReadonlyMap<string, number>;
    readonly outboundSequences: ReadonlyMap<string, number>;
    readonly deliveryPending: boolean;
  } {
    return {
      relayCursor: this.relayCursor,
      inboundSequences: new Map(this.inboundSequences),
      outboundSequences: new Map(this.outboundSequences),
      deliveryPending: this.pending !== null,
    };
  }

  get persistedState(): RemoteConnectorPersistedState {
    return {
      relayCursor: this.relayCursor,
      inboundSequences: [...this.inboundSequences.entries()],
      outboundSequences: [...this.outboundSequences.entries()],
      pending: this.pending ? { ...this.pending } : null,
    };
  }

  private async persistCurrentState(): Promise<void> {
    await this.options.persistState?.(this.persistedState);
  }

  private async finishPending(signal?: AbortSignal): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    if (pending.responseEnvelope && !pending.responsePublished) {
      await this.options.relay.publish(pending.responseEnvelope, signal);
      pending.responsePublished = true;
      await this.persistCurrentState();
    }
    if (!pending.sequencesCommitted) {
      this.inboundSequences.set(pending.senderDeviceId, pending.inboundSequence);
      if (pending.outboundSequence !== null) {
        this.outboundSequences.set(pending.senderDeviceId, pending.outboundSequence);
      }
      pending.sequencesCommitted = true;
      await this.persistCurrentState();
    }
    await this.options.relay.acknowledge({
      accountId: this.certificate.accountId,
      deviceId: this.certificate.deviceId,
      throughCursor: pending.relayCursor,
      signal,
    });
    this.relayCursor = pending.relayCursor;
    this.pending = null;
    await this.persistCurrentState();
  }

  async processOnce(input: {
    readonly signal?: AbortSignal;
    readonly waitMs?: number;
  } = {}): Promise<number> {
    let processed = 0;
    await this.persistCurrentState();
    if (this.pending) {
      await this.finishPending(input.signal);
      processed += 1;
    }

    const inbox = await this.options.relay.poll({
      accountId: this.certificate.accountId,
      deviceId: this.certificate.deviceId,
      afterCursor: this.relayCursor,
      limit: 25,
      waitMs: input.waitMs ?? this.pollWaitMs,
      signal: input.signal,
    });

    let expectedCursor = this.relayCursor;
    for (const item of inbox.items) {
      expectedCursor += 1;
      if (!Number.isSafeInteger(expectedCursor) || item.cursor !== expectedCursor) {
        throw new RemoteBridgeSecurityError("relay returned a missing or reordered cursor");
      }
    }
    if (inbox.nextCursor !== expectedCursor) {
      throw new RemoteBridgeSecurityError("relay returned an inconsistent next cursor");
    }

    for (const item of inbox.items) {
      const senderCertificate = await this.options.resolveSenderCertificate(
        item.envelope.senderDeviceId,
      );
      const lastAcceptedSequence = this.inboundSequences.get(
        item.envelope.senderDeviceId,
      ) ?? 0;
      const opened = openRemoteEnvelope({
        envelope: item.envelope,
        recipientIdentity: this.options.identity,
        recipientCertificate: this.certificate,
        senderCertificate,
        accountSigningPublicKey: this.options.accountSigningPublicKey,
        lastAcceptedSequence,
        now: this.now(),
      });
      const request = {
        ...opened,
        senderDeviceId: item.envelope.senderDeviceId,
      };
      const action = validatedAuditIdentifier(
        this.options.classifyAction
          ? await this.options.classifyAction(request)
          : "remote.request",
        "action",
      );
      let response: RemoteConnectorResponse | null;
      try {
        response = await this.options.handleRequest(request);
      } catch (error) {
        await this.options.recordAudit?.({
          accountId: this.certificate.accountId,
          localDeviceId: this.certificate.deviceId,
          remoteDeviceId: item.envelope.senderDeviceId,
          messageId: opened.messageId,
          contentType: opened.contentType,
          action,
          outcome: "failed",
          errorCode: safeAuditErrorCode(error),
          createdAt: this.now().toISOString(),
        });
        throw error;
      }
      await this.options.recordAudit?.({
        accountId: this.certificate.accountId,
        localDeviceId: this.certificate.deviceId,
        remoteDeviceId: item.envelope.senderDeviceId,
        messageId: opened.messageId,
        contentType: opened.contentType,
        action,
        outcome: "accepted",
        createdAt: this.now().toISOString(),
      });
      const outboundSequence = response
        ? (this.outboundSequences.get(item.envelope.senderDeviceId) ?? 0) + 1
        : null;
      const responseEnvelope = response && outboundSequence !== null
        ? sealRemoteEnvelope({
            plaintext: response.plaintext,
            contentType: response.contentType,
            sequence: outboundSequence,
            senderIdentity: this.options.identity,
            senderCertificate: this.certificate,
            recipientCertificate: senderCertificate,
            accountSigningPublicKey: this.options.accountSigningPublicKey,
            sentAt: this.now(),
          })
        : null;

      this.pending = {
        relayCursor: item.cursor,
        senderDeviceId: item.envelope.senderDeviceId,
        inboundSequence: opened.sequence,
        responseEnvelope,
        outboundSequence,
        responsePublished: false,
        sequencesCommitted: false,
      };
      await this.persistCurrentState();
      await this.finishPending(input.signal);
      processed += 1;
    }
    return processed;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.processOnce({ signal });
      } catch (error) {
        if (signal.aborted && error instanceof Error && error.name === "AbortError") return;
        throw error;
      }
    }
  }
}

export interface RemoteConnectorDurableStore {
  isDeviceActive(deviceId: string): boolean;
  loadConnectorState(localDeviceId: string): RemoteConnectorPersistedState | null;
  saveConnectorState(localDeviceId: string, state: RemoteConnectorPersistedState): void;
  appendRemoteAction(event: RemoteConnectorAuditEvent): unknown;
}

export type DurableRemoteOutboundConnectorOptions = Omit<
  RemoteOutboundConnectorOptions,
  | "initialRelayCursor"
  | "initialInboundSequences"
  | "initialOutboundSequences"
  | "initialPersistedState"
  | "persistState"
  | "recordAudit"
  | "classifyAction"
> & {
  readonly stateStore: RemoteConnectorDurableStore;
  readonly classifyAction: NonNullable<RemoteOutboundConnectorOptions["classifyAction"]>;
};

export function createDurableRemoteOutboundConnector(
  input: DurableRemoteOutboundConnectorOptions,
): RemoteOutboundConnector {
  const { stateStore, ...options } = input;
  if (!stateStore.isDeviceActive(input.identity.deviceId)) {
    throw new RemoteBridgeSecurityError("local remote-bridge device is not active");
  }
  return new RemoteOutboundConnector({
    ...options,
    resolveSenderCertificate: async (deviceId) => {
      if (!stateStore.isDeviceActive(deviceId)) {
        throw new RemoteBridgeSecurityError("remote sender device is not active");
      }
      return options.resolveSenderCertificate(deviceId);
    },
    initialPersistedState: stateStore.loadConnectorState(input.identity.deviceId) ?? undefined,
    persistState: (state) => {
      stateStore.saveConnectorState(input.identity.deviceId, state);
    },
    recordAudit: (event) => {
      stateStore.appendRemoteAction(event);
    },
  });
}
