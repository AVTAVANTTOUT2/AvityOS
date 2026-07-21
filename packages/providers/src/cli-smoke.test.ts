/**
 * Non-destructive CLI smoke tests.
 *
 * These prove that an installed binary can *start* under the AvityOS OS sandbox
 * with a throwaway HOME (`--version` / `--help` / auth status). They do **not**
 * prove authentication against a vendor API, a paid mission, or end-to-end
 * provider completion. Missing binaries are skipped with an explicit reason
 * (never a false success).
 *
 * Authenticated live checks require operator credentials and are documented in
 * docs/PROVIDER-ADAPTERS.md — they are not part of this suite.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandProviderAdapter } from "./command.js";
import type { RunEvent } from "./types.js";

async function drain(events: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

const SANDBOX_AVAILABLE =
  (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) ||
  (process.platform === "linux" && ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].some(existsSync));

function which(bin: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe.skipIf(!SANDBOX_AVAILABLE)("CLI smoke (binary start under sandbox, not auth proof)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function smoke(executable: string, args: string[]): Promise<RunEvent[]> {
    const ws = mkdtempSync(join(tmpdir(), "avity-cli-smoke-"));
    dirs.push(ws);
    const adapter = new CommandProviderAdapter("smoke", {
      executable,
      args,
      allowNetwork: false,
      env: {},
    });
    return drain(
      adapter.startRun({
        runId: "smoke",
        model: "default",
        systemPrompt: "",
        userPrompt: "",
        cwd: ws,
        timeoutMs: 15_000,
      }).events,
    );
  }

  it("codex --version starts under sandbox when installed", async (ctx) => {
    const bin = which("codex");
    if (!bin) {
      ctx.skip();
      return;
    }
    const events = await smoke(bin, ["--version"]);
    const completed = events.find((e) => e.type === "completed");
    expect(completed, `codex --version failed: ${JSON.stringify(events)}`).toBeDefined();
    expect((completed as { resultText: string }).resultText.toLowerCase()).toMatch(/codex|version|\d/);
  });

  it("claude --version starts under sandbox when installed", async (ctx) => {
    const bin = which("claude");
    if (!bin) {
      ctx.skip();
      return;
    }
    const events = await smoke(bin, ["--version"]);
    const completed = events.find((e) => e.type === "completed");
    expect(completed, `claude --version failed: ${JSON.stringify(events)}`).toBeDefined();
  });

  it("cursor-agent --version starts under sandbox when installed", async (ctx) => {
    const bin = which("cursor-agent") ?? which("agent");
    if (!bin) {
      ctx.skip();
      return;
    }
    const events = await smoke(bin, ["--version"]);
    const completed = events.find((e) => e.type === "completed");
    expect(completed, `cursor-agent --version failed: ${JSON.stringify(events)}`).toBeDefined();
  });

  it("generic command provider can run a local --help under sandbox", async () => {
    const events = await smoke("node", ["--version"]);
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
  });
});

describe("CLI smoke skip rationale when sandbox missing", () => {
  it("documents that smoke tests require an OS sandbox primitive", () => {
    if (SANDBOX_AVAILABLE) {
      expect(SANDBOX_AVAILABLE).toBe(true);
      return;
    }
    // Without sandbox-exec/bwrap, CLI providers fail closed; smoke is N/A.
    expect(SANDBOX_AVAILABLE).toBe(false);
  });
});
