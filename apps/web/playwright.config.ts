import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const e2eHome = process.env.AVITY_LIVE_E2E_HOME ?? mkdtempSync(join(tmpdir(), "avity-web-live-e2e-"));
const apiToken = process.env.AVITY_LIVE_E2E_TOKEN ?? "live-e2e-browser-token";

function e2ePort(value: string | undefined, fallback: number): string {
  const port = Number(value ?? fallback);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("E2E ports must be integers between 1024 and 65535");
  }
  return String(port);
}

const controlPlanePort = e2ePort(process.env.AVITY_E2E_CONTROL_PLANE_PORT, 17_717);
const webPort = e2ePort(process.env.AVITY_E2E_WEB_PORT, 15_173);
const controlPlaneUrl = `http://127.0.0.1:${controlPlanePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;

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
    baseURL: webUrl,
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
          command: "pnpm --filter @avityos/control-plane build && node services/control-plane/dist/main.js",
          cwd: repoRoot,
          env: {
            AVITY_EXECUTION_MODE: "test",
            AVITY_API_TOKEN: apiToken,
            AVITY_DB_PATH: join(e2eHome, "cp.sqlite"),
            AVITY_HOME: e2eHome,
            AVITY_PORT: controlPlanePort,
            AVITY_HOST: "127.0.0.1",
            AVITY_ALLOWED_ORIGINS: webUrl,
          },
          url: `${controlPlaneUrl}/v1/health`,
          reuseExistingServer: false,
          timeout: 180_000,
        }]
      : []),
    {
      command: `pnpm dev --host 127.0.0.1 --port ${webPort}`,
      cwd: join(repoRoot, "apps/web"),
      env: needsControlPlane ? { VITE_AVITY_API: controlPlaneUrl } : {},
      url: webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
