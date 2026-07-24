import { describe, expect, it } from "vitest";
import {
  RemoteCertificateRenewalRequest,
  RemoteCertificateRenewalResponse,
  RemoteControlRequest,
  RemoteDeviceCertificate,
  RemoteEncryptedEnvelope,
  RemotePairingBootstrap,
  RemotePairingOffer,
  RemotePairingRequest,
  RemoteRelayAckRequest,
  RemoteRelayInbox,
  RemoteRelayUpdateDeviceCertificateRequest,
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

  it("keeps remote control and bootstrap payloads strict and versioned", () => {
    expect(RemoteControlRequest.parse({
      protocolVersion: 1,
      requestId: `rreq_${"a".repeat(32)}`,
      method: "GET",
      path: "/v1/projects",
    })).toMatchObject({ method: "GET", path: "/v1/projects" });
    expect(RemoteControlRequest.safeParse({
      protocolVersion: 1,
      requestId: `rreq_${"a".repeat(32)}`,
      method: "DELETE",
      path: "/v1/projects",
    }).success).toBe(false);
    expect(RemoteControlRequest.safeParse({
      protocolVersion: 1,
      requestId: `rreq_${"a".repeat(32)}`,
      method: "GET",
      path: "https://attacker.example/v1/projects",
    }).success).toBe(false);
    expect(RemotePairingBootstrap.safeParse({
      protocolVersion: 1,
      sessionId: `rpair_${"b".repeat(32)}`,
      relayAccessToken: "must-never-be-plaintext",
    }).success).toBe(false);
  });

  it("keeps certificate renewal payloads minimal and strict", () => {
    expect(RemoteCertificateRenewalRequest.parse({
      protocolVersion: 1,
    })).toEqual({ protocolVersion: 1 });
    expect(RemoteCertificateRenewalRequest.safeParse({
      protocolVersion: 1,
      rotateAccessToken: true,
    }).success).toBe(false);
    expect(RemoteCertificateRenewalResponse.safeParse({
      protocolVersion: 1,
      deviceCertificate: {},
      hostCertificate: {},
    }).success).toBe(false);
    expect(RemoteRelayUpdateDeviceCertificateRequest.safeParse({
      certificate: {},
      accessToken: "renewal-must-not-rotate-the-bearer",
    }).success).toBe(false);
  });
});
