import { useEffect, useState } from "react";
import {
  Bot, Brain, ChevronLeft, Clock, Folder, GitBranch, Pause, Pencil, Play, TrendingUp, Zap,
} from "lucide-react";
import { api, type ApiClarification, type ApiE2EPreflightReport, type ApiE2EScenarioStatus, type ApiProjectPauseState } from "../../lib/api";
import { useData } from "../../lib/data";
import { BrainPanel } from "../components/BrainPanel";
import { ClarificationPanel } from "../components/ClarificationPanel";
import { NewProjectModal } from "../components/NewProjectModal";
import { Bar2, cn, Glass, StatusDot } from "../components/shared";
import { CodePRScreen } from "./CodePRScreen";
import { MissionsScreen } from "./MissionsScreen";
import { TeamScreen } from "./TeamScreen";

const UPCOMING_COLUMNS: [string, string][] = [
  ["En cours", "En cours"],
  ["En validation", "En attente"],
  ["Prête", "À planifier"],
  ["À planifier", "À planifier"],
];

const HEALTH_BADGES: Record<string, { label: string; className: string }> = {
  good: { label: "Actif", className: "bg-green-50 text-green-700" },
  warning: { label: "Attention", className: "bg-orange-50 text-orange-600" },
  blocked: { label: "Bloqué", className: "bg-red-50 text-red-600" },
};

const PREFLIGHT_STATUS_LABELS: Record<ApiE2EScenarioStatus, string> = {
  ready: "Prêt",
  blocked_operator_configuration: "Config. opérateur",
  blocked_missing_tool: "Outil manquant",
  blocked_missing_credentials: "Credentials",
  blocked_product_gap: "Lacune produit",
};

function preflightBadgeClass(status: ApiE2EScenarioStatus): string {
  if (status === "ready") return "bg-green-50 text-green-700";
  if (status === "blocked_missing_credentials") return "bg-red-50 text-red-600";
  return "bg-orange-50 text-orange-700";
}

function PreflightPanel({ report }: { report: ApiE2EPreflightReport }) {
  return (
    <Glass className="p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide">
            Préparation campagne live
          </div>
          <p className="text-[10px] text-[#74716B] mt-1 leading-relaxed">
            Indique si une tentative semble <strong className="font-medium text-[#202124]">runnable</strong>.
            Ce n&apos;est pas une preuve qu&apos;une campagne a <strong className="font-medium text-[#202124]">réussi</strong>.
          </p>
        </div>
        <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0", preflightBadgeClass(report.readiness))}>
          {PREFLIGHT_STATUS_LABELS[report.readiness]}
        </span>
      </div>
      <div className="text-[10px] text-[#74716B] mb-3">
        {report.readyCount} prêt{report.readyCount === 1 ? "" : "s"} · {report.blockedCount} bloqué{report.blockedCount === 1 ? "" : "s"}
        {report.usesFakeFixtureOnly && (
          <span className="ml-2 text-amber-700 font-medium">· fixture fake uniquement</span>
        )}
      </div>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {report.scenarios.map((scenario) => (
          <div key={scenario.key} className="rounded-xl bg-[#F7F4EE] px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-[#202124]">{scenario.title}</span>
              <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase", preflightBadgeClass(scenario.status))}>
                {PREFLIGHT_STATUS_LABELS[scenario.status]}
              </span>
            </div>
            <p className="text-[10px] text-[#74716B] mt-1">{scenario.detail}</p>
            {scenario.reasons[0] && (
              <p className="text-[9px] text-[#74716B] mt-1">{scenario.reasons[0].remediation[0]}</p>
            )}
          </div>
        ))}
      </div>
      <p className="text-[9px] text-[#74716B] mt-3">{report.note}</p>
    </Glass>
  );
}

export function ProjectDetailScreen({ projectId, onBack }: { projectId: number | string; onBack: () => void }) {
  const { projects: PROJECTS, agents: AGENTS, prs: PRS, kanban, actions, mode, refresh } = useData();
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [clarification, setClarification] = useState<ApiClarification | null>(null);
  const [preflight, setPreflight] = useState<ApiE2EPreflightReport | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [pauseState, setPauseState] = useState<ApiProjectPauseState | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseFeedback, setPauseFeedback] = useState<string | null>(null);
  const p = PROJECTS.find(x => x.id === projectId);
  useEffect(() => {
    if (!p || mode !== "live") {
      setClarification(null);
      setPreflight(null);
      setPreflightError(null);
      setPauseState(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      api.clarifications(String(p.id)),
      api.pauseState(String(p.id)),
    ]).then(([clarifications, pause]) => {
      if (cancelled) return;
      setClarification(clarifications.items[0] ?? null);
      setPauseState(pause);
    }).catch(() => {
      if (!cancelled) {
        setClarification(null);
        setPauseState(null);
      }
    });
    void api.getE2EPreflight(String(p.id))
      .then((preflightReport) => {
        if (cancelled) return;
        if (!Array.isArray(preflightReport?.scenarios)) {
          setPreflight(null);
          setPreflightError("réponse preflight invalide");
          return;
        }
        setPreflight(preflightReport);
        setPreflightError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setPreflight(null);
          setPreflightError((err as Error).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [p, mode, refresh]);
  if (!p) {
    return <div className="p-6 text-sm text-[#74716B]">Projet introuvable. <button className="text-[#5267D9] underline" onClick={onBack}>Retour</button></div>;
  }
  const projectAgents = AGENTS.filter(a => a.projectId === p.id);
  const projectPrs = PRS.filter(pr => pr.projectId === p.id);
  const projectCards = (col: string) => (kanban[col] ?? []).filter(c => c.projectId === p.id);
  const tabs = [
    { id: "overview", label: "Vue d'ensemble" },
    { id: "plan", label: "Plan" },
    { id: "missions", label: "Missions" },
    { id: "team", label: "Équipe" },
    { id: "code", label: "Code & PR" },
  ];
  const upcoming = UPCOMING_COLUMNS.flatMap(([col, s]) =>
    projectCards(col).map(card => ({ label: card.title, s })),
  );
  const badge = HEALTH_BADGES[p.health] ?? HEALTH_BADGES.good;
  const summary = `${p.phase} — progression ${p.progress} %. Prochaine étape : ${p.nextCheckpoint}. ${p.activeAgents} agent${p.activeAgents === 1 ? "" : "s"} actif${p.activeAgents === 1 ? "" : "s"}, ${p.cost} consommés.`;

  const nextSteps = (
    <Glass className="p-4">
      <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-3">Prochaines étapes</div>
      <div className="space-y-2">
        {upcoming.length === 0 && <div className="text-[11px] text-[#74716B]">Aucune étape planifiée pour ce projet.</div>}
        {upcoming.slice(0, 6).map((step, i) => (
          <div key={i} className="flex items-center gap-2.5 text-[11px]">
            <div className={cn("w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center",
              step.s === "En cours" ? "border-[#5267D9]" : step.s === "En attente" ? "border-orange-300" : "border-black/10"
            )}>
              {step.s === "En cours" && <div className="w-1.5 h-1.5 rounded-full bg-[#5267D9]" />}
            </div>
            <span className="flex-1 text-[#202124]">{step.label}</span>
            <span className="text-[9px] text-[#74716B]">{step.s}</span>
          </div>
        ))}
      </div>
    </Glass>
  );

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-[11px] text-[#74716B] hover:text-[#202124] transition-colors">
        <ChevronLeft size={13} />Retour aux projets
      </button>
      <Glass className="p-5">
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-2xl bg-[#5267D9]/10 flex items-center justify-center flex-shrink-0">
            <Folder size={20} className="text-[#5267D9]" strokeWidth={1.5} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2.5 mb-1">
              <h1 className="text-[14px] font-semibold text-[#202124]">{p.name}</h1>
              <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", badge.className)}>{badge.label}</span>
            </div>
            <p className="text-[11px] text-[#74716B]">{p.goal}</p>
          </div>
          <div className="text-right space-y-2">
            <div className="text-[10px] text-[#74716B]">Progression</div>
            <div className="text-xl font-semibold text-[#202124]">{p.progress}%</div>
            <button onClick={() => setEditing(true)} className="mt-1 inline-flex items-center gap-1 text-[10px] text-[#5267D9]"><Pencil size={10} />Modifier</button>
            {mode === "live" && (
              <div className="flex flex-col items-end gap-1">
                {(pauseState?.status === "paused" || pauseState?.status === "pausing" || p.phase === "En pause") ? (
                  <button
                    type="button"
                    disabled={pauseBusy || pauseState?.status === "pausing"}
                    onClick={() => {
                      setPauseBusy(true);
                      void actions.resumeProject(String(p.id)).then((result) => {
                        setPauseBusy(false);
                        setPauseFeedback(result.detail);
                      });
                    }}
                    className="inline-flex items-center gap-1 text-[10px] bg-[#202124] text-white px-2.5 py-1.5 rounded-xl disabled:opacity-40"
                  >
                    <Play size={10} />{pauseState?.status === "pausing" ? "Arrêt en cours…" : "Reprendre"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={pauseBusy || ["Terminé", "Archivé"].includes(p.phase)}
                    onClick={() => {
                      setPauseBusy(true);
                      void actions.pauseProject(String(p.id), "pause demandée depuis l'UI").then((result) => {
                        setPauseBusy(false);
                        setPauseFeedback(result.detail);
                      });
                    }}
                    className="inline-flex items-center gap-1 text-[10px] bg-[#F7F4EE] text-[#202124] px-2.5 py-1.5 rounded-xl disabled:opacity-40"
                  >
                    <Pause size={10} />Pause atomique
                  </button>
                )}
                {(pauseState?.status === "paused" || p.phase === "En pause") && (
                  <span className="text-[9px] font-bold uppercase tracking-wide text-orange-600">Pausé</span>
                )}
                {pauseState?.status === "resuming" && (
                  <span className="text-[9px] font-bold uppercase tracking-wide text-[#5267D9]">Reprise en cours</span>
                )}
                {pauseFeedback && <div className="text-[9px] text-[#74716B] max-w-[180px]">{pauseFeedback}</div>}
              </div>
            )}
          </div>
        </div>
        <div className="mt-4"><Bar2 value={p.progress} /></div>
        <div className="flex gap-5 mt-3 text-[10px] text-[#74716B]">
          <span className="flex items-center gap-1.5"><Bot size={10} />{p.activeAgents} agents actifs</span>
          <span className="flex items-center gap-1.5"><GitBranch size={10} />{p.branch}</span>
          <span className="flex items-center gap-1.5"><Clock size={10} />{p.lastActivity}</span>
          <span className="flex items-center gap-1.5"><TrendingUp size={10} />{p.cost} dépensés</span>
          <span className="flex items-center gap-1.5"><Zap size={10} className="text-[#5267D9]" />Checkpoint : {p.nextCheckpoint}</span>
        </div>
      </Glass>

      <div className="flex gap-1 bg-white/60 rounded-2xl p-1 border border-black/[0.06] w-fit">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cn("text-[11px] px-3.5 py-2 rounded-xl transition-all", tab === t.id ? "bg-white shadow-sm text-[#202124] font-medium" : "text-[#74716B] hover:text-[#202124]")}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-[1fr_264px] gap-4">
          <div className="space-y-4">
            <Glass className="p-5">
              <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Brain size={11} className="text-[#5267D9]" />Résumé
              </div>
              <p className="text-[12px] text-[#202124] leading-relaxed">{summary}</p>
            </Glass>
            {mode === "live" && clarification && (
              <ClarificationPanel
                clarification={clarification}
                onSubmit={async (answers) => {
                  const result = await actions.answerClarificationGroup(clarification.id, answers);
                  if (!result.ok) throw new Error(result.detail);
                  setClarification(null);
                }}
              />
            )}
            {mode === "live" && preflight && <PreflightPanel report={preflight} />}
            {mode === "live" && preflightError && (
              <Glass className="p-4 text-[11px] text-red-600">
                Préparation campagne indisponible : {preflightError}
              </Glass>
            )}
            <Glass className="p-5">
              <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-3">Configuration persistée</div>
              <p className="text-[10px] text-[#74716B] mb-3">
                Lecture seule — modifiez via « Modifier » (persisté côté control plane).
              </p>
              <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-[10px]">
                <dt className="text-[#74716B]">Objectif</dt><dd className="text-[#202124]">{p.goal}</dd>
                <dt className="text-[#74716B]">Critères d'acceptation</dt>
                <dd className="text-[#202124]">
                  {p.acceptanceCriteria.length ? <ul className="list-disc ml-4">{p.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul> : "Aucun"}
                </dd>
                <dt className="text-[#74716B]">Dépôt local</dt><dd className="font-mono text-[#202124] break-all">{p.repoPath ?? "Aucun dépôt"}</dd>
                <dt className="text-[#74716B]">Remote GitHub</dt><dd className="font-mono text-[#202124] break-all">{p.repoRemoteUrl ?? "Aucun remote"}</dd>
                <dt className="text-[#74716B]">Branche principale</dt><dd className="font-mono text-[#202124]">{p.branch}</dd>
                <dt className="text-[#74716B]">Autonomie</dt><dd className="text-[#202124]">{p.autonomyProfile}</dd>
                <dt className="text-[#74716B]">Budget</dt><dd className="text-[#202124]">{p.budgetUsd === null ? "Sans limite" : `$${p.budgetUsd.toFixed(2)}`}</dd>
                <dt className="text-[#74716B]">Seuil d'alerte</dt><dd className="text-[#202124]">{p.budgetUsd === null ? "Non applicable" : `${Math.round(p.budgetWarnAtFraction * 100)} %`}</dd>
              </dl>
            </Glass>
            <Glass className="p-5">
              <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-3">Agents actifs</div>
              <div className="space-y-2">
                {projectAgents.length === 0 && (
                  <div className="text-[11px] text-[#74716B]">Aucun agent actif sur ce projet.</div>
                )}
                {projectAgents.map(a => (
                  <div key={a.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-[#F7F4EE]">
                    <StatusDot status={a.status} />
                    <div className="flex-1 min-w-0">
                      <span className="text-[11px] font-medium text-[#202124]">{a.name}</span>
                      <span className="text-[10px] text-[#74716B] ml-2">{a.mission}</span>
                    </div>
                    <span className="text-[9px] font-mono text-[#74716B]">{a.context}</span>
                  </div>
                ))}
              </div>
            </Glass>
          </div>
          <div className="space-y-4">
            {nextSteps}
            <Glass className="p-4">
              <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-3">PR ouvertes</div>
              <div className="space-y-2">
                {projectPrs.filter(pr => pr.status !== "merged").length === 0 && (
                  <div className="text-[11px] text-[#74716B]">Aucune PR ouverte pour ce projet.</div>
                )}
                {projectPrs.filter(pr => pr.status !== "merged").map(pr => (
                  <div key={pr.id} className="p-2.5 rounded-xl bg-[#F7F4EE]">
                    <div className="font-mono text-[9px] text-[#74716B] mb-0.5">{pr.id}</div>
                    <div className="text-[10px] font-medium text-[#202124] leading-snug">
                      {pr.title.length > 48 ? pr.title.slice(0, 48) + "…" : pr.title}
                    </div>
                  </div>
                ))}
              </div>
            </Glass>
          </div>
        </div>
      )}
      {tab === "plan" && (
        <div className="grid grid-cols-[1fr_264px] gap-4 items-start">
          <BrainPanel projectId={String(p.id)} />
          {nextSteps}
        </div>
      )}
      {tab === "missions" && <MissionsScreen projectId={p.id} />}
      {tab === "team" && <TeamScreen projectId={p.id} projectName={p.name} />}
      {tab === "code" && <CodePRScreen projectId={p.id} projectName={p.name} />}
      {editing && <NewProjectModal project={p} onClose={() => setEditing(false)} />}
    </div>
  );
}
