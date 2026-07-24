import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MacOSUpdateError,
  assertMacOSSystemMeetsMinimum,
  assertMacOSUpdateIsUpgrade,
  createSignedMacOSUpdate,
  downloadVerifiedMacOSUpdate,
  macOSUpdatePublicKeyFingerprint,
  verifySignedMacOSUpdateManifest,
} from "./index.js";

const keypair = generateKeyPairSync("ed25519");
const otherKeypair = generateKeyPairSync("ed25519");
const archive = Buffer.from("synthetic-not-a-real-zip");

function signedUpdate() {
  return createSignedMacOSUpdate({
    version: "1.2.0",
    buildNumber: 12,
    minimumSystemVersion: "14.0",
    publishedAt: "2026-07-24T12:00:00.000Z",
    teamIdentifier: "ABCDE12345",
    archiveUrl: "https://updates.example/AvityOS.zip",
    archiveBytes: archive,
    releaseNotesUrl: "https://updates.example/releases/1.2.0",
    privateKey: keypair.privateKey,
  });
}

describe("signed macOS application updates", () => {
  it("signs and verifies a canonical strict manifest", () => {
    const signed = signedUpdate();
    expect(
      verifySignedMacOSUpdateManifest(signed, keypair.publicKey),
    ).toMatchObject({
      version: "1.2.0",
      buildNumber: 12,
      teamIdentifier: "ABCDE12345",
    });
    expect(macOSUpdatePublicKeyFingerprint(keypair.publicKey)).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("rejects tampering and the wrong trust anchor", () => {
    const signed = signedUpdate();
    expect(() => verifySignedMacOSUpdateManifest({
      ...signed,
      manifest: { ...signed.manifest, buildNumber: 13 },
    }, keypair.publicKey)).toThrow(MacOSUpdateError);
    expect(() => verifySignedMacOSUpdateManifest(
      signed,
      otherKeypair.publicKey,
    )).toThrow(/signature is invalid/i);
  });

  it("allows only a non-decreasing semantic version and increasing build", () => {
    const manifest = signedUpdate().manifest;
    expect(() => assertMacOSUpdateIsUpgrade({
      installedVersion: "1.1.9",
      installedBuildNumber: 11,
      manifest,
    })).not.toThrow();
    expect(() => assertMacOSUpdateIsUpgrade({
      installedVersion: "1.2.0",
      installedBuildNumber: 12,
      manifest,
    })).toThrow(/non-increasing/i);
    expect(() => assertMacOSUpdateIsUpgrade({
      installedVersion: "2.0.0",
      installedBuildNumber: 11,
      manifest,
    })).toThrow(/non-increasing/i);
    expect(() => assertMacOSSystemMeetsMinimum({
      systemVersion: "14.6.1",
      minimumSystemVersion: "14.0",
    })).not.toThrow();
    expect(() => assertMacOSSystemMeetsMinimum({
      systemVersion: "13.7.4",
      minimumSystemVersion: "14.0",
    })).toThrow(/requires macOS 14.0/i);
  });

  it("downloads only a signature-, size- and checksum-valid upgrade", async () => {
    const signed = signedUpdate();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(signed), {
        status: 200,
        headers: { "content-length": String(JSON.stringify(signed).length) },
      }))
      .mockResolvedValueOnce(new Response(archive, {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      }));
    const result = await downloadVerifiedMacOSUpdate({
      manifestUrl: "https://updates.example/stable.json",
      publicKey: keypair.publicKey,
      installedVersion: "1.1.0",
      installedBuildNumber: 11,
      fetchImpl,
    });
    expect(result.manifest.version).toBe("1.2.0");
    expect(result.archiveBytes).toEqual(archive);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://updates.example/stable.json",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("rejects cleartext feeds, oversized manifests and archive tampering", async () => {
    await expect(downloadVerifiedMacOSUpdate({
      manifestUrl: "http://updates.example/stable.json",
      publicKey: keypair.publicKey,
      installedVersion: "1.1.0",
      installedBuildNumber: 11,
      fetchImpl: vi.fn(),
    })).rejects.toMatchObject({ code: "invalid_input" });

    await expect(downloadVerifiedMacOSUpdate({
      manifestUrl: "https://updates.example/stable.json",
      publicKey: keypair.publicKey,
      installedVersion: "1.1.0",
      installedBuildNumber: 11,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
        status: 200,
        headers: { "content-length": String(65 * 1024) },
      })),
    })).rejects.toMatchObject({ code: "size_mismatch" });

    const signed = signedUpdate();
    const tamperedFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(signed)))
      .mockResolvedValueOnce(new Response("tampered"));
    await expect(downloadVerifiedMacOSUpdate({
      manifestUrl: "https://updates.example/stable.json",
      publicKey: keypair.publicKey,
      installedVersion: "1.1.0",
      installedBuildNumber: 11,
      fetchImpl: tamperedFetch,
    })).rejects.toMatchObject({ code: "size_mismatch" });

    const sameSizeTamperedFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(signed)))
      .mockResolvedValueOnce(new Response(Buffer.alloc(archive.byteLength, 0x78)));
    await expect(downloadVerifiedMacOSUpdate({
      manifestUrl: "https://updates.example/stable.json",
      publicKey: keypair.publicKey,
      installedVersion: "1.1.0",
      installedBuildNumber: 11,
      fetchImpl: sameSizeTamperedFetch,
    })).rejects.toMatchObject({ code: "checksum_mismatch" });
  });
});
