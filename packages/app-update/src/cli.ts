#!/usr/bin/env node

import {
  chmodSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { MacOSUpdateManifest } from "@avityos/contracts";
import {
  assertMacOSSystemMeetsMinimum,
  createSignedMacOSUpdate,
  downloadVerifiedMacOSUpdate,
  macOSUpdatePublicKeyFingerprint,
  verifySignedMacOSUpdateManifest,
} from "./index.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function absolutePath(name: string): string {
  const value = requiredEnvironment(name);
  if (!isAbsolute(value) || value === "/") {
    throw new Error(`${name} must be an absolute non-root path`);
  }
  return value;
}

function positiveInteger(name: string): number {
  const value = requiredEnvironment(name);
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds the safe integer range`);
  }
  return parsed;
}

function privateKey(path: string): Buffer {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o077) !== 0) {
    throw new Error("update signing key must be a private regular file (mode 0600)");
  }
  return readFileSync(path);
}

function publicKey(path: string): Buffer {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o022) !== 0) {
    throw new Error("update public key must not be group/world writable");
  }
  return readFileSync(path);
}

function boundedArchive(path: string): Buffer {
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size < 1 ||
    stats.size > 512 * 1024 * 1024
  ) {
    throw new Error("update archive must be a 1-byte to 512-MiB regular file");
  }
  return readFileSync(path);
}

function writeExclusive(path: string, bytes: Uint8Array | string): void {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

async function createManifest(): Promise<void> {
  const archivePath = absolutePath("AVITY_UPDATE_ARCHIVE_PATH");
  const outputPath = absolutePath("AVITY_UPDATE_MANIFEST_PATH");
  const signingKeyPath = absolutePath("AVITY_UPDATE_SIGNING_KEY_PATH");
  const signingPublicKey = publicKey(
    absolutePath("AVITY_UPDATE_PUBLIC_KEY_PATH"),
  );
  const signed = createSignedMacOSUpdate({
    version: requiredEnvironment("AVITY_UPDATE_VERSION"),
    buildNumber: positiveInteger("AVITY_UPDATE_BUILD_NUMBER"),
    minimumSystemVersion: requiredEnvironment(
      "AVITY_UPDATE_MINIMUM_SYSTEM_VERSION",
    ),
    publishedAt: process.env.AVITY_UPDATE_PUBLISHED_AT ?? Date.now(),
    teamIdentifier: requiredEnvironment("AVITY_UPDATE_TEAM_ID"),
    archiveUrl: requiredEnvironment("AVITY_UPDATE_ARCHIVE_URL"),
    archiveBytes: boundedArchive(archivePath),
    releaseNotesUrl: requiredEnvironment("AVITY_UPDATE_RELEASE_NOTES_URL"),
    privateKey: privateKey(signingKeyPath),
  });
  verifySignedMacOSUpdateManifest(signed, signingPublicKey);
  writeExclusive(outputPath, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(JSON.stringify({
    version: signed.manifest.version,
    buildNumber: signed.manifest.buildNumber,
    archiveSha256: signed.manifest.archive.sha256,
    archiveSizeBytes: signed.manifest.archive.sizeBytes,
    publicKeyFingerprint: macOSUpdatePublicKeyFingerprint(signingPublicKey),
    manifestPath: outputPath,
  }));
}

async function downloadUpdate(): Promise<void> {
  const outputPath = absolutePath("AVITY_UPDATE_ARCHIVE_PATH");
  const manifestOutputPath = absolutePath(
    "AVITY_UPDATE_VERIFIED_MANIFEST_PATH",
  );
  if (outputPath === manifestOutputPath) {
    throw new Error("archive and verified-manifest outputs must be distinct");
  }
  const publicKeyPath = absolutePath("AVITY_UPDATE_PUBLIC_KEY_PATH");
  const result = await downloadVerifiedMacOSUpdate({
    manifestUrl: requiredEnvironment("AVITY_UPDATE_MANIFEST_URL"),
    publicKey: publicKey(publicKeyPath),
    installedVersion: requiredEnvironment("AVITY_UPDATE_INSTALLED_VERSION"),
    installedBuildNumber: positiveInteger(
      "AVITY_UPDATE_INSTALLED_BUILD_NUMBER",
    ),
  });
  writeExclusive(outputPath, result.archiveBytes);
  writeExclusive(
    manifestOutputPath,
    `${JSON.stringify(result.manifest, null, 2)}\n`,
  );
  console.log(JSON.stringify({
    version: result.manifest.version,
    buildNumber: result.manifest.buildNumber,
    teamIdentifier: result.manifest.teamIdentifier,
    archiveSha256: result.manifest.archive.sha256,
    publicKeyFingerprint: macOSUpdatePublicKeyFingerprint(
      publicKey(publicKeyPath),
    ),
  }));
}

function checkBundleMetadata(): void {
  const manifest = MacOSUpdateManifest.parse(JSON.parse(
    readFileSync(
      absolutePath("AVITY_UPDATE_VERIFIED_MANIFEST_PATH"),
      "utf8",
    ),
  ));
  const actual = {
    version: requiredEnvironment("AVITY_UPDATE_BUNDLE_VERSION"),
    buildNumber: positiveInteger("AVITY_UPDATE_BUNDLE_BUILD_NUMBER"),
    minimumSystemVersion: requiredEnvironment(
      "AVITY_UPDATE_BUNDLE_MINIMUM_SYSTEM_VERSION",
    ),
    teamIdentifier: requiredEnvironment("AVITY_UPDATE_BUNDLE_TEAM_ID"),
    systemVersion: requiredEnvironment("AVITY_UPDATE_SYSTEM_VERSION"),
  };
  assertMacOSSystemMeetsMinimum({
    systemVersion: actual.systemVersion,
    minimumSystemVersion: manifest.minimumSystemVersion,
  });
  if (
    actual.version !== manifest.version ||
    actual.buildNumber !== manifest.buildNumber ||
    actual.minimumSystemVersion !== manifest.minimumSystemVersion ||
    actual.teamIdentifier !== manifest.teamIdentifier
  ) {
    throw new Error("downloaded application metadata does not match the signed manifest");
  }
  console.log(JSON.stringify(actual));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "create") {
    await createManifest();
    return;
  }
  if (command === "download") {
    await downloadUpdate();
    return;
  }
  if (command === "check-bundle") {
    checkBundleMetadata();
    return;
  }
  throw new Error("usage: avity-macos-update <create|download|check-bundle>");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unexpected update error";
  console.error(`macOS update error: ${message.replace(/[\r\n]+/g, " ").slice(0, 500)}`);
  process.exitCode = 1;
});
