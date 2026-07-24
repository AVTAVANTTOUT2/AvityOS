import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../main.js";
import { readEnvFile, writeEnvFileAtomic } from "./env.js";
import { resolveOperatorPaths } from "./paths.js";
import { rotateOperatorWorkerCertificate } from "./worker-certificate-rotation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createCertificatePair(
  root: string,
  name: string,
): { readonly certificate: string; readonly privateKey: string } {
  const privateKey = join(root, `${name}.key`);
  const request = join(root, `${name}.csr`);
  const certificate = join(root, `${name}.crt`);
  const extensions = join(root, `${name}.ext`);
  writeFileSync(
    extensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "extendedKeyUsage=critical,clientAuth",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      `/CN=${name}`,
      "-keyout",
      privateKey,
      "-out",
      request,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-sha256",
      "-days",
      "1",
      "-in",
      request,
      "-signkey",
      privateKey,
      "-extfile",
      extensions,
      "-out",
      certificate,
    ],
    { stdio: "ignore" },
  );
  chmodSync(privateKey, 0o600);
  chmodSync(certificate, 0o644);
  return { certificate, privateKey };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "avity-worker-cert-rotation-"));
  chmodSync(root, 0o700);
  const repositoryRoot = join(root, "repository");
  mkdirSync(repositoryRoot, { mode: 0o700 });
  const paths = resolveOperatorPaths({
    repositoryRoot,
    operatorHome: join(root, "operator"),
  });
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.serviceConfigDir, { recursive: true, mode: 0o700 });
  const current = createCertificatePair(root, "current-worker");
  const candidate = createCertificatePair(root, "candidate-worker");
  writeEnvFileAtomic(paths.operatorEnvPath, {
    AVITY_CONTROL_PLANE_URL: "https://127.0.0.1:7717",
    AVITY_TLS_CLIENT_CERT_PATH: current.certificate,
    AVITY_TLS_CLIENT_KEY_PATH: current.privateKey,
    AVITY_WORKER_ID: "wrk_certificate",
    AVITY_WORKER_TOKEN: "worker-token",
  });
  return { paths, current, candidate };
}

describe("operator worker certificate rotation", () => {
  it("advertises the command and refuses positional material", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["help"])).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain(
      "tls worker-certificate-rotate --certificate <path>",
    );
    expect(await main([
      "tls",
      "worker-certificate-rotate",
      "--certificate",
      "/private/candidate.crt",
      "--private-key",
      "/private/candidate.key",
      "positional-material",
    ])).toBe(2);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "accepts only --certificate and --private-key",
    );
  });

  it("stages, proves and commits a candidate without persisting PEM material", async () => {
    const { paths, candidate } = fixture();
    let statusCalls = 0;
    const result = await rotateOperatorWorkerCertificate(
      paths,
      "wrk_certificate",
      candidate.certificate,
      candidate.privateKey,
      {
        status: async () => {
          statusCalls += 1;
          return statusCalls === 1
            ? { state: "stable", rotationId: null, pendingSeen: false }
            : {
                state: "prepared",
                rotationId: "wcr_success",
                pendingSeen: true,
              };
        },
        role: async () => {
          throw new Error("role is not needed during a fresh successful rotation");
        },
        prepare: async (certificate) => {
          expect(certificate).toContain("BEGIN CERTIFICATE");
          return { rotationId: "wcr_success" };
        },
        activate: async (certificate, role) => {
          expect(certificate).toContain("BEGIN CERTIFICATE");
          expect(role).toBe("pending");
          expect(readEnvFile(paths.operatorEnvPath)).toMatchObject({
            AVITY_TLS_CLIENT_CERT_PATH: candidate.certificate,
            AVITY_TLS_CLIENT_KEY_PATH: candidate.privateKey,
          });
        },
        commit: async (rotationId) => {
          expect(rotationId).toBe("wcr_success");
        },
        abort: async () => {
          throw new Error("abort must not run");
        },
      },
    );

    expect(result).toMatchObject({
      workerId: "wrk_certificate",
      rotationId: "wcr_success",
      certificatePath: candidate.certificate,
      resumed: false,
    });
    expect(JSON.stringify(result)).not.toContain(candidate.privateKey);
    expect(readFileSync(paths.operatorEnvPath, "utf8")).not.toContain(
      "BEGIN CERTIFICATE",
    );
  });

  it("restores the previous paths and certifies them when candidate proof fails", async () => {
    const { paths, current, candidate } = fixture();
    let aborted = false;
    await expect(
      rotateOperatorWorkerCertificate(
        paths,
        "wrk_certificate",
        candidate.certificate,
        candidate.privateKey,
        {
          status: async () => ({
            state: "stable",
            rotationId: null,
            pendingSeen: false,
          }),
          role: async (certificate) => {
            expect(certificate).toContain("BEGIN CERTIFICATE");
            return "current";
          },
          prepare: async () => ({ rotationId: "wcr_rollback" }),
          activate: async (_certificate, role) => {
            if (role === "pending") {
              throw new Error("candidate handshake refused");
            }
            expect(readEnvFile(paths.operatorEnvPath)).toMatchObject({
              AVITY_TLS_CLIENT_CERT_PATH: current.certificate,
              AVITY_TLS_CLIENT_KEY_PATH: current.privateKey,
            });
          },
          commit: async () => {
            throw new Error("commit must not run");
          },
          abort: async (rotationId) => {
            expect(rotationId).toBe("wcr_rollback");
            aborted = true;
          },
        },
      ),
    ).rejects.toThrow(/previous certificate restored/i);
    expect(aborted).toBe(true);
    expect(readEnvFile(paths.operatorEnvPath)).toMatchObject({
      AVITY_TLS_CLIENT_CERT_PATH: current.certificate,
      AVITY_TLS_CLIENT_KEY_PATH: current.privateKey,
    });
  });

  it("resumes a proven pending certificate after an ambiguous commit response", async () => {
    const { paths, candidate } = fixture();
    writeEnvFileAtomic(paths.operatorEnvPath, {
      ...readEnvFile(paths.operatorEnvPath),
      AVITY_TLS_CLIENT_CERT_PATH: candidate.certificate,
      AVITY_TLS_CLIENT_KEY_PATH: candidate.privateKey,
    });
    let roleCalls = 0;
    const result = await rotateOperatorWorkerCertificate(
      paths,
      "wrk_certificate",
      candidate.certificate,
      candidate.privateKey,
      {
        status: async () => ({
          state: "prepared",
          rotationId: "wcr_ambiguous",
          pendingSeen: true,
        }),
        role: async () => {
          roleCalls += 1;
          return "pending";
        },
        prepare: async () => {
          throw new Error("prepare must not repeat");
        },
        activate: async (_certificate, role) => {
          expect(role).toBe("pending");
        },
        commit: async (rotationId) => {
          expect(rotationId).toBe("wcr_ambiguous");
        },
        abort: async () => {
          throw new Error("abort must not run");
        },
      },
    );

    expect(roleCalls).toBe(2);
    expect(result).toMatchObject({
      rotationId: "wcr_ambiguous",
      resumed: true,
    });
  });
});
