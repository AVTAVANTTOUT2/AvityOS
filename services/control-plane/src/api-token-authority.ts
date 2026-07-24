import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { DB } from "./db.js";

export type ApiTokenRole = "current" | "pending";

export interface ApiTokenRotationStatus {
  readonly state: "stable" | "prepared";
  readonly rotationId: string | null;
  readonly tokenRole: ApiTokenRole;
}

interface ApiTokenRow {
  current_hash: string;
  pending_hash: string | null;
  pending_rotation_id: string | null;
  last_committed_rotation_id: string | null;
}

export class ApiTokenRotationError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "invalid_bootstrap"
      | "not_found"
      | "unauthorized"
      | "unchanged",
    message: string,
  ) {
    super(message);
    this.name = "ApiTokenRotationError";
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

/**
 * Durable two-phase authority for the administrator bearer.
 *
 * Only hashes are persisted. A prepared rotation accepts both the current and
 * pending bearer so the operator can update its encrypted vault and prove the
 * new client before atomically promoting it. Startup accepts either side of a
 * prepared rotation, making crashes between phases recoverable.
 */
export class ApiTokenAuthority {
  constructor(
    private readonly db: DB,
    bootstrapToken: string,
  ) {
    const bootstrapHash = tokenHash(bootstrapToken);
    const existing = this.read();
    if (!existing) {
      const timestamp = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO api_auth_tokens
           (singleton, current_hash, pending_hash, pending_rotation_id,
            last_committed_rotation_id, created_at, updated_at)
         VALUES (1, ?, NULL, NULL, NULL, ?, ?)`,
      ).run(bootstrapHash, timestamp, timestamp);
      return;
    }
    if (
      !hashesMatch(existing.current_hash, bootstrapHash) &&
      (!existing.pending_hash ||
        !hashesMatch(existing.pending_hash, bootstrapHash))
    ) {
      throw new ApiTokenRotationError(
        "invalid_bootstrap",
        "configured API token does not match the durable token authority",
      );
    }
  }

  role(token: string | null | undefined): ApiTokenRole | null {
    if (!token) return null;
    return this.roleForHash(this.requiredRow(), tokenHash(token));
  }

  status(token: string): ApiTokenRotationStatus {
    const row = this.requiredRow();
    const tokenRole = this.roleForHash(row, tokenHash(token));
    if (!tokenRole) {
      throw new ApiTokenRotationError(
        "unauthorized",
        "invalid API token",
      );
    }
    return {
      state: row.pending_rotation_id ? "prepared" : "stable",
      rotationId: row.pending_rotation_id,
      tokenRole,
    };
  }

  prepare(currentToken: string, nextToken: string): {
    readonly rotationId: string;
    readonly state: "prepared";
  } {
    if (this.role(currentToken) !== "current") {
      throw new ApiTokenRotationError(
        "unauthorized",
        "the current API token is required to prepare a rotation",
      );
    }
    const currentHash = tokenHash(currentToken);
    const nextHash = tokenHash(nextToken);
    let rotationId = "";
    this.db.transaction(() => {
      const row = this.requiredRow();
      if (!hashesMatch(row.current_hash, currentHash)) {
        throw new ApiTokenRotationError(
          "unauthorized",
          "the current API token changed before rotation preparation",
        );
      }
      if (hashesMatch(row.current_hash, nextHash)) {
        throw new ApiTokenRotationError(
          "unchanged",
          "new API token must differ from the current token",
        );
      }
      if (row.pending_hash || row.pending_rotation_id) {
        if (
          row.pending_hash &&
          row.pending_rotation_id &&
          hashesMatch(row.pending_hash, nextHash)
        ) {
          rotationId = row.pending_rotation_id;
          return;
        }
        throw new ApiTokenRotationError(
          "conflict",
          "another API token rotation is already prepared",
        );
      }
      rotationId = `atr_${randomBytes(16).toString("hex")}`;
      this.db.prepare(
        `UPDATE api_auth_tokens
         SET pending_hash = ?, pending_rotation_id = ?, updated_at = ?
         WHERE singleton = 1`,
      ).run(nextHash, rotationId, new Date().toISOString());
    })();
    return { rotationId, state: "prepared" };
  }

  commit(rotationId: string, nextToken: string): {
    readonly rotationId: string;
    readonly state: "committed";
    readonly idempotent: boolean;
  } {
    const nextHash = tokenHash(nextToken);
    let idempotent = false;
    this.db.transaction(() => {
      const row = this.requiredRow();
      if (
        row.last_committed_rotation_id === rotationId &&
        hashesMatch(row.current_hash, nextHash)
      ) {
        idempotent = true;
        return;
      }
      if (
        row.pending_rotation_id !== rotationId ||
        !row.pending_hash
      ) {
        throw new ApiTokenRotationError(
          "not_found",
          "API token rotation is not prepared",
        );
      }
      if (!hashesMatch(row.pending_hash, nextHash)) {
        throw new ApiTokenRotationError(
          "unauthorized",
          "the pending API token is required to commit a rotation",
        );
      }
      this.db.prepare(
        `UPDATE api_auth_tokens
         SET current_hash = pending_hash,
             pending_hash = NULL,
             pending_rotation_id = NULL,
             last_committed_rotation_id = ?,
             updated_at = ?
         WHERE singleton = 1`,
      ).run(rotationId, new Date().toISOString());
    })();
    return { rotationId, state: "committed", idempotent };
  }

  abort(rotationId: string, currentToken: string): {
    readonly rotationId: string;
    readonly state: "aborted";
    readonly idempotent: boolean;
  } {
    const currentHash = tokenHash(currentToken);
    if (this.role(currentToken) !== "current") {
      throw new ApiTokenRotationError(
        "unauthorized",
        "the current API token is required to abort a rotation",
      );
    }
    let idempotent = false;
    this.db.transaction(() => {
      const row = this.requiredRow();
      if (!hashesMatch(row.current_hash, currentHash)) {
        throw new ApiTokenRotationError(
          "unauthorized",
          "the current API token changed before rotation abort",
        );
      }
      if (!row.pending_rotation_id && !row.pending_hash) {
        idempotent = true;
        return;
      }
      if (row.pending_rotation_id !== rotationId) {
        throw new ApiTokenRotationError(
          "not_found",
          "API token rotation is not prepared",
        );
      }
      this.db.prepare(
        `UPDATE api_auth_tokens
         SET pending_hash = NULL,
             pending_rotation_id = NULL,
             updated_at = ?
         WHERE singleton = 1`,
      ).run(new Date().toISOString());
    })();
    return { rotationId, state: "aborted", idempotent };
  }

  private read(): ApiTokenRow | undefined {
    return this.db.prepare(
      `SELECT current_hash, pending_hash, pending_rotation_id,
              last_committed_rotation_id
       FROM api_auth_tokens
       WHERE singleton = 1`,
    ).get() as ApiTokenRow | undefined;
  }

  private requiredRow(): ApiTokenRow {
    const row = this.read();
    if (!row) {
      throw new ApiTokenRotationError(
        "invalid_bootstrap",
        "API token authority is not initialized",
      );
    }
    return row;
  }

  private roleForHash(
    row: ApiTokenRow,
    hash: string,
  ): ApiTokenRole | null {
    if (hashesMatch(row.current_hash, hash)) return "current";
    if (row.pending_hash && hashesMatch(row.pending_hash, hash)) {
      return "pending";
    }
    return null;
  }
}
