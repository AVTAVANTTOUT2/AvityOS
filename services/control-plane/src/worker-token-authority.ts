import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { DB } from "./db.js";

export type WorkerTokenRole = "current" | "pending";

interface WorkerTokenRow {
  status: string;
  token_hash: string;
  pending_token_hash: string | null;
  token_rotation_id: string | null;
  pending_token_seen_at: string | null;
  last_committed_token_rotation_id: string | null;
  certificate_rotation_id: string | null;
}

export class WorkerTokenRotationError extends Error {
  constructor(
    readonly code:
      | "active_work"
      | "conflict"
      | "not_found"
      | "not_proven"
      | "revoked"
      | "unauthorized",
    message: string,
  ) {
    super(message);
    this.name = "WorkerTokenRotationError";
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

export class WorkerTokenAuthority {
  constructor(private readonly db: DB) {}

  authenticate(
    workerId: string,
    token: string,
  ): { readonly role: WorkerTokenRole; readonly rotationId: string | null } | null {
    if (!workerId || !token) return null;
    const row = this.read(workerId);
    if (!row || row.status === "revoked") return null;
    const hash = tokenHash(token);
    if (hashesMatch(row.token_hash, hash)) {
      return { role: "current", rotationId: row.token_rotation_id };
    }
    if (
      row.pending_token_hash &&
      hashesMatch(row.pending_token_hash, hash)
    ) {
      return { role: "pending", rotationId: row.token_rotation_id };
    }
    return null;
  }

  prepare(workerId: string): {
    readonly rotationId: string;
    readonly token: string;
    readonly state: "prepared";
  } {
    const token = randomBytes(24).toString("hex");
    const pendingHash = tokenHash(token);
    let rotationId = "";
    this.db.transaction(() => {
      const row = this.requiredRow(workerId);
      if (row.status === "revoked") {
        throw new WorkerTokenRotationError(
          "revoked",
          "revoked worker credentials cannot be rotated",
        );
      }
      if (
        row.pending_token_hash ||
        row.token_rotation_id ||
        row.certificate_rotation_id
      ) {
        throw new WorkerTokenRotationError(
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
        throw new WorkerTokenRotationError(
          "active_work",
          "worker token rotation requires the worker to have no active terminal",
        );
      }
      rotationId = `wtr_${randomBytes(16).toString("hex")}`;
      this.db.prepare(
        `UPDATE workers
         SET status = 'draining',
             pending_token_hash = ?,
             token_rotation_id = ?,
             pending_token_seen_at = NULL,
             updated_at = ?
         WHERE id = ?`,
      ).run(pendingHash, rotationId, new Date().toISOString(), workerId);
    })();
    return { rotationId, token, state: "prepared" };
  }

  markPendingSeen(workerId: string, rotationId: string): void {
    this.db.prepare(
      `UPDATE workers
       SET pending_token_seen_at = COALESCE(pending_token_seen_at, ?),
           updated_at = ?
       WHERE id = ? AND token_rotation_id = ? AND pending_token_hash IS NOT NULL`,
    ).run(
      new Date().toISOString(),
      new Date().toISOString(),
      workerId,
      rotationId,
    );
  }

  status(workerId: string): {
    readonly state: "stable" | "prepared";
    readonly rotationId: string | null;
    readonly pendingSeen: boolean;
  } {
    const row = this.requiredRow(workerId);
    return {
      state: row.token_rotation_id ? "prepared" : "stable",
      rotationId: row.token_rotation_id,
      pendingSeen: row.pending_token_seen_at !== null,
    };
  }

  tokenRole(workerId: string, token: string): WorkerTokenRole {
    const authenticated = this.authenticate(workerId, token);
    if (!authenticated) {
      throw new WorkerTokenRotationError(
        "unauthorized",
        "candidate worker token is not accepted",
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
        throw new WorkerTokenRotationError(
          "revoked",
          "revoked worker credentials cannot be committed",
        );
      }
      if (
        row.last_committed_token_rotation_id === rotationId &&
        !row.token_rotation_id &&
        !row.pending_token_hash
      ) {
        idempotent = true;
        return;
      }
      if (
        row.token_rotation_id !== rotationId ||
        !row.pending_token_hash
      ) {
        throw new WorkerTokenRotationError(
          "not_found",
          "worker token rotation is not prepared",
        );
      }
      if (!row.pending_token_seen_at) {
        throw new WorkerTokenRotationError(
          "not_proven",
          "pending worker token has not authenticated with the enrolled worker identity",
        );
      }
      this.db.prepare(
        `UPDATE workers
         SET status = CASE WHEN status = 'draining' THEN 'online' ELSE status END,
             token_hash = pending_token_hash,
             pending_token_hash = NULL,
             token_rotation_id = NULL,
             pending_token_seen_at = NULL,
             last_committed_token_rotation_id = ?,
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
      if (!row.token_rotation_id && !row.pending_token_hash) {
        idempotent = true;
        return;
      }
      if (row.token_rotation_id !== rotationId) {
        throw new WorkerTokenRotationError(
          "not_found",
          "worker token rotation is not prepared",
        );
      }
      this.db.prepare(
        `UPDATE workers
         SET status = CASE WHEN status = 'draining' THEN 'online' ELSE status END,
             pending_token_hash = NULL,
             token_rotation_id = NULL,
             pending_token_seen_at = NULL,
             updated_at = ?
         WHERE id = ?`,
      ).run(new Date().toISOString(), workerId);
    })();
    return { rotationId, state: "aborted", idempotent };
  }

  private read(workerId: string): WorkerTokenRow | undefined {
    return this.db.prepare(
      `SELECT status, token_hash, pending_token_hash, token_rotation_id,
              pending_token_seen_at, last_committed_token_rotation_id,
              certificate_rotation_id
       FROM workers
       WHERE id = ?`,
    ).get(workerId) as WorkerTokenRow | undefined;
  }

  private requiredRow(workerId: string): WorkerTokenRow {
    const row = this.read(workerId);
    if (!row) {
      throw new WorkerTokenRotationError(
        "not_found",
        `worker ${workerId} not found`,
      );
    }
    return row;
  }
}
