import { posix } from "node:path";

const LEGACY_STATUS_PREFIX = /^(?:created|modified|updated)\s*:?\s+(.+)$/i;
const GLOB_META = /[*?[\]{}]/;

/**
 * Compatibility for plans persisted before expectedArtifacts was constrained
 * to exact paths. Confinement and mission path policy still run afterwards.
 */
export function normalizeLegacyExpectedArtifactReference(
  reference: string,
): string {
  const trimmed = reference.trim();
  const match = LEGACY_STATUS_PREFIX.exec(trimmed);
  let candidate = match?.[1]?.trim() ?? trimmed;
  if (
    candidate.length >= 2 &&
    candidate.startsWith("`") &&
    candidate.endsWith("`")
  ) {
    candidate = candidate.slice(1, -1).trim();
  }
  return candidate;
}

/**
 * Planned expected artifacts are exact, portable repository-relative paths:
 * no prose/status label, glob, absolute path, parent traversal or redundant
 * path segment. Returns an actionable repair issue, or null when canonical.
 */
export function expectedArtifactPathIssue(reference: string): string | null {
  if (reference !== reference.trim()) {
    return "must not contain surrounding whitespace";
  }
  if (normalizeLegacyExpectedArtifactReference(reference) !== reference) {
    return "must be an exact repository-relative path without a status label or backticks";
  }
  if (
    reference.length === 0 ||
    reference.startsWith("/") ||
    reference.includes("\\")
  ) {
    return "must be a portable repository-relative path";
  }
  if (GLOB_META.test(reference)) {
    return "must be an exact file path, not a glob";
  }
  const segments = reference.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "must not contain empty, current-directory or parent-directory segments";
  }
  if (posix.normalize(reference) !== reference) {
    return "must be a normalized repository-relative path";
  }
  return null;
}
