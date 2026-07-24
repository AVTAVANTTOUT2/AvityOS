import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect as connectTls,
  type TLSSocket,
} from "node:tls";
import {
  buildServer,
  DEFAULT_ENGINE_CONFIG,
  Engine,
  openDatabase,
  Store,
} from "@avityos/control-plane";
import { FakeProviderAdapter } from "@avityos/providers";
import {
  createSecureFetchTransport,
  loadClientTlsConfiguration,
  loadControlPlaneTlsConfiguration,
  type SecureFetchTransport,
} from "@avityos/transport-security";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { WorkerAgent } from "./agent.js";

interface TestPki {
  readonly root: string;
  readonly serverCert: string;
  readonly serverKey: string;
  readonly workerCaCert: string;
  readonly workerCert: string;
  readonly workerKey: string;
  readonly rogueCert: string;
  readonly rogueKey: string;
}

function openssl(args: readonly string[]): void {
  execFileSync("openssl", [...args], { stdio: "ignore" });
}

function createSelfSignedTrustAnchor(
  root: string,
  name: string,
  usage?: "serverAuth",
): { readonly cert: string; readonly key: string } {
  const key = join(root, `${name}.key`);
  const cert = join(root, `${name}.crt`);
  const request = join(root, `${name}.csr`);
  const extensionFile = join(root, `${name}.ext`);
  const extensions = [
    "basicConstraints=critical,CA:TRUE",
    "subjectKeyIdentifier=hash",
    "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign,cRLSign",
    ...(usage
      ? [
          `extendedKeyUsage=critical,${usage}`,
          "subjectAltName=IP:127.0.0.1",
        ]
      : []),
  ];
  writeFileSync(
    extensionFile,
    [...extensions, ""].join("\n"),
    { mode: 0o600 },
  );
  openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-subj",
    `/CN=${name}`,
    "-keyout",
    key,
    "-out",
    request,
  ]);
  openssl([
    "x509",
    "-req",
    "-sha256",
    "-days",
    "1",
    "-in",
    request,
    "-signkey",
    key,
    "-extfile",
    extensionFile,
    "-out",
    cert,
  ]);
  chmodSync(key, 0o600);
  chmodSync(cert, 0o644);
  return { cert, key };
}

function createSignedClientCertificate(
  root: string,
  ca: { readonly cert: string; readonly key: string },
  name: string,
): { readonly cert: string; readonly key: string } {
  const key = join(root, `${name}.key`);
  const request = join(root, `${name}.csr`);
  const cert = join(root, `${name}.crt`);
  const chain = join(root, `${name}-chain.crt`);
  const extensions = join(root, `${name}.ext`);
  writeFileSync(
    extensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid,issuer",
      "extendedKeyUsage=critical,clientAuth",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-subj",
    `/CN=${name}`,
    "-keyout",
    key,
    "-out",
    request,
  ]);
  openssl([
    "x509",
    "-req",
    "-sha256",
    "-days",
    "1",
    "-in",
    request,
    "-CA",
    ca.cert,
    "-CAkey",
    ca.key,
    "-CAcreateserial",
    "-extfile",
    extensions,
    "-out",
    cert,
  ]);
  chmodSync(key, 0o600);
  chmodSync(cert, 0o644);
  writeFileSync(
    chain,
    Buffer.concat([
      readFileSync(cert),
      Buffer.from("\n"),
      readFileSync(ca.cert),
    ]),
    { mode: 0o644 },
  );
  return { cert: chain, key };
}

function createTestPki(): TestPki {
  const root = mkdtempSync(join(tmpdir(), "avity-worker-mtls-"));
  chmodSync(root, 0o700);
  const server = createSelfSignedTrustAnchor(
    root,
    "server",
    "serverAuth",
  );
  const workerCa = createSelfSignedTrustAnchor(root, "worker-ca");
  const worker = createSignedClientCertificate(root, workerCa, "worker");
  const rogue = createSignedClientCertificate(root, workerCa, "rogue");
  return {
    root,
    serverCert: server.cert,
    serverKey: server.key,
    workerCaCert: workerCa.cert,
    workerCert: worker.cert,
    workerKey: worker.key,
    rogueCert: rogue.cert,
    rogueKey: rogue.key,
  };
}

function clientTransport(
  caPath: string,
  certPath?: string,
  keyPath?: string,
): SecureFetchTransport {
  const configuration = loadClientTlsConfiguration({
    AVITY_TLS_CA_PATH: caPath,
    ...(certPath ? { AVITY_TLS_CLIENT_CERT_PATH: certPath } : {}),
    ...(keyPath ? { AVITY_TLS_CLIENT_KEY_PATH: keyPath } : {}),
  });
  if (!configuration) throw new Error("test TLS configuration is missing");
  return createSecureFetchTransport(configuration);
}

async function probeRawTls(port: number, caPath: string): Promise<void> {
  const configuration = loadClientTlsConfiguration({
    AVITY_TLS_CA_PATH: caPath,
  });
  if (!configuration) throw new Error("test TLS configuration is missing");
  await new Promise<void>((resolve, reject) => {
    const socket = connectTls(
      {
        host: "127.0.0.1",
        port,
        ca: configuration.ca,
        allowPartialTrustChain: true,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
      },
      () => {
        socket.end();
        resolve();
      },
    );
    socket.once("error", reject);
  });
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("mTLS worker test timed out");
}

describe("worker mutual TLS transport", () => {
  it("binds the enrolled worker bearer to its authorized client certificate", async () => {
    const pki = createTestPki();
    expect(new X509Certificate(readFileSync(pki.workerCaCert)).ca).toBe(true);
    const serverTls = loadControlPlaneTlsConfiguration(
      {
        AVITY_TLS_CERT_PATH: pki.serverCert,
        AVITY_TLS_KEY_PATH: pki.serverKey,
        AVITY_TLS_CLIENT_CA_PATH: pki.workerCaCert,
      },
      "127.0.0.1",
    );
    const caOnly = clientTransport(pki.serverCert);
    const trusted = clientTransport(
      pki.serverCert,
      pki.workerCert,
      pki.workerKey,
    );
    const rogue = clientTransport(
      pki.serverCert,
      pki.rogueCert,
      pki.rogueKey,
    );
    const db = openDatabase(":memory:");
    const store = new Store(db);
    const engine = new Engine(
      store,
      new Map([["fake", new FakeProviderAdapter()]]),
      { ...DEFAULT_ENGINE_CONFIG, tickMs: 50 },
    );
    let app: FastifyInstance | null = null;
    let agent: WorkerAgent | null = null;
    let lastPeerDiagnostics: Record<string, unknown> | null = null;
    try {
      app = await buildServer({
        store,
        engine,
        version: "test",
        apiToken: "admin-token",
        https: serverTls.serverOptions,
        workerMtlsRequired: serverTls.workerMtlsRequired,
      });
      app.server.on("secureConnection", (socket: TLSSocket) => {
        const certificate = socket.getPeerCertificate();
        lastPeerDiagnostics = {
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ?? null,
          subject: certificate.subject ?? null,
          issuer: certificate.issuer ?? null,
          hasRawCertificate: Boolean(certificate.raw?.byteLength),
        };
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const baseUrl =
        `https://127.0.0.1:${port}`;

      try {
        await probeRawTls(port, pki.serverCert);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `raw TLS trust probe failed on ${process.version}: ${detail}`,
          { cause: error },
        );
      }

      let withoutCertificate: Response;
      try {
        withoutCertificate = await caOnly.fetch(
          `${baseUrl}/v1/workers/enroll`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer admin-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              name: "no-certificate",
              capabilities: ["shell"],
            }),
          },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `server-certificate trust probe failed on ${process.version}: ${detail}`,
          { cause: error },
        );
      }
      expect(withoutCertificate.status).toBe(401);

      const browserSession = await caOnly.fetch(`${baseUrl}/v1/session`, {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
      });
      expect(browserSession.status).toBe(200);
      expect(browserSession.headers.get("set-cookie")).toContain("Secure");

      const enrollmentAgent = new WorkerAgent({
        controlPlaneUrl: baseUrl,
        name: "mtls-worker",
        pollMs: 25,
        capabilities: ["shell"],
        apiToken: "admin-token",
        fetchImpl: trusted.fetch,
      });
      let credentials: Awaited<ReturnType<WorkerAgent["enroll"]>>;
      try {
        credentials = await enrollmentAgent.enroll();
      } catch (error) {
        throw new Error(
          `worker enrollment TLS diagnostics: ${JSON.stringify(lastPeerDiagnostics)}`,
          { cause: error },
        );
      }
      const persisted = store.db.prepare(
        "SELECT mtls_fingerprint FROM workers WHERE id = ?",
      ).get(credentials.id) as { mtls_fingerprint: string };
      expect(persisted.mtls_fingerprint).toMatch(/^[a-f0-9]{64}$/);

      agent = new WorkerAgent({
        controlPlaneUrl: baseUrl,
        name: "mtls-worker",
        workerId: credentials.id,
        workerToken: credentials.token,
        pollMs: 25,
        capabilities: ["shell"],
        fetchImpl: trusted.fetch,
      });
      agent.start();
      const project = store.createProject({
        name: "mTLS transport",
        description: "",
        repoPath: null,
        repoRemoteUrl: null,
        autonomyProfile: "autonomous_with_checkpoints",
      });
      const terminal = store.createTerminal(
        project.id,
        ["echo", "certificate-bound"],
        process.cwd(),
      );
      await waitFor(() => store.getTerminal(terminal.id)?.state === "succeeded");
      expect(
        store.terminalLogs(terminal.id).map((row) => row.text).join(""),
      ).toContain("certificate-bound");

      const stolenBearer = await rogue.fetch(
        `${baseUrl}/v1/workers/lease`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-worker-id": credentials.id,
            "x-worker-token": credentials.token,
          },
          body: "{}",
        },
      );
      expect(stolenBearer.status).toBe(401);

      const rotationResponse = await caOnly.fetch(
        `${baseUrl}/v1/workers/${credentials.id}/token-rotations`,
        {
          method: "POST",
          headers: { authorization: "Bearer admin-token" },
        },
      );
      expect(rotationResponse.status).toBe(201);
      const rotation = await rotationResponse.json() as {
        rotationId: string;
        token: string;
      };
      expect(JSON.stringify(
        store.db.prepare("SELECT * FROM workers WHERE id = ?").get(
          credentials.id,
        ),
      )).not.toContain(rotation.token);

      const roguePending = await rogue.fetch(
        `${baseUrl}/v1/workers/lease`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-worker-id": credentials.id,
            "x-worker-token": rotation.token,
          },
          body: "{}",
        },
      );
      expect(roguePending.status).toBe(401);
      const unseen = await caOnly.fetch(
        `${baseUrl}/v1/workers/${credentials.id}/token-rotation`,
        { headers: { authorization: "Bearer admin-token" } },
      );
      expect(await unseen.json()).toMatchObject({ pendingSeen: false });

      await agent.stop();
      agent = new WorkerAgent({
        controlPlaneUrl: baseUrl,
        name: "mtls-worker",
        workerId: credentials.id,
        workerToken: rotation.token,
        pollMs: 25,
        capabilities: ["shell"],
        fetchImpl: trusted.fetch,
      });
      await agent.poll();
      const proven = await caOnly.fetch(
        `${baseUrl}/v1/workers/${credentials.id}/token-rotation`,
        { headers: { authorization: "Bearer admin-token" } },
      );
      expect(await proven.json()).toMatchObject({
        rotationId: rotation.rotationId,
        pendingSeen: true,
      });
      const committed = await caOnly.fetch(
        `${baseUrl}/v1/workers/${credentials.id}/token-rotations/${rotation.rotationId}/commit`,
        {
          method: "POST",
          headers: { authorization: "Bearer admin-token" },
        },
      );
      expect(committed.status).toBe(200);

      const retiredBearer = await trusted.fetch(
        `${baseUrl}/v1/workers/lease`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-worker-id": credentials.id,
            "x-worker-token": credentials.token,
          },
          body: "{}",
        },
      );
      expect(retiredBearer.status).toBe(401);
      const rotatedBearer = await trusted.fetch(
        `${baseUrl}/v1/workers/lease`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-worker-id": credentials.id,
            "x-worker-token": rotation.token,
          },
          body: "{}",
        },
      );
      expect(rotatedBearer.status).toBe(200);

      const listed = await caOnly.fetch(`${baseUrl}/v1/workers`, {
        headers: { authorization: "Bearer admin-token" },
      });
      expect(listed.status).toBe(200);
      const listing = await listed.json() as {
        items: Array<Record<string, unknown>>;
      };
      expect(listing.items).toEqual([
        expect.objectContaining({
          id: credentials.id,
          mutualTls: true,
        }),
      ]);
      expect(JSON.stringify(listing)).not.toContain(
        persisted.mtls_fingerprint,
      );
    } finally {
      await agent?.stop();
      await engine.stop();
      await app?.close();
      db.close();
      caOnly.close();
      trusted.close();
      rogue.close();
    }
  });
});
