import { expect, test } from "@playwright/test";

test("authenticates then displays canonical live state", async ({ page }) => {
  let authenticated = false;
  await page.route("http://127.0.0.1:7717/**", async (route) => {
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
