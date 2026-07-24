import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  RemoteAccountId,
  RemoteBridgeMessageId,
  RemoteDeviceCertificate,
  RemoteDeviceId,
  RemotePairingSession,
  RemotePairingSessionId,
  type RemoteDeviceCertificate as RemoteDeviceCertificateType,
  type RemotePairingSession as RemotePairingSessionType,
} from "@avityos/contracts";
import type { RemoteConnectorPersistedState } from "./index.js";
import { verifyRemoteDeviceCertificate } from "./security.js";

export interface RemoteActionAuditInput {
  readonly accountId: string;
  readonly localDeviceId: string;
  readonly remoteDeviceId: string;
  readonly messageId: string;
  readonly contentType: string;
  readonly action: string;
  readonly outcome: "accepted" | "rejected" | "failed";
  readonly errorCode?: string;
  readonly createdAt?: Date | string | number;
}

export interface RemoteActionAuditRecord extends Omit<RemoteActionAuditInput, "createdAt"> {
  readonly id: string;
  readonly createdAt: string;
  readonly previousHash: string | null;
  readonly entryHash: string;
}

function timestamp(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid remote bridge timestamp");
  return date.toISOString();
}

function bounded(value: string, label: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n]/.test(normalized)) {
    throw new Error(`invalid remote audit ${label}`);
  }
  return normalized;
}

function identifier(value: string, label: string, maximum = 200): string {
  const normalized = bounded(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) {
    throw new Error(`invalid remote audit ${label}`);
  }
  return normalized;
}

function auditHash(record: Omit<RemoteActionAuditRecord, "entryHash">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export class RemoteBridgeStateStore {
  private readonly db: DatabaseSync;

  constructor(readonly databasePath: string) {
    if (databasePath !== ":memory:") {
      const parent = dirname(databasePath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if ((statSync(parent).mode & 0o077) !== 0) {
        throw new Error("remote bridge database directory must not be group/world accessible");
      }
    }
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS remote_accounts (
        account_id TEXT PRIMARY KEY,
        signing_public_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS remote_devices (
        device_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES remote_accounts(account_id),
        certificate TEXT NOT NULL,
        revoked_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS remote_pairing_sessions (
        session_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES remote_accounts(account_id),
        session TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS remote_connector_states (
        local_device_id TEXT PRIMARY KEY REFERENCES remote_devices(device_id),
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS remote_action_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        account_id TEXT NOT NULL,
        local_device_id TEXT NOT NULL,
        remote_device_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT,
        previous_hash TEXT,
        entry_hash TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_action_once
        ON remote_action_audit(account_id, local_device_id, message_id);
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  registerAccount(accountIdValue: string, signingPublicKey: string, now = Date.now()): void {
    const accountId = RemoteAccountId.parse(accountIdValue);
    const createdAt = timestamp(now);
    if (!/^[A-Za-z0-9_-]{40,2048}$/.test(signingPublicKey)) {
      throw new Error("invalid remote account signing public key");
    }
    const existing = this.db.prepare(`
      SELECT signing_public_key FROM remote_accounts WHERE account_id = ?
    `).get(accountId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.signing_public_key !== signingPublicKey) {
        throw new Error("remote account trust root mismatch");
      }
      return;
    }
    this.db.prepare(`
      INSERT INTO remote_accounts (account_id, signing_public_key, created_at)
      VALUES (?, ?, ?)
    `).run(accountId, signingPublicKey, createdAt);
  }

  registerDevice(certificateValue: RemoteDeviceCertificateType, now = Date.now()): void {
    const parsedCertificate = RemoteDeviceCertificate.parse(certificateValue);
    const account = this.db.prepare(`
      SELECT signing_public_key FROM remote_accounts WHERE account_id = ?
    `).get(parsedCertificate.accountId) as Record<string, unknown> | undefined;
    if (!account || typeof account.signing_public_key !== "string") {
      throw new Error("remote device account trust root not found");
    }
    const certificate = verifyRemoteDeviceCertificate(
      parsedCertificate,
      account.signing_public_key,
      now,
    );
    const updatedAt = timestamp(now);
    const existing = this.db.prepare(`
      SELECT account_id FROM remote_devices WHERE device_id = ?
    `).get(certificate.deviceId) as Record<string, unknown> | undefined;
    if (existing && existing.account_id !== certificate.accountId) {
      throw new Error("remote device account binding mismatch");
    }
    this.db.prepare(`
      INSERT INTO remote_devices (device_id, account_id, certificate, revoked_at, updated_at)
      VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        account_id = excluded.account_id,
        certificate = excluded.certificate,
        updated_at = excluded.updated_at
    `).run(
      certificate.deviceId,
      certificate.accountId,
      JSON.stringify(certificate),
      updatedAt,
    );
  }

  revokeDevice(deviceIdValue: string, now = Date.now()): boolean {
    const deviceId = RemoteDeviceId.parse(deviceIdValue);
    const revokedAt = timestamp(now);
    const result = this.db.prepare(`
      UPDATE remote_devices SET revoked_at = ?, updated_at = ? WHERE device_id = ?
    `).run(revokedAt, revokedAt, deviceId);
    return Number(result.changes) > 0;
  }

  isDeviceActive(deviceIdValue: string): boolean {
    const deviceId = RemoteDeviceId.parse(deviceIdValue);
    const row = this.db.prepare(`
      SELECT revoked_at FROM remote_devices WHERE device_id = ?
    `).get(deviceId) as Record<string, unknown> | undefined;
    return Boolean(row) && row?.revoked_at === null;
  }

  savePairingSession(sessionValue: RemotePairingSessionType, now = Date.now()): void {
    const session = RemotePairingSession.parse(sessionValue);
    const serialized = JSON.stringify(session);
    const existing = this.db.prepare(`
      SELECT session FROM remote_pairing_sessions WHERE session_id = ?
    `).get(session.sessionId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.session !== serialized) {
        throw new Error("pairing session is immutable once persisted");
      }
      return;
    }
    this.db.prepare(`
      INSERT INTO remote_pairing_sessions (session_id, account_id, session, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(
      session.sessionId,
      session.accountId,
      serialized,
      timestamp(now),
    );
  }

  consumePairingSession(sessionId: string, now = Date.now()): RemotePairingSessionType {
    const parsedSessionId = RemotePairingSessionId.parse(sessionId);
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT session FROM remote_pairing_sessions WHERE session_id = ?
      `).get(parsedSessionId) as Record<string, unknown> | undefined;
      if (!row || typeof row.session !== "string") throw new Error("pairing session not found");
      const session = RemotePairingSession.parse(JSON.parse(row.session));
      if (session.consumedAt) throw new Error("pairing session already consumed");
      const consumedAt = timestamp(now);
      if (new Date(session.expiresAt).getTime() < new Date(consumedAt).getTime()) {
        throw new Error("pairing session expired");
      }
      const consumed = RemotePairingSession.parse({ ...session, consumedAt });
      this.db.prepare(`
        UPDATE remote_pairing_sessions SET session = ?, updated_at = ?
        WHERE session_id = ?
      `).run(JSON.stringify(consumed), consumedAt, session.sessionId);
      return consumed;
    });
  }

  saveConnectorState(
    localDeviceIdValue: string,
    state: RemoteConnectorPersistedState,
    now = Date.now(),
  ): void {
    const localDeviceId = RemoteDeviceId.parse(localDeviceIdValue);
    this.db.prepare(`
      INSERT INTO remote_connector_states (local_device_id, state, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(local_device_id) DO UPDATE SET
        state = excluded.state,
        updated_at = excluded.updated_at
    `).run(localDeviceId, JSON.stringify(state), timestamp(now));
  }

  loadConnectorState(localDeviceIdValue: string): RemoteConnectorPersistedState | null {
    const localDeviceId = RemoteDeviceId.parse(localDeviceIdValue);
    const row = this.db.prepare(`
      SELECT state FROM remote_connector_states WHERE local_device_id = ?
    `).get(localDeviceId) as Record<string, unknown> | undefined;
    if (!row || typeof row.state !== "string") return null;
    return JSON.parse(row.state) as RemoteConnectorPersistedState;
  }

  appendRemoteAction(input: RemoteActionAuditInput): RemoteActionAuditRecord {
    const accountId = RemoteAccountId.parse(input.accountId);
    const localDeviceId = RemoteDeviceId.parse(input.localDeviceId);
    const remoteDeviceId = RemoteDeviceId.parse(input.remoteDeviceId);
    const messageId = RemoteBridgeMessageId.parse(input.messageId);
    const createdAt = timestamp(input.createdAt ?? Date.now());
    const contentType = bounded(input.contentType, "content type", 120);
    const action = identifier(input.action, "action");
    if (!["accepted", "rejected", "failed"].includes(input.outcome)) {
      throw new Error("invalid remote audit outcome");
    }
    const errorCode = input.errorCode
      ? identifier(input.errorCode, "error code", 120)
      : undefined;
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM remote_action_audit
        WHERE account_id = ? AND local_device_id = ? AND message_id = ?
      `).get(accountId, localDeviceId, messageId) as Record<string, unknown> | undefined;
      if (existing) {
        const record: RemoteActionAuditRecord = {
          id: String(existing.id),
          accountId: String(existing.account_id),
          localDeviceId: String(existing.local_device_id),
          remoteDeviceId: String(existing.remote_device_id),
          messageId: String(existing.message_id),
          contentType: String(existing.content_type),
          action: String(existing.action),
          outcome: existing.outcome as RemoteActionAuditRecord["outcome"],
          ...(existing.error_code ? { errorCode: String(existing.error_code) } : {}),
          createdAt: String(existing.created_at),
          previousHash: existing.previous_hash ? String(existing.previous_hash) : null,
          entryHash: String(existing.entry_hash),
        };
        if (
          record.remoteDeviceId !== remoteDeviceId ||
          record.contentType !== contentType ||
          record.action !== action ||
          record.outcome !== input.outcome ||
          record.errorCode !== errorCode
        ) {
          throw new Error("remote audit idempotency conflict");
        }
        return record;
      }
      const previous = this.db.prepare(`
        SELECT entry_hash FROM remote_action_audit ORDER BY seq DESC LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      const previousHash = typeof previous?.entry_hash === "string" ? previous.entry_hash : null;
      const unsigned = {
        id: `raud_${randomBytes(16).toString("hex")}`,
        accountId,
        localDeviceId,
        remoteDeviceId,
        messageId,
        contentType,
        action,
        outcome: input.outcome,
        ...(errorCode ? { errorCode } : {}),
        createdAt,
        previousHash,
      };
      const record: RemoteActionAuditRecord = {
        ...unsigned,
        entryHash: auditHash(unsigned),
      };
      this.db.prepare(`
        INSERT INTO remote_action_audit (
          id, created_at, account_id, local_device_id, remote_device_id,
          message_id, content_type, action, outcome, error_code,
          previous_hash, entry_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.createdAt,
        record.accountId,
        record.localDeviceId,
        record.remoteDeviceId,
        record.messageId,
        record.contentType,
        record.action,
        record.outcome,
        record.errorCode ?? null,
        record.previousHash,
        record.entryHash,
      );
      return record;
    });
  }

  verifyAuditChain(): boolean {
    const rows = this.db.prepare(`
      SELECT * FROM remote_action_audit ORDER BY seq ASC
    `).all() as Array<Record<string, unknown>>;
    let previousHash: string | null = null;
    for (const row of rows) {
      const unsigned = {
        id: String(row.id),
        accountId: String(row.account_id),
        localDeviceId: String(row.local_device_id),
        remoteDeviceId: String(row.remote_device_id),
        messageId: String(row.message_id),
        contentType: String(row.content_type),
        action: String(row.action),
        outcome: row.outcome as RemoteActionAuditRecord["outcome"],
        ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
        createdAt: String(row.created_at),
        previousHash,
      };
      if (row.previous_hash !== previousHash || row.entry_hash !== auditHash(unsigned)) return false;
      previousHash = String(row.entry_hash);
    }
    return true;
  }

  close(): void {
    this.db.close();
  }
}
