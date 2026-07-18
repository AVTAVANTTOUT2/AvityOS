import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointKind, EvidenceRef, Project, RepoSnapshot } from "@avityos/contracts";
import { RepoSnapshot as RepoSnapshotSchema } from "@avityos/contracts";
import { git } from "@avityos/git";
import { redactSecrets } from "@avityos/policy";

/**
 * Bounded, secret-free repository snapshot for the AI brain. It is built
 * exclusively from the server-validated `project.repoPath` (never from
 * model- or client-supplied paths), reads only Git-tracked files whose
 * realpath stays inside the repository, excludes secret-shaped and binary
 * files, redacts every captured text and enforces hard size/count limits
 * before anything reaches a prompt, an event or persistence.
 */
export const SNAPSHOT_LIMITS = {
  maxTreeFiles: 2000,
  maxDocuments: 12,
  maxManifests: 12,
  maxDocumentBytes: 16_384,
  maxManifestBytes: 8_192,
} as const;

const SECRET_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?(\/|$)/i,
  /\.(pem|key|p12|pfx|keystore|jks|der|crt)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /credential/i,
  /\.(sqlite|db|kdbx)$/i,
];

const DOCUMENT_CANDIDATES = [
  "README.md",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/ARCHITECTURE.md",
  "docs/PRODUCT.md",
  "docs/ROADMAP.md",
] as const;

const MANIFEST_CANDIDATES = [
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "Package.swift",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "Makefile",
  "Dockerfile",
] as const;

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  swift: "Swift",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cs: "C#",
  php: "PHP",
  sql: "SQL",
  sh: "Shell",
  css: "CSS",
  html: "HTML",
};

export function isSecretLikePath(path: string): boolean {
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function isProbablyBinary(content: Buffer): boolean {
  return content.subarray(0, 4096).includes(0);
}

/**
 * Read one Git-tracked repository file, bounded and redacted. Returns null
 * for secret-shaped paths, binary content, missing files and any path whose
 * realpath escapes the repository root (symlinks included).
 */
function readBoundedFile(
  repoRoot: string,
  relPath: string,
  maxBytes: number,
): { path: string; content: string; truncated: boolean } | null {
  if (isSecretLikePath(relPath)) return null;
  const target = join(repoRoot, relPath);
  if (!existsSync(target)) return null;
  let resolved: string;
  try {
    resolved = realpathSync(target);
  } catch {
    return null;
  }
  if (resolved !== repoRoot && !resolved.startsWith(`${repoRoot}/`)) return null;
  let raw: Buffer;
  try {
    raw = readFileSync(resolved);
  } catch {
    return null;
  }
  if (isProbablyBinary(raw)) return null;
  const truncated = raw.byteLength > maxBytes;
  const content = redactSecrets(raw.subarray(0, maxBytes).toString("utf8"));
  return { path: relPath, content, truncated };
}

/**
 * Deterministically detect the checks that really exist in a repository —
 * never invent a passing command. Used both for planning context and for the
 * validation of AI-proposed mission check commands.
 */
export function detectRepositoryChecks(
  repoPath: string,
  trackedPaths: ReadonlySet<string>,
): {
  requiredChecks: CheckpointKind[];
  checkCommands: Record<string, string[]>;
} {
  const repoRoot = realpathSync(repoPath);
  const requiredChecks: CheckpointKind[] = ["architecture_rule"];
  const checkCommands: Record<string, string[]> = {
    architecture_rule: ["git", "diff", "--check", "HEAD"],
  };
  const packageManifest = trackedPaths.has("package.json")
    ? readBoundedFile(repoRoot, "package.json", SNAPSHOT_LIMITS.maxManifestBytes)
    : null;
  if (packageManifest && !packageManifest.truncated) {
    try {
      const pkg = JSON.parse(packageManifest.content) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const pnpmLock = trackedPaths.has("pnpm-lock.yaml")
        ? readBoundedFile(repoRoot, "pnpm-lock.yaml", 1)
        : null;
      const runner = pnpmLock ? "pnpm" : "npm";
      for (const kind of ["lint", "typecheck", "test", "build"] as const) {
        if (!scripts[kind]) continue;
        requiredChecks.push(kind);
        checkCommands[kind] = [runner, "run", kind];
      }
    } catch {
      // Malformed project metadata is surfaced by the architecture check and
      // the coding agent; never invent a passing package command.
    }
  } else if (
    trackedPaths.has("Package.swift") &&
    readBoundedFile(repoRoot, "Package.swift", SNAPSHOT_LIMITS.maxManifestBytes)
  ) {
    requiredChecks.push("build", "test");
    checkCommands.build = ["swift", "build"];
    checkCommands.test = ["swift", "test"];
  }
  return { requiredChecks, checkCommands };
}

/** Build the bounded snapshot; null for greenfield projects without a repo. */
export async function buildRepoSnapshot(project: Project): Promise<RepoSnapshot | null> {
  if (!project.repoPath) return null;
  const repoRoot = realpathSync(project.repoPath);

  const branch = (await git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  const commit = (await git(repoRoot, "rev-parse", "HEAD")).trim();
  const workingTreeClean = (await git(repoRoot, "status", "--porcelain")).trim().length === 0;
  const tracked = (await git(repoRoot, "ls-files"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const visibleTracked = tracked.filter((path) => !isSecretLikePath(path));
  const fileTree = visibleTracked.slice(0, SNAPSHOT_LIMITS.maxTreeFiles);
  const truncatedFileCount = Math.max(0, visibleTracked.length - fileTree.length);
  const trackedSet = new Set(tracked);

  const documents = DOCUMENT_CANDIDATES.filter((path) => trackedSet.has(path))
    .slice(0, SNAPSHOT_LIMITS.maxDocuments)
    .map((path) => readBoundedFile(repoRoot, path, SNAPSHOT_LIMITS.maxDocumentBytes))
    .filter((doc): doc is NonNullable<typeof doc> => doc !== null);
  const manifests = MANIFEST_CANDIDATES.filter((path) => trackedSet.has(path))
    .slice(0, SNAPSHOT_LIMITS.maxManifests)
    .map((path) => readBoundedFile(repoRoot, path, SNAPSHOT_LIMITS.maxManifestBytes))
    .filter((doc): doc is NonNullable<typeof doc> => doc !== null);

  let scripts: Record<string, string> = {};
  const packageManifest = manifests.find((manifest) => manifest.path === "package.json");
  if (packageManifest && !packageManifest.truncated) {
    try {
      const parsed = JSON.parse(packageManifest.content) as { scripts?: Record<string, string> };
      scripts = parsed.scripts ?? {};
    } catch {
      scripts = {};
    }
  }

  const languageCounts = new Map<string, number>();
  for (const path of visibleTracked) {
    const extension = path.split(".").pop() ?? "";
    const language = LANGUAGE_BY_EXTENSION[extension.toLowerCase()];
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const languages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([language]) => language);

  const availableChecks = detectRepositoryChecks(repoRoot, trackedSet);

  const evidence: EvidenceRef[] = [
    { kind: "git" as const, ref: `commit:${commit}`, detail: `branch ${branch}` },
    ...documents.map((doc) => ({ kind: "doc" as const, ref: `file:${doc.path}@${commit}`, detail: "" })),
    ...manifests.map((manifest) => ({ kind: "manifest" as const, ref: `file:${manifest.path}@${commit}`, detail: "" })),
    ...Object.keys(availableChecks.checkCommands).map((kind) => ({
      kind: "check" as const,
      ref: `check:${kind}`,
      detail: (availableChecks.checkCommands[kind] ?? []).join(" "),
    })),
  ].slice(0, 100);

  const body = {
    schemaVersion: 1 as const,
    branch,
    commit,
    workingTreeClean,
    fileTree,
    truncatedFileCount,
    documents,
    manifests,
    scripts,
    languages,
    availableChecks,
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return RepoSnapshotSchema.parse({ ...body, hash, evidence });
}
