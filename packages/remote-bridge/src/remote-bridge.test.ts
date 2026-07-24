import { describe, expect, it } from "vitest";
import {
  RemoteBridgeSecurityError,
  acceptRemotePairingRequest,
  assertFreshRemoteSequence,
  createRemotePairingRequest,
  createRemotePairingSession,
  generateRemoteAccountIdentity,
  generateRemoteDeviceIdentity,
  issueRemoteDeviceCertificate,
  openRemoteEnvelope,
  openRemotePairingAcceptance,
  sealRemoteEnvelope,
  verifyRemoteDeviceCertificate,
} from "./index.js";

const NOW = "2026-07-24T09:00:00.000Z";

function tamperBase64Url(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}

function setupDevices() {
  const account = generateRemoteAccountIdentity();
  const host = generateRemoteDeviceIdentity();
  const client = generateRemoteDeviceIdentity();
  const hostCertificate = issueRemoteDeviceCertificate({
    account,
    device: host,
    name: "Host Mac",
    issuedAt: NOW,
  });
  const clientCertificate = issueRemoteDeviceCertificate({
    account,
    device: client,
    name: "Client Mac",
    issuedAt: NOW,
  });
  return { account, host, client, hostCertificate, clientCertificate };
}

describe("remote account and device trust", () => {
  it("issues and verifies an account-signed device certificate", () => {
    const { account, hostCertificate } = setupDevices();
    expect(verifyRemoteDeviceCertificate(hostCertificate, account.signingPublicKey, NOW))
      .toEqual(hostCertificate);
  });

  it("rejects tampered and expired certificates", () => {
    const { account, hostCertificate } = setupDevices();
    expect(() => verifyRemoteDeviceCertificate(
      { ...hostCertificate, name: "Attacker" },
      account.signingPublicKey,
      NOW,
    )).toThrow(/signature/i);
    expect(() => verifyRemoteDeviceCertificate(
      hostCertificate,
      account.signingPublicKey,
      "2028-07-24T09:00:00.000Z",
    )).toThrow(/not currently valid/i);
    expect(() => verifyRemoteDeviceCertificate(
      hostCertificate,
      account.signingPublicKey,
      "not-a-date",
    )).toThrow(/verification timestamp/i);
  });

  it("rejects mismatched local private keys before publishing an artifact", () => {
    const first = setupDevices();
    const second = setupDevices();
    expect(() => issueRemoteDeviceCertificate({
      account: {
        ...first.account,
        signingPrivateKey: second.account.signingPrivateKey,
      },
      device: first.host,
      name: "Host",
      issuedAt: NOW,
    })).toThrow(/key pair/i);

    expect(() => sealRemoteEnvelope({
      plaintext: "payload",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: {
        ...first.client,
        signingPrivateKey: second.client.signingPrivateKey,
      },
      senderCertificate: first.clientCertificate,
      recipientCertificate: first.hostCertificate,
      accountSigningPublicKey: first.account.signingPublicKey,
      sentAt: NOW,
    })).toThrow(/key pair/i);
  });
});

describe("out-of-band pairing", () => {
  it("pairs a new device while keeping its identity payload opaque to a relay", () => {
    const { account, host, client, hostCertificate } = setupDevices();
    const created = createRemotePairingSession({
      account,
      hostIdentity: host,
      hostCertificate,
      now: NOW,
    });
    const request = createRemotePairingRequest({
      offer: created.bundle.offer,
      pairingSecret: created.bundle.pairingSecret,
      device: client,
      name: "Paired iPhone",
      now: NOW,
    });
    const serializedRequest = JSON.stringify(request);
    expect(serializedRequest).not.toContain("Paired iPhone");
    expect(serializedRequest).not.toContain(client.signingPublicKey);
    expect(serializedRequest).not.toContain(created.bundle.pairingSecret);

    const accepted = acceptRemotePairingRequest({
      session: created.session,
      request,
      pairingSecret: created.bundle.pairingSecret,
      account,
      now: NOW,
    });
    expect(accepted.session.consumedAt).toBe(NOW);
    const certificate = openRemotePairingAcceptance({
      offer: created.bundle.offer,
      acceptance: accepted.acceptance,
      pairingSecret: created.bundle.pairingSecret,
      device: client,
      now: NOW,
    });
    expect(certificate.deviceId).toBe(client.deviceId);
    expect(certificate.name).toBe("Paired iPhone");
    expect(JSON.stringify(accepted.acceptance)).not.toContain("Paired iPhone");
  });

  it("rejects a wrong secret, replayed session, tampering and expiry", () => {
    const { account, host, client, hostCertificate } = setupDevices();
    const created = createRemotePairingSession({
      account,
      hostIdentity: host,
      hostCertificate,
      now: NOW,
      ttlMs: 30_000,
    });
    const request = createRemotePairingRequest({
      offer: created.bundle.offer,
      pairingSecret: created.bundle.pairingSecret,
      device: client,
      name: "Client",
      now: NOW,
    });
    expect(() => acceptRemotePairingRequest({
      session: created.session,
      request,
      pairingSecret: Buffer.alloc(32, 7).toString("base64url"),
      account,
      now: NOW,
    })).toThrow(/secret/i);

    const tampered = {
      ...request,
      ciphertext: tamperBase64Url(request.ciphertext),
    };
    expect(() => acceptRemotePairingRequest({
      session: created.session,
      request: tampered,
      pairingSecret: created.bundle.pairingSecret,
      account,
      now: NOW,
    })).toThrow(/authentication/i);

    const accepted = acceptRemotePairingRequest({
      session: created.session,
      request,
      pairingSecret: created.bundle.pairingSecret,
      account,
      now: NOW,
    });
    expect(() => acceptRemotePairingRequest({
      session: accepted.session,
      request,
      pairingSecret: created.bundle.pairingSecret,
      account,
      now: NOW,
    })).toThrow(/consumed/i);
    expect(() => createRemotePairingRequest({
      offer: created.bundle.offer,
      pairingSecret: created.bundle.pairingSecret,
      device: client,
      name: "Client",
      now: "2026-07-24T09:01:00.000Z",
    })).toThrow(/expired/i);
  });

  it("binds the relay-visible offer to the signed host account and session window", () => {
    const { account, host, client, hostCertificate } = setupDevices();
    const created = createRemotePairingSession({
      account,
      hostIdentity: host,
      hostCertificate,
      now: "2026-07-24T09:10:00.000Z",
    });
    const otherAccount = generateRemoteAccountIdentity();
    expect(() => createRemotePairingRequest({
      offer: { ...created.bundle.offer, accountId: otherAccount.accountId },
      pairingSecret: created.bundle.pairingSecret,
      device: client,
      name: "Client",
      now: "2026-07-24T09:10:00.000Z",
    })).toThrow(/account/i);

    const earlyRequest = createRemotePairingRequest({
      offer: created.bundle.offer,
      pairingSecret: created.bundle.pairingSecret,
      device: client,
      name: "Client",
      now: NOW,
    });
    expect(() => acceptRemotePairingRequest({
      session: created.session,
      request: earlyRequest,
      pairingSecret: created.bundle.pairingSecret,
      account,
      now: "2026-07-24T09:11:00.000Z",
    })).toThrow(/session window/i);
  });
});

describe("end-to-end encrypted envelopes", () => {
  it("round-trips ciphertext without exposing plaintext to the relay", () => {
    const { account, host, client, hostCertificate, clientCertificate } = setupDevices();
    const plaintext = JSON.stringify({ action: "project.list", token: "never-relay-clear" });
    const envelope = sealRemoteEnvelope({
      plaintext,
      contentType: "application/json",
      sequence: 1,
      senderIdentity: client,
      senderCertificate: clientCertificate,
      recipientCertificate: hostCertificate,
      accountSigningPublicKey: account.signingPublicKey,
      sentAt: NOW,
    });
    expect(JSON.stringify(envelope)).not.toContain("project.list");
    expect(JSON.stringify(envelope)).not.toContain("never-relay-clear");
    const opened = openRemoteEnvelope({
      envelope,
      recipientIdentity: host,
      recipientCertificate: hostCertificate,
      senderCertificate: clientCertificate,
      accountSigningPublicKey: account.signingPublicKey,
      lastAcceptedSequence: 0,
      now: NOW,
    });
    expect(opened.plaintext.toString("utf8")).toBe(plaintext);
    expect(opened.sequence).toBe(1);
  });

  it("rejects tampering, a wrong recipient and replayed sequences", () => {
    const { account, host, client, hostCertificate, clientCertificate } = setupDevices();
    const envelope = sealRemoteEnvelope({
      plaintext: "sensitive",
      contentType: "text/plain",
      sequence: 9,
      senderIdentity: client,
      senderCertificate: clientCertificate,
      recipientCertificate: hostCertificate,
      accountSigningPublicKey: account.signingPublicKey,
      sentAt: NOW,
    });
    const tampered = {
      ...envelope,
      ciphertext: tamperBase64Url(envelope.ciphertext),
    };
    expect(() => openRemoteEnvelope({
      envelope: tampered,
      recipientIdentity: host,
      recipientCertificate: hostCertificate,
      senderCertificate: clientCertificate,
      accountSigningPublicKey: account.signingPublicKey,
      lastAcceptedSequence: 0,
      now: NOW,
    })).toThrow(/signature/i);

    const stranger = generateRemoteDeviceIdentity();
    const strangerCertificate = issueRemoteDeviceCertificate({
      account,
      device: stranger,
      name: "Stranger",
      issuedAt: NOW,
    });
    expect(() => openRemoteEnvelope({
      envelope,
      recipientIdentity: stranger,
      recipientCertificate: strangerCertificate,
      senderCertificate: clientCertificate,
      accountSigningPublicKey: account.signingPublicKey,
      lastAcceptedSequence: 0,
      now: NOW,
    })).toThrow(/routing/i);
    expect(() => assertFreshRemoteSequence(9, 9)).toThrow(/replay/i);
    expect(() => openRemoteEnvelope({
      envelope,
      recipientIdentity: host,
      recipientCertificate: hostCertificate,
      senderCertificate: clientCertificate,
      accountSigningPublicKey: account.signingPublicKey,
      lastAcceptedSequence: 9,
      now: NOW,
    })).toThrow(/replay/i);
    expect(() => openRemoteEnvelope({
      envelope,
      recipientIdentity: host,
      recipientCertificate: hostCertificate,
      senderCertificate: clientCertificate,
      accountSigningPublicKey: account.signingPublicKey,
      lastAcceptedSequence: 0,
      now: "not-a-date",
    })).toThrow(/verification timestamp/i);
    expect(() => openRemoteEnvelope({
      envelope,
      recipientIdentity: host,
      recipientCertificate: hostCertificate,
      senderCertificate: clientCertificate,
      accountSigningPublicKey: account.signingPublicKey,
      lastAcceptedSequence: 0,
      now: NOW,
      maxClockSkewMs: Number.POSITIVE_INFINITY,
    })).toThrow(/clock skew/i);
  });

  it("never includes private key material in public certificates or envelopes", () => {
    const { account, host, client, hostCertificate, clientCertificate } = setupDevices();
    const envelope = sealRemoteEnvelope({
      plaintext: "payload",
      contentType: "text/plain",
      sequence: 1,
      senderIdentity: client,
      senderCertificate: clientCertificate,
      recipientCertificate: hostCertificate,
      accountSigningPublicKey: account.signingPublicKey,
      sentAt: NOW,
    });
    const publicMaterial = JSON.stringify({ hostCertificate, clientCertificate, envelope });
    expect(publicMaterial).not.toContain(account.signingPrivateKey);
    expect(publicMaterial).not.toContain(host.signingPrivateKey);
    expect(publicMaterial).not.toContain(host.agreementPrivateKey);
    expect(publicMaterial).not.toContain(client.signingPrivateKey);
    expect(publicMaterial).not.toContain(client.agreementPrivateKey);
  });
});

describe("failure type", () => {
  it("uses a stable security error for policy failures", () => {
    expect(() => assertFreshRemoteSequence(1, 1)).toThrow(RemoteBridgeSecurityError);
  });
});
