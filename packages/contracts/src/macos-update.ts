import { z } from "zod";
import { Timestamp } from "./entities.js";

export const MACOS_UPDATE_MANIFEST_SCHEMA_VERSION = 1 as const;

const HttpsUrl = z.string().url().max(2_048).refine((value) => {
  if (!value.startsWith("https://") || value.includes("#")) return false;
  const authority = value.slice("https://".length).split(/[/?]/, 1)[0];
  return authority !== undefined && authority.length > 0 && !authority.includes("@");
}, "must use HTTPS without credentials or a fragment");

export const MacOSUpdateVersion = z.string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .refine(
    (value) => value.split(".").every(
      (component) => Number.isSafeInteger(Number(component)),
    ),
    "version components must be safe integers",
  );
export type MacOSUpdateVersion = z.infer<typeof MacOSUpdateVersion>;

export const MacOSUpdateManifest = z.object({
  schemaVersion: z.literal(MACOS_UPDATE_MANIFEST_SCHEMA_VERSION),
  channel: z.literal("stable"),
  version: MacOSUpdateVersion,
  buildNumber: z.number().int().positive().safe(),
  minimumSystemVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  publishedAt: Timestamp,
  teamIdentifier: z.string().regex(/^[A-Z0-9]{10}$/),
  archive: z.object({
    url: HttpsUrl,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().positive().max(512 * 1024 * 1024).safe(),
  }).strict(),
  releaseNotesUrl: HttpsUrl,
}).strict();
export type MacOSUpdateManifest = z.infer<typeof MacOSUpdateManifest>;

export const SignedMacOSUpdateManifest = z.object({
  manifest: MacOSUpdateManifest,
  signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export type SignedMacOSUpdateManifest = z.infer<
  typeof SignedMacOSUpdateManifest
>;
