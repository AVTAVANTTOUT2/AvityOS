import { X509Certificate } from "node:crypto";
import { loadClientTlsConfiguration } from "@avityos/transport-security";
import type { OperatorPaths } from "./paths.js";
import {
  loadOperatorEnvironment,
  saveOperatorEnvironment,
} from "./setup.js";
import { loadOperatorServiceEnvironment } from "./services.js";

const CERTIFICATE_PATH = "AVITY_TLS_CLIENT_CERT_PATH";
const PRIVATE_KEY_PATH = "AVITY_TLS_CLIENT_KEY_PATH";

export interface WorkerCertificateRotationStatus {
  readonly state: "stable" | "prepared";
  readonly rotationId: string | null;
  readonly pendingSeen: boolean;
}

export interface OperatorWorkerCertificateRotationDependencies {
  readonly status: () => Promise<WorkerCertificateRotationStatus>;
  readonly role: (
    certificate: string,
  ) => Promise<"current" | "pending">;
  readonly prepare: (
    certificate: string,
  ) => Promise<{ readonly rotationId: string }>;
  readonly activate: (
    certificate: string,
    role: "current" | "pending",
  ) => Promise<void>;
  readonly commit: (rotationId: string) => Promise<void>;
  readonly abort: (rotationId: string) => Promise<void>;
}

export interface OperatorWorkerCertificateRotationResult {
  readonly service: "worker";
  readonly workerId: string;
  readonly rotationId: string;
  readonly certificatePath: string;
  readonly resumed: boolean;
}

interface CertificatePair {
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly certificate: string;
  readonly fingerprint: string;
}

interface OperatorTlsSnapshot {
  readonly certificatePath: string | undefined;
  readonly privateKeyPath: string | undefined;
}

function loadCertificatePair(
  certificatePath: string | undefined,
  privateKeyPath: string | undefined,
): CertificatePair {
  if (!certificatePath || !privateKeyPath) {
    throw new Error(
      "worker certificate rotation requires an existing certificate/key pair and a complete candidate pair",
    );
  }
  const configuration = loadClientTlsConfiguration({
    AVITY_TLS_CLIENT_CERT_PATH: certificatePath,
    AVITY_TLS_CLIENT_KEY_PATH: privateKeyPath,
  });
  if (!configuration?.cert || !configuration.key) {
    throw new Error("worker mTLS certificate/key pair could not be loaded");
  }
  try {
    const certificate = new X509Certificate(configuration.cert);
    return {
      certificatePath,
      privateKeyPath,
      certificate: configuration.cert,
      fingerprint: certificate.fingerprint256,
    };
  } finally {
    configuration.key.fill(0);
  }
}

function operatorTlsSnapshot(paths: OperatorPaths): OperatorTlsSnapshot {
  const environment = loadOperatorEnvironment(paths);
  return {
    certificatePath: environment[CERTIFICATE_PATH],
    privateKeyPath: environment[PRIVATE_KEY_PATH],
  };
}

function stageOperatorTlsPaths(
  paths: OperatorPaths,
  pair: CertificatePair,
): void {
  const environment = loadOperatorEnvironment(paths);
  saveOperatorEnvironment(paths, {
    ...environment,
    [CERTIFICATE_PATH]: pair.certificatePath,
    [PRIVATE_KEY_PATH]: pair.privateKeyPath,
  });
  const effective = loadOperatorServiceEnvironment(paths, "worker");
  if (
    effective[CERTIFICATE_PATH] !== pair.certificatePath ||
    effective[PRIVATE_KEY_PATH] !== pair.privateKeyPath
  ) {
    throw new Error("candidate worker certificate paths were not activated");
  }
}

function operatorTlsPathsMatch(
  paths: OperatorPaths,
  pair: CertificatePair,
): boolean {
  const environment = loadOperatorEnvironment(paths);
  return environment[CERTIFICATE_PATH] === pair.certificatePath &&
    environment[PRIVATE_KEY_PATH] === pair.privateKeyPath;
}

function restoreOperatorTlsPaths(
  paths: OperatorPaths,
  candidate: CertificatePair,
  snapshot: OperatorTlsSnapshot,
): void {
  const environment = loadOperatorEnvironment(paths);
  if (
    environment[CERTIFICATE_PATH] !== candidate.certificatePath ||
    environment[PRIVATE_KEY_PATH] !== candidate.privateKeyPath
  ) {
    throw new Error(
      "worker TLS paths changed concurrently; refusing to overwrite them during rollback",
    );
  }
  if (snapshot.certificatePath === undefined) {
    delete environment[CERTIFICATE_PATH];
  } else {
    environment[CERTIFICATE_PATH] = snapshot.certificatePath;
  }
  if (snapshot.privateKeyPath === undefined) {
    delete environment[PRIVATE_KEY_PATH];
  } else {
    environment[PRIVATE_KEY_PATH] = snapshot.privateKeyPath;
  }
  saveOperatorEnvironment(paths, environment);
}

async function proveAndCommit(
  paths: OperatorPaths,
  rotationId: string,
  candidate: CertificatePair,
  dependencies: OperatorWorkerCertificateRotationDependencies,
): Promise<void> {
  await dependencies.activate(candidate.certificate, "pending");
  const proven = await dependencies.status();
  if (
    proven.rotationId !== rotationId ||
    !proven.pendingSeen
  ) {
    throw new Error(
      "pending worker certificate did not authenticate with the current bearer",
    );
  }
  if (!operatorTlsPathsMatch(paths, candidate)) {
    throw new Error(
      "worker TLS paths changed concurrently after verification",
    );
  }
  try {
    await dependencies.commit(rotationId);
  } catch (error) {
    throw new Error(
      "new worker certificate is active, but commit finalization is ambiguous; rerun worker-certificate-rotate with the same files",
      { cause: error },
    );
  }
}

export async function rotateOperatorWorkerCertificate(
  paths: OperatorPaths,
  workerId: string,
  candidateCertificatePath: string,
  candidatePrivateKeyPath: string,
  dependencies: OperatorWorkerCertificateRotationDependencies,
): Promise<OperatorWorkerCertificateRotationResult> {
  if (!workerId) {
    throw new Error("worker id is required for certificate rotation");
  }
  const effective = loadOperatorServiceEnvironment(paths, "worker");
  const current = loadCertificatePair(
    effective[CERTIFICATE_PATH],
    effective[PRIVATE_KEY_PATH],
  );
  const candidate = loadCertificatePair(
    candidateCertificatePath,
    candidatePrivateKeyPath,
  );
  const originalOperatorTls = operatorTlsSnapshot(paths);

  const existing = await dependencies.status();
  if (existing.state === "prepared" && existing.rotationId) {
    const activeRole = await dependencies.role(current.certificate);
    if (activeRole === "pending") {
      const candidateRole = await dependencies.role(candidate.certificate);
      if (candidateRole !== "pending") {
        throw new Error(
          "a different worker certificate rotation is already active; rerun with the active candidate files",
        );
      }
      stageOperatorTlsPaths(paths, candidate);
      await proveAndCommit(
        paths,
        existing.rotationId,
        candidate,
        dependencies,
      );
      return {
        service: "worker",
        workerId,
        rotationId: existing.rotationId,
        certificatePath: candidate.certificatePath,
        resumed: true,
      };
    }
    await dependencies.abort(existing.rotationId);
  }

  if (current.fingerprint === candidate.fingerprint) {
    throw new Error("candidate worker certificate is already active");
  }

  const prepared = await dependencies.prepare(candidate.certificate);
  try {
    stageOperatorTlsPaths(paths, candidate);
  } catch (error) {
    await dependencies.abort(prepared.rotationId);
    throw error;
  }

  try {
    await dependencies.activate(candidate.certificate, "pending");
    const proven = await dependencies.status();
    if (
      proven.rotationId !== prepared.rotationId ||
      !proven.pendingSeen
    ) {
      throw new Error(
        "pending worker certificate did not authenticate after worker restart",
      );
    }
    if (!operatorTlsPathsMatch(paths, candidate)) {
      throw new Error(
        "worker TLS paths changed concurrently after verification",
      );
    }
  } catch (verificationError) {
    try {
      restoreOperatorTlsPaths(paths, candidate, originalOperatorTls);
      await dependencies.abort(prepared.rotationId);
      await dependencies.activate(current.certificate, "current");
      if (await dependencies.role(current.certificate) !== "current") {
        throw new Error("previous worker certificate rollback was not accepted");
      }
    } catch (rollbackError) {
      throw new Error(
        `worker certificate verification failed and rollback could not be certified: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`,
        { cause: verificationError },
      );
    }
    throw new Error(
      "worker certificate verification failed; previous certificate restored",
      { cause: verificationError },
    );
  }

  try {
    await dependencies.commit(prepared.rotationId);
  } catch (error) {
    throw new Error(
      "new worker certificate is active, but commit finalization is ambiguous; rerun worker-certificate-rotate with the same files",
      { cause: error },
    );
  }

  return {
    service: "worker",
    workerId,
    rotationId: prepared.rotationId,
    certificatePath: candidate.certificatePath,
    resumed: false,
  };
}
