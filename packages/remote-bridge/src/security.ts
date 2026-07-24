import {
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  RemoteDeviceCertificate,
  type RemoteDeviceCertificate as RemoteDeviceCertificateType,
} from "@avityos/contracts";

export class RemoteBridgeSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteBridgeSecurityError";
  }
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new RemoteBridgeSecurityError("unsupported canonical value");
}

export function decode(value: string, label: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 0) throw new Error("empty");
    return decoded;
  } catch {
    throw new RemoteBridgeSecurityError(`invalid ${label}`);
  }
}

export function importPublicKey(value: string): KeyObject {
  try {
    return createPublicKey({
      key: decode(value, "public key"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new RemoteBridgeSecurityError("invalid public key");
  }
}

export function validDate(input: Date | string | number, label: string): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) {
    throw new RemoteBridgeSecurityError(`invalid ${label}`);
  }
  return date;
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
  const { signature, ...payload } = certificate;
  const authentic = verify(
    null,
    Buffer.from(canonicalJson(payload)),
    importPublicKey(accountSigningPublicKey),
    decode(signature, "certificate signature"),
  );
  if (!authentic) {
    throw new RemoteBridgeSecurityError("device certificate signature is invalid");
  }
  return certificate;
}
