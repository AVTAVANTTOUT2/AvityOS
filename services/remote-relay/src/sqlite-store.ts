import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  RemoteEncryptedEnvelope,
  RemoteRelayAckResult,
  RemoteRelayDeviceRecord,
  RemoteRelayInbox,
  RemoteRelayPublishResult,
  RemoteRelayRegisterDeviceRequest,
  RemoteRelayUpdateDeviceCertificateRequest,
  type RemoteRelayAckResult as RemoteRelayAckResultType,
  type RemoteRelayDeviceRecord as RemoteRelayDeviceRecordType,
  type RemoteRelayInbox as RemoteRelayInboxType,
  type RemoteRelayPublishResult as RemoteRelayPublishResultType,
  type RemoteRelayRegisterDeviceRequest as RemoteRelayRegisterDeviceRequestType,
  type RemoteRelayUpdateDeviceCertificateRequest as RemoteRelayUpdateDeviceCertificateRequestType,
} from "@avityos/contracts";
import {
  InMemoryRelayStore,
  RemoteRelayCapacityError,
  RemoteRelayConflictError,
  assertCertificateRenewal,
  type InMemoryRelayStoreOptions,
  type RemoteRelayStore,
} from "./store.js";

interface SqliteRelayStoreOptions extends InMemoryRelayStoreOptions {}

function rowNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function rowString(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid relay database row");
  return value;
}

function key(accountId: string, deviceId: string): string {
  return `${accountId}:${deviceId}`;
}

export class SqliteRelayStore implements RemoteRelayStore {
  private readonly db: DatabaseSync;
  private readonly ttlMs: number;
  private readonly maxItemsPerInbox: number;
  private readonly maxTotalItems: number;
  private readonly maxBytesPerInbox: number;
  private readonly maxTotalBytes: number;
  private readonly maxInboxStates: number;
  private readonly maxSeenMessages: number;
  private readonly maxWaiters: number;
  private readonly now: () => number;
  private readonly waiters = new Map<string, Set<() => void>>();
  private waiterCount = 0;

  constructor(readonly databasePath: string, options: SqliteRelayStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60_000;
    this.maxItemsPerInbox = options.maxItemsPerInbox ?? 100;
    this.maxTotalItems = options.maxTotalItems ?? 10_000;
    this.maxBytesPerInbox = options.maxBytesPerInbox ?? 32 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
    this.maxInboxStates = options.maxInboxStates ?? 10_000;
    this.maxSeenMessages = options.maxSeenMessages ?? 100_000;
    this.maxWaiters = options.maxWaiters ?? 1_000;
    this.now = options.now ?? Date.now;
    // Reuse the in-memory implementation's fail-closed option validation.
    new InMemoryRelayStore(options);
    if (databasePath !== ":memory:") {
      const parent = dirname(databasePath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if ((statSync(parent).mode & 0o077) !== 0) {
        throw new Error("relay database directory must not be group/world accessible");
      }
    }
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS relay_devices (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        certificate TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        revoked_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, device_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS relay_cursors (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        PRIMARY KEY (account_id, device_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS relay_inbox (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        received_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        envelope TEXT NOT NULL,
        PRIMARY KEY (account_id, device_id, cursor)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_relay_inbox_expiry
        ON relay_inbox(expires_at);
      CREATE TABLE IF NOT EXISTS relay_seen (
        message_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_relay_seen_expiry
        ON relay_seen(expires_at);
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

  private cleanup(now: number): void {
    this.db.prepare("DELETE FROM relay_inbox WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM relay_seen WHERE expires_at <= ?").run(now);
  }

  private notify(waiterKey: string): void {
    const current = this.waiters.get(waiterKey);
    if (!current) return;
    this.waiters.delete(waiterKey);
    for (const finish of current) finish();
  }

  registerDevice(inputValue: RemoteRelayRegisterDeviceRequestType): RemoteRelayDeviceRecordType {
    const input = RemoteRelayRegisterDeviceRequest.parse(inputValue);
    const updatedAt = new Date(this.now()).toISOString();
    const tokenHash = createHash("sha256").update(input.accessToken).digest("hex");
    this.db.prepare(`
      INSERT INTO relay_devices (
        account_id, device_id, certificate, token_hash, revoked_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(account_id, device_id) DO UPDATE SET
        certificate = excluded.certificate,
        token_hash = excluded.token_hash,
        revoked_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      input.certificate.accountId,
      input.certificate.deviceId,
      JSON.stringify(input.certificate),
      tokenHash,
      updatedAt,
    );
    return RemoteRelayDeviceRecord.parse({
      accountId: input.certificate.accountId,
      deviceId: input.certificate.deviceId,
      status: "active",
      updatedAt,
    });
  }

  updateDeviceCertificate(
    inputValue: RemoteRelayUpdateDeviceCertificateRequestType,
  ): RemoteRelayDeviceRecordType | null {
    const input = RemoteRelayUpdateDeviceCertificateRequest.parse(inputValue);
    const existing = this.db.prepare(`
      SELECT certificate, revoked_at, updated_at
      FROM relay_devices
      WHERE account_id = ? AND device_id = ?
    `).get(
      input.certificate.accountId,
      input.certificate.deviceId,
    ) as Record<string, unknown> | undefined;
    if (!existing) return null;
    if (existing.revoked_at !== null) {
      throw new RemoteRelayConflictError(
        "revoked relay device certificates cannot be renewed",
      );
    }
    const renewal = assertCertificateRenewal(
      JSON.parse(rowString(existing.certificate)),
      input.certificate,
    );
    if (renewal.unchanged) {
      return RemoteRelayDeviceRecord.parse({
        accountId: renewal.next.accountId,
        deviceId: renewal.next.deviceId,
        status: "active",
        updatedAt: rowString(existing.updated_at),
      });
    }
    const updatedAt = new Date(this.now()).toISOString();
    this.db.prepare(`
      UPDATE relay_devices
      SET certificate = ?, updated_at = ?
      WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL
    `).run(
      JSON.stringify(renewal.next),
      updatedAt,
      renewal.next.accountId,
      renewal.next.deviceId,
    );
    return RemoteRelayDeviceRecord.parse({
      accountId: renewal.next.accountId,
      deviceId: renewal.next.deviceId,
      status: "active",
      updatedAt,
    });
  }

  revokeDevice(accountId: string, deviceId: string): RemoteRelayDeviceRecordType | null {
    const updatedAt = new Date(this.now()).toISOString();
    const result = this.db.prepare(`
      UPDATE relay_devices SET revoked_at = ?, updated_at = ?
      WHERE account_id = ? AND device_id = ?
    `).run(updatedAt, updatedAt, accountId, deviceId);
    if (Number(result.changes) === 0) return null;
    return RemoteRelayDeviceRecord.parse({
      accountId,
      deviceId,
      status: "revoked",
      updatedAt,
    });
  }

  authorizeDevice(accountId: string, deviceId: string, accessToken: string): boolean {
    const row = this.db.prepare(`
      SELECT token_hash, revoked_at FROM relay_devices
      WHERE account_id = ? AND device_id = ?
    `).get(accountId, deviceId) as Record<string, unknown> | undefined;
    if (!row || row.revoked_at !== null) return false;
    const expected = Buffer.from(rowString(row.token_hash), "hex");
    const supplied = createHash("sha256").update(accessToken).digest();
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  isDeviceActive(accountId: string, deviceId: string): boolean {
    const row = this.db.prepare(`
      SELECT revoked_at FROM relay_devices
      WHERE account_id = ? AND device_id = ?
    `).get(accountId, deviceId) as Record<string, unknown> | undefined;
    return Boolean(row) && row?.revoked_at === null;
  }

  publish(envelopeInput: unknown): RemoteRelayPublishResultType {
    const envelope = RemoteEncryptedEnvelope.parse(envelopeInput);
    const serialized = JSON.stringify(envelope);
    const sizeBytes = Buffer.byteLength(serialized);
    const envelopeFingerprint = createHash("sha256").update(serialized).digest("hex");
    const now = this.now();
    let published = false;
    const result = this.transaction(() => {
      this.cleanup(now);
      const duplicate = this.db.prepare(`
        SELECT fingerprint, accepted_at FROM relay_seen WHERE message_id = ?
      `).get(envelope.messageId) as Record<string, unknown> | undefined;
      if (duplicate) {
        if (rowString(duplicate.fingerprint) !== envelopeFingerprint) {
          throw new RemoteRelayConflictError("message id is already bound to another envelope");
        }
        return RemoteRelayPublishResult.parse({
          messageId: envelope.messageId,
          acceptedAt: rowString(duplicate.accepted_at),
          duplicate: true,
        });
      }

      const seenCount = rowNumber(
        (this.db.prepare("SELECT COUNT(*) count FROM relay_seen").get() as Record<string, unknown>).count,
      );
      if (seenCount >= this.maxSeenMessages) {
        throw new RemoteRelayCapacityError("relay deduplication capacity reached");
      }
      const inboxStats = this.db.prepare(`
        SELECT COUNT(*) count, COALESCE(SUM(size_bytes), 0) bytes
        FROM relay_inbox WHERE account_id = ? AND device_id = ?
      `).get(envelope.accountId, envelope.recipientDeviceId) as Record<string, unknown>;
      if (rowNumber(inboxStats.count) >= this.maxItemsPerInbox) {
        throw new RemoteRelayCapacityError("recipient inbox capacity reached");
      }
      if (rowNumber(inboxStats.bytes) + sizeBytes > this.maxBytesPerInbox) {
        throw new RemoteRelayCapacityError("recipient inbox byte capacity reached");
      }
      const totalStats = this.db.prepare(`
        SELECT COUNT(*) count, COALESCE(SUM(size_bytes), 0) bytes FROM relay_inbox
      `).get() as Record<string, unknown>;
      if (rowNumber(totalStats.count) >= this.maxTotalItems) {
        throw new RemoteRelayCapacityError("relay total queue capacity reached");
      }
      if (rowNumber(totalStats.bytes) + sizeBytes > this.maxTotalBytes) {
        throw new RemoteRelayCapacityError("relay total byte capacity reached");
      }
      const cursorRow = this.db.prepare(`
        SELECT cursor FROM relay_cursors WHERE account_id = ? AND device_id = ?
      `).get(envelope.accountId, envelope.recipientDeviceId) as Record<string, unknown> | undefined;
      if (!cursorRow) {
        const cursorCount = rowNumber(
          (this.db.prepare("SELECT COUNT(*) count FROM relay_cursors").get() as Record<string, unknown>).count,
        );
        if (cursorCount >= this.maxInboxStates) {
          throw new RemoteRelayCapacityError("relay inbox-state capacity reached");
        }
      }
      const cursor = rowNumber(cursorRow?.cursor) + 1;
      if (!Number.isSafeInteger(cursor)) {
        throw new RemoteRelayCapacityError("recipient cursor capacity reached");
      }
      const receivedAt = new Date(now).toISOString();
      const expiresAt = now + this.ttlMs;
      this.db.prepare(`
        INSERT INTO relay_cursors (account_id, device_id, cursor)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id, device_id) DO UPDATE SET
          cursor = excluded.cursor
      `).run(envelope.accountId, envelope.recipientDeviceId, cursor);
      this.db.prepare(`
        INSERT INTO relay_inbox (
          account_id, device_id, cursor, message_id, fingerprint,
          received_at, expires_at, size_bytes, envelope
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        envelope.accountId,
        envelope.recipientDeviceId,
        cursor,
        envelope.messageId,
        envelopeFingerprint,
        receivedAt,
        expiresAt,
        sizeBytes,
        serialized,
      );
      this.db.prepare(`
        INSERT INTO relay_seen (message_id, fingerprint, accepted_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(envelope.messageId, envelopeFingerprint, receivedAt, expiresAt);
      published = true;
      return RemoteRelayPublishResult.parse({
        messageId: envelope.messageId,
        acceptedAt: receivedAt,
        duplicate: false,
      });
    });
    if (published) this.notify(key(envelope.accountId, envelope.recipientDeviceId));
    return result;
  }

  list(accountId: string, deviceId: string, afterCursor: number, limit: number): RemoteRelayInboxType {
    const now = this.now();
    this.transaction(() => this.cleanup(now));
    const rows = this.db.prepare(`
      SELECT cursor, received_at, envelope FROM relay_inbox
      WHERE account_id = ? AND device_id = ? AND cursor > ?
      ORDER BY cursor ASC LIMIT ?
    `).all(accountId, deviceId, afterCursor, limit) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      cursor: rowNumber(row.cursor),
      receivedAt: rowString(row.received_at),
      envelope: RemoteEncryptedEnvelope.parse(JSON.parse(rowString(row.envelope))),
    }));
    return RemoteRelayInbox.parse({
      items,
      nextCursor: items.at(-1)?.cursor ?? afterCursor,
    });
  }

  acknowledge(
    accountId: string,
    deviceId: string,
    throughCursor: number,
  ): RemoteRelayAckResultType {
    const now = this.now();
    const deleted = this.transaction(() => {
      this.cleanup(now);
      const result = this.db.prepare(`
        DELETE FROM relay_inbox
        WHERE account_id = ? AND device_id = ? AND cursor <= ?
      `).run(accountId, deviceId, throughCursor);
      return Number(result.changes);
    });
    return RemoteRelayAckResult.parse({ throughCursor, deleted });
  }

  async waitForItems(input: {
    readonly accountId: string;
    readonly deviceId: string;
    readonly afterCursor: number;
    readonly waitMs: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (
      input.waitMs === 0 ||
      this.list(input.accountId, input.deviceId, input.afterCursor, 1).items.length > 0
    ) {
      return;
    }
    if (this.waiterCount >= this.maxWaiters) {
      throw new RemoteRelayCapacityError("relay long-poll capacity reached");
    }
    const waiterKey = key(input.accountId, input.deviceId);
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", finish);
        const current = this.waiters.get(waiterKey);
        current?.delete(finish);
        if (current?.size === 0) this.waiters.delete(waiterKey);
        this.waiterCount -= 1;
        resolve();
      };
      const timer = setTimeout(finish, input.waitMs);
      const current = this.waiters.get(waiterKey) ?? new Set<() => void>();
      current.add(finish);
      this.waiters.set(waiterKey, current);
      this.waiterCount += 1;
      input.signal?.addEventListener("abort", finish, { once: true });
      if (input.signal?.aborted) finish();
    });
  }

  stats(): { readonly inboxes: number; readonly queuedEnvelopes: number } {
    this.transaction(() => this.cleanup(this.now()));
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT account_id || ':' || device_id) inboxes,
             COUNT(*) queued
      FROM relay_inbox
    `).get() as Record<string, unknown>;
    return {
      inboxes: rowNumber(row.inboxes),
      queuedEnvelopes: rowNumber(row.queued),
    };
  }

  close(): void {
    this.db.close();
  }
}
