import { expect, test } from "@playwright/test";

test("authenticates then displays canonical live state", async ({ page }) => {
  let authenticated = false;
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/health") {
      return route.fulfill({ json: { status: "ok", version: "test" } });
    }
    if (url.pathname === "/v1/session" && route.request().method() === "POST") {
      expect(route.request().headers().authorization).toBe("Bearer browser-token");
      authenticated = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (!authenticated) {
      return route.fulfill({ status: 401, json: { error: { message: "invalid or missing API token" } } });
    }
    if (url.pathname === "/v1/projects") return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/v1/events/stream") return route.abort();
    return route.fulfill({ json: { items: [] } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connecter AvityOS" })).toBeVisible();
  await page.getByLabel("Token du control plane").fill("browser-token");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByText("Système opérationnel")).toBeVisible();
});

test("transmits the complete repository onboarding payload", async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/projects" && route.request().method() === "POST") {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: {
        id: "prj_browser",
        workspaceId: "default",
        name: "Browser onboarding",
        status: "active",
        autonomyProfile: "maximum_autonomy",
        description: "",
        repoPath: "/srv/browser-project",
        repoRemoteUrl: "git@github.com:example/browser-project.git",
        defaultBranch: "develop",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        clarificationId: null,
      } });
    }
    if (url.pathname === "/v1/health") return route.fulfill({ json: { status: "ok", version: "test" } });
    if (url.pathname === "/v1/events/stream") return route.abort();
    return route.fulfill({ json: { items: [] } });
  });

  await page.goto("/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Nouveau projet/ }).first().click();
  await page.getByLabel("Nom du projet").fill("Browser onboarding");
  await page.getByLabel("Objectif").fill("Deliver complete onboarding from the browser");
  await page.getByLabel("Critère d'acceptation 1").fill("repository is validated");
  await page.getByRole("button", { name: "Ajouter un critère" }).click();
  await page.getByLabel("Critère d'acceptation 2").fill("all values are persisted");
  await page.getByRole("button", { name: /Continuer/ }).click();
  await page.getByRole("radio", { name: "Importer un dépôt existant" }).click();
  await page.getByLabel("Chemin local du dépôt").fill("/srv/browser-project");
  await page.getByLabel("Remote GitHub").fill("git@github.com:example/browser-project.git");
  await page.getByLabel("Branche principale").fill("develop");
  await page.getByRole("button", { name: /Continuer/ }).click();
  await page.getByRole("radio", { name: /Autonomie maximale/ }).click();
  await page.getByLabel("Budget maximal (USD)").fill("120");
  await page.getByLabel("Seuil d'alerte (%)").fill("65");
  await page.getByRole("button", { name: "Créer le projet" }).click();

  await expect.poll(() => submitted).toEqual({
    name: "Browser onboarding",
    objective: "Deliver complete onboarding from the browser",
    acceptanceCriteria: ["repository is validated", "all values are persisted"],
    autonomyProfile: "maximum_autonomy",
    repoPath: "/srv/browser-project",
    repoRemoteUrl: "git@github.com:example/browser-project.git",
    defaultBranch: "develop",
    budgetUsd: 120,
    budgetWarnAtFraction: 0.65,
  });
});
