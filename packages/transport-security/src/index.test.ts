import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientCertificateIsAuthorizedBy,
  loadClientTlsConfiguration,
  loadControlPlaneTlsConfiguration,
} from "./index.js";

function fixture(): {
  readonly root: string;
  readonly certPath: string;
  readonly keyPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "avity-transport-tls-"));
  chmodSync(root, 0o700);
  const certPath = join(root, "server.crt");
  const keyPath = join(root, "server.key");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ], { stdio: "ignore" });
  chmodSync(keyPath, 0o600);
  chmodSync(certPath, 0o644);
  return { root, certPath, keyPath };
}

function signedCertificateFixture(): {
  readonly ca: X509Certificate;
  readonly client: X509Certificate;
  readonly server: X509Certificate;
} {
  const root = mkdtempSync(join(tmpdir(), "avity-transport-client-ca-"));
  chmodSync(root, 0o700);
  const caKey = join(root, "ca.key");
  const caCert = join(root, "ca.crt");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=AvityOS transport test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    caKey,
    "-out",
    caCert,
  ], { stdio: "ignore" });

  const issue = (
    name: string,
    usage: "clientAuth" | "serverAuth",
  ): X509Certificate => {
    const key = join(root, `${name}.key`);
    const request = join(root, `${name}.csr`);
    const cert = join(root, `${name}.crt`);
    const extensions = join(root, `${name}.ext`);
    writeFileSync(
      extensions,
      [
        "basicConstraints=critical,CA:FALSE",
        `extendedKeyUsage=critical,${usage}`,
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    execFileSync("openssl", [
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
    ], { stdio: "ignore" });
    execFileSync("openssl", [
      "x509",
      "-req",
      "-sha256",
      "-days",
      "1",
      "-in",
      request,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-extfile",
      extensions,
      "-out",
      cert,
    ], { stdio: "ignore" });
    return new X509Certificate(readFileSync(cert));
  };

  return {
    ca: new X509Certificate(readFileSync(caCert)),
    client: issue("worker", "clientAuth"),
    server: issue("server", "serverAuth"),
  };
}

describe("transport TLS configuration", () => {
  it("fails closed for non-loopback plaintext and incomplete TLS pairs", () => {
    expect(() => loadControlPlaneTlsConfiguration({}, "0.0.0.0")).toThrow(
      /refusing plaintext/,
    );
    expect(
      () =>
        loadControlPlaneTlsConfiguration(
          { AVITY_TLS_CERT_PATH: "/private/server.crt" },
          "127.0.0.1",
        ),
    ).toThrow(/configured together/);
    expect(loadControlPlaneTlsConfiguration({}, "127.0.0.1")).toEqual({
      enabled: false,
      protocol: "http",
      workerMtlsRequired: false,
    });
  });

  it("loads only owner-controlled PEM files and validates key/cert pairs", () => {
    const { root, certPath, keyPath } = fixture();
    const loaded = loadControlPlaneTlsConfiguration(
      {
        AVITY_TLS_CERT_PATH: certPath,
        AVITY_TLS_KEY_PATH: keyPath,
        AVITY_TLS_CLIENT_CA_PATH: certPath,
      },
      "0.0.0.0",
    );
    expect(loaded.protocol).toBe("https");
    expect(loaded.workerMtlsRequired).toBe(true);
    expect(loaded.workerTrustAnchors).toHaveLength(1);
    expect(loaded.serverOptions?.minVersion).toBe("TLSv1.3");
    const loadedCertificate = loaded.serverOptions?.cert;
    expect(loadedCertificate).toEqual(expect.any(String));
    expect(loadedCertificate).toContain("BEGIN CERTIFICATE");

    chmodSync(keyPath, 0o644);
    expect(() =>
      loadControlPlaneTlsConfiguration(
        {
          AVITY_TLS_CERT_PATH: certPath,
          AVITY_TLS_KEY_PATH: keyPath,
        },
        "127.0.0.1",
      )
    ).toThrow(/mode 0600/);

    const linked = join(root, "linked-ca.crt");
    symlinkSync(certPath, linked);
    expect(() =>
      loadClientTlsConfiguration({ AVITY_TLS_CA_PATH: linked })
    ).toThrow(/regular file/);
  });

  it("rejects client key/cert mismatches before opening a connection", () => {
    const { root, certPath, keyPath } = fixture();
    const other = join(root, "other.key");
    writeFileSync(other, "not a private key\n", { mode: 0o600 });
    expect(() =>
      loadClientTlsConfiguration({
        AVITY_TLS_CA_PATH: certPath,
        AVITY_TLS_CLIENT_CERT_PATH: certPath,
        AVITY_TLS_CLIENT_KEY_PATH: other,
      })
    ).toThrow();
    expect(() =>
      loadClientTlsConfiguration({
        AVITY_TLS_CLIENT_CERT_PATH: certPath,
      })
    ).toThrow(/configured together/);
    expect(() =>
      loadClientTlsConfiguration({
        AVITY_TLS_CA_PATH: certPath,
        AVITY_TLS_SERVER_NAME: "127.0.0.1",
      })
    ).toThrow(/DNS hostname/);
    const loaded = loadClientTlsConfiguration({
      AVITY_TLS_CA_PATH: certPath,
      AVITY_TLS_CLIENT_CERT_PATH: certPath,
      AVITY_TLS_CLIENT_KEY_PATH: keyPath,
    });
    expect(loaded).toMatchObject({
      ca: expect.any(String),
      cert: expect.any(String),
      key: expect.any(Buffer),
    });
    expect(loaded?.key?.buffer.byteLength).toBe(loaded?.key?.byteLength);
  });

  it("accepts only a current client-auth leaf signed by a configured CA", () => {
    const { ca, client, server } = signedCertificateFixture();
    const { ca: unrelatedCa } = signedCertificateFixture();
    const now = Date.now();
    expect({
      caIsAuthority: ca.ca,
      caValidNow:
        Date.parse(ca.validFrom) <= now && now <= Date.parse(ca.validTo),
      clientIsAuthority: client.ca,
      clientUsage: client.keyUsage,
      clientHasClientAuth:
        client.keyUsage?.includes("1.3.6.1.5.5.7.3.2") ?? true,
      clientValidNow:
        Date.parse(client.validFrom) <= now &&
        now <= Date.parse(client.validTo),
      signatureVerified: client.verify(ca.publicKey),
    }).toEqual({
      caIsAuthority: true,
      caValidNow: true,
      clientIsAuthority: false,
      clientUsage: expect.any(Array),
      clientHasClientAuth: true,
      clientValidNow: true,
      signatureVerified: true,
    });
    expect(clientCertificateIsAuthorizedBy(client, [ca])).toBe(true);
    expect(clientCertificateIsAuthorizedBy(server, [ca])).toBe(false);
    expect(clientCertificateIsAuthorizedBy(client, [client])).toBe(false);
    expect(clientCertificateIsAuthorizedBy(client, [unrelatedCa])).toBe(false);
    expect(
      clientCertificateIsAuthorizedBy(
        client,
        [ca],
        Date.parse(client.validTo) + 1,
      ),
    ).toBe(false);
  });
});
