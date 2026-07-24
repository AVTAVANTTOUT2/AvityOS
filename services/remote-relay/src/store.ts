import { createHash, timingSafeEqual } from "node:crypto";
import {
  RemoteEncryptedEnvelope,
  RemoteRelayAckResult,
  RemoteRelayDeviceRecord,
  RemoteRelayInbox,
  RemoteRelayPublishResult,
  RemoteRelayRegisterDeviceRequest,
  type RemoteEncryptedEnvelope as RemoteEncryptedEnvelopeType,
  type RemoteRelayAckResult as RemoteRelayAckResultType,
  type RemoteRelayDeviceRecord as RemoteRelayDeviceRecordType,
  type RemoteRelayInbox as RemoteRelayInboxType,
  type RemoteRelayPublishResult as RemoteRelayPublishResultType,
  type RemoteRelayRegisterDeviceRequest as RemoteRelayRegisterDeviceRequestType,
} from "@avityos/contracts";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_ITEMS_PER_INBOX = 100;
const DEFAULT_MAX_TOTAL_ITEMS = 10_000;
const DEFAULT_MAX_BYTES_PER_INBOX = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_INBOX_STATES = 10_000;
const DEFAULT_MAX_SEEN_MESSAGES = 100_000;
const DEFAULT_MAX_WAITERS = 1_000;

interface StoredRelayItem {
  readonly cursor: number;
  readonly receivedAt: string;
  readonly expiresAt: number;
  readonly sizeBytes: number;
  readonly envelope: RemoteEncryptedEnvelopeType;
}

interface SeenMessage {
  readonly fingerprint: string;
  readonly acceptedAt: string;
  readonly expiresAt: number;
}

interface CursorState {
  readonly cursor: number;
}

interface AuthorizedDevice {
  readonly tokenHash: Buffer;
  readonly certificate: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

export interface RemoteRelayStore {
  registerDevice(input: RemoteRelayRegisterDeviceRequestType): RemoteRelayDeviceRecordType;
  revokeDevice(accountId: string, deviceId: string): RemoteRelayDeviceRecordType | null;
  authorizeDevice(accountId: string, deviceId: string, accessToken: string): boolean;
  isDeviceActive(accountId: string, deviceId: string): boolean;
  publish(envelopeInput: unknown): RemoteRelayPublishResultType;
  list(accountId: string, deviceId: string, afterCursor: number, limit: number): RemoteRelayInboxType;
  acknowledge(accountId: string, deviceId: string, throughCursor: number): RemoteRelayAckResultType;
  waitForItems(input: {
    readonly accountId: string;
    readonly deviceId: string;
    readonly afterCursor: number;
    readonly waitMs: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  stats(): { readonly inboxes: number; readonly queuedEnvelopes: number };
}

export interface InMemoryRelayStoreOptions {
  readonly ttlMs?: number;
  readonly maxItemsPerInbox?: number;
  readonly maxTotalItems?: number;
  readonly maxBytesPerInbox?: number;
  readonly maxTotalBytes?: number;
  readonly maxInboxStates?: number;
  readonly maxSeenMessages?: number;
  readonly maxWaiters?: number;
  readonly now?: () => number;
}

export class RemoteRelayConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteRelayConflictError";
  }
}

export class RemoteRelayCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteRelayCapacityError";
  }
}

function inboxKey(accountId: string, deviceId: string): string {
  return `${accountId}:${deviceId}`;
}

function fingerprint(serializedEnvelope: string): string {
  return createHash("sha256").update(serializedEnvelope).digest("hex");
}

export class InMemoryRelayStore implements RemoteRelayStore {
  private readonly ttlMs: number;
  private readonly maxItemsPerInbox: number;
  private readonly maxTotalItems: number;
  private readonly maxBytesPerInbox: number;
  private readonly maxTotalBytes: number;
  private readonly maxInboxStates: number;
  private readonly maxSeenMessages: number;
  private readonly maxWaiters: number;
  private readonly now: () => number;
  private readonly inboxes = new Map<string, StoredRelayItem[]>();
  private readonly cursorStates = new Map<string, CursorState>();
  private readonly seenMessages = new Map<string, SeenMessage>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly devices = new Map<string, AuthorizedDevice>();
  private waiterCount = 0;

  constructor(options: InMemoryRelayStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxItemsPerInbox = options.maxItemsPerInbox ?? DEFAULT_MAX_ITEMS_PER_INBOX;
    this.maxTotalItems = options.maxTotalItems ?? DEFAULT_MAX_TOTAL_ITEMS;
    this.maxBytesPerInbox = options.maxBytesPerInbox ?? DEFAULT_MAX_BYTES_PER_INBOX;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxInboxStates = options.maxInboxStates ?? DEFAULT_MAX_INBOX_STATES;
    this.maxSeenMessages = options.maxSeenMessages ?? DEFAULT_MAX_SEEN_MESSAGES;
    this.maxWaiters = options.maxWaiters ?? DEFAULT_MAX_WAITERS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 30 * 24 * 60 * 60_000) {
      throw new Error("relay ttl must be between one second and 30 days");
    }
    if (
      !Number.isSafeInteger(this.maxItemsPerInbox) ||
      this.maxItemsPerInbox < 1 ||
      this.maxItemsPerInbox > 100_000
    ) {
      throw new Error("relay inbox capacity must be between 1 and 100000");
    }
    if (
      !Number.isSafeInteger(this.maxTotalItems) ||
      this.maxTotalItems < this.maxItemsPerInbox ||
      this.maxTotalItems > 1_000_000
    ) {
      throw new Error("relay total capacity must cover one inbox and be at most 1000000");
    }
    if (
      !Number.isSafeInteger(this.maxBytesPerInbox) ||
      this.maxBytesPerInbox < 1_024 ||
      this.maxBytesPerInbox > 1024 * 1024 * 1024
    ) {
      throw new Error("relay inbox byte capacity must be between 1 KiB and 1 GiB");
    }
    if (
      !Number.isSafeInteger(this.maxTotalBytes) ||
      this.maxTotalBytes < this.maxBytesPerInbox ||
      this.maxTotalBytes > 4 * 1024 * 1024 * 1024
    ) {
      throw new Error("relay total byte capacity must cover one inbox and be at most 4 GiB");
    }
    if (!Number.isSafeInteger(this.maxInboxStates) || this.maxInboxStates < 1 || this.maxInboxStates > 100_000) {
      throw new Error("relay inbox-state capacity must be between 1 and 100000");
    }
    if (!Number.isSafeInteger(this.maxSeenMessages) || this.maxSeenMessages < 1 || this.maxSeenMessages > 2_000_000) {
      throw new Error("relay deduplication capacity must be between 1 and 2000000");
    }
    if (!Number.isSafeInteger(this.maxWaiters) || this.maxWaiters < 1 || this.maxWaiters > 100_000) {
      throw new Error("relay long-poll capacity must be between 1 and 100000");
    }
  }

  private cleanup(now: number): void {
    for (const [key, items] of this.inboxes) {
      const current = items.filter((item) => item.expiresAt > now);
      if (current.length > 0) this.inboxes.set(key, current);
      else this.inboxes.delete(key);
    }
    for (const [messageId, seen] of this.seenMessages) {
      if (seen.expiresAt <= now) this.seenMessages.delete(messageId);
    }
  }

  private notify(key: string): void {
    const current = this.waiters.get(key);
    if (!current) return;
    this.waiters.delete(key);
    for (const resolve of current) resolve();
  }

  registerDevice(inputValue: RemoteRelayRegisterDeviceRequestType): RemoteRelayDeviceRecordType {
    const input = RemoteRelayRegisterDeviceRequest.parse(inputValue);
    const updatedAt = new Date(this.now()).toISOString();
    const key = inboxKey(input.certificate.accountId, input.certificate.deviceId);
    this.devices.set(key, {
      tokenHash: createHash("sha256").update(input.accessToken).digest(),
      certificate: JSON.stringify(input.certificate),
      updatedAt,
      revokedAt: null,
    });
    return RemoteRelayDeviceRecord.parse({
      accountId: input.certificate.accountId,
      deviceId: input.certificate.deviceId,
      status: "active",
      updatedAt,
    });
  }

  revokeDevice(accountId: string, deviceId: string): RemoteRelayDeviceRecordType | null {
    const key = inboxKey(accountId, deviceId);
    const existing = this.devices.get(key);
    if (!existing) return null;
    const updatedAt = new Date(this.now()).toISOString();
    this.devices.set(key, { ...existing, updatedAt, revokedAt: updatedAt });
    return RemoteRelayDeviceRecord.parse({
      accountId,
      deviceId,
      status: "revoked",
      updatedAt,
    });
  }

  authorizeDevice(accountId: string, deviceId: string, accessToken: string): boolean {
    const device = this.devices.get(inboxKey(accountId, deviceId));
    if (!device || device.revokedAt) return false;
    const suppliedHash = createHash("sha256").update(accessToken).digest();
    return timingSafeEqual(suppliedHash, device.tokenHash);
  }

  isDeviceActive(accountId: string, deviceId: string): boolean {
    const device = this.devices.get(inboxKey(accountId, deviceId));
    return Boolean(device && !device.revokedAt);
  }

  publish(envelopeInput: unknown): RemoteRelayPublishResultType {
    const envelope = RemoteEncryptedEnvelope.parse(envelopeInput);
    const now = this.now();
    this.cleanup(now);
    const serializedEnvelope = JSON.stringify(envelope);
    const sizeBytes = Buffer.byteLength(serializedEnvelope, "utf8");
    const envelopeFingerprint = fingerprint(serializedEnvelope);
    const existing = this.seenMessages.get(envelope.messageId);
    if (existing) {
      if (existing.fingerprint !== envelopeFingerprint) {
        throw new RemoteRelayConflictError("message id is already bound to another envelope");
      }
      return RemoteRelayPublishResult.parse({
        messageId: envelope.messageId,
        acceptedAt: existing.acceptedAt,
        duplicate: true,
      });
    }
    if (this.seenMessages.size >= this.maxSeenMessages) {
      throw new RemoteRelayCapacityError("relay deduplication capacity reached");
    }

    const key = inboxKey(envelope.accountId, envelope.recipientDeviceId);
    const items = this.inboxes.get(key) ?? [];
    if (!this.cursorStates.has(key) && this.cursorStates.size >= this.maxInboxStates) {
      throw new RemoteRelayCapacityError("relay inbox-state capacity reached");
    }
    if (items.length >= this.maxItemsPerInbox) {
      throw new RemoteRelayCapacityError("recipient inbox capacity reached");
    }
    let inboxBytes = 0;
    for (const item of items) inboxBytes += item.sizeBytes;
    if (inboxBytes + sizeBytes > this.maxBytesPerInbox) {
      throw new RemoteRelayCapacityError("recipient inbox byte capacity reached");
    }
    let totalItems = 0;
    let totalBytes = 0;
    for (const inboxItems of this.inboxes.values()) {
      totalItems += inboxItems.length;
      for (const item of inboxItems) totalBytes += item.sizeBytes;
    }
    if (totalItems >= this.maxTotalItems) {
      throw new RemoteRelayCapacityError("relay total queue capacity reached");
    }
    if (totalBytes + sizeBytes > this.maxTotalBytes) {
      throw new RemoteRelayCapacityError("relay total byte capacity reached");
    }
    const cursor = (this.cursorStates.get(key)?.cursor ?? 0) + 1;
    if (!Number.isSafeInteger(cursor)) {
      throw new RemoteRelayCapacityError("recipient cursor capacity reached");
    }
    const receivedAt = new Date(now).toISOString();
    const expiresAt = now + this.ttlMs;
    items.push({ cursor, receivedAt, expiresAt, sizeBytes, envelope });
    this.inboxes.set(key, items);
    this.cursorStates.set(key, { cursor });
    this.seenMessages.set(envelope.messageId, {
      fingerprint: envelopeFingerprint,
      acceptedAt: receivedAt,
      expiresAt,
    });
    this.notify(key);
    return RemoteRelayPublishResult.parse({
      messageId: envelope.messageId,
      acceptedAt: receivedAt,
      duplicate: false,
    });
  }

  list(
    accountId: string,
    deviceId: string,
    afterCursor: number,
    limit: number,
  ): RemoteRelayInboxType {
    const now = this.now();
    this.cleanup(now);
    const key = inboxKey(accountId, deviceId);
    const items = (this.inboxes.get(key) ?? [])
      .filter((item) => item.cursor > afterCursor)
      .slice(0, limit)
      .map(({ cursor, receivedAt, envelope }) => ({ cursor, receivedAt, envelope }));
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
    this.cleanup(now);
    const key = inboxKey(accountId, deviceId);
    const current = this.inboxes.get(key) ?? [];
    const retained = current.filter((item) => item.cursor > throughCursor);
    const deleted = current.length - retained.length;
    if (retained.length > 0) this.inboxes.set(key, retained);
    else this.inboxes.delete(key);
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
    const key = inboxKey(input.accountId, input.deviceId);
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", finish);
        const current = this.waiters.get(key);
        current?.delete(finish);
        if (current?.size === 0) this.waiters.delete(key);
        this.waiterCount -= 1;
        resolve();
      };
      const timer = setTimeout(finish, input.waitMs);
      const current = this.waiters.get(key) ?? new Set<() => void>();
      current.add(finish);
      this.waiters.set(key, current);
      this.waiterCount += 1;
      input.signal?.addEventListener("abort", finish, { once: true });
      if (input.signal?.aborted) finish();
    });
  }

  stats(): { readonly inboxes: number; readonly queuedEnvelopes: number } {
    this.cleanup(this.now());
    let queuedEnvelopes = 0;
    for (const items of this.inboxes.values()) queuedEnvelopes += items.length;
    return { inboxes: this.inboxes.size, queuedEnvelopes };
  }
}
