import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Canonical path confinement (ADR-aligned with the sandbox primitive).
 *
 * Membership of a path inside a trusted root must be decided on *canonical*
 * paths, never on lexical string prefixes. Untrusted repositories, plans and
 * providers can otherwise escape a worktree with `..`, absolute paths, or
 * symlinked path components that resolve outside the root.
 */

export class ConfinementError extends Error {
  constructor(
    message: string,
    readonly code:
      | "empty"
      | "absolute_not_allowed"
      | "parent_segment"
      | "root_missing"
      | "escapes_root"
      | "symlink_final",
  ) {
    super(message);
    this.name = "ConfinementError";
  }
}

export interface ConfinementPolicy {
  /** Allow the candidate to be an absolute path. Default: false (relative only). */
  allowAbsolute?: boolean;
  /** Allow `..` segments in the candidate. Default: false. */
  allowParentSegments?: boolean;
  /** Require the resolved path to already exist. Default: false. */
  mustExist?: boolean;
  /**
   * Reject when the final path component is itself a symlink. Default: false.
   * Use for artifacts and other sensitive leaves that must be real files.
   */
  denySymlinkedFinal?: boolean;
}

export interface ConfinedPath {
  /** Canonical absolute path (symlinks in existing components resolved). */
  absolute: string;
  /** Canonical path relative to the (canonical) root, using `/`. */
  relative: string;
}

/**
 * Resolve the longest existing prefix of `abs` through `realpathSync` (which
 * collapses symlinks) and re-append the not-yet-created tail. This canonicalises
 * a path that may not fully exist while still resolving every symlink that does.
 */
function canonicalizeExisting(abs: string): string {
  let current = abs;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    tail.unshift(basename(current));
    current = parent;
  }
  const realBase = realpathSync(current);
  return tail.length ? resolve(realBase, ...tail) : realBase;
}

/** Split a path into segments, tolerating either separator. */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/**
 * True when `target` is the root itself or genuinely nested inside it, decided
 * on canonical paths. Rejects sibling paths that merely share a textual prefix
 * (e.g. `/root-evil` for root `/root`) because `path.relative` yields a `..`
 * segment for them.
 */
export function isInsideRoot(root: string, target: string): boolean {
  const canonicalRoot = canonicalizeExisting(resolve(root));
  const canonicalTarget = canonicalizeExisting(resolve(target));
  if (canonicalTarget === canonicalRoot) return true;
  const rel = relative(canonicalRoot, canonicalTarget);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Validate an input path and assert it resolves strictly inside `root`.
 *
 * Steps (fail-closed): validate form → reject absolute unless allowed → reject
 * `..` unless allowed → canonicalise root (must exist) → resolve candidate →
 * resolve symlinks in existing components → assert canonical membership →
 * optionally require existence and reject a symlinked final component.
 *
 * @throws {ConfinementError} on any violation.
 */
export function resolveAndAssertInside(
  root: string,
  candidate: string,
  policy: ConfinementPolicy = {},
): ConfinedPath {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new ConfinementError("empty or non-string path", "empty");
  }

  const candidateIsAbsolute = isAbsolute(candidate);
  if (candidateIsAbsolute && !policy.allowAbsolute) {
    throw new ConfinementError(`absolute path not allowed: ${candidate}`, "absolute_not_allowed");
  }
  if (!policy.allowParentSegments && segments(candidate).includes("..")) {
    throw new ConfinementError(`parent segment ".." not allowed: ${candidate}`, "parent_segment");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolve(root));
  } catch {
    throw new ConfinementError(`confinement root does not exist: ${root}`, "root_missing");
  }

  const absoluteCandidate = candidateIsAbsolute ? resolve(candidate) : resolve(canonicalRoot, candidate);
  const canonical = canonicalizeExisting(absoluteCandidate);

  const rel = canonical === canonicalRoot ? "" : relative(canonicalRoot, canonical);
  const inside = canonical === canonicalRoot || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) {
    throw new ConfinementError(`path escapes confinement root: ${candidate}`, "escapes_root");
  }

  if (policy.mustExist && !existsSync(absoluteCandidate)) {
    throw new ConfinementError(`path does not exist: ${candidate}`, "escapes_root");
  }

  if (policy.denySymlinkedFinal && existsSync(absoluteCandidate)) {
    if (lstatSync(absoluteCandidate).isSymbolicLink()) {
      throw new ConfinementError(`final path component is a symlink: ${candidate}`, "symlink_final");
    }
  }

  return { absolute: canonical, relative: rel.split(sep).join("/") };
}

/**
 * True when `target` is the root or nested under it, comparing already-canonical
 * absolute paths (no further symlink resolution).
 */
function isInsideCanonical(canonicalRoot: string, canonicalTarget: string): boolean {
  if (canonicalTarget === canonicalRoot) return true;
  const rel = relative(canonicalRoot, canonicalTarget);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Ensure a directory exists under `root` without ever creating, writing, or
 * following a path that escapes the repository.
 *
 * Sequence (fail-closed):
 * 1. Canonicalise and validate the confinement root.
 * 2. Walk each existing path component with `lstat` (no follow).
 * 3. Reject any symlink / redirect whose realpath leaves the root (including
 *    dangling symlinks).
 * 4. Create only missing components whose parent is already validated.
 * 5. Re-validate the final path after creation.
 *
 * This deliberately does **not** call `mkdirSync(..., { recursive: true })` on
 * the full path up front: that would materialise directories through an
 * outbound symlink before confinement can reject it.
 */
export function ensureConfinedDirectory(root: string, relativePath: string): ConfinedPath {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new ConfinementError("empty or non-string path", "empty");
  }
  if (isAbsolute(relativePath)) {
    throw new ConfinementError(`absolute path not allowed: ${relativePath}`, "absolute_not_allowed");
  }
  const parts = segments(relativePath);
  if (parts.includes("..")) {
    throw new ConfinementError(`parent segment ".." not allowed: ${relativePath}`, "parent_segment");
  }
  if (parts.length === 0) {
    throw new ConfinementError("empty or non-string path", "empty");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolve(root));
  } catch {
    throw new ConfinementError(`confinement root does not exist: ${root}`, "root_missing");
  }

  let current = canonicalRoot;
  for (const part of parts) {
    const next = join(current, part);
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(next);
    } catch {
      st = undefined;
    }

    if (st) {
      if (st.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(next);
        } catch {
          throw new ConfinementError(
            `symlink component is dangling or unresolvable: ${relativePath}`,
            "escapes_root",
          );
        }
        if (!isInsideCanonical(canonicalRoot, real)) {
          throw new ConfinementError(
            `symlink component escapes confinement root: ${relativePath}`,
            "escapes_root",
          );
        }
        let after: ReturnType<typeof lstatSync>;
        try {
          after = lstatSync(real);
        } catch {
          throw new ConfinementError(
            `symlink component target is missing: ${relativePath}`,
            "escapes_root",
          );
        }
        if (!after.isDirectory()) {
          throw new ConfinementError(
            `symlink component does not resolve to a directory: ${relativePath}`,
            "escapes_root",
          );
        }
        current = real;
        continue;
      }

      if (!st.isDirectory()) {
        throw new ConfinementError(
          `path component is not a directory: ${relativePath}`,
          "escapes_root",
        );
      }

      const real = realpathSync(next);
      if (!isInsideCanonical(canonicalRoot, real)) {
        throw new ConfinementError(
          `path escapes confinement root: ${relativePath}`,
          "escapes_root",
        );
      }
      current = real;
      continue;
    }

    // Missing component: parent `current` is already canonical and inside root.
    if (!isInsideCanonical(canonicalRoot, current)) {
      throw new ConfinementError(
        `parent escapes confinement root before create: ${relativePath}`,
        "escapes_root",
      );
    }
    mkdirSync(next, { recursive: false });
    const created = realpathSync(next);
    if (!isInsideCanonical(canonicalRoot, created)) {
      throw new ConfinementError(
        `created path escapes confinement root: ${relativePath}`,
        "escapes_root",
      );
    }
    current = created;
  }

  // Final membership check through the shared primitive. Outbound symlinks were
  // already rejected during the walk; an inbound symlink leaf is resolved to its
  // real path and must remain inside the root.
  return resolveAndAssertInside(root, relativePath, {
    mustExist: true,
  });
}
