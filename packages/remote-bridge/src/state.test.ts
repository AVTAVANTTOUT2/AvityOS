import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  RemoteBridgeStateStore,
  createRemotePairingSession,
  generateRemoteAccountIdentity,
  generateRemoteDeviceIdentity,
  issueRemoteDeviceCertificate,
  type RemoteConnectorPersistedState,
} from "./index.js";

const NOW = "2026-07-24T10:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("remote bridge durable local state", () => {
  it("persists public trust, one-time pairing, connector cursors and chained metadata-only audit", () => {
    const directory = mkdtempSync(join(tmpdir(), "avity-bridge-state-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "bridge.sqlite");
    const account = generateRemoteAccountIdentity();
    const host = generateRemoteDeviceIdentity();
    const remote = generateRemoteDeviceIdentity();
    const hostCertificate = issueRemoteDeviceCertificate({
      account,
      device: host,
      name: "Host",
      issuedAt: NOW,
    });
    const remoteCertificate = issueRemoteDeviceCertificate({
      account,
      device: remote,
      name: "Remote",
      issuedAt: NOW,
    });
    const pairing = createRemotePairingSession({
      account,
      hostIdentity: host,
      hostCertificate,
      now: NOW,
    });
    const connectorState: RemoteConnectorPersistedState = {
      relayCursor: 4,
      inboundSequences: [[remote.deviceId, 3]],
      outboundSequences: [[remote.deviceId, 2]],
      pending: null,
    };

    const first = new RemoteBridgeStateStore(databasePath);
    first.registerAccount(account.accountId, account.signingPublicKey, NOW);
    expect(() => first.registerDevice({
      ...remoteCertificate,
      name: "Forged remote",
    }, NOW)).toThrow(/signature/i);
    first.registerDevice(hostCertificate, NOW);
    first.registerDevice(remoteCertificate, NOW);
    first.savePairingSession(pairing.session, NOW);
    expect(first.consumePairingSession(
      pairing.session.sessionId,
      "2026-07-24T10:01:00.000Z",
    ).consumedAt).toBe("2026-07-24T10:01:00.000Z");
    expect(() => first.consumePairingSession(
      pairing.session.sessionId,
      "2026-07-24T10:02:00.000Z",
    )).toThrow(/consumed/i);
    first.saveConnectorState(host.deviceId, connectorState, NOW);
    const firstAudit = first.appendRemoteAction({
      accountId: account.accountId,
      localDeviceId: host.deviceId,
      remoteDeviceId: remote.deviceId,
      messageId: `rmsg_${"a".repeat(32)}`,
      contentType: "application/json",
      action: "project.list",
      outcome: "accepted",
      createdAt: NOW,
    });
    const secondAudit = first.appendRemoteAction({
      accountId: account.accountId,
      localDeviceId: host.deviceId,
      remoteDeviceId: remote.deviceId,
      messageId: `rmsg_${"b".repeat(32)}`,
      contentType: "application/json",
      action: "project.pause",
      outcome: "rejected",
      errorCode: "policy_denied",
      createdAt: "2026-07-24T10:02:00.000Z",
      plaintext: "must-never-persist",
    } as Parameters<RemoteBridgeStateStore["appendRemoteAction"]>[0] & { plaintext: string });
    expect(secondAudit.previousHash).toBe(firstAudit.entryHash);
    expect(first.appendRemoteAction({
      accountId: account.accountId,
      localDeviceId: host.deviceId,
      remoteDeviceId: remote.deviceId,
      messageId: `rmsg_${"b".repeat(32)}`,
      contentType: "application/json",
      action: "project.pause",
      outcome: "rejected",
      errorCode: "policy_denied",
      createdAt: "2026-07-24T10:02:00.000Z",
    }).id).toBe(secondAudit.id);
    expect(() => first.appendRemoteAction({
      accountId: account.accountId,
      localDeviceId: host.deviceId,
      remoteDeviceId: remote.deviceId,
      messageId: `rmsg_${"b".repeat(32)}`,
      contentType: "application/json",
      action: "conflicting-action",
      outcome: "failed",
      createdAt: "2026-07-24T10:03:00.000Z",
    })).toThrow(/idempotency conflict/i);
    expect(() => first.appendRemoteAction({
      accountId: account.accountId,
      localDeviceId: host.deviceId,
      remoteDeviceId: remote.deviceId,
      messageId: `rmsg_${"c".repeat(32)}`,
      contentType: "application/json",
      action: "plaintext must not become an audit action",
      outcome: "accepted",
      createdAt: NOW,
    })).toThrow(/audit action/i);
    expect(() => first.savePairingSession({
      ...pairing.session,
      consumedAt: "2026-07-24T10:04:00.000Z",
    }, NOW)).toThrow(/immutable/i);
    expect(first.verifyAuditChain()).toBe(true);
    first.close();

    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(databasePath);
    expect(bytes.includes(Buffer.from(pairing.bundle.pairingSecret))).toBe(false);
    expect(bytes.includes(Buffer.from(account.signingPrivateKey))).toBe(false);
    expect(bytes.includes(Buffer.from(host.signingPrivateKey))).toBe(false);
    expect(bytes.includes(Buffer.from("must-never-persist"))).toBe(false);

    const second = new RemoteBridgeStateStore(databasePath);
    expect(second.isDeviceActive(remote.deviceId)).toBe(true);
    expect(second.loadConnectorState(host.deviceId)).toEqual(connectorState);
    expect(second.revokeDevice(remote.deviceId, NOW)).toBe(true);
    expect(second.isDeviceActive(remote.deviceId)).toBe(false);
    second.registerDevice(remoteCertificate, NOW);
    expect(second.isDeviceActive(remote.deviceId)).toBe(false);
    expect(second.verifyAuditChain()).toBe(true);
    second.close();

    const tamper = new DatabaseSync(databasePath);
    tamper.prepare("UPDATE remote_action_audit SET action = ? WHERE id = ?")
      .run("tampered", secondAudit.id);
    tamper.close();
    const third = new RemoteBridgeStateStore(databasePath);
    expect(third.verifyAuditChain()).toBe(false);
    third.close();
  });
});
