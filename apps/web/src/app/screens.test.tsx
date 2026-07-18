import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as demo from "../demo/fixtures";
import { DataContext, type AppData } from "../lib/data";
import { CommandPalette } from "./components/CommandPalette";
import { ProjectDetailScreen } from "./screens/ProjectDetailScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
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
    termOut: demo.TERM_OUT,
    diff: demo.DIFF,
    refresh: vi.fn(),
    actions: {
      createProject: vi.fn(async () => ({ ok: true, detail: "" })),
      answerIntervention: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

function renderWithData(ui: ReactNode, data = makeData()) {
  return render(<DataContext.Provider value={data}>{ui}</DataContext.Provider>);
}

describe("command palette", () => {
  it("lists commands built from real data and runs navigation on click", async () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    renderWithData(
      <CommandPalette open onClose={onClose} onNavigate={onNavigate} onNewProject={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Ouvrir SaaS Facturation/ })).toBeInTheDocument();
    expect(screen.getByText("3 en attente")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /journal d'activité/ }));
    expect(onClose).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith("activity");
  });

  it("supports keyboard selection of a filtered command", async () => {
    const onNavigate = vi.fn();
    renderWithData(
      <CommandPalette open onClose={vi.fn()} onNavigate={onNavigate} onNewProject={vi.fn()} />,
    );
    await userEvent.type(screen.getByPlaceholderText("Rechercher une commande..."), "exécutions{Enter}");
    expect(onNavigate).toHaveBeenCalledWith("executions");
  });
});

describe("terminals screen", () => {
  it("derives sessions from provider data instead of hardcoded fixtures", () => {
    renderWithData(<TerminalsScreen />);
    // demo fixtures: 6 agents with a mission (Infra Atlas has none)
    expect(screen.getByText("6 sessions")).toBeInTheDocument();
    expect(screen.getByText("Backend Mira")).toBeInTheDocument();
    expect(screen.queryByText("Infra Atlas")).not.toBeInTheDocument();
  });

  it("filters blocked sessions and shows the saturation banner only when a provider is above 85%", async () => {
    renderWithData(<TerminalsScreen />);
    expect(screen.getByText(/Rate limit élevé — DeepSeek \(91%\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Bloquées" }));
    expect(screen.getByText("SecOps Rex")).toBeInTheDocument();
    expect(screen.queryByText("Backend Mira")).not.toBeInTheDocument();
  });

  it("shows no saturation banner and an honest empty state without live sessions", () => {
    renderWithData(
      <TerminalsScreen />,
      makeData({
        mode: "live",
        agents: [] as unknown as AppData["agents"],
        providers: demo.PROVIDERS.map(p => ({ ...p, rateLimit: 0 })) as AppData["providers"],
      }),
    );
    expect(screen.getByText("Aucune session d'exécution en cours.")).toBeInTheDocument();
    expect(screen.queryByText(/Rate limit élevé/)).not.toBeInTheDocument();
  });
});

describe("project detail tabs", () => {
  it("wires each tab to its screen content", async () => {
    renderWithData(<ProjectDetailScreen onBack={vi.fn()} />);
    expect(screen.getByText(/progression 67 %/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Équipe" }));
    expect(screen.getByRole("button", { name: "Organigramme" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Missions" }));
    expect(screen.getByText("En validation")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.getByText("API REST facturation v2")).toBeInTheDocument();
  });
});

describe("settings screen", () => {
  it("toggles protection rules", async () => {
    render(<SettingsScreen />);
    const toggle = screen.getByRole("switch", { name: "Fusion automatique si checks passent" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

describe("team screen resilience", () => {
  it("renders an empty state instead of crashing when no agents exist", async () => {
    const { TeamScreen } = await import("./screens/TeamScreen");
    renderWithData(<TeamScreen />, makeData({ agents: [] as unknown as AppData["agents"] }));
    expect(within(document.body).getByText("Aucun agent actif pour le moment.")).toBeInTheDocument();
  });
});
