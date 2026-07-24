import { describe, expect, it } from "vitest";
import {
  RemoteDeviceCertificate,
  RemoteEncryptedEnvelope,
  RemotePairingOffer,
  RemotePairingRequest,
  RemoteRelayAckRequest,
  RemoteRelayInbox,
} from "./remote-bridge.js";

describe("remote bridge contracts", () => {
  it("rejects unknown fields and malformed public identifiers", () => {
    expect(RemotePairingOffer.safeParse({
      protocolVersion: 1,
      sessionId: "bad",
      accountId: "bad",
      unexpected: true,
    }).success).toBe(false);
    expect(RemoteDeviceCertificate.safeParse({ protocolVersion: 1 }).success).toBe(false);
  });

  it("rejects plaintext-shaped and incomplete relay payloads", () => {
    expect(RemotePairingRequest.safeParse({
      protocolVersion: 1,
      sessionId: `rpair_${"a".repeat(32)}`,
      plaintext: "secret",
    }).success).toBe(false);
    expect(RemoteEncryptedEnvelope.safeParse({
      protocolVersion: 1,
      messageId: `rmsg_${"a".repeat(32)}`,
      accountId: `racc_${"b".repeat(32)}`,
      senderDeviceId: `rdev_${"c".repeat(32)}`,
      recipientDeviceId: `rdev_${"d".repeat(32)}`,
      sequence: 1,
      sentAt: "2026-07-24T00:00:00.000Z",
      contentType: "application/json",
      plaintext: "{}",
    }).success).toBe(false);
  });

  it("bounds relay inboxes and acknowledgements", () => {
    expect(RemoteRelayInbox.safeParse({
      items: [],
      nextCursor: 0,
      plaintext: "forbidden",
    }).success).toBe(false);
    expect(RemoteRelayInbox.safeParse({
      items: Array.from({ length: 101 }, () => ({})),
      nextCursor: 0,
    }).success).toBe(false);
    expect(RemoteRelayAckRequest.safeParse({ throughCursor: 0 }).success).toBe(false);
  });
});
