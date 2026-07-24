import { expect, test } from "@playwright/test";

const project = {
  id: "prj_chantier3",
  workspaceId: "default",
  name: "Chantier 3",
  status: "clarifying",
  autonomyProfile: "autonomous_with_checkpoints",
  description: "Clarify then pause",
  repoPath: null,
  repoRemoteUrl: null,
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const clarification = {
  id: "clr_1",
  projectId: project.id,
  objectiveId: "obj_1",
  status: "pending",
  round: 1,
  schemaVersion: 1,
  provenance: "fake_fixture",
  providerId: "fake",
  model: "fake-model",
  createdAt: new Date().toISOString(),
  answeredAt: null,
  questions: [
    {
      id: "q_scope",
      clarificationId: "clr_1",
      logicalKey: "acceptance_criteria",
      category: "acceptance",
      question: "Quels critères d'acceptation sont indispensables ?",
      reason: "Sans critères, le plan ne peut pas être validé.",
      answerType: "text",
      options: [],
      required: true,
      acceptanceCriteriaRefs: [],
      blockedDecisionKeys: ["plan"],
      displayOrder: 0,
      status: "pending",
    },
  ],
};

const pauseActive = {
  projectId: project.id,
  status: "active" as const,
  reason: null,
  actor: null,
  previousStatus: null,
  generation: 0,
  pausedAt: null,
  resumedAt: null,
  cancellingRunIds: [] as string[],
};

const pausePaused = {
  ...pauseActive,
  status: "paused" as const,
  reason: "pause demandée depuis l'UI",
  actor: "user",
  previousStatus: "clarifying",
  generation: 1,
  pausedAt: new Date().toISOString(),
};

test("answers a grouped clarification then pauses and resumes atomically", async ({ page }) => {
  let authenticated = false;
  let answered: unknown = null;
  let pauseBody: unknown = null;
  let resumeCalled = false;
  let projectStatus = "clarifying";
  let pauseState = { ...pauseActive };

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (url.pathname === "/v1/health") {
      return route.fulfill({ json: { status: "ok", version: "test" } });
    }
    if (url.pathname === "/v1/session" && method === "POST") {
      authenticated = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (!authenticated && url.pathname !== "/v1/health") {
      return route.fulfill({ status: 401, json: { error: { message: "invalid or missing API token" } } });
    }
    if (url.pathname === "/v1/events/stream") return route.abort();

    if (url.pathname === "/v1/projects" && method === "GET") {
      return route.fulfill({
        json: { items: [{ ...project, status: projectStatus }] },
      });
    }
    if (url.pathname === `/v1/projects/${project.id}/configuration`) {
      return route.fulfill({
        json: {
          project: { ...project, status: projectStatus },
          objective: {
            id: "obj_1",
            projectId: project.id,
            text: "Clarify then pause",
            acceptanceCriteria: [],
            createdAt: project.createdAt,
          },
          budget: null,
        },
      });
    }
    if (url.pathname === `/v1/projects/${project.id}/clarifications`) {
      return route.fulfill({
        json: { items: answered ? [] : [clarification] },
      });
    }
    if (url.pathname === `/v1/clarifications/${clarification.id}/answers` && method === "POST") {
      answered = route.request().postDataJSON();
      projectStatus = "planning";
      return route.fulfill({
        json: {
          ...clarification,
          status: "answered",
          answeredAt: new Date().toISOString(),
          questions: clarification.questions.map((q) => ({ ...q, status: "answered" })),
        },
      });
    }
    if (url.pathname === `/v1/projects/${project.id}/pause` && method === "GET") {
      return route.fulfill({ json: pauseState });
    }
    if (url.pathname === `/v1/projects/${project.id}/pause` && method === "POST") {
      pauseBody = route.request().postDataJSON();
      projectStatus = "paused";
      pauseState = { ...pausePaused };
      return route.fulfill({ json: pauseState });
    }
    if (url.pathname === "/v1/e2e/preflight") {
      return route.fulfill({
        json: {
          schemaVersion: 2,
          generatedAt: new Date().toISOString(),
          readiness: "ready",
          usesFakeFixtureOnly: true,
          realProviderCount: 0,
          realWorkspaceEditorCount: 0,
          readyCount: 1,
          blockedCount: 0,
          scenarios: [{
            key: "no_autonomous_merge",
            title: "No autonomous merge",
            status: "ready",
            detail: "Guaranteed by design.",
            reasons: [],
          }],
          note: "Preflight mock for browser test.",
        },
      });
    }
    if (url.pathname === `/v1/projects/${project.id}/resume` && method === "POST") {
      resumeCalled = true;
      projectStatus = "active";
      pauseState = { ...pauseActive };
      return route.fulfill({ json: pauseState });
    }
    if (url.pathname.endsWith("/missions")) {
      return route.fulfill({ json: { items: [] } });
    }
    if (url.pathname.endsWith("/usage")) {
      return route.fulfill({
        json: { inputTokens: 0, outputTokens: 0, costUsd: 0, budget: null },
      });
    }
    if (url.pathname === "/v1/runs" || url.pathname === "/v1/approvals" || url.pathname === "/v1/events"
      || url.pathname === "/v1/providers" || url.pathname === "/v1/prs" || url.pathname === "/v1/terminals") {
      return route.fulfill({ json: { items: [] } });
    }
    return route.fulfill({ json: { items: [] } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connecter AvityOS" })).toBeVisible();
  await page.getByLabel("Token du control plane").fill("browser-token");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  await page.getByText("Chantier 3", { exact: true }).first().click();
  await expect(page.getByText("Clarifications groupées")).toBeVisible();
  await expect(page.getByText("Fixture déterministe (fake_fixture)")).toBeVisible();
  await page.getByPlaceholder("Réponse obligatoire").fill("Tous les tests passent et la doc est à jour");
  await page.getByRole("button", { name: "Envoyer toutes les réponses" }).click();
  await expect.poll(() => answered).not.toBeNull();

  await page.getByRole("button", { name: /Pause atomique/ }).click();
  await expect.poll(() => pauseBody).toMatchObject({ reason: "pause demandée depuis l'UI" });
  await expect(page.getByText("Pausé", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Reprendre/ }).click();
  await expect.poll(() => resumeCalled).toBe(true);
});
