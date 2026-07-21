import { describe, expect, it } from "vitest";
import type { Policy } from "@avityos/contracts";
import {
  checkBudget,
  containsSecret,
  evaluate,
  globMatch,
  isCommandAllowed,
  isPathAllowed,
  redactSecrets,
  REDACTED,
} from "./index.js";

const policy: Policy = {
  id: "pol1",
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  projectId: "p1",
  name: "project-policy",
  rules: [
    { id: "r1", description: "allow git ops", action: "git.*", resource: "**", effect: "allow" },
    { id: "r2", description: "deny prod deploys", action: "deploy.production", resource: "**", effect: "deny" },
    { id: "r3", description: "npm publish needs approval", action: "publish.npm", resource: "**", effect: "require_approval" },
  ],
};

describe("policy engine", () => {
  it("matches globs", () => {
    expect(globMatch("git.*", "git.commit")).toBe(true);
    expect(globMatch("git.*", "git.push.force")).toBe(false);
    expect(globMatch("git.**", "git.push.force")).toBe(true);
    expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/a/b.ts")).toBe(false);
  });

  it("first matching rule wins", () => {
    expect(evaluate([policy], "git.commit", "repo", "maximum_autonomy").effect).toBe("allow");
    expect(evaluate([policy], "deploy.production", "prod", "maximum_autonomy").effect).toBe("deny");
    expect(evaluate([policy], "publish.npm", "pkg", "maximum_autonomy").effect).toBe("require_approval");
  });

  it("unmatched dangerous actions require approval even at maximum autonomy", () => {
    const e = evaluate([policy], "infra.provision_paid", "aws", "maximum_autonomy");
    expect(e.effect).toBe("require_approval");
  });

  it("supervised profile defaults unmatched actions to approval", () => {
    expect(evaluate([policy], "fs.write", "src/a.ts", "supervised").effect).toBe("require_approval");
    expect(evaluate([policy], "fs.write", "src/a.ts", "autonomous_with_checkpoints").effect).toBe("allow");
  });

  it("command allowlist works on argv, denies unknown executables", () => {
    const cp = { allowedExecutables: ["git", "pnpm"], deniedExecutables: ["curl"] };
    expect(isCommandAllowed(cp, ["git", "status"]).effect).toBe("allow");
    expect(isCommandAllowed(cp, ["/usr/bin/git", "status"]).effect).toBe("allow");
    expect(isCommandAllowed(cp, ["curl", "http://x"]).effect).toBe("deny");
    expect(isCommandAllowed(cp, ["rm", "-rf", "/"]).effect).toBe("deny");
    expect(isCommandAllowed(cp, []).effect).toBe("deny");
  });

  it("budget checks warn and deny at thresholds", () => {
    expect(checkBudget(100, 50, 10, 0.8)).toMatchObject({ allowed: true, warn: false });
    expect(checkBudget(100, 75, 10, 0.8)).toMatchObject({ allowed: true, warn: true });
    expect(checkBudget(100, 95, 10, 0.8)).toMatchObject({ allowed: false });
  });

  it("path policy keeps missions inside their worktree", () => {
    const wt = "/tmp/wt/m1";
    expect(isPathAllowed(wt, [], [], "/tmp/wt/m1/src/a.ts").effect).toBe("allow");
    expect(isPathAllowed(wt, [], [], "/tmp/wt/other/x").effect).toBe("deny");
    expect(isPathAllowed(wt, [], ["**/.env"], "/tmp/wt/m1/api/.env").effect).toBe("deny");
    expect(isPathAllowed(wt, ["src/**"], [], "/tmp/wt/m1/src/a.ts").effect).toBe("allow");
    expect(isPathAllowed(wt, ["src/**"], [], "/tmp/wt/m1/infra/x.tf").effect).toBe("deny");
  });

  it("path policy denies a sibling worktree sharing a textual prefix and canonicalizes ..", () => {
    const wt = "/tmp/wt/m1";
    // Sibling that only shares the prefix "/tmp/wt/m1" must not be treated as inside.
    expect(isPathAllowed(wt, [], [], "/tmp/wt/m1-evil/secret").effect).toBe("deny");
    // A lexical `..` escape resolves outside the worktree.
    expect(isPathAllowed(wt, [], [], "/tmp/wt/m1/../m2/x").effect).toBe("deny");
  });
});

describe("secret redaction", () => {
  it("redacts common credential shapes", () => {
    const text = [
      "key=sk-abcdefghijklmnop1234",
      "gh: ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234",
      "aws AKIAIOSFODNN7EXAMPLE",
      'password: "hunter2secret"',
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).not.toContain("sk-abcdefghijklmnop1234");
    expect(out).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("hunter2secret");
    expect(out).toContain(REDACTED);
  });

  it("leaves ordinary text alone and detects secrets", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
    expect(containsSecret("token=sk-abcdefghijklmnop1234")).toBe(true);
    expect(containsSecret("no secrets here")).toBe(false);
  });
});
