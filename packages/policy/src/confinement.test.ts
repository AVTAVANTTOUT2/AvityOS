import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfinementError, isInsideRoot, resolveAndAssertInside } from "./confinement.js";

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
