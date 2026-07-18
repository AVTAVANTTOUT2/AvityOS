import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as demo from "../demo/fixtures";
import { DataContext, type AppData } from "../lib/data";
import { CommandPalette } from "./components/CommandPalette";
import { InterventionsScreen } from "./screens/InterventionsScreen";
import { MissionsScreen } from "./screens/MissionsScreen";
import { ProjectDetailScreen } from "./screens/ProjectDetailScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TeamScreen } from "./screens/TeamScreen";
import { TerminalsScreen } from "./screens/TerminalsScreen";

function makeData(overrides: Partial<AppData> = {}): AppData {
  return {
    mode: "demo",
    projects: demo.PROJECTS,
    agents: demo.AGENTS,
    kanban: demo.KANBAN,
    interventions: demo.INTERVENTIONS,
    providers: demo.PROVIDERS,
    consumption: demo.CONSUMPTION,
    activity: demo.ACTIVITY_LOG,
    prs: demo.PRS,
    terminals: demo.TERMINALS,
    diff: demo.DIFF,
    refresh: vi.fn(),
    actions: {
      createProject: vi.fn(async () => ({ ok: true, detail: "" })),
      answerIntervention: vi.fn(async () => undefined),
      transitionMission: vi.fn(async () => ({ ok: true, detail: "" })),
      cancelTerminal: vi.fn(async () => ({ ok: true, detail: "" })),
    },
    ...overrides,
  };
}

function renderWithData(ui: ReactNode, data = makeData()) {
  return render(<DataContext.Provider value={data}>{ui}</DataContext.Provider>);
}

describe("project selection", () => {
  it("passes the second project's id when its card is clicked", async () => {
    const onOpenProject = vi.fn();
    renderWithData(<ProjectsScreen onOpenProject={onOpenProject} onNewProject={vi.fn()} />);
    await userEvent.click(screen.getByText("Plateforme Réservation"));
    expect(onOpenProject).toHaveBeenCalledWith(2);
  });

  it("opens a specific project from the command palette", async () => {
    const onOpenProject = vi.fn();
    const onClose = vi.fn();
    renderWithData(
      <CommandPalette open onClose={onClose} onNavigate={vi.fn()} onOpenProject={onOpenProject} onNewProject={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Ouvrir Plateforme Réservation/ }));
    expect(onClose).toHaveBeenCalled();
    expect(onOpenProject).toHaveBeenCalledWith(2);
  });

  it("renders the selected project, not the first one", () => {
    renderWithData(<ProjectDetailScreen projectId={2} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Plateforme Réservation" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "SaaS Facturation" })).not.toBeInTheDocument();
  });
});

describe("project data isolation", () => {
  it("filters agents, PRs and next steps to the selected project", () => {
    renderWithData(<ProjectDetailScreen projectId={2} onBack={vi.fn()} />);
    // agents of Plateforme Réservation only
    expect(screen.getByText("Backend Mira")).toBeInTheDocument();
    expect(screen.getByText("QA Nova")).toBeInTheDocument();
    expect(screen.queryByText("Frontend Leo")).not.toBeInTheDocument();
    // PRs of that project only (PR #47 belongs to SaaS Facturation)
    expect(screen.getByText("PR #46")).toBeInTheDocument();
    expect(screen.queryByText("PR #47")).not.toBeInTheDocument();
    // next steps come from this project's missions only
    expect(screen.getByText("Authentification OAuth Google")).toBeInTheDocument();
    expect(screen.queryByText("API REST facturation v2")).not.toBeInTheDocument();
  });

  it("filters the missions tab by project", async () => {
    renderWithData(<ProjectDetailScreen projectId={2} onBack={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Missions" }));
    expect(screen.getByText("Refactoring module paiements")).toBeInTheDocument();
    expect(screen.queryByText("Migration base de données v3")).not.toBeInTheDocument();
  });

  it("filters the team tab by project", () => {
    renderWithData(<TeamScreen project="API Finance" />);
    expect(screen.getByText("SecOps Rex")).toBeInTheDocument();
    expect(screen.queryByText("Backend Mira")).not.toBeInTheDocument();
  });
});

describe("terminal sessions", () => {
  it("renders one card per terminal, each with its own logs", () => {
    renderWithData(<TerminalsScreen />);
    expect(screen.getByText("4 sessions")).toBeInTheDocument();
    const card1 = screen.getByText("term_demo_1").closest(".overflow-hidden") as HTMLElement;
    const card2 = screen.getByText("term_demo_2").closest(".overflow-hidden") as HTMLElement;
    expect(within(card1).getByText("✓ Routes compiled (48 endpoints)")).toBeInTheDocument();
    expect(within(card1).queryByText(/PASS src\/billing\/stripe\.test\.ts/)).not.toBeInTheDocument();
    expect(within(card2).getByText(/PASS src\/billing\/stripe\.test\.ts/)).toBeInTheDocument();
    expect(within(card2).queryByText("✓ Routes compiled (48 endpoints)")).not.toBeInTheDocument();
  });

  it("shows an honest empty log state and filters finished sessions", async () => {
    renderWithData(<TerminalsScreen />);
    expect(screen.getByText("Aucune sortie pour cette session.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Terminées" }));
    expect(screen.getByText("term_demo_2")).toBeInTheDocument();
    expect(screen.queryByText("term_demo_1")).not.toBeInTheDocument();
  });

  it("disables cancellation outside live mode and calls the action in live mode", async () => {
    const { unmount } = renderWithData(<TerminalsScreen />);
    expect(screen.getByRole("button", { name: "Annuler npm run build:api" })).toBeDisabled();
    unmount();
    const data = makeData({ mode: "live" });
    renderWithData(<TerminalsScreen />, data);
    const cancel = screen.getByRole("button", { name: "Annuler npm run build:api" });
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(data.actions.cancelTerminal).toHaveBeenCalledWith("term_demo_1");
    // finished sessions stay non-cancellable even in live mode
    expect(screen.getByRole("button", { name: /Annuler npm run test/ })).toBeDisabled();
  });
});

describe("controls without fake behavior", () => {
  it("disables intervention answers outside live mode and drops the dead 'Reporter' button", () => {
    renderWithData(<InterventionsScreen />);
    expect(screen.getByRole("button", { name: /Répondre avec la recommandation/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refuser" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Reporter" })).not.toBeInTheDocument();
    expect(screen.getByText("Réponses désactivées : le control plane n'est pas connecté.")).toBeInTheDocument();
  });

  it("lets the user pick a non-recommended option", async () => {
    renderWithData(<InterventionsScreen />);
    const option = screen.getByRole("radio", { name: /SAML 2.0 avec SSO/ });
    expect(option).toHaveAttribute("aria-checked", "false");
    await userEvent.click(option);
    expect(option).toHaveAttribute("aria-checked", "true");
  });

  it("disables mission actions in demo mode with an explicit notice", async () => {
    renderWithData(<MissionsScreen />);
    await userEvent.click(screen.getByText("API REST facturation v2"));
    expect(screen.getByRole("button", { name: /Pause/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Annuler$/ })).toBeDisabled();
    expect(screen.getByText("Actions de mission disponibles uniquement en mode live.")).toBeInTheDocument();
  });

  it("sends a real transition for a live mission", async () => {
    const liveKanban = {
      ...demo.KANBAN,
      "En cours": [
        { ...demo.KANBAN["En cours"]![0]!, apiId: "msn_1", state: "running" },
      ],
    } as AppData["kanban"];
    const data = makeData({ mode: "live", kanban: liveKanban });
    renderWithData(<MissionsScreen />, data);
    await userEvent.click(screen.getByText("API REST facturation v2"));
    const pause = screen.getByRole("button", { name: /Pause/ });
    expect(pause).toBeEnabled();
    await userEvent.click(pause);
    expect(data.actions.transitionMission).toHaveBeenCalledWith("msn_1", "paused");
  });

  it("keeps settings read-only: no fake toggles or fake GitHub org", () => {
    renderWithData(<SettingsScreen />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText("mon-organisation")).not.toBeInTheDocument();
    expect(screen.getByText(/ne fusionne jamais une PR lui-même/)).toBeInTheDocument();
  });

  it("shows real providers read-only in settings", () => {
    renderWithData(<SettingsScreen initialSection="Providers" />);
    expect(screen.getByText("Anthropic / Claude")).toBeInTheDocument();
    expect(screen.getByText(/se configurent côté control plane/)).toBeInTheDocument();
  });
});

describe("team screen resilience", () => {
  it("renders an empty state instead of crashing when no agents exist", () => {
    renderWithData(<TeamScreen />, makeData({ agents: [] as unknown as AppData["agents"] }));
    expect(screen.getByText("Aucun agent actif pour le moment.")).toBeInTheDocument();
  });
});
