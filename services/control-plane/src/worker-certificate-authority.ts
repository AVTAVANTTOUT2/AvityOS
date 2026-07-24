import {
  createHash,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import type { DB } from "./db.js";

export type WorkerCertificateRole = "current" | "pending";

interface WorkerCertificateRow {
  status: string;
  mtls_fingerprint: string | null;
  pending_mtls_fingerprint: string | null;
  certificate_rotation_id: string | null;
  pending_certificate_seen_at: string | null;
  last_committed_certificate_rotation_id: string | null;
  token_rotation_id: string | null;
}

export class WorkerCertificateRotationError extends Error {
  constructor(
    readonly code:
      | "active_work"
      | "conflict"
      | "invalid_certificate"
      | "not_enrolled"
      | "not_found"
      | "not_proven"
      | "revoked"
      | "unauthorized",
    message: string,
  ) {
    super(message);
    this.name = "WorkerCertificateRotationError";
  }
}

function certificateFingerprint(certificatePem: string): string {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new WorkerCertificateRotationError(
      "invalid_certificate",
      "candidate worker certificate is not valid PEM X.509",
    );
  }
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  const now = Date.now();
  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    now < validFrom ||
    now >= validTo
  ) {
    throw new WorkerCertificateRotationError(
      "invalid_certificate",
      "candidate worker certificate is not currently valid",
    );
  }
  if (certificate.ca) {
    throw new WorkerCertificateRotationError(
      "invalid_certificate",
      "candidate worker certificate must be a leaf certificate",
    );
  }
  return createHash("sha256").update(certificate.raw).digest("hex");
}

export class WorkerCertificateAuthority {
  constructor(private readonly db: DB) {}

  authenticate(
    workerId: string,
    peerFingerprint: string,
  ): {
    readonly role: WorkerCertificateRole;
    readonly rotationId: string | null;
  } | null {
    if (!workerId || !peerFingerprint) return null;
    const row = this.read(workerId);
    if (!row || row.status === "revoked") return null;
    if (row.mtls_fingerprint === peerFingerprint) {
      return { role: "current", rotationId: row.certificate_rotation_id };
    }
    if (
      row.pending_mtls_fingerprint === peerFingerprint &&
      row.certificate_rotation_id
    ) {
      return { role: "pending", rotationId: row.certificate_rotation_id };
    }
    return null;
  }

  prepare(
    workerId: string,
    certificatePem: string,
  ): {
    readonly rotationId: string;
    readonly state: "prepared";
  } {
    const pendingFingerprint = certificateFingerprint(certificatePem);
    let rotationId = "";
    this.db.transaction(() => {
      const row = this.requiredRow(workerId);
      if (row.status === "revoked") {
        throw new WorkerCertificateRotationError(
          "revoked",
          "revoked worker credentials cannot be rotated",
        );
      }
      if (!row.mtls_fingerprint) {
        throw new WorkerCertificateRotationError(
          "not_enrolled",
          "worker is not bound to an mTLS certificate",
        );
      }
      if (row.mtls_fingerprint === pendingFingerprint) {
        throw new WorkerCertificateRotationError(
          "conflict",
          "candidate worker certificate is already active",
        );
      }
      if (
        row.pending_mtls_fingerprint ||
        row.certificate_rotation_id ||
        row.token_rotation_id
      ) {
        throw new WorkerCertificateRotationError(
          "conflict",
          "another worker credential rotation is already prepared",
        );
      }
      const active = this.db.prepare(
        `SELECT COUNT(*) AS count
         FROM terminal_sessions
         WHERE worker_id = ?
           AND state IN ('starting', 'running', 'cancelling')`,
      ).get(workerId) as { count: number };
      if (active.count > 0) {
        throw new WorkerCertificateRotationError(
          "active_work",
          "worker certificate rotation requires the worker to have no active terminal",
        );
      }
      rotationId = `wcr_${randomBytes(16).toString("hex")}`;
      this.db.prepare(
        `UPDATE workers
         SET status = 'draining',
             pending_mtls_fingerprint = ?,
             certificate_rotation_id = ?,
             pending_certificate_seen_at = NULL,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        pendingFingerprint,
        rotationId,
        new Date().toISOString(),
        workerId,
      );
    })();
    return { rotationId, state: "prepared" };
  }

  markPendingSeen(workerId: string, rotationId: string): void {
    const timestamp = new Date().toISOString();
    this.db.prepare(
      `UPDATE workers
       SET pending_certificate_seen_at =
             COALESCE(pending_certificate_seen_at, ?),
           updated_at = ?
       WHERE id = ?
         AND certificate_rotation_id = ?
         AND pending_mtls_fingerprint IS NOT NULL`,
    ).run(timestamp, timestamp, workerId, rotationId);
  }

  status(workerId: string): {
    readonly state: "stable" | "prepared";
    readonly rotationId: string | null;
    readonly pendingSeen: boolean;
  } {
    const row = this.requiredRow(workerId);
    return {
      state: row.certificate_rotation_id ? "prepared" : "stable",
      rotationId: row.certificate_rotation_id,
      pendingSeen: row.pending_certificate_seen_at !== null,
    };
  }

  certificateRole(
    workerId: string,
    certificatePem: string,
  ): WorkerCertificateRole {
    const fingerprint = certificateFingerprint(certificatePem);
    const authenticated = this.authenticate(workerId, fingerprint);
    if (!authenticated) {
      throw new WorkerCertificateRotationError(
        "unauthorized",
        "candidate worker certificate is not accepted",
      );
    }
    return authenticated.role;
  }

  commit(workerId: string, rotationId: string): {
    readonly rotationId: string;
    readonly state: "committed";
    readonly idempotent: boolean;
  } {
    let idempotent = false;
    this.db.transaction(() => {
      const row = this.requiredRow(workerId);
      if (row.status === "revoked") {
        throw new WorkerCertificateRotationError(
          "revoked",
          "revoked worker certificate cannot be committed",
        );
      }
      if (
        row.last_committed_certificate_rotation_id === rotationId &&
        !row.certificate_rotation_id &&
        !row.pending_mtls_fingerprint
      ) {
        idempotent = true;
        return;
      }
      if (
        row.certificate_rotation_id !== rotationId ||
        !row.pending_mtls_fingerprint
      ) {
        throw new WorkerCertificateRotationError(
          "not_found",
          "worker certificate rotation is not prepared",
        );
      }
      if (!row.pending_certificate_seen_at) {
        throw new WorkerCertificateRotationError(
          "not_proven",
          "pending worker certificate has not authenticated with the current bearer",
        );
      }
      this.db.prepare(
        `UPDATE workers
         SET status =
               CASE WHEN status = 'draining' THEN 'online' ELSE status END,
             mtls_fingerprint = pending_mtls_fingerprint,
             pending_mtls_fingerprint = NULL,
             certificate_rotation_id = NULL,
             pending_certificate_seen_at = NULL,
             last_committed_certificate_rotation_id = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(rotationId, new Date().toISOString(), workerId);
    })();
    return { rotationId, state: "committed", idempotent };
  }

  abort(workerId: string, rotationId: string): {
    readonly rotationId: string;
    readonly state: "aborted";
    readonly idempotent: boolean;
  } {
    let idempotent = false;
    this.db.transaction(() => {
      const row = this.requiredRow(workerId);
      if (!row.certificate_rotation_id && !row.pending_mtls_fingerprint) {
        idempotent = true;
        return;
      }
      if (row.certificate_rotation_id !== rotationId) {
        throw new WorkerCertificateRotationError(
          "not_found",
          "worker certificate rotation is not prepared",
        );
      }
      this.db.prepare(
        `UPDATE workers
         SET status =
               CASE WHEN status = 'draining' THEN 'online' ELSE status END,
             pending_mtls_fingerprint = NULL,
             certificate_rotation_id = NULL,
             pending_certificate_seen_at = NULL,
             updated_at = ?
         WHERE id = ?`,
      ).run(new Date().toISOString(), workerId);
    })();
    return { rotationId, state: "aborted", idempotent };
  }

  private read(workerId: string): WorkerCertificateRow | undefined {
    return this.db.prepare(
      `SELECT status, mtls_fingerprint, pending_mtls_fingerprint,
              certificate_rotation_id, pending_certificate_seen_at,
              last_committed_certificate_rotation_id, token_rotation_id
       FROM workers
       WHERE id = ?`,
    ).get(workerId) as WorkerCertificateRow | undefined;
  }

  private requiredRow(workerId: string): WorkerCertificateRow {
    const row = this.read(workerId);
    if (!row) {
      throw new WorkerCertificateRotationError(
        "not_found",
        `worker ${workerId} not found`,
      );
    }
    return row;
  }
}
