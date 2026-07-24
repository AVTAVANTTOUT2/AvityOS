import { X509Certificate } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import {
  Agent as HttpsAgent,
  request as httpsRequest,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import { isIP } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";

const MAX_PRIVATE_KEY_BYTES = 128 * 1024;
const MAX_CERTIFICATE_CHAIN_BYTES = 512 * 1024;
const MAX_HTTPS_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ControlPlaneTlsConfiguration {
  readonly enabled: boolean;
  readonly protocol: "http" | "https";
  readonly workerMtlsRequired: boolean;
  readonly serverOptions?: HttpsServerOptions;
}

export interface ClientTlsConfiguration {
  readonly ca?: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
  readonly servername?: string;
}

export interface SecureFetchTransport {
  readonly fetch: typeof fetch;
  close(): void;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1";
}

function requiredPath(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isAbsolute(value) || value === "/") {
    throw new Error(`${label} must be an absolute non-root path`);
  }
  return value;
}

function readOwnedPem(
  path: string,
  label: string,
  options: {
    readonly privateMaterial: boolean;
    readonly maxBytes: number;
  },
): Buffer {
  const stats = lstatSync(path);
  const expectedUid = process.getuid?.();
  const mode = stats.mode & 0o777;
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (expectedUid !== undefined && stats.uid !== expectedUid) ||
    (options.privateMaterial
      ? mode !== 0o600
      : (mode & 0o022) !== 0 || (mode & 0o400) === 0)
  ) {
    throw new Error(
      options.privateMaterial
        ? `${label} must be a mode 0600 regular file owned by this user`
        : `${label} must be an owner-readable, non-writable-by-group/others regular file owned by this user`,
    );
  }
  if (stats.size < 1 || stats.size > options.maxBytes) {
    throw new Error(`${label} size is outside the allowed range`);
  }
  const descriptor = openSync(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(stats.size + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        total,
        bytes.byteLength - total,
        null,
      );
      if (count === 0) break;
      total += count;
    }
    if (total !== stats.size) {
      throw new Error(`${label} changed while being read`);
    }
    return bytes.subarray(0, total);
  } finally {
    closeSync(descriptor);
  }
}

function readCertificate(path: string, label: string): Buffer {
  return readOwnedPem(path, label, {
    privateMaterial: false,
    maxBytes: MAX_CERTIFICATE_CHAIN_BYTES,
  });
}

function readPrivateKey(path: string, label: string): Buffer {
  const parent = dirname(path);
  const parentStats = lstatSync(parent);
  const expectedUid = process.getuid?.();
  if (
    parentStats.isSymbolicLink() ||
    !parentStats.isDirectory() ||
    (parentStats.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && parentStats.uid !== expectedUid)
  ) {
    throw new Error(
      `${label} directory must be mode 0700, non-symlinked and owned by this user`,
    );
  }
  return readOwnedPem(path, label, {
    privateMaterial: true,
    maxBytes: MAX_PRIVATE_KEY_BYTES,
  });
}

export function loadControlPlaneTlsConfiguration(
  env: NodeJS.ProcessEnv,
  bindHost: string,
): ControlPlaneTlsConfiguration {
  const certPath = requiredPath(
    env.AVITY_TLS_CERT_PATH,
    "AVITY_TLS_CERT_PATH",
  );
  const keyPath = requiredPath(
    env.AVITY_TLS_KEY_PATH,
    "AVITY_TLS_KEY_PATH",
  );
  const clientCaPath = requiredPath(
    env.AVITY_TLS_CLIENT_CA_PATH,
    "AVITY_TLS_CLIENT_CA_PATH",
  );
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error(
      "AVITY_TLS_CERT_PATH and AVITY_TLS_KEY_PATH must be configured together",
    );
  }
  if (!certPath || !keyPath) {
    if (clientCaPath) {
      throw new Error("AVITY_TLS_CLIENT_CA_PATH requires server TLS");
    }
    if (!isLoopbackHost(bindHost)) {
      throw new Error(
        `refusing plaintext control-plane bind on ${bindHost}; configure TLS or bind loopback`,
      );
    }
    return {
      enabled: false,
      protocol: "http",
      workerMtlsRequired: false,
    };
  }

  const cert = readCertificate(certPath, "control-plane TLS certificate");
  const key = readPrivateKey(keyPath, "control-plane TLS private key");
  const ca = clientCaPath
    ? readCertificate(clientCaPath, "worker mTLS client CA")
    : undefined;
  createSecureContext({
    cert,
    key,
    ...(ca ? { ca } : {}),
    minVersion: "TLSv1.3",
  });
  return {
    enabled: true,
    protocol: "https",
    workerMtlsRequired: Boolean(ca),
    serverOptions: {
      cert,
      key,
      ...(ca
        ? {
            ca,
            requestCert: true,
            // Admin/browser clients may authenticate with the bearer without
            // a client certificate. Worker routes enforce authorization and
            // fingerprint binding in the application layer.
            rejectUnauthorized: false,
          }
        : {}),
      minVersion: "TLSv1.3",
    },
  };
}

export function loadClientTlsConfiguration(
  env: NodeJS.ProcessEnv,
): ClientTlsConfiguration | null {
  const caPath = requiredPath(env.AVITY_TLS_CA_PATH, "AVITY_TLS_CA_PATH");
  const certPath = requiredPath(
    env.AVITY_TLS_CLIENT_CERT_PATH,
    "AVITY_TLS_CLIENT_CERT_PATH",
  );
  const keyPath = requiredPath(
    env.AVITY_TLS_CLIENT_KEY_PATH,
    "AVITY_TLS_CLIENT_KEY_PATH",
  );
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error(
      "AVITY_TLS_CLIENT_CERT_PATH and AVITY_TLS_CLIENT_KEY_PATH must be configured together",
    );
  }
  if (!caPath && !certPath) return null;
  const servername = env.AVITY_TLS_SERVER_NAME;
  if (
    servername &&
    (servername.length > 253 ||
      isIP(servername) !== 0 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(servername) ||
      servername.includes(".."))
  ) {
    throw new Error("AVITY_TLS_SERVER_NAME must be a valid DNS hostname");
  }
  const configuration: ClientTlsConfiguration = {
    ...(caPath
      ? { ca: readCertificate(caPath, "control-plane TLS CA") }
      : {}),
    ...(certPath && keyPath
      ? {
          cert: readCertificate(certPath, "mTLS client certificate"),
          key: readPrivateKey(keyPath, "mTLS client private key"),
        }
      : {}),
    ...(servername
      ? { servername }
      : {}),
  };
  createSecureContext({
    ...configuration,
    minVersion: "TLSv1.3",
  });
  return configuration;
}

function requestBody(
  body: RequestInit["body"],
): Buffer | string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error("secure fetch supports only bounded string or byte bodies");
}

export function createSecureFetchTransport(
  configuration: ClientTlsConfiguration,
): SecureFetchTransport {
  const agent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 8,
    maxFreeSockets: 2,
    timeout: 30_000,
    ...configuration,
    minVersion: "TLSv1.3",
    rejectUnauthorized: true,
  });
  const secureFetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.protocol !== "https:") {
      throw new Error("custom TLS material may only be used with HTTPS");
    }
    if (url.username || url.password) {
      throw new Error("HTTPS control-plane URL must not contain credentials");
    }
    const method = init.method ??
      (input instanceof Request ? input.method : "GET");
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const body = requestBody(init.body);
    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          agent,
          // Keep the TLS identity explicit on each request so verification
          // does not depend on Agent option inheritance across supported
          // Node builds.
          ...configuration,
          method,
          headers: Object.fromEntries(headers.entries()),
          signal: init.signal ?? undefined,
          ...(configuration.servername
            ? { servername: configuration.servername }
            : isIP(url.hostname) === 0
              ? { servername: url.hostname }
              : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > MAX_HTTPS_RESPONSE_BYTES) {
              response.destroy(
                new Error("HTTPS response exceeds the 4 MiB limit"),
              );
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once("error", reject);
          response.once("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) responseHeaders.append(name, item);
              } else if (value !== undefined) {
                responseHeaders.set(name, value);
              }
            }
            resolve(
              new Response(Buffer.concat(chunks, total), {
                status: response.statusCode ?? 500,
                statusText: response.statusMessage,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      request.once("error", reject);
      if (body !== null) request.write(body);
      request.end();
    });
  }) as typeof fetch;
  return {
    fetch: secureFetch,
    close: () => agent.destroy(),
  };
}

export function authorizedPeerCertificateFingerprint(
  socket: unknown,
): string | null {
  if (!(socket instanceof TLSSocket) || !socket.authorized) return null;
  const certificate = socket.getPeerCertificate();
  if (!certificate.raw || certificate.raw.byteLength === 0) return null;
  return new X509Certificate(certificate.raw).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
}
