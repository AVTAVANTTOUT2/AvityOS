import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import {
  MACOS_UPDATE_MANIFEST_SCHEMA_VERSION,
  MacOSUpdateManifest,
  MacOSUpdateVersion,
  SignedMacOSUpdateManifest,
  type MacOSUpdateManifest as MacOSUpdateManifestType,
  type SignedMacOSUpdateManifest as SignedMacOSUpdateManifestType,
} from "@avityos/contracts";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export class MacOSUpdateError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_signature"
      | "network"
      | "size_mismatch"
      | "checksum_mismatch"
      | "not_an_upgrade",
    message: string,
  ) {
    super(message);
    this.name = "MacOSUpdateError";
  }
}

function ed25519PrivateKey(value: string | Buffer | KeyObject): KeyObject {
  try {
    const key = value instanceof KeyObject ? value : createPrivateKey(value);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("not an Ed25519 private key");
    }
    return key;
  } catch {
    throw new MacOSUpdateError(
      "invalid_input",
      "update signing key must be an Ed25519 private key",
    );
  }
}

function ed25519PublicKey(value: string | Buffer | KeyObject): KeyObject {
  try {
    const key = value instanceof KeyObject ? value : createPublicKey(value);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("not an Ed25519 public key");
    }
    return key;
  } catch {
    throw new MacOSUpdateError(
      "invalid_input",
      "update trust anchor must be an Ed25519 public key",
    );
  }
}

function canonicalManifest(
  value: MacOSUpdateManifestType,
): {
  readonly manifest: MacOSUpdateManifestType;
  readonly bytes: Buffer;
} {
  const manifest = MacOSUpdateManifest.parse(value);
  return {
    manifest,
    bytes: Buffer.from(JSON.stringify(manifest), "utf8"),
  };
}

export function signMacOSUpdateManifest(
  manifestValue: MacOSUpdateManifestType,
  privateKeyValue: string | Buffer | KeyObject,
): SignedMacOSUpdateManifestType {
  const { manifest, bytes } = canonicalManifest(manifestValue);
  const signature = sign(
    null,
    bytes,
    ed25519PrivateKey(privateKeyValue),
  ).toString("base64url");
  return SignedMacOSUpdateManifest.parse({ manifest, signature });
}

export function verifySignedMacOSUpdateManifest(
  value: unknown,
  publicKeyValue: string | Buffer | KeyObject,
): MacOSUpdateManifestType {
  const signed = SignedMacOSUpdateManifest.parse(value);
  const { manifest, bytes } = canonicalManifest(signed.manifest);
  const valid = verify(
    null,
    bytes,
    ed25519PublicKey(publicKeyValue),
    Buffer.from(signed.signature, "base64url"),
  );
  if (!valid) {
    throw new MacOSUpdateError(
      "invalid_signature",
      "macOS update manifest signature is invalid",
    );
  }
  return manifest;
}

export function macOSUpdatePublicKeyFingerprint(
  publicKeyValue: string | Buffer | KeyObject,
): string {
  const der = ed25519PublicKey(publicKeyValue).export({
    format: "der",
    type: "spki",
  });
  return createHash("sha256").update(der).digest("hex");
}

export function createSignedMacOSUpdate(input: {
  readonly version: string;
  readonly buildNumber: number;
  readonly minimumSystemVersion: string;
  readonly publishedAt?: Date | string | number;
  readonly teamIdentifier: string;
  readonly archiveUrl: string;
  readonly archiveBytes: Uint8Array;
  readonly releaseNotesUrl: string;
  readonly privateKey: string | Buffer | KeyObject;
}): SignedMacOSUpdateManifestType {
  const publishedAt = new Date(input.publishedAt ?? Date.now());
  if (!Number.isFinite(publishedAt.getTime())) {
    throw new MacOSUpdateError("invalid_input", "update publication date is invalid");
  }
  const archiveBytes = Buffer.from(input.archiveBytes);
  const manifest = MacOSUpdateManifest.parse({
    schemaVersion: MACOS_UPDATE_MANIFEST_SCHEMA_VERSION,
    channel: "stable",
    version: input.version,
    buildNumber: input.buildNumber,
    minimumSystemVersion: input.minimumSystemVersion,
    publishedAt: publishedAt.toISOString(),
    teamIdentifier: input.teamIdentifier,
    archive: {
      url: input.archiveUrl,
      sha256: createHash("sha256").update(archiveBytes).digest("hex"),
      sizeBytes: archiveBytes.byteLength,
    },
    releaseNotesUrl: input.releaseNotesUrl,
  });
  return signMacOSUpdateManifest(manifest, input.privateKey);
}

function numericVersion(value: string): readonly [number, number, number] {
  return MacOSUpdateVersion.parse(value).split(".").map(Number) as [
    number,
    number,
    number,
  ];
}

function compareNumericVersions(left: string, right: string): number {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function assertMacOSUpdateIsUpgrade(input: {
  readonly installedVersion: string;
  readonly installedBuildNumber: number;
  readonly manifest: MacOSUpdateManifestType;
}): void {
  const manifest = MacOSUpdateManifest.parse(input.manifest);
  const installedVersion = MacOSUpdateVersion.parse(input.installedVersion);
  if (
    !Number.isSafeInteger(input.installedBuildNumber) ||
    input.installedBuildNumber < 1
  ) {
    throw new MacOSUpdateError(
      "invalid_input",
      "installed build number must be a positive safe integer",
    );
  }
  if (
    compareNumericVersions(manifest.version, installedVersion) < 0 ||
    manifest.buildNumber <= input.installedBuildNumber
  ) {
    throw new MacOSUpdateError(
      "not_an_upgrade",
      `refusing non-increasing update ${manifest.version} (${manifest.buildNumber})`,
    );
  }
}

export function assertMacOSSystemMeetsMinimum(input: {
  readonly systemVersion: string;
  readonly minimumSystemVersion: string;
}): void {
  const parse = (value: string, label: string): readonly [number, number] => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.\d+)?$/.exec(value);
    if (!match) {
      throw new MacOSUpdateError("invalid_input", `${label} is invalid`);
    }
    return [Number(match[1]), Number(match[2])];
  };
  const system = parse(input.systemVersion, "macOS system version");
  const minimum = parse(
    input.minimumSystemVersion,
    "minimum macOS system version",
  );
  if (
    system[0] < minimum[0] ||
    (system[0] === minimum[0] && system[1] < minimum[1])
  ) {
    throw new MacOSUpdateError(
      "invalid_input",
      `update requires macOS ${input.minimumSystemVersion} or later`,
    );
  }
}

function validatedHttpsUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("invalid update URL");
    }
    return url.toString();
  } catch {
    throw new MacOSUpdateError(
      "invalid_input",
      `${label} must be an HTTPS URL without credentials or fragment`,
    );
  }
}

async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  if (!response.ok) {
    throw new MacOSUpdateError(
      "network",
      `${label} request failed with HTTP ${response.status}`,
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (
      !/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > maximumBytes
    )
  ) {
    throw new MacOSUpdateError("size_mismatch", `${label} exceeds its size limit`);
  }
  if (!response.body) {
    throw new MacOSUpdateError("network", `${label} response has no body`);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new MacOSUpdateError("size_mismatch", `${label} exceeds its size limit`);
    }
    chunks.push(Buffer.from(result.value));
  }
  return Buffer.concat(chunks, size);
}

export async function downloadVerifiedMacOSUpdate(input: {
  readonly manifestUrl: string;
  readonly publicKey: string | Buffer | KeyObject;
  readonly installedVersion: string;
  readonly installedBuildNumber: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly manifest: MacOSUpdateManifestType;
  readonly archiveBytes: Buffer;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const manifestUrl = validatedHttpsUrl(input.manifestUrl, "update manifest URL");
  let manifestResponse: Response;
  try {
    manifestResponse = await fetchImpl(manifestUrl, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    throw new MacOSUpdateError(
      "network",
      `update manifest request failed: ${
        error instanceof Error ? error.message : "network error"
      }`,
    );
  }
  const manifestBytes = await boundedResponseBytes(
    manifestResponse,
    MAX_MANIFEST_BYTES,
    "update manifest",
  );
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new MacOSUpdateError("invalid_input", "update manifest is not valid JSON");
  }
  const manifest = verifySignedMacOSUpdateManifest(
    manifestValue,
    input.publicKey,
  );
  assertMacOSUpdateIsUpgrade({
    installedVersion: input.installedVersion,
    installedBuildNumber: input.installedBuildNumber,
    manifest,
  });

  const archiveUrl = validatedHttpsUrl(
    manifest.archive.url,
    "update archive URL",
  );
  let archiveResponse: Response;
  try {
    archiveResponse = await fetchImpl(archiveUrl, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/zip",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    throw new MacOSUpdateError(
      "network",
      `update archive request failed: ${
        error instanceof Error ? error.message : "network error"
      }`,
    );
  }
  const archiveBytes = await boundedResponseBytes(
    archiveResponse,
    MAX_ARCHIVE_BYTES,
    "update archive",
  );
  if (archiveBytes.byteLength !== manifest.archive.sizeBytes) {
    throw new MacOSUpdateError(
      "size_mismatch",
      "update archive size does not match the signed manifest",
    );
  }
  const checksum = createHash("sha256").update(archiveBytes).digest("hex");
  if (checksum !== manifest.archive.sha256) {
    throw new MacOSUpdateError(
      "checksum_mismatch",
      "update archive checksum does not match the signed manifest",
    );
  }
  return { manifest, archiveBytes };
}
