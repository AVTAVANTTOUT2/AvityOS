import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import * as demo from "../demo/fixtures";
import { api, eventStream, type ApiEvent } from "./api";

/**
 * Single data source for every screen. In live mode the control plane is the
 * source of truth (REST snapshot + SSE-triggered refresh); demo mode serves
 * labeled fixtures only when VITE_AVITY_DEMO=1 is set. A backend failure is
 * represented honestly as offline state, optionally retaining the last live
 * snapshot rather than replacing it with fictional data.
 */

export type BackendMode = "connecting" | "live" | "offline" | "demo";

export interface AppData {
  mode: BackendMode;
  projects: typeof demo.PROJECTS;
  agents: typeof demo.AGENTS;
  kanban: typeof demo.KANBAN;
  interventions: typeof demo.INTERVENTIONS;
  providers: typeof demo.PROVIDERS;
  consumption: typeof demo.CONSUMPTION;
  activity: typeof demo.ACTIVITY_LOG;
  prs: typeof demo.PRS;
  termOut: string[];
  diff: typeof demo.DIFF;
  refresh: () => void;
  actions: {
    createProject: (input: {
      name: string;
      objective: string;
      autonomy: string;
      criteria: string[];
    }) => Promise<{ ok: boolean; detail: string }>;
    answerIntervention: (id: string, answer: string, decision: "approved" | "rejected") => Promise<void>;
  };
}

const STATE_TO_COLUMN: Record<string, string> = {
  proposed: "À planifier",
  ready: "Prête",
  assigned: "En cours",
  running: "En cours",
  retrying: "En cours",
  result_submitted: "En validation",
  validating: "En validation",
  review_required: "En validation",
  approved: "PR ouverte",
  integrated: "PR ouverte",
  paused: "Bloquée",
  blocked: "Bloquée",
  failed: "Bloquée",
  cancelled: "Terminée",
  completed: "Terminée",
};

const KANBAN_COLUMNS = ["À planifier", "Prête", "En cours", "En validation", "PR ouverte", "Bloquée", "Terminée"];

const PROJECT_PHASE: Record<string, string> = {
  draft: "Nouveau projet",
  clarifying: "Clarification requise",
  planning: "Planification",
  active: "Exécution",
  paused: "En pause",
  blocked: "Bloqué",
  completed: "Terminé",
  archived: "Archivé",
};

const EVENT_LABELS: Record<string, string> = {
  "project.created": "Projet créé",
  "objective.submitted": "Objectif soumis",
  "clarification.requested": "Clarification demandée",
  "clarification.answered": "Clarification répondue",
  "plan.created": "Plan créé",
  "mission.created": "Mission créée",
  "mission.state_changed": "Mission mise à jour",
  "mission.correction_loop": "Boucle de correction",
  "run.state_changed": "Exécution mise à jour",
  "run.usage": "Consommation",
  "provider.fallback": "Fallback provider",
  "approval.requested": "Approbation requise",
  "approval.resolved": "Approbation résolue",
  "checkpoint.updated": "Checkpoint",
  "policy.decision": "Décision de policy",
  "terminal.output": "Terminal",
  "git.pr_opened": "PR ouverte",
  "worker.status_changed": "Worker",
};

function relTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `il y a ${hours}h` : `il y a ${Math.round(hours / 24)}j`;
}

const DEMO_FORCED = (import.meta as { env?: Record<string, string> }).env?.VITE_AVITY_DEMO === "1";

export const DataContext = createContext<AppData | null>(null);

export function useData(): AppData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useData must be used inside DataProvider");
  return value;
}

const demoData: Omit<AppData, "refresh" | "actions" | "mode"> = {
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
};

const emptyData: Omit<AppData, "refresh" | "actions" | "mode"> = {
  projects: [] as unknown as typeof demo.PROJECTS,
  agents: [] as unknown as typeof demo.AGENTS,
  kanban: Object.fromEntries(KANBAN_COLUMNS.map((column) => [column, []])) as typeof demo.KANBAN,
  interventions: [] as unknown as typeof demo.INTERVENTIONS,
  providers: [] as unknown as typeof demo.PROVIDERS,
  consumption: [] as unknown as typeof demo.CONSUMPTION,
  activity: [] as unknown as typeof demo.ACTIVITY_LOG,
  prs: [] as unknown as typeof demo.PRS,
  termOut: [],
  diff: [],
};

async function loadLive(): Promise<Omit<AppData, "refresh" | "actions" | "mode">> {
  const [projectsRes, runsRes, approvalsRes, eventsRes, providersRes, prsRes, terminalsRes] = await Promise.all([
    api.projects(),
    api.runs(),
    api.approvals(),
    api.events(0),
    api.providers(),
    api.prs(),
    api.terminals(),
  ]);

  const projectNames = new Map(projectsRes.items.map((p) => [p.id, p.name]));
  const missionsByProject = await Promise.all(
    projectsRes.items.map(async (p) => ({ id: p.id, missions: (await api.missions(p.id)).items })),
  );
  const usageByProject = await Promise.all(
    projectsRes.items.map(async (p) => ({ id: p.id, usage: await api.usage(p.id) })),
  );
  const clarifications = (
    await Promise.all(projectsRes.items.map(async (p) => (await api.clarifications(p.id)).items))
  ).flat();

  const allMissions = missionsByProject.flatMap((m) => m.missions);
  const missionTitle = new Map(allMissions.map((m) => [m.id, m.title]));
  const activeRuns = runsRes.items.filter((r) => ["queued", "starting", "running", "paused"].includes(r.state));

  const projects = projectsRes.items.map((p, i) => {
    const missions = missionsByProject.find((m) => m.id === p.id)?.missions ?? [];
    const done = missions.filter((m) => m.state === "completed").length;
    const usage = usageByProject.find((u) => u.id === p.id)?.usage;
    const running = activeRuns.filter((r) => r.projectId === p.id).length;
    return {
      id: (i + 1) as never,
      name: p.name,
      goal: p.description || "—",
      phase: PROJECT_PHASE[p.status] ?? p.status,
      progress: missions.length ? Math.round((done / missions.length) * 100) : 0,
      health: p.status === "blocked" ? "blocked" : p.status === "clarifying" ? "warning" : "good",
      activeAgents: running,
      branch: "main",
      lastActivity: relTime(p.updatedAt),
      nextCheckpoint: missions.find((m) => !["completed", "cancelled"].includes(m.state))?.title ?? "—",
      cost: `$${(usage?.costUsd ?? 0).toFixed(2)}`,
      status: p.status === "blocked" ? "blocked" : "active",
      apiId: p.id,
    };
  }) as unknown as typeof demo.PROJECTS;

  const agents = activeRuns.map((r, i) => ({
    id: (i + 1) as never,
    name: `Agent ${r.id.slice(-6)}`,
    role: allMissions.find((m) => m.id === r.missionId)?.role ?? "backend",
    model: r.model ?? "—",
    status: r.state === "running" ? "execution" : r.state,
    mission: missionTitle.get(r.missionId) ?? r.missionId,
    context: `${Math.round((r.inputTokens + r.outputTokens) / 1000)}k`,
    cost: `$${r.costUsd.toFixed(2)}`,
    successRate: 100,
    project: projectNames.get(r.projectId) ?? r.projectId,
  })) as unknown as typeof demo.AGENTS;

  const kanban = Object.fromEntries(KANBAN_COLUMNS.map((c) => [c, [] as unknown[]])) as typeof demo.KANBAN;
  for (const m of allMissions) {
    const column = STATE_TO_COLUMN[m.state] ?? "À planifier";
    kanban[column]!.push({
      id: m.id,
      title: m.title,
      team: m.role,
      agent: projectNames.get(m.projectId) ?? "—",
      priority: m.priority >= 70 ? "critique" : m.priority >= 50 ? "haute" : "normale",
      duration: relTime(m.createdAt),
      branch: m.branchName ?? "—",
      ...(m.state === "completed" ? { tests: "passing" } : {}),
    });
  }

  const interventions = [
    ...approvalsRes.items.map((a, i) => ({
      id: (i + 1) as never,
      apiId: a.id,
      kind: "approval",
      project: projectNames.get(a.projectId) ?? a.projectId,
      question: a.title,
      reason: a.description,
      impact: a.missionId ? `Mission ${missionTitle.get(a.missionId) ?? a.missionId} en attente` : "—",
      options: ["Approuver", "Rejeter"],
      recommendation: "Approuver",
      urgency: "haute",
      blockedAgents: [],
      time: "en attente",
      type: "approbation",
    })),
    ...clarifications.map((c, i) => ({
      id: (100 + i) as never,
      apiId: c.id,
      kind: "clarification",
      questionId: c.questions[0]?.id,
      project: projectNames.get(c.projectId) ?? c.projectId,
      question: c.questions.map((q) => q.question).join(" — "),
      reason: "L'objectif est ambigu ; une réponse groupée permet de reprendre automatiquement.",
      impact: "La planification est en pause jusqu'à la réponse.",
      options: c.questions[0]?.options ?? [],
      recommendation: "",
      urgency: "haute",
      blockedAgents: [],
      time: "en attente",
      type: "clarification",
    })),
  ] as unknown as typeof demo.INTERVENTIONS;

  const providers = providersRes.items.map((p) => ({
    name: p.name,
    models: p.models,
    status: p.healthy ? "healthy" : "warning",
    latency: "—",
    rateLimit: 0,
    tokens: "—",
    cost: "—",
    missions: activeRuns.length,
    health: p.healthy ? 100 : 0,
  })) as unknown as typeof demo.PROVIDERS;

  const recent = [...eventsRes.items].sort((a, b) => b.seq - a.seq).slice(0, 50);
  const activity = recent.map((e) => ({
    time: new Date(e.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    project: (e.projectId && projectNames.get(e.projectId)) || "—",
    agent: e.runId ? `run ${e.runId.slice(-6)}` : "système",
    event: EVENT_LABELS[e.type] ?? e.type,
    action: summarizePayload(e),
    result: e.type.includes("fallback") || String(e.payload.to ?? "").includes("fail") ? "error" : "success",
    cost: "—",
  })) as unknown as typeof demo.ACTIVITY_LOG;

  const prs = prsRes.items.map((pr) => ({
    id: pr.number ? `PR #${pr.number}` : pr.id,
    title: pr.title,
    agent: "—",
    reviewer: "—",
    branch: `${pr.branch} → main`,
    files: 0,
    risk: "faible",
    tests: "passing",
    status: pr.state,
    mission: "—",
  })) as unknown as typeof demo.PRS;

  // daily cost buckets from usage events
  const buckets = new Map<string, { cost: number; tokens: number }>();
  for (const e of eventsRes.items.filter((x) => x.type === "run.usage")) {
    const day = new Date(e.createdAt).toLocaleDateString("fr-FR", { weekday: "short" });
    const b = buckets.get(day) ?? { cost: 0, tokens: 0 };
    b.cost += Number(e.payload.costUsd ?? 0);
    b.tokens += Number(e.payload.inputTokens ?? 0) + Number(e.payload.outputTokens ?? 0);
    buckets.set(day, b);
  }
  const consumption = [...buckets.entries()].map(([day, b]) => ({
    day,
    cost: Number(b.cost.toFixed(2)),
    tokens: b.tokens,
  })) as unknown as typeof demo.CONSUMPTION;

  let termOut: string[] = [];
  const lastTerminal = terminalsRes.items.at(-1);
  if (lastTerminal) {
    const detail = await api.terminalDetail(lastTerminal.id);
    termOut = [`> ${lastTerminal.command.join(" ")}`, ...detail.logs.map((l) => l.text.replace(/\n$/, ""))];
  }

  return {
    projects,
    agents,
    kanban,
    interventions,
    providers,
    consumption: consumption.length ? consumption : ([] as unknown as typeof demo.CONSUMPTION),
    activity,
    prs,
    termOut,
    diff: [],
  };
}

function summarizePayload(e: ApiEvent): string {
  if (e.type === "mission.state_changed") return `${e.payload.from} → ${e.payload.to}`;
  if (e.type === "run.usage") return `${e.payload.inputTokens}+${e.payload.outputTokens} tokens`;
  if (e.type === "provider.fallback") return String(e.payload.reason ?? "");
  if (e.type === "policy.decision") return `${e.payload.action}: ${e.payload.effect}`;
  const text = e.payload.text ?? e.payload.title ?? e.payload.reason ?? e.payload.name ?? "";
  return String(text).slice(0, 80) || e.type;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<BackendMode>(DEMO_FORCED ? "demo" : "connecting");
  const [live, setLive] = useState<Omit<AppData, "refresh" | "actions" | "mode"> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (DEMO_FORCED) return;
    loadLive()
      .then((data) => {
        setLive(data);
        setMode("live");
      })
      .catch(() => setMode("offline"));
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refresh();
    }, 400);
  }, [refresh]);

  useEffect(() => {
    if (DEMO_FORCED) return;
    refresh();
    let close: (() => void) | null = null;
    api
      .health()
      .then(() => {
        close = eventStream(() => scheduleRefresh());
      })
      .catch(() => setMode("offline"));
    const poll = setInterval(refresh, 15_000);
    return () => {
      close?.();
      clearInterval(poll);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, scheduleRefresh]);

  const base = mode === "demo" ? demoData : (live ?? emptyData);

  const value: AppData = {
    ...base,
    mode,
    refresh,
    actions: {
      createProject: async ({ name, objective, autonomy, criteria }) => {
        try {
          const project = await api.createProject({ name, description: objective, autonomyProfile: autonomy });
          const result = await api.submitObjective(project.id, objective, criteria);
          refresh();
          return {
            ok: true,
            detail: result.clarificationId
              ? "Objectif soumis — une clarification est demandée dans Interventions."
              : "Objectif soumis — planification démarrée.",
          };
        } catch (err) {
          return { ok: false, detail: (err as Error).message };
        }
      },
      answerIntervention: async (apiId, answer, decision) => {
        if (apiId.startsWith("clr_")) {
          // answer every open question of the clarification with the given text
          const clarification = (
            await Promise.all(
              (await api.projects()).items.map(async (p) => (await api.clarifications(p.id)).items),
            )
          )
            .flat()
            .find((c) => c.id === apiId);
          if (clarification) {
            await api.answerClarification(
              apiId,
              clarification.questions.map((q) => ({ questionId: q.id, answer })),
            );
          }
        } else {
          await api.resolveApproval(apiId, decision, answer);
        }
        refresh();
      },
    },
  };

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
