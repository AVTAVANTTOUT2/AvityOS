import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const API_TOKEN = process.env.AVITY_LIVE_E2E_TOKEN ?? "live-e2e-browser-token";
const E2E_HOME = process.env.AVITY_LIVE_E2E_HOME ?? join(process.cwd(), ".live-e2e-state");
const FIXTURE_PATH = join(E2E_HOME, "fixture-repo");

function ensureFixtureRepository(): void {
  if (existsSync(join(FIXTURE_PATH, ".git"))) return;
  mkdirSync(FIXTURE_PATH, { recursive: true });
  writeFileSync(join(FIXTURE_PATH, "README.md"), "# Live E2E fixture\n");
  writeFileSync(
    join(FIXTURE_PATH, "package.json"),
    `${JSON.stringify({
      name: "avity-live-e2e-fixture",
      private: true,
      scripts: { test: "node --test" },
    }, null, 2)}\n`,
  );
  execSync("git init -b main", { cwd: FIXTURE_PATH, stdio: "ignore" });
  execSync("git config user.email fixture@test.invalid", { cwd: FIXTURE_PATH, stdio: "ignore" });
  execSync('git config user.name "Avity Fixture"', { cwd: FIXTURE_PATH, stdio: "ignore" });
  execSync("git add .", { cwd: FIXTURE_PATH, stdio: "ignore" });
  execSync('git commit -m "chore: live e2e fixture"', {
    cwd: FIXTURE_PATH,
    stdio: "ignore",
    env: { ...process.env, HUSKY: "0" },
  });
}

async function authenticateIfNeeded(page: import("@playwright/test").Page): Promise<void> {
  const gate = page.getByRole("heading", { name: "Connecter AvityOS" });
  if (await gate.isVisible().catch(() => false)) {
    await page.getByLabel("Token du control plane").fill(API_TOKEN);
    await page.getByRole("button", { name: "Se connecter" }).click();
  }
}

test.describe("live preparation against real control plane", () => {
  test.beforeAll(() => {
    mkdirSync(E2E_HOME, { recursive: true });
    ensureFixtureRepository();
  });

  test("auth, import fixture repo, create project, and show honest credential blocking", async ({ page }) => {
    await page.goto("/");
    await authenticateIfNeeded(page);
    await expect(page.getByText("Live", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Nouveau projet|Nouvel objectif/ }).first().click();
    await page.getByLabel("Nom du projet").fill("Projet fixture live");
    await page.getByLabel("Objectif").fill("Valider la préparation campagne sans exécution provider");
    await page.getByLabel("Critère d'acceptation 1").fill("Preflight affiché honnêtement");
    await page.getByRole("button", { name: /Continuer/ }).click();

    await page.getByRole("radio", { name: "Importer un dépôt existant" }).click();
    await page.getByLabel("Chemin local du dépôt").fill(FIXTURE_PATH);
    await page.getByLabel("Branche principale").fill("main");
    await page.getByRole("button", { name: /Continuer/ }).click();
    await page.getByRole("button", { name: "Créer le projet" }).click();

    await expect(page.getByText("Projet fixture live", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText("Projet fixture live", { exact: true }).first().click();

    await expect(page.getByText("Préparation campagne live")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Ce n.est pas une preuve/)).toBeVisible();
    await expect(page.getByText(/Credentials|Config\. opérateur|Outil manquant/).first()).toBeVisible();
    await expect(page.getByText(/fixture fake uniquement/i)).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(bodyText).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    expect(bodyText).not.toMatch(/Bearer\s+\S+/);
  });
});
