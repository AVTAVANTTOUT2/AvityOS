import { describe, expect, it } from "vitest";
import {
  MACOS_UPDATE_MANIFEST_SCHEMA_VERSION,
  MacOSUpdateManifest,
  MacOSUpdateVersion,
  SignedMacOSUpdateManifest,
} from "./macos-update.js";

const manifest = {
  schemaVersion: MACOS_UPDATE_MANIFEST_SCHEMA_VERSION,
  channel: "stable",
  version: "1.2.3",
  buildNumber: 42,
  minimumSystemVersion: "14.0",
  publishedAt: "2026-07-24T12:00:00.000Z",
  teamIdentifier: "ABCDE12345",
  archive: {
    url: "https://updates.example/AvityOS.zip",
    sha256: "a".repeat(64),
    sizeBytes: 42,
  },
  releaseNotesUrl: "https://updates.example/releases/1.2.3",
};

describe("macOS update contracts", () => {
  it("accepts a strict stable update manifest", () => {
    expect(MacOSUpdateManifest.parse(manifest)).toEqual(manifest);
    expect(MacOSUpdateVersion.parse("0.1.0")).toBe("0.1.0");
  });

  it("rejects insecure URLs, loose versions and unknown fields", () => {
    expect(MacOSUpdateManifest.safeParse({
      ...manifest,
      archive: { ...manifest.archive, url: "http://updates.example/app.zip" },
    }).success).toBe(false);
    expect(MacOSUpdateManifest.safeParse({
      ...manifest,
      releaseNotesUrl: "https://operator:secret@updates.example/notes",
    }).success).toBe(false);
    expect(MacOSUpdateManifest.safeParse({
      ...manifest,
      archive: {
        ...manifest.archive,
        url: "https://updates.example/app.zip#untrusted",
      },
    }).success).toBe(false);
    expect(MacOSUpdateManifest.safeParse({
      ...manifest,
      version: "1.2",
    }).success).toBe(false);
    expect(MacOSUpdateVersion.safeParse(
      `${"9".repeat(80)}.1.0`,
    ).success).toBe(false);
    expect(MacOSUpdateManifest.safeParse({
      ...manifest,
      rotateTrustAnchor: true,
    }).success).toBe(false);
  });

  it("requires a bounded detached Ed25519-shaped signature", () => {
    expect(SignedMacOSUpdateManifest.safeParse({
      manifest,
      signature: "short",
    }).success).toBe(false);
    expect(SignedMacOSUpdateManifest.parse({
      manifest,
      signature: "A".repeat(86),
    }).manifest.version).toBe("1.2.3");
  });
});
