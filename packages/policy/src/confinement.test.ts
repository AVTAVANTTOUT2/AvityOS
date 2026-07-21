import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfinementError,
  ensureConfinedDirectory,
  isInsideRoot,
  resolveAndAssertInside,
} from "./confinement.js";

let scratch: string;
let root: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "avity-confine-"));
  root = join(scratch, "worktree");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("resolveAndAssertInside", () => {
  it("accepts a normal relative path", () => {
    const confined = resolveAndAssertInside(root, "src/a.ts", { mustExist: true });
    expect(confined.relative).toBe("src/a.ts");
  });

  it("accepts a normal nested subdirectory path that does not yet exist", () => {
    const confined = resolveAndAssertInside(root, "src/nested/new-file.ts");
    expect(confined.relative).toBe("src/nested/new-file.ts");
  });

  it("rejects a single ../ escape", () => {
    expect(() => resolveAndAssertInside(root, "../outside.ts")).toThrow(ConfinementError);
    expect(() => resolveAndAssertInside(root, "../outside.ts")).toThrow(/parent segment/);
  });

  it("rejects a ../../ escape", () => {
    expect(() => resolveAndAssertInside(root, "../../secret")).toThrow(ConfinementError);
  });

  it("rejects an absolute path by default", () => {
    expect(() => resolveAndAssertInside(root, join(scratch, "elsewhere"))).toThrow(/absolute path not allowed/);
  });

  it("rejects an internal symlink that points outside the root", () => {
    const secret = join(scratch, "secret.txt");
    writeFileSync(secret, "top secret\n");
    symlinkSync(secret, join(root, "leak"));
    expect(() => resolveAndAssertInside(root, "leak", { mustExist: true })).toThrow(/escapes/);
  });

  it("rejects a final artifact that is itself a symlink (even pointing inside)", () => {
    const realTarget = join(root, "src", "a.ts");
    symlinkSync(realTarget, join(root, "artifact-link"));
    expect(() =>
      resolveAndAssertInside(root, "artifact-link", { mustExist: true, denySymlinkedFinal: true }),
    ).toThrow(/symlink/);
  });

  it("rejects a path traversing a symlinked directory component that escapes", () => {
    const outsideDir = join(scratch, "outside-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "f.txt"), "x\n");
    symlinkSync(outsideDir, join(root, "linkdir"));
    expect(() => resolveAndAssertInside(root, "linkdir/f.txt", { mustExist: true })).toThrow(/escapes/);
  });

  it("rejects a sibling that only shares the same textual prefix", () => {
    const sibling = `${root}-evil`;
    mkdirSync(sibling, { recursive: true });
    expect(isInsideRoot(root, join(sibling, "file"))).toBe(false);
  });

  it("rejects a non-existent path whose parent escapes the root", () => {
    expect(() => resolveAndAssertInside(root, "../ghost/new.ts")).toThrow(ConfinementError);
  });

  it("rejects an empty candidate", () => {
    expect(() => resolveAndAssertInside(root, "   ")).toThrow(/empty/);
  });

  it("throws root_missing when the confinement root does not exist", () => {
    expect(() => resolveAndAssertInside(join(scratch, "nope"), "a.ts")).toThrow(/root does not exist/);
  });

  it("can allow absolute paths inside the root when the policy opts in", () => {
    const abs = join(root, "src", "a.ts");
    const confined = resolveAndAssertInside(root, abs, { allowAbsolute: true, mustExist: true });
    expect(confined.relative).toBe("src/a.ts");
  });
});

describe("isInsideRoot", () => {
  it("treats the root itself as inside", () => {
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it("accepts a genuine descendant", () => {
    expect(isInsideRoot(root, join(root, "src", "a.ts"))).toBe(true);
  });

  it("rejects a parent directory", () => {
    expect(isInsideRoot(root, scratch)).toBe(false);
  });
});

describe("ensureConfinedDirectory — no exterior side effects before validation", () => {
  function exteriorEntries(outside: string): string[] {
    if (!existsSync(outside)) return [];
    return readdirSync(outside);
  }

  it("creates .avity/worktrees inside the repo when nothing exists yet", () => {
    const confined = ensureConfinedDirectory(root, join(".avity", "worktrees"));
    expect(confined.relative).toBe(".avity/worktrees");
    expect(existsSync(join(root, ".avity", "worktrees"))).toBe(true);
    expect(lstatSync(join(root, ".avity", "worktrees")).isDirectory()).toBe(true);
  });

  it("rejects when .avity is a symlink to an existing exterior directory — and creates nothing outside", () => {
    const outside = join(scratch, "outside-avity");
    mkdirSync(outside, { recursive: true });
    const before = exteriorEntries(outside);
    symlinkSync(outside, join(root, ".avity"));

    expect(() => ensureConfinedDirectory(root, join(".avity", "worktrees"))).toThrow(ConfinementError);
    expect(() => ensureConfinedDirectory(root, join(".avity", "worktrees"))).toThrow(/escapes|symlink/);

    expect(exteriorEntries(outside)).toEqual(before);
    expect(existsSync(join(outside, "worktrees"))).toBe(false);
  });

  it("rejects when .avity is a symlink to a not-yet-existing exterior path — and creates nothing outside", () => {
    const outside = join(scratch, "missing-outside-avity");
    expect(existsSync(outside)).toBe(false);
    symlinkSync(outside, join(root, ".avity"));

    expect(() => ensureConfinedDirectory(root, join(".avity", "worktrees"))).toThrow(ConfinementError);

    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(outside, "worktrees"))).toBe(false);
  });

  it("rejects when .avity/worktrees is a symlink to an exterior directory — and creates nothing outside", () => {
    const outside = join(scratch, "outside-worktrees");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(root, ".avity"), { recursive: true });
    const before = exteriorEntries(outside);
    symlinkSync(outside, join(root, ".avity", "worktrees"));

    expect(() => ensureConfinedDirectory(root, join(".avity", "worktrees"))).toThrow(ConfinementError);

    expect(exteriorEntries(outside)).toEqual(before);
    expect(existsSync(join(outside, "mission-id"))).toBe(false);
  });

  it("rejects when .avity/worktrees is a symlink to a missing exterior path — and creates nothing outside", () => {
    const outside = join(scratch, "missing-outside-worktrees");
    mkdirSync(join(root, ".avity"), { recursive: true });
    expect(existsSync(outside)).toBe(false);
    symlinkSync(outside, join(root, ".avity", "worktrees"));

    expect(() => ensureConfinedDirectory(root, join(".avity", "worktrees"))).toThrow(ConfinementError);

    expect(existsSync(outside)).toBe(false);
  });

  it("rejects an intermediate symlink component that escapes — exterior target untouched", () => {
    const outside = join(scratch, "outside-mid");
    mkdirSync(outside, { recursive: true });
    // .avity exists as a real dir; plant a symlink as a nested component path
    // simulating `.avity/link/worktrees` where link escapes.
    mkdirSync(join(root, ".avity"), { recursive: true });
    symlinkSync(outside, join(root, ".avity", "link"));
    const before = exteriorEntries(outside);

    expect(() => ensureConfinedDirectory(root, join(".avity", "link", "worktrees"))).toThrow(
      ConfinementError,
    );

    expect(exteriorEntries(outside)).toEqual(before);
    expect(existsSync(join(outside, "worktrees"))).toBe(false);
  });

  it("rejects when the exterior target exists but does not yet contain worktrees", () => {
    const outside = join(scratch, "outside-empty");
    mkdirSync(outside, { recursive: true });
    // Ensure worktrees is absent
    expect(existsSync(join(outside, "worktrees"))).toBe(false);
    symlinkSync(outside, join(root, ".avity"));

    expect(() => ensureConfinedDirectory(root, join(".avity", "worktrees"))).toThrow(ConfinementError);

    expect(existsSync(join(outside, "worktrees"))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("does not chmod or alter an exterior directory on rejection", () => {
    const outside = join(scratch, "outside-mode");
    mkdirSync(outside, { recursive: true });
    chmodSync(outside, 0o700);
    const modeBefore = lstatSync(outside).mode;
    symlinkSync(outside, join(root, ".avity"));

    expect(() => ensureConfinedDirectory(root, join(".avity", "worktrees"))).toThrow(ConfinementError);

    expect(lstatSync(outside).mode).toBe(modeBefore);
    expect(readdirSync(outside)).toEqual([]);
  });
});
