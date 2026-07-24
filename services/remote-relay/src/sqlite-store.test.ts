import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateRemoteAccountIdentity,
  generateRemoteDeviceIdentity,
  issueRemoteDeviceCertificate,
  sealRemoteEnvelope,
} from "@avityos/remote-bridge";
import { SqliteRelayStore } from "./sqlite-store.js";
import { RemoteRelayConflictError } from "./store.js";

const NOW = "2026-07-24T10:00:00.000Z";
const DEVICE_TOKEN = "durable-device-token-".padEnd(32, "x");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const account = generateRemoteAccountIdentity();
  const sender = generateRemoteDeviceIdentity();
  const recipient = generateRemoteDeviceIdentity();
  const senderCertificate = issueRemoteDeviceCertificate({
    account,
    device: sender,
    name: "Sender",
    issuedAt: NOW,
  });
  const recipientCertificate = issueRemoteDeviceCertificate({
    account,
    device: recipient,
    name: "Recipient",
    issuedAt: NOW,
  });
  return {
    account,
    sender,
    recipient,
    senderCertificate,
    recipientCertificate,
  };
}

describe("durable relay SQLite store", () => {
  it("persists device authorization, ciphertext, deduplication and cursors across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "avity-relay-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "relay.sqlite");
    const setup = fixture();
    const firstEnvelope = sealRemoteEnvelope({
      plaintext: "durable-secret-not-in-relay-clear",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: setup.sender,
      senderCertificate: setup.senderCertificate,
      recipientCertificate: setup.recipientCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });

    let now = new Date(NOW).getTime();
    const first = new SqliteRelayStore(databasePath, {
      now: () => now,
      ttlMs: 1_000,
    });
    first.registerDevice({
      certificate: setup.senderCertificate,
      accessToken: DEVICE_TOKEN,
    });
    expect(first.authorizeDevice(
      setup.account.accountId,
      setup.sender.deviceId,
      DEVICE_TOKEN,
    )).toBe(true);
    expect(first.publish(firstEnvelope).duplicate).toBe(false);
    first.close();

    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    const databaseBytes = readFileSync(databasePath);
    expect(databaseBytes.includes(Buffer.from(DEVICE_TOKEN))).toBe(false);
    expect(databaseBytes.includes(Buffer.from("durable-secret-not-in-relay-clear"))).toBe(false);

    const second = new SqliteRelayStore(databasePath, {
      now: () => now,
      ttlMs: 1_000,
    });
    expect(second.authorizeDevice(
      setup.account.accountId,
      setup.sender.deviceId,
      DEVICE_TOKEN,
    )).toBe(true);
    expect(second.publish(firstEnvelope).duplicate).toBe(true);
    const inbox = second.list(
      setup.account.accountId,
      setup.recipient.deviceId,
      0,
      25,
    );
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.cursor).toBe(1);
    expect(second.acknowledge(
      setup.account.accountId,
      setup.recipient.deviceId,
      1,
    ).deleted).toBe(1);
    second.close();

    now += 1_001;
    const third = new SqliteRelayStore(databasePath, {
      now: () => now,
      ttlMs: 1_000,
    });
    const secondEnvelope = sealRemoteEnvelope({
      plaintext: "next",
      contentType: "text/plain",
      sequence: 2,
      senderIdentity: setup.sender,
      senderCertificate: setup.senderCertificate,
      recipientCertificate: setup.recipientCertificate,
      accountSigningPublicKey: setup.account.signingPublicKey,
      sentAt: NOW,
    });
    third.publish(secondEnvelope);
    expect(third.list(
      setup.account.accountId,
      setup.recipient.deviceId,
      1,
      25,
    ).items[0]?.cursor).toBe(2);
    expect(third.revokeDevice(
      setup.account.accountId,
      setup.sender.deviceId,
    )?.status).toBe("revoked");
    expect(third.authorizeDevice(
      setup.account.accountId,
      setup.sender.deviceId,
      DEVICE_TOKEN,
    )).toBe(false);
    third.close();
  });

  it("persists certificate renewal while preserving bearer and revocation state", () => {
    const directory = mkdtempSync(join(tmpdir(), "avity-relay-renewal-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "relay.sqlite");
    const setup = fixture();
    const renewed = issueRemoteDeviceCertificate({
      account: setup.account,
      device: setup.sender,
      name: setup.senderCertificate.name,
      issuedAt: "2026-08-01T10:00:00.000Z",
    });
    const first = new SqliteRelayStore(databasePath, {
      now: () => new Date("2026-08-01T10:00:00.000Z").getTime(),
    });
    first.registerDevice({
      certificate: setup.senderCertificate,
      accessToken: DEVICE_TOKEN,
    });
    first.updateDeviceCertificate({ certificate: renewed });
    first.close();

    const second = new SqliteRelayStore(databasePath);
    expect(second.authorizeDevice(
      setup.account.accountId,
      setup.sender.deviceId,
      DEVICE_TOKEN,
    )).toBe(true);
    expect(second.updateDeviceCertificate({ certificate: renewed })?.status)
      .toBe("active");
    second.revokeDevice(setup.account.accountId, setup.sender.deviceId);
    expect(() => second.updateDeviceCertificate({ certificate: renewed }))
      .toThrow(RemoteRelayConflictError);
    expect(second.authorizeDevice(
      setup.account.accountId,
      setup.sender.deviceId,
      DEVICE_TOKEN,
    )).toBe(false);
    second.close();
  });
});
