import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
  const requestPath = join(root, "server.csr");
  const extensionsPath = join(root, "server.ext");
  writeFileSync(
    extensionsPath,
    ["subjectAltName=IP:127.0.0.1", ""].join("\n"),
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
    "/CN=127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    requestPath,
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "x509",
    "-req",
    "-sha256",
    "-days",
    "1",
    "-in",
    requestPath,
    "-signkey",
    keyPath,
    "-extfile",
    extensionsPath,
    "-out",
    certPath,
  ], { stdio: "ignore" });
  chmodSync(keyPath, 0o600);
  chmodSync(certPath, 0o644);
  return { root, certPath, keyPath };
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
});
