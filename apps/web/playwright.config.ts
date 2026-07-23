import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const e2eHome = process.env.AVITY_LIVE_E2E_HOME ?? mkdtempSync(join(tmpdir(), "avity-web-live-e2e-"));
const apiToken = process.env.AVITY_LIVE_E2E_TOKEN ?? "live-e2e-browser-token";

process.env.AVITY_LIVE_E2E_HOME = e2eHome;
process.env.AVITY_LIVE_E2E_TOKEN = apiToken;

function selectedProjects(): string[] {
  const selected: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--project" && process.argv[index + 1]) {
      selected.push(process.argv[index + 1]!);
    }
    const inline = process.argv[index]?.match(/^--project=(.+)$/);
    if (inline) selected.push(inline[1]!);
  }
  return selected.length > 0 ? selected : ["intercepted", "live-preparation"];
}

const needsControlPlane = selectedProjects().includes("live-preparation");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "intercepted",
      testIgnore: "**/live-preparation.spec.ts",
    },
    {
      name: "live-preparation",
      testMatch: "**/live-preparation.spec.ts",
    },
  ],
  webServer: [
    ...(needsControlPlane
      ? [{
          command: `pnpm --filter @avityos/control-plane build && AVITY_EXECUTION_MODE=test AVITY_API_TOKEN=${apiToken} AVITY_DB_PATH=${join(e2eHome, "cp.sqlite")} AVITY_HOME=${e2eHome} AVITY_PORT=7717 AVITY_HOST=127.0.0.1 node services/control-plane/dist/main.js`,
          cwd: repoRoot,
          url: "http://127.0.0.1:7717/v1/health",
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        }]
      : []),
    {
      command: needsControlPlane
        ? "VITE_AVITY_API=http://127.0.0.1:7717 pnpm dev --host 127.0.0.1 --port 5173"
        : "pnpm dev --host 127.0.0.1 --port 5173",
      cwd: join(repoRoot, "apps/web"),
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
