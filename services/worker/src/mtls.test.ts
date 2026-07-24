import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  readonly workerCert: string;
  readonly workerKey: string;
  readonly rogueCert: string;
  readonly rogueKey: string;
}

function openssl(args: readonly string[]): void {
  execFileSync("openssl", [...args], { stdio: "ignore" });
}

function createSelfSignedCertificate(
  root: string,
  name: string,
  usage: "serverAuth" | "clientAuth",
): { readonly cert: string; readonly key: string } {
  const key = join(root, `${name}.key`);
  const cert = join(root, `${name}.crt`);
  const extensions = [
    "basicConstraints=critical,CA:FALSE",
    `extendedKeyUsage=critical,${usage}`,
    "keyUsage=critical,digitalSignature,keyEncipherment",
    ...(usage === "serverAuth" ? ["subjectAltName=IP:127.0.0.1"] : []),
  ];
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    `/CN=${name}`,
    ...extensions.flatMap((extension) => ["-addext", extension]),
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  chmodSync(key, 0o600);
  chmodSync(cert, 0o644);
  return { cert, key };
}

function createTestPki(): TestPki {
  const root = mkdtempSync(join(tmpdir(), "avity-worker-mtls-"));
  chmodSync(root, 0o700);
  const server = createSelfSignedCertificate(
    root,
    "server",
    "serverAuth",
  );
  const worker = createSelfSignedCertificate(
    root,
    "worker",
    "clientAuth",
  );
  const rogue = createSelfSignedCertificate(
    root,
    "rogue",
    "clientAuth",
  );
  return {
    root,
    serverCert: server.cert,
    serverKey: server.key,
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
    const serverTls = loadControlPlaneTlsConfiguration(
      {
        AVITY_TLS_CERT_PATH: pki.serverCert,
        AVITY_TLS_KEY_PATH: pki.serverKey,
        AVITY_TLS_CLIENT_CA_PATH: pki.workerCert,
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
    try {
      app = await buildServer({
        store,
        engine,
        version: "test",
        apiToken: "admin-token",
        https: serverTls.serverOptions,
        workerMtlsRequired: serverTls.workerMtlsRequired,
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const baseUrl =
        `https://127.0.0.1:${
          typeof address === "object" && address ? address.port : 0
        }`;

      const withoutCertificate = await caOnly.fetch(
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
      const credentials = await enrollmentAgent.enroll();
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
