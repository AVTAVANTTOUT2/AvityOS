import { useState } from "react";
import {
  Bot, Brain, ChevronLeft, Clock, Folder, GitBranch, TrendingUp, Zap,
} from "lucide-react";
import { useData } from "../../lib/data";
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

export function ProjectDetailScreen({ projectId, onBack }: { projectId: number | string; onBack: () => void }) {
  const { projects: PROJECTS, agents: AGENTS, prs: PRS, kanban } = useData();
  const [tab, setTab] = useState("overview");
  const p = PROJECTS.find(x => x.id === projectId);
  if (!p) {
    return <div className="p-6 text-sm text-[#74716B]">Projet introuvable. <button className="text-[#5267D9] underline" onClick={onBack}>Retour</button></div>;
  }
  const projectAgents = AGENTS.filter(a => a.project === p.name);
  const projectPrs = PRS.filter(pr => pr.project === p.name);
  const projectCards = (col: string) => (kanban[col] ?? []).filter(c => c.project === p.name);
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
          <div className="text-right">
            <div className="text-[10px] text-[#74716B]">Progression</div>
            <div className="text-xl font-semibold text-[#202124]">{p.progress}%</div>
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
      {tab === "plan" && <div className="max-w-md">{nextSteps}</div>}
      {tab === "missions" && <MissionsScreen project={p.name} />}
      {tab === "team" && <TeamScreen project={p.name} />}
      {tab === "code" && <CodePRScreen project={p.name} />}
    </div>
  );
}
