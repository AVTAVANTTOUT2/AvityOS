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
  RemotePairingOffer,
  RemotePairingRequest,
  RemotePairingRequestPayload,
  RemotePairingSession,
  type RemoteEncryptedEnvelope as RemoteEncryptedEnvelopeType,
  type RemoteDeviceCertificate as RemoteDeviceCertificateType,
  type RemotePairingAcceptance as RemotePairingAcceptanceType,
  type RemotePairingOffer as RemotePairingOfferType,
  type RemotePairingRequest as RemotePairingRequestType,
  type RemotePairingSession as RemotePairingSessionType,
} from "@avityos/contracts";

const PAIRING_REQUEST_CONTEXT = "avityos-remote-pairing-request-v1";
const PAIRING_ACCEPTANCE_CONTEXT = "avityos-remote-pairing-acceptance-v1";
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

export class RemoteBridgeSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteBridgeSecurityError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new RemoteBridgeSecurityError("unsupported canonical value");
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string, label: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 0) throw new Error("empty");
    return decoded;
  } catch {
    throw new RemoteBridgeSecurityError(`invalid ${label}`);
  }
}

function exportPublicKey(key: KeyObject): string {
  return encode(key.export({ format: "der", type: "spki" }));
}

function exportPrivateKey(key: KeyObject): string {
  return encode(key.export({ format: "der", type: "pkcs8" }));
}

function importPublicKey(value: string): KeyObject {
  try {
    return createPublicKey({ key: decode(value, "public key"), format: "der", type: "spki" });
  } catch {
    throw new RemoteBridgeSecurityError("invalid public key");
  }
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

function validDate(input: Date | string | number, label: string): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) {
    throw new RemoteBridgeSecurityError(`invalid ${label}`);
  }
  return date;
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

function certificatePayload(certificate: RemoteDeviceCertificateType): Omit<RemoteDeviceCertificateType, "signature"> {
  const { signature: _signature, ...payload } = certificate;
  return payload;
}

function pairingAad(sessionId: string, direction: "request" | "acceptance"): Buffer {
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

export function verifyRemoteDeviceCertificate(
  certificateInput: unknown,
  accountSigningPublicKey: string,
  now: Date | string | number = Date.now(),
): RemoteDeviceCertificateType {
  const certificate = RemoteDeviceCertificate.parse(certificateInput);
  const current = validDate(now, "certificate verification timestamp").getTime();
  if (
    current < new Date(certificate.issuedAt).getTime() ||
    current > new Date(certificate.validUntil).getTime()
  ) {
    throw new RemoteBridgeSecurityError("device certificate is not currently valid");
  }
  const valid = verify(
    null,
    Buffer.from(canonicalJson(certificatePayload(certificate))),
    importPublicKey(accountSigningPublicKey),
    decode(certificate.signature, "certificate signature"),
  );
  if (!valid) throw new RemoteBridgeSecurityError("device certificate signature is invalid");
  return certificate;
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
