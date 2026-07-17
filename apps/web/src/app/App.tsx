import { useState, useEffect } from "react";
import {
  LayoutGrid, Folder, Inbox, Users, Terminal, GitPullRequest,
  Cpu, Activity, Settings, Search, Plus, Bell, RefreshCw,
  ChevronRight, ChevronLeft, CheckCircle, AlertTriangle, Clock,
  Zap, GitBranch, Pause, Square, RotateCcw, ExternalLink,
  TrendingUp, Shield, Code, X, Filter, ArrowRight,
  Monitor, Eye, Bot, Brain, GitMerge, MoreHorizontal,
  AlertCircle, Lock, Globe, Database, FileText
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from "recharts";
import { DataProvider, useData } from "../lib/data";
import { api, ApiRequestError } from "../lib/api";
import type { Agent, Project as ProjectCardData } from "../demo/fixtures";

// ─── UTILS ──────────────────────────────────────────────────────────────────

function cn(...c: (string | undefined | false | null)[]) {
  return c.filter(Boolean).join(" ");
}

// ─── DATA ────────────────────────────────────────────────────────────────────
// All data flows through DataProvider (src/lib/data.tsx): live control-plane
// state when available, explicit demo fixtures only with VITE_AVITY_DEMO=1.

const NAV = [
  { id: "mission-control", label: "Vue générale", icon: LayoutGrid },
  { id: "projects", label: "Projets", icon: Folder },
  { id: "interventions", label: "Interventions", icon: Inbox, badge: true },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "executions", label: "Exécutions", icon: Terminal },
  { id: "github", label: "GitHub & Code", icon: GitPullRequest },
  { id: "providers", label: "Providers", icon: Cpu },
  { id: "activity", label: "Activité", icon: Activity },
  { id: "settings", label: "Paramètres", icon: Settings },
];

const CMD_ITEMS = [
  { icon: Plus, label: "Créer un nouveau projet", shortcut: "N" },
  { icon: Folder, label: "Ouvrir SaaS Facturation", sub: "Projet actif" },
  { icon: Folder, label: "Ouvrir Plateforme Réservation", sub: "Projet actif" },
  { icon: Terminal, label: "Ouvrir un nouveau terminal", shortcut: "T" },
  { icon: Inbox, label: "Répondre à une intervention", sub: "3 en attente" },
  { icon: GitPullRequest, label: "Consulter PR #47", sub: "En review" },
  { icon: Pause, label: "Mettre en pause toutes les exécutions" },
  { icon: Activity, label: "Voir le journal d'activité" },
];

// ─── SHARED UI ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    good: "bg-green-400", healthy: "bg-green-400", available: "bg-green-400",
    warning: "bg-orange-400", blocked: "bg-red-400", error: "bg-red-400",
    planning: "bg-blue-400", execution: "bg-[#5267D9]", validation: "bg-purple-400",
    offline: "bg-gray-300", approved: "bg-green-400", merged: "bg-purple-400",
  };
  return <span className={cn("inline-block w-2 h-2 rounded-full flex-shrink-0", map[status] ?? "bg-gray-300")} />;
}

function Bar2({ value, color = "bg-[#5267D9]" }: { value: number; color?: string }) {
  return (
    <div className="h-1.5 bg-black/[0.06] rounded-full overflow-hidden">
      <div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${Math.min(value, 100)}%` }} />
    </div>
  );
}

function Glass({ className, children, onClick }: { className?: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "bg-white/80 backdrop-blur-xl rounded-2xl border border-white/70 shadow-[0_2px_24px_rgba(0,0,0,0.05)]",
        onClick && "cursor-pointer hover:shadow-[0_4px_32px_rgba(0,0,0,0.09)] transition-shadow",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ─── SIDEBAR ─────────────────────────────────────────────────────────────────

function Sidebar({ current, onChange, macOS }: { current: string; onChange: (s: string) => void; macOS: boolean }) {
  const { interventions, consumption, mode } = useData();
  const interventionCount = interventions.length;
  const monthCost = consumption.reduce((sum, c) => sum + c.cost, 0);
  return (
    <div className={cn(
      "w-[216px] flex-shrink-0 flex flex-col border-r border-black/[0.06]",
      macOS ? "bg-white/55 backdrop-blur-2xl" : "bg-[#F2EFE8]",
    )}>
      <div className={cn("h-14 flex items-center px-5 border-b border-black/[0.05]", macOS && "h-[calc(3.5rem+1px)]")}>
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#5267D9] flex items-center justify-center shadow-sm">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <circle cx="7.5" cy="7.5" r="2.5" fill="white" />
              <circle cx="2" cy="4" r="1.6" fill="white" fillOpacity="0.65" />
              <circle cx="13" cy="4" r="1.6" fill="white" fillOpacity="0.65" />
              <circle cx="2" cy="11" r="1.6" fill="white" fillOpacity="0.65" />
              <circle cx="13" cy="11" r="1.6" fill="white" fillOpacity="0.65" />
              <line x1="7.5" y1="7.5" x2="2" y2="4" stroke="white" strokeOpacity="0.45" strokeWidth="0.9" />
              <line x1="7.5" y1="7.5" x2="13" y2="4" stroke="white" strokeOpacity="0.45" strokeWidth="0.9" />
              <line x1="7.5" y1="7.5" x2="2" y2="11" stroke="white" strokeOpacity="0.45" strokeWidth="0.9" />
              <line x1="7.5" y1="7.5" x2="13" y2="11" stroke="white" strokeOpacity="0.45" strokeWidth="0.9" />
            </svg>
          </div>
          <span className="font-semibold text-[#202124] text-[15px] tracking-tight">AvityOS</span>
        </div>
      </div>

      <nav className="flex-1 px-3 py-3.5 space-y-0.5 overflow-y-auto">
        {NAV.map(item => {
          const Icon = item.icon;
          const active = current === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-[7px] rounded-xl text-[13px] transition-all",
                active
                  ? "bg-[#5267D9]/[0.09] text-[#5267D9] font-medium"
                  : "text-[#74716B] hover:text-[#202124] hover:bg-black/[0.04] font-normal",
              )}
            >
              <Icon size={15} strokeWidth={active ? 2 : 1.6} />
              <span>{item.label}</span>
              {"badge" in item && item.badge && interventionCount > 0 && (
                <span className="ml-auto bg-[#5267D9] text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                  {interventionCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="px-3 pb-4 border-t border-black/[0.05] pt-3 space-y-0.5">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <div className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", mode === "live" ? "bg-green-400" : mode === "offline" ? "bg-red-400" : "bg-amber-400")} />
          <span className="text-[11px] text-[#74716B]">{mode === "live" ? "Système opérationnel" : mode === "offline" ? "Control plane indisponible" : mode === "demo" ? "Mode démonstration" : "Connexion…"}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <TrendingUp size={11} className="text-[#74716B]" />
          <span className="text-[11px] text-[#74716B]">{`$${monthCost.toFixed(2)} ce mois`}</span>
        </div>
        <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] text-[#74716B] hover:text-[#202124] hover:bg-black/[0.04] transition-all">
          <div className="w-6 h-6 rounded-full bg-[#5267D9]/15 flex items-center justify-center text-[#5267D9] text-[10px] font-bold">A</div>
          <span>Alex Martin</span>
        </button>
      </div>
    </div>
  );
}

// ─── TOP BAR ─────────────────────────────────────────────────────────────────

function TopBar({ screen, onNewProject, onCmdK, macOS, onToggleMacOS }: {
  screen: string; onNewProject: () => void; onCmdK: () => void;
  macOS: boolean; onToggleMacOS: () => void;
}) {
  const { mode } = useData();
  const titles: Record<string, string> = {
    "mission-control": "Vue générale", projects: "Projets", interventions: "Interventions",
    agents: "Agents IA", executions: "Exécutions & Terminaux", github: "GitHub & Code",
    providers: "Providers", activity: "Journal d'activité", settings: "Paramètres",
  };
  return (
    <div className="h-14 flex items-center gap-3 px-5 border-b border-black/[0.06] bg-[#F7F4EE]/80 backdrop-blur-xl flex-shrink-0">
      <span className="text-[13px] font-semibold text-[#202124]">{titles[screen] ?? screen}</span>
      {mode === "demo" && (
        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide bg-amber-50 text-amber-600" title="Le control plane est injoignable — données de démonstration affichées">Démo</span>
      )}
      {mode === "live" && (
        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide bg-green-50 text-green-700" title="Connecté au control plane">Live</span>
      )}
      {mode === "offline" && (
        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide bg-red-50 text-red-700" title="Control plane indisponible — aucune donnée de démonstration injectée">Hors ligne</span>
      )}
      {mode === "connecting" && (
        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide bg-blue-50 text-[#5267D9]">Connexion…</span>
      )}
      <div className="flex-1" />
      <button
        onClick={onCmdK}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/80 border border-black/[0.08] text-[#74716B] text-[12px] hover:border-[#5267D9]/30 transition-all shadow-[0_1px_4px_rgba(0,0,0,0.04)]"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 4.5C2 3.12 3.12 2 4.5 2S7 3.12 7 4.5 5.88 7 4.5 7 2 5.88 2 4.5zM6.5 6.5L10 10" stroke="#74716B" strokeWidth="1.4" strokeLinecap="round"/></svg>
        <span>Rechercher...</span>
        <kbd className="ml-1 text-[9px] bg-black/[0.06] px-1.5 py-0.5 rounded-md font-mono text-[#74716B]">⌘K</kbd>
      </button>
      <button
        onClick={onToggleMacOS}
        title="Basculer vue macOS"
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] transition-all border",
          macOS ? "bg-[#5267D9] text-white border-transparent" : "bg-white/80 border-black/[0.08] text-[#74716B] hover:border-[#5267D9]/25",
        )}
      >
        <Monitor size={12} />
        <span>macOS</span>
      </button>
      <div className={cn("flex items-center gap-1.5 text-[11px]", mode === "live" ? "text-green-600" : "text-[#74716B]")}>
        <RefreshCw size={11} />
        <span>{mode === "live" ? "Sync" : "Non synchronisé"}</span>
      </div>
      <button className="relative p-2 rounded-xl hover:bg-black/[0.04] transition-all">
        <Bell size={14} strokeWidth={1.5} className="text-[#74716B]" />
        <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-[#5267D9] rounded-full" />
      </button>
      <button
        onClick={onNewProject}
        className="flex items-center gap-1.5 bg-[#5267D9] text-white text-[12px] px-3.5 py-2 rounded-xl font-medium hover:bg-[#4255C4] transition-all shadow-sm"
      >
        <Plus size={13} />
        <span>Nouvel objectif</span>
      </button>
    </div>
  );
}

// ─── PROJECT CARD ─────────────────────────────────────────────────────────────

function ProjectCard({ p, onClick }: { p: ProjectCardData; onClick: () => void }) {
  const hc = { good: "border-l-green-400", warning: "border-l-orange-400", blocked: "border-l-red-400" }[p.health] ?? "border-l-gray-200";
  const hbg = { good: "bg-green-50 text-green-700", warning: "bg-orange-50 text-orange-600", blocked: "bg-red-50 text-red-600" }[p.health] ?? "bg-gray-50 text-gray-500";
  const hl = { good: "Sain", warning: "Attention", blocked: "Bloqué" }[p.health] ?? "";
  const bar = { good: "bg-[#5267D9]", warning: "bg-orange-400", blocked: "bg-red-400" }[p.health] ?? "bg-[#5267D9]";
  return (
    <Glass onClick={onClick} className={cn("p-5 border-l-4", hc)}>
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1 mr-2">
          <div className="text-[13px] font-semibold text-[#202124]">{p.name}</div>
          <div className="text-[11px] text-[#74716B] mt-0.5 leading-snug line-clamp-2">{p.goal}</div>
        </div>
        <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0", hbg)}>{hl}</span>
      </div>
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-[#74716B]">{p.phase}</span>
          <span className="text-[10px] font-semibold text-[#202124]">{p.progress}%</span>
        </div>
        <Bar2 value={p.progress} color={bar} />
      </div>
      <div className="grid grid-cols-2 gap-y-1.5 text-[10px] text-[#74716B]">
        <span className="flex items-center gap-1.5"><Bot size={10} strokeWidth={1.5} />{p.activeAgents} agents</span>
        <span className="flex items-center gap-1.5"><GitBranch size={10} strokeWidth={1.5} />{p.branch}</span>
        <span className="flex items-center gap-1.5"><Clock size={10} strokeWidth={1.5} />{p.lastActivity}</span>
        <span className="flex items-center gap-1.5"><TrendingUp size={10} strokeWidth={1.5} />{p.cost}</span>
      </div>
      <div className="mt-3 pt-3 border-t border-black/[0.05] flex items-center gap-1.5 text-[10px] text-[#74716B]">
        <Zap size={9} className="text-[#5267D9]" />
        <span>Prochain : {p.nextCheckpoint}</span>
      </div>
    </Glass>
  );
}

// ─── MISSION CONTROL ─────────────────────────────────────────────────────────

function MissionControl({ onNewProject, onOpenProject }: { onNewProject: () => void; onOpenProject: () => void }) {
  const { projects: PROJECTS, interventions: INTERVENTIONS, consumption: CONSUMPTION, providers: PROVIDERS, agents, prs, kanban } = useData();
  const blocked = PROJECTS.filter(p => p.health === "blocked").length;
  const urgent = INTERVENTIONS.filter(i => i.urgency === "haute").length;
  const openPrs = prs.filter(pr => pr.status !== "merged").length;
  const totalCost = CONSUMPTION.reduce((sum, c) => sum + c.cost, 0);
  const missionsInFlight = (kanban["En cours"]?.length ?? 0) + (kanban["En validation"]?.length ?? 0);
  const stats = [
    { label: "Projets actifs", value: String(PROJECTS.length), sub: blocked ? `dont ${blocked} bloqué${blocked > 1 ? "s" : ""}` : "aucun bloqué", Icon: Folder, color: "text-[#5267D9]" },
    { label: "Agents actifs", value: String(agents.length), sub: `${missionsInFlight} mission${missionsInFlight === 1 ? "" : "s"} en cours`, Icon: Bot, color: "text-green-600" },
    { label: "Interventions", value: String(INTERVENTIONS.length), sub: urgent ? `${urgent} urgente${urgent > 1 ? "s" : ""}` : "aucune urgente", Icon: Inbox, color: "text-orange-500" },
    { label: "PR en attente", value: String(openPrs), sub: `${prs.length} au total`, Icon: GitPullRequest, color: "text-purple-600" },
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-4">
        {stats.map(s => (
          <Glass key={s.label} className="p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] text-[#74716B] font-medium">{s.label}</span>
              <s.Icon size={14} className={s.color} strokeWidth={1.5} />
            </div>
            <div className="text-2xl font-semibold text-[#202124]">{s.value}</div>
            <div className="text-[10px] text-[#74716B] mt-0.5">{s.sub}</div>
          </Glass>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_300px] gap-4">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-[#202124]">Projets en cours</h2>
            <button onClick={onNewProject} className="text-[11px] text-[#5267D9] hover:underline flex items-center gap-1">
              <Plus size={11} />Nouveau projet
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {PROJECTS.map(p => <ProjectCard key={p.id} p={p} onClick={onOpenProject} />)}
          </div>
        </div>

        <div className="space-y-4">
          <Glass className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Inbox size={13} className="text-orange-500" strokeWidth={1.5} />
              <span className="text-[12px] font-semibold text-[#202124]">Interventions urgentes</span>
              <span className="ml-auto text-[10px] font-semibold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">{INTERVENTIONS.length}</span>
            </div>
            <div className="space-y-2">
              {INTERVENTIONS.slice(0, 2).map(i => (
                <div key={i.id} className="p-3 rounded-xl bg-[#F7F4EE] hover:bg-[#F0EDE7] cursor-pointer transition-colors">
                  <div className="flex items-start gap-2">
                    <div className={cn("w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0", i.urgency === "haute" ? "bg-orange-400" : "bg-blue-400")} />
                    <div>
                      <div className="text-[11px] font-medium text-[#202124] leading-snug">
                        {i.question.length > 62 ? i.question.slice(0, 62) + "…" : i.question}
                      </div>
                      <div className="text-[10px] text-[#74716B] mt-0.5">{i.project} · {i.time}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Glass>

          <Glass className="p-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-semibold text-[#202124]">Consommation</span>
              <span className="text-[10px] text-[#74716B]">7 jours</span>
            </div>
            <div className="text-xl font-semibold text-[#202124] mt-1">{`$${totalCost.toFixed(2)}`}</div>
            <div className="text-[10px] text-[#74716B] mb-2">{CONSUMPTION.length ? `sur ${CONSUMPTION.length} jour${CONSUMPTION.length > 1 ? "s" : ""} d'activité` : "aucune consommation enregistrée"}</div>
            <Bar2 value={Math.min(100, Math.round(totalCost))} />
            <div className="mt-4 h-20">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={CONSUMPTION} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#5267D9" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#5267D9" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="cost" stroke="#5267D9" strokeWidth={1.5} fill="url(#cg)" dot={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 9, fill: "#74716B" }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "white", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 10, fontSize: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}
                    formatter={(v: number) => [`€${v}`, "Coût"]}
                    labelStyle={{ color: "#74716B" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Glass>

          <Glass className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Cpu size={13} className="text-[#74716B]" strokeWidth={1.5} />
              <span className="text-[12px] font-semibold text-[#202124]">Providers</span>
            </div>
            <div className="space-y-2">
              {PROVIDERS.map(p => (
                <div key={p.name} className="flex items-center gap-2">
                  <StatusDot status={p.status} />
                  <span className="text-[11px] text-[#202124] flex-1 truncate">{p.name}</span>
                  <span className="text-[10px] text-[#74716B]">{p.latency}</span>
                  <span className={cn("text-[9px] font-medium px-1.5 py-0.5 rounded-full", p.rateLimit > 85 ? "bg-red-50 text-red-600" : p.rateLimit > 70 ? "bg-orange-50 text-orange-600" : "bg-green-50 text-green-700")}>
                    {p.rateLimit}%
                  </span>
                </div>
              ))}
            </div>
          </Glass>
        </div>
      </div>
    </div>
  );
}

// ─── INTERVENTIONS ────────────────────────────────────────────────────────────

function InterventionsScreen() {
  const { interventions: INTERVENTIONS, actions, mode } = useData();
  const [sel, setSel] = useState<number | null>(null);
  const [freeText, setFreeText] = useState("");
  const intervention = INTERVENTIONS.find(i => i.id === sel) ?? INTERVENTIONS[0];
  if (!intervention) {
    return (
      <div className="p-6 text-sm text-[#74716B]">Aucune intervention en attente. Les agents poursuivent leur travail de manière autonome.</div>
    );
  }
  return (
    <div className="flex gap-4 h-full">
      <div className="w-72 flex-shrink-0 space-y-2">
        <h2 className="text-[13px] font-semibold text-[#202124] mb-4">
          Interventions requises <span className="ml-1 text-orange-600 bg-orange-50 text-[10px] px-2 py-0.5 rounded-full">{INTERVENTIONS.length}</span>
        </h2>
        {INTERVENTIONS.map(i => (
          <div
            key={i.id} onClick={() => setSel(i.id)}
            className={cn(
              "p-4 rounded-2xl border cursor-pointer transition-all",
              sel === i.id ? "bg-white/90 border-[#5267D9]/25 shadow-sm" : "bg-white/50 border-black/[0.06] hover:bg-white/70",
            )}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", i.urgency === "haute" ? "bg-orange-50 text-orange-600" : "bg-blue-50 text-[#5267D9]")}>
                {i.urgency === "haute" ? "Urgent" : "Normal"}
              </span>
              <span className="text-[10px] text-[#74716B]">{i.project}</span>
            </div>
            <div className="text-[11px] font-medium text-[#202124] leading-snug">
              {i.question.length > 72 ? i.question.slice(0, 72) + "…" : i.question}
            </div>
            <div className="text-[10px] text-[#74716B] mt-1.5 flex items-center gap-1.5">
              <Clock size={9} /><span>{i.time}</span>
              {i.blockedAgents.length > 0 && <span className="text-orange-500">· {i.blockedAgents.length} agent(s) bloqué(s)</span>}
            </div>
          </div>
        ))}
      </div>

      <Glass className="flex-1 p-6 overflow-y-auto">
        <div className="flex items-start gap-3 mb-5">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] text-[#74716B] bg-[#F7F4EE] px-2 py-1 rounded-lg">{intervention.project}</span>
              <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", intervention.urgency === "haute" ? "bg-orange-50 text-orange-600" : "bg-blue-50 text-[#5267D9]")}>
                {intervention.urgency === "haute" ? "Urgent" : "Normal"}
              </span>
            </div>
            <h1 className="text-[14px] font-semibold text-[#202124] leading-snug max-w-xl">{intervention.question}</h1>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-[#F7F4EE] rounded-xl p-4">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Pourquoi cette question ?</div>
            <p className="text-[12px] text-[#202124] leading-relaxed">{intervention.reason}</p>
          </div>
          <div className="bg-[#F7F4EE] rounded-xl p-4">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Impact</div>
            <p className="text-[12px] text-[#202124] leading-relaxed">{intervention.impact}</p>
          </div>
        </div>

        {intervention.blockedAgents.length > 0 && (
          <div className="mb-4">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Agents bloqués</div>
            <div className="flex gap-2">
              {intervention.blockedAgents.map(a => (
                <span key={a} className="flex items-center gap-1.5 text-[11px] bg-red-50 text-red-600 border border-red-100 px-3 py-1.5 rounded-xl">
                  <Bot size={10} />{a}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mb-5">
          <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Options proposées</div>
          <div className="space-y-2">
            {intervention.options.map((opt, i) => (
              <div key={i} className={cn(
                "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all",
                opt === intervention.recommendation ? "bg-[#5267D9]/[0.04] border-[#5267D9]/25" : "bg-[#F7F4EE] border-transparent hover:border-black/10",
              )}>
                <div className={cn("w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center",
                  opt === intervention.recommendation ? "border-[#5267D9]" : "border-black/20"
                )}>
                  {opt === intervention.recommendation && <div className="w-2 h-2 rounded-full bg-[#5267D9]" />}
                </div>
                <span className="text-[12px] text-[#202124] flex-1">{opt}</span>
                {opt === intervention.recommendation && (
                  <span className="text-[9px] font-bold text-[#5267D9] bg-[#5267D9]/[0.08] px-2 py-0.5 rounded-full uppercase tracking-wide">Recommandé</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Réponse libre</div>
          <textarea
            className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl p-3 text-[12px] text-[#202124] placeholder:text-[#74716B] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15 resize-none"
            rows={3}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Ajoutez des précisions ou instructions supplémentaires..."
          />
        </div>

        <div className="flex gap-2.5">
          <button
            onClick={() => {
              if (mode !== "live") return;
              const apiId = (intervention as { apiId?: string }).apiId;
              if (apiId) void actions.answerIntervention(apiId, freeText || intervention.recommendation || "Approuvé", "approved");
              setFreeText("");
            }}
            className="flex items-center gap-2 bg-[#5267D9] text-white text-[12px] px-4 py-2.5 rounded-xl font-medium hover:bg-[#4255C4] transition-all">
            <CheckCircle size={13} />{freeText ? "Répondre" : "Répondre avec la recommandation"}
          </button>
          <button className="text-[12px] px-4 py-2.5 rounded-xl font-medium bg-white/80 border border-black/[0.07] text-[#202124] hover:bg-[#F7F4EE] transition-all">Reporter</button>
          <button
            onClick={() => {
              if (mode !== "live") return;
              const apiId = (intervention as { apiId?: string }).apiId;
              if (apiId) void actions.answerIntervention(apiId, freeText || "Refusé", "rejected");
              setFreeText("");
            }}
            className="text-[12px] px-4 py-2.5 rounded-xl font-medium text-red-500 hover:bg-red-50 transition-all">Refuser</button>
        </div>

        <div className="mt-4 text-[11px] text-[#74716B] bg-[#F7F4EE] px-3 py-2 rounded-xl flex items-center gap-2">
          <Zap size={11} className="text-[#5267D9]" />
          {"AvityOS reprendra automatiquement le projet avec cette décision."}
        </div>
      </Glass>
    </div>
  );
}

// ─── MISSIONS KANBAN ─────────────────────────────────────────────────────────

const COL_STYLES: Record<string, string> = {
  "À planifier": "bg-gray-100/50", "Prête": "bg-blue-50/50", "En cours": "bg-indigo-50/50",
  "En validation": "bg-purple-50/50", "PR ouverte": "bg-violet-50/50",
  "Bloquée": "bg-red-50/50", "Terminée": "bg-green-50/50",
};
const PRIO_STYLES: Record<string, string> = {
  critique: "bg-red-50 text-red-600", haute: "bg-orange-50 text-orange-600",
  normale: "bg-blue-50 text-[#5267D9]",
};
const TEST_STYLES: Record<string, string> = {
  passing: "text-green-600", running: "text-blue-500", pending: "text-[#74716B]", failed: "text-red-500",
};
const TEST_LABELS: Record<string, string> = {
  passing: "✓ tests", running: "⟳ tests", pending: "· tests", failed: "✗ tests",
};

function MissionsScreen() {
  const { kanban: KANBAN } = useData();
  const [sel, setSel] = useState<string | null>(null);
  const allCards = Object.values(KANBAN).flat();
  const selCard = allCards.find(c => c.id === sel);

  return (
    <div className="flex gap-4 h-full">
      <div className="flex-1 overflow-x-auto">
        <div className="flex gap-3 pb-4 min-w-max h-full">
          {Object.entries(KANBAN).map(([col, cards]) => (
            <div key={col} className={cn("w-60 rounded-2xl p-3 flex-shrink-0", COL_STYLES[col])}>
              <div className="flex items-center gap-2 mb-3 px-1">
                <span className="text-[11px] font-semibold text-[#202124]">{col}</span>
                <span className="text-[9px] text-[#74716B] bg-white/70 px-1.5 py-0.5 rounded-full">{cards.length}</span>
              </div>
              <div className="space-y-2">
                {cards.map(card => (
                  <div
                    key={card.id}
                    onClick={() => setSel(sel === card.id ? null : card.id)}
                    className={cn(
                      "bg-white/90 rounded-xl p-3 border cursor-pointer transition-all shadow-[0_1px_6px_rgba(0,0,0,0.04)]",
                      sel === card.id ? "border-[#5267D9]/30 shadow-[0_2px_12px_rgba(82,103,217,0.1)]" : "border-white/80 hover:border-black/10",
                    )}
                  >
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-[9px] font-mono text-[#74716B]">{card.id}</span>
                      <span className={cn("text-[8px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide", PRIO_STYLES[card.priority])}>{card.priority}</span>
                    </div>
                    <div className="text-[11px] font-medium text-[#202124] mb-2 leading-snug">{card.title}</div>
                    <div className="flex items-center gap-2 text-[9px] text-[#74716B]">
                      <span className="bg-[#F7F4EE] px-1.5 py-0.5 rounded">{card.team}</span>
                      {card.tests && <span className={TEST_STYLES[card.tests]}>{TEST_LABELS[card.tests]}</span>}
                    </div>
                    {card.agent !== "—" && (
                      <div className="mt-2 pt-2 border-t border-black/[0.04] flex items-center gap-1.5 text-[9px] text-[#74716B]">
                        <Bot size={9} strokeWidth={1.5} /><span>{card.agent}</span>
                      </div>
                    )}
                  </div>
                ))}
                <button className="w-full py-2 rounded-xl text-[10px] text-[#74716B] hover:text-[#202124] hover:bg-white/50 transition-all flex items-center justify-center gap-1">
                  <Plus size={10} />Ajouter
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {selCard && (
        <Glass className="w-72 flex-shrink-0 p-5 overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <span className="font-mono text-[10px] text-[#74716B]">{selCard.id}</span>
            <button onClick={() => setSel(null)} className="p-1 rounded-lg hover:bg-black/[0.04] text-[#74716B]"><X size={13} /></button>
          </div>
          <h3 className="text-[12px] font-semibold text-[#202124] mb-4 leading-snug">{selCard.title}</h3>
          <div className="space-y-3 text-[11px]">
            {[
              { label: "Équipe", value: selCard.team },
              { label: "Agent", value: selCard.agent },
              { label: "Priorité", value: selCard.priority },
              { label: "Durée estimée", value: selCard.duration },
            ].map(row => (
              <div key={row.label}>
                <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1">{row.label}</div>
                <span className="text-[#202124]">{row.value}</span>
              </div>
            ))}
            <div>
              <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1">Branche</div>
              <span className="font-mono text-[#202124] text-[10px]">{selCard.branch}</span>
            </div>
            {selCard.tests && (
              <div>
                <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1">Tests</div>
                <span className={cn("font-medium", TEST_STYLES[selCard.tests])}>
                  {selCard.tests === "passing" ? "✓ Tous les tests passent" : selCard.tests === "failed" ? "✗ Tests échoués" : selCard.tests === "running" ? "⟳ En cours" : "En attente"}
                </span>
              </div>
            )}
          </div>
          <div className="mt-5 pt-4 border-t border-black/[0.05] space-y-2">
            <button className="w-full flex items-center gap-2 justify-center text-[11px] bg-[#5267D9] text-white py-2 rounded-xl hover:bg-[#4255C4] transition-all">
              <Eye size={11} />Voir le terminal
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button className="flex items-center gap-1.5 justify-center text-[11px] bg-[#F7F4EE] text-[#202124] py-2 rounded-xl hover:bg-[#F0EDE7] transition-all"><Pause size={10} />Pause</button>
              <button className="flex items-center gap-1.5 justify-center text-[11px] bg-[#F7F4EE] text-orange-600 py-2 rounded-xl hover:bg-orange-50 transition-all"><RotateCcw size={10} />Relancer</button>
            </div>
          </div>
        </Glass>
      )}
    </div>
  );
}

// ─── PROVIDERS ───────────────────────────────────────────────────────────────

function ProvidersScreen() {
  const { providers: PROVIDERS, consumption: CONSUMPTION } = useData();
  const [period, setPeriod] = useState("Semaine");
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        {PROVIDERS.map(p => (
          <Glass key={p.name} className="p-5">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-[13px] font-semibold text-[#202124]">{p.name}</div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {p.models.map(m => (
                    <span key={m} className="text-[9px] font-mono bg-[#F7F4EE] text-[#74716B] px-1.5 py-0.5 rounded">{m}</span>
                  ))}
                </div>
              </div>
              <div className={cn("flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full", p.status === "healthy" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-600")}>
                <StatusDot status={p.status} />{p.status === "healthy" ? "Opérationnel" : "Dégradé"}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5 mb-4">
              {[
                { l: "Latence", v: p.latency },
                { l: "Tokens", v: p.tokens },
                { l: "Coût total", v: p.cost },
                { l: "Missions actives", v: String(p.missions) },
              ].map(s => (
                <div key={s.l} className="bg-[#F7F4EE] rounded-xl p-3">
                  <div className="text-[9px] text-[#74716B] mb-0.5">{s.l}</div>
                  <div className="text-[12px] font-semibold text-[#202124]">{s.v}</div>
                </div>
              ))}
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5 text-[10px]">
                <span className="text-[#74716B]">Rate limit utilisé</span>
                <span className={cn("font-semibold", p.rateLimit > 85 ? "text-red-500" : p.rateLimit > 70 ? "text-orange-500" : "text-[#202124]")}>{p.rateLimit}%</span>
              </div>
              <Bar2 value={p.rateLimit} color={p.rateLimit > 85 ? "bg-red-400" : p.rateLimit > 70 ? "bg-orange-400" : "bg-green-400"} />
            </div>
            <div className="mt-4 pt-4 border-t border-black/[0.05] flex items-center justify-between text-[10px]">
              <span className="flex items-center gap-1.5 text-[#74716B]"><Zap size={10} className="text-[#5267D9]" />Santé : {p.health}%</span>
              <button className="text-[#5267D9] hover:underline">Configurer</button>
            </div>
          </Glass>
        ))}
      </div>
      <Glass className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[13px] font-semibold text-[#202124]">Consommation tokens — par provider</h3>
          <div className="flex rounded-xl overflow-hidden border border-black/[0.07]">
            {["Aujourd'hui", "Semaine", "Mois"].map(t => (
              <button key={t} onClick={() => setPeriod(t)} className={cn("text-[10px] px-3 py-1.5 transition-all", period === t ? "bg-[#5267D9] text-white" : "bg-white/80 text-[#74716B] hover:bg-[#F7F4EE]")}>{t}</button>
            ))}
          </div>
        </div>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={CONSUMPTION} barSize={18}>
              <XAxis dataKey="day" tick={{ fontSize: 9, fill: "#74716B" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: "#74716B" }} axisLine={false} tickLine={false} width={28} />
              <Tooltip
                contentStyle={{ background: "white", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 10, fontSize: 10 }}
                formatter={(v: number) => [`${v}k tokens`, ""]}
              />
              <Bar dataKey="tokens" fill="#5267D9" radius={[4, 4, 0, 0]} fillOpacity={0.75} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Glass>
    </div>
  );
}

// ─── TERMINALS ───────────────────────────────────────────────────────────────

const SESSIONS = [
  { id: 1, agent: "Backend Mira", mission: "API REST facturation v2", provider: "Claude Sonnet 4.6", branch: "api/billing-v2", duration: "1h 23m", tokens: "112k", status: "execution" },
  { id: 2, agent: "Frontend Leo", mission: "Composants design system", provider: "GPT-4o", branch: "ui/components-v2", duration: "47m", tokens: "64k", status: "execution" },
  { id: 3, agent: "SecOps Rex", mission: "Audit authentification", provider: "DeepSeek R1", branch: "feat/open-banking", duration: "—", tokens: "78k", status: "blocked" },
  { id: 4, agent: "QA Nova", mission: "Tests end-to-end", provider: "Claude Sonnet 4.6", branch: "test/e2e", duration: "32m", tokens: "95k", status: "execution" },
];

function TerminalsScreen() {
  const { termOut: TERM_OUT } = useData();
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-[13px] font-semibold text-[#202124]">Sessions actives</h2>
        <span className="text-[10px] text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-medium">4 sessions</span>
        <div className="ml-auto">
          <button className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 bg-white/80 border border-black/[0.07] rounded-xl text-[#74716B] hover:bg-[#F7F4EE] transition-all">
            <Filter size={10} />Filtrer
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {SESSIONS.map((s, idx) => (
          <Glass key={s.id} className="overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-black/[0.06] bg-white/50">
              <StatusDot status={s.status} />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-semibold text-[#202124] truncate">{s.agent}</div>
                <div className="text-[9px] text-[#74716B] truncate">{s.mission}</div>
              </div>
              <div className="flex items-center gap-1 text-[9px] text-[#74716B]"><Clock size={9} /><span>{s.duration}</span></div>
              <div className="flex gap-0.5">
                <button className="p-1.5 rounded-lg hover:bg-black/[0.05] text-[#74716B] transition-all"><Pause size={10} /></button>
                <button className="p-1.5 rounded-lg hover:bg-black/[0.05] text-[#74716B] transition-all"><Square size={10} /></button>
                <button className="p-1.5 rounded-lg hover:bg-black/[0.05] text-[#74716B] transition-all"><ExternalLink size={10} /></button>
              </div>
            </div>
            <div className="bg-[#1C1C1E] p-4 h-44 overflow-y-auto font-mono text-[10px] leading-relaxed">
              {s.status === "blocked" ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <div className="text-orange-400 font-medium mb-1">⚠ Agent en attente</div>
                  <div className="text-gray-500 text-[9px]">En attente d'une décision utilisateur (API Finance)</div>
                  <button className="mt-3 text-[9px] bg-orange-500/20 text-orange-400 px-3 py-1 rounded-lg hover:bg-orange-500/30 transition-all">
                    Répondre maintenant
                  </button>
                </div>
              ) : (
                TERM_OUT.slice(0, idx === 1 ? 8 : idx === 3 ? 12 : TERM_OUT.length).map((line, i) => (
                  <div key={i} className={cn(
                    "whitespace-pre",
                    line.startsWith(">") ? "text-[#7B93FF]" :
                    line.startsWith("✓") || line.startsWith("PASS") || line.startsWith("All tests") ? "text-green-400" :
                    "text-[#A0A0A0]",
                  )}>
                    {line || " "}
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center gap-3 px-4 py-2 border-t border-black/[0.06] bg-white/30 text-[9px] text-[#74716B]">
              <span className="font-mono bg-[#F7F4EE] px-1.5 py-0.5 rounded text-[8px]">{s.branch}</span>
              <span>{s.provider}</span>
              <span className="ml-auto">{s.tokens} tokens</span>
            </div>
          </Glass>
        ))}
      </div>

      <Glass className="p-4 border !border-orange-200/60 !bg-orange-50/30">
        <div className="flex items-center gap-3">
          <AlertTriangle size={15} className="text-orange-500 flex-shrink-0" />
          <div className="flex-1">
            <div className="text-[12px] font-semibold text-orange-700">Rate limit atteint — DeepSeek (91%)</div>
            <div className="text-[11px] text-orange-600 mt-0.5">SecOps Rex suspendu. Réinitialisation dans 14 minutes. Bascule automatique disponible.</div>
          </div>
          <button className="text-[11px] font-medium bg-orange-500 text-white px-4 py-2 rounded-xl hover:bg-orange-600 transition-all flex-shrink-0">
            Basculer vers Claude
          </button>
        </div>
      </Glass>
    </div>
  );
}

// ─── CODE & PR ───────────────────────────────────────────────────────────────

function CodePRScreen() {
  const { prs: PRS, diff: DIFF } = useData();
  const [selIdx, setSelIdx] = useState(0);
  const selPR = PRS[selIdx] ?? PRS[0];
  if (!selPR) {
    return <div className="p-6 text-sm text-[#74716B]">Aucune pull request pour le moment.</div>;
  }
  return (
    <div className="flex gap-4 h-full">
      <div className="w-72 flex-shrink-0 space-y-2">
        <h2 className="text-[13px] font-semibold text-[#202124] mb-4">Pull Requests</h2>
        {PRS.map(pr => (
          <div
            key={pr.id} onClick={() => setSelIdx(PRS.indexOf(pr))}
            className={cn("p-4 rounded-2xl border cursor-pointer transition-all", selPR.id === pr.id ? "bg-white/90 border-[#5267D9]/25 shadow-sm" : "bg-white/50 border-black/[0.06] hover:bg-white/70")}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono text-[9px] text-[#74716B]">{pr.id}</span>
              <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide",
                pr.status === "merged" ? "bg-purple-50 text-purple-600" : pr.status === "approved" ? "bg-green-50 text-green-700" : "bg-blue-50 text-[#5267D9]"
              )}>
                {pr.status === "merged" ? "Fusionnée" : pr.status === "approved" ? "Approuvée" : "En review"}
              </span>
            </div>
            <div className="text-[11px] font-medium text-[#202124] leading-snug mb-2">
              {pr.title.length > 55 ? pr.title.slice(0, 55) + "…" : pr.title}
            </div>
            <div className="flex items-center gap-2 text-[9px] text-[#74716B]">
              <span>{pr.files} fichiers</span>
              <span className={cn("px-1.5 py-0.5 rounded", pr.risk === "faible" ? "bg-green-50 text-green-700" : pr.risk === "moyenne" ? "bg-orange-50 text-orange-600" : "bg-red-50 text-red-600")}>
                Risque {pr.risk}
              </span>
            </div>
          </div>
        ))}
      </div>

      <Glass className="flex-1 overflow-hidden flex flex-col">
        <div className="p-5 border-b border-black/[0.06]">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-[10px] text-[#74716B]">{selPR.id}</span>
            <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide",
              selPR.status === "merged" ? "bg-purple-100 text-purple-700" : selPR.status === "approved" ? "bg-green-100 text-green-700" : "bg-blue-100 text-[#5267D9]"
            )}>
              {selPR.status === "merged" ? "Fusionnée" : selPR.status === "approved" ? "Approuvée" : "En review"}
            </span>
          </div>
          <h3 className="text-[13px] font-semibold text-[#202124] mb-3">{selPR.title}</h3>
          <div className="flex flex-wrap gap-4 text-[10px] text-[#74716B]">
            <span className="flex items-center gap-1.5"><Bot size={10} />{selPR.agent}</span>
            <span className="flex items-center gap-1.5"><Eye size={10} />Review : {selPR.reviewer}</span>
            <span className="flex items-center gap-1.5"><GitBranch size={10} className="font-mono" />{selPR.branch}</span>
            <span className="flex items-center gap-1.5"><Code size={10} />{selPR.files} fichiers</span>
            <span className={cn("flex items-center gap-1.5", selPR.tests === "passing" ? "text-green-600" : "text-red-500")}>
              <CheckCircle size={10} />Tests {selPR.tests === "passing" ? "passent" : "échoués"}
            </span>
          </div>
          <div className="mt-3 text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-3 py-2 rounded-xl flex items-center gap-2">
            <Shield size={11} />
            <span>Un agent ne peut pas valider son propre travail — review indépendante par {selPR.reviewer}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto bg-[#1C1C1E] font-mono text-[10px] p-4">
          {DIFF.map((line, i) => (
            <div key={i} className={cn("px-2 py-0.5 leading-relaxed whitespace-pre",
              line.t === "add" ? "bg-green-900/40 text-green-300" :
              line.t === "del" ? "bg-red-900/40 text-red-300" :
              line.t === "meta" ? "text-blue-400" : "text-[#7A7A7A]"
            )}>
              {line.c}
            </div>
          ))}
        </div>
        {selPR.status !== "merged" && (
          <div className="p-4 border-t border-black/[0.06] flex gap-2.5">
            <button className="flex items-center gap-2 bg-green-500 text-white text-[11px] px-4 py-2 rounded-xl font-medium hover:bg-green-600 transition-all">
              <CheckCircle size={12} />Approuver et fusionner
            </button>
            <button className="text-[11px] px-4 py-2 rounded-xl border border-black/[0.07] bg-white/80 text-[#202124] hover:bg-[#F7F4EE] transition-all">
              Demander des corrections
            </button>
            <button className="ml-auto text-[11px] px-4 py-2 rounded-xl text-red-500 hover:bg-red-50 transition-all">Refuser</button>
          </div>
        )}
      </Glass>
    </div>
  );
}

// ─── TEAM ─────────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  execution: "En exécution", planning: "Planification", validation: "Validation",
  available: "Disponible", blocked: "Bloqué", offline: "Hors ligne",
};
const STATUS_STYLES: Record<string, string> = {
  execution: "bg-[#5267D9]/[0.08] text-[#5267D9]", planning: "bg-blue-50 text-blue-600",
  validation: "bg-purple-50 text-purple-600", available: "bg-green-50 text-green-700",
  blocked: "bg-red-50 text-red-600", offline: "bg-gray-50 text-gray-500",
};

function AgentNode({ agent, size = "md" }: { agent: Agent; size?: "sm" | "md" | "lg" }) {
  const dotColors: Record<string, string> = { execution: "bg-[#5267D9]", planning: "bg-blue-400", validation: "bg-purple-400", available: "bg-green-400", blocked: "bg-red-400", offline: "bg-gray-300" };
  const sz = { sm: { box: "w-8 h-8", icon: 13, name: "text-[9px]", role: "text-[8px]" }, md: { box: "w-10 h-10", icon: 16, name: "text-[10px]", role: "text-[9px]" }, lg: { box: "w-12 h-12", icon: 20, name: "text-[11px]", role: "text-[10px]" } }[size];
  return (
    <div className="flex flex-col items-center p-4 rounded-2xl border border-black/[0.07] bg-white/80 min-w-[130px] hover:shadow-md transition-all cursor-pointer">
      <div className={cn("rounded-xl bg-[#5267D9]/10 flex items-center justify-center mb-2 relative", sz.box)}>
        <Bot size={sz.icon} className="text-[#5267D9]" strokeWidth={1.5} />
        <div className={cn("absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-white", dotColors[agent.status])} />
      </div>
      <div className={cn("font-semibold text-[#202124] text-center", sz.name)}>{agent.name}</div>
      <div className={cn("text-[#74716B] text-center mt-0.5", sz.role)}>{agent.role}</div>
      {size !== "sm" && <div className="mt-1.5 text-[8px] font-mono text-[#74716B] bg-[#F7F4EE] px-1.5 py-0.5 rounded">{agent.model}</div>}
    </div>
  );
}

function TeamScreen() {
  const { agents: AGENTS } = useData();
  const [view, setView] = useState<"org" | "list">("org");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-[13px] font-semibold text-[#202124]">Équipe IA</h2>
        <span className="text-[10px] text-[#74716B] bg-[#F7F4EE] px-2 py-0.5 rounded-full">{AGENTS.length} agents</span>
        <div className="ml-auto flex rounded-xl overflow-hidden border border-black/[0.07]">
          {(["org", "list"] as const).map(v => (
            <button key={v} onClick={() => setView(v)} className={cn("text-[11px] px-4 py-1.5 transition-all", view === v ? "bg-[#5267D9] text-white" : "bg-white/80 text-[#74716B] hover:bg-[#F7F4EE]")}>
              {v === "org" ? "Organigramme" : "Liste"}
            </button>
          ))}
        </div>
      </div>

      {view === "org" ? (
        <Glass className="p-8">
          <div className="flex flex-col items-center gap-5">
            <AgentNode agent={AGENTS[0]} size="lg" />
            <div className="w-px h-5 bg-black/10" />
            <div className="flex gap-6">
              <AgentNode agent={AGENTS[1]} />
              <AgentNode agent={AGENTS[4]} />
            </div>
            <div className="w-full h-px bg-black/[0.06]" />
            <div className="flex gap-4 flex-wrap justify-center">
              {[AGENTS[2], AGENTS[3], AGENTS[5], AGENTS[6]].map(a => <AgentNode key={a.id} agent={a} size="sm" />)}
            </div>
          </div>
        </Glass>
      ) : (
        <div className="space-y-2">
          {AGENTS.map(a => (
            <Glass key={a.id} className="p-4">
              <div className="flex items-center gap-4">
                <div className="w-9 h-9 rounded-xl bg-[#5267D9]/10 flex items-center justify-center flex-shrink-0">
                  <Bot size={16} className="text-[#5267D9]" strokeWidth={1.5} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-[#202124]">{a.name}</span>
                    <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", STATUS_STYLES[a.status])}>
                      {STATUS_LABELS[a.status]}
                    </span>
                  </div>
                  <div className="text-[10px] text-[#74716B]">{a.role} · {a.model}</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-[#74716B]">{a.mission}</div>
                  <div className="text-[10px] text-[#74716B] font-mono mt-0.5">{a.context}</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-semibold text-green-600">{a.successRate}%</div>
                  <div className="text-[9px] text-[#74716B]">réussite</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-medium text-[#202124]">{a.cost}</div>
                  <div className="text-[9px] text-[#74716B]">ce mois</div>
                </div>
              </div>
            </Glass>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ACTIVITY ────────────────────────────────────────────────────────────────

function ActivityScreen() {
  const { activity: ACTIVITY_LOG } = useData();
  const rStyle: Record<string, string> = { success: "text-green-600", error: "text-red-500", blocked: "text-orange-500" };
  const rLabel: Record<string, string> = { success: "✓ Succès", error: "✗ Erreur", blocked: "⚠ Bloqué" };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-[#202124]">Journal d'activité</h2>
        <button className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 bg-white/80 border border-black/[0.07] rounded-xl text-[#74716B] hover:bg-[#F7F4EE] transition-all">
          <Filter size={10} />Filtres
        </button>
      </div>
      <Glass className="overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-[#F7F4EE]/50 border-b border-black/[0.06]">
              {["Heure", "Projet", "Agent", "Événement", "Action", "Résultat", "Coût"].map(h => (
                <th key={h} className="text-left px-4 py-3 text-[10px] text-[#74716B] font-semibold uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ACTIVITY_LOG.map((log, i) => (
              <tr key={i} className="border-b border-black/[0.04] hover:bg-[#F7F4EE]/20 transition-colors">
                <td className="px-4 py-3 font-mono text-[10px] text-[#74716B]">{log.time}</td>
                <td className="px-4 py-3 text-[11px] font-medium text-[#202124]">{log.project}</td>
                <td className="px-4 py-3 text-[10px] text-[#74716B]">{log.agent}</td>
                <td className="px-4 py-3 text-[11px] text-[#202124]">{log.event}</td>
                <td className="px-4 py-3 font-mono text-[9px] text-[#74716B] max-w-[200px] truncate">{log.action}</td>
                <td className="px-4 py-3"><span className={cn("text-[10px] font-semibold", rStyle[log.result])}>{rLabel[log.result]}</span></td>
                <td className="px-4 py-3 text-[10px] text-[#74716B]">{log.cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Glass>
    </div>
  );
}

// ─── PROJECT DETAIL ───────────────────────────────────────────────────────────

function ProjectDetailScreen({ onBack }: { onBack: () => void }) {
  const { projects: PROJECTS, agents: AGENTS, prs: PRS } = useData();
  const [tab, setTab] = useState("overview");
  const p = PROJECTS[0];
  if (!p) {
    return <div className="p-6 text-sm text-[#74716B]">Aucun projet. <button className="text-[#5267D9] underline" onClick={onBack}>Retour</button></div>;
  }
  const tabs = [
    { id: "overview", label: "Vue d'ensemble" },
    { id: "plan", label: "Plan" },
    { id: "missions", label: "Missions" },
    { id: "team", label: "Équipe" },
    { id: "code", label: "Code & PR" },
  ];
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-[11px] text-[#74716B] hover:text-[#202124] transition-colors">
        <ChevronLeft size={13} />Vue générale
      </button>
      <Glass className="p-5">
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-2xl bg-[#5267D9]/10 flex items-center justify-center flex-shrink-0">
            <Folder size={20} className="text-[#5267D9]" strokeWidth={1.5} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2.5 mb-1">
              <h1 className="text-[14px] font-semibold text-[#202124]">{p.name}</h1>
              <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-green-50 text-green-700 uppercase tracking-wide">Actif</span>
            </div>
            <p className="text-[11px] text-[#74716B]">{p.goal}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-[10px] text-[#74716B]">Progression</div>
              <div className="text-xl font-semibold text-[#202124]">{p.progress}%</div>
            </div>
            <button className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 bg-[#F7F4EE] border border-black/[0.07] rounded-xl text-[#74716B] hover:bg-[#F0EDE7] transition-all"><Pause size={10} />Pause</button>
            <button className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 bg-[#F7F4EE] border border-black/[0.07] rounded-xl text-[#74716B] hover:bg-[#F0EDE7] transition-all"><ExternalLink size={10} />Ouvrir</button>
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

      <div className="grid grid-cols-[1fr_264px] gap-4">
        <div className="space-y-4">
          <Glass className="p-5">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Brain size={11} className="text-[#5267D9]" />Résumé — Cerveau Central
            </div>
            <p className="text-[12px] text-[#202124] leading-relaxed">
              {"Le module de facturation est finalisé à 80 %. L'intégration Stripe webhooks est en cours (mission T-083). La migration de base de données v3 est bloquée en attente de validation du schéma. Les tests couvrent 74 % du code — objectif 85 % avant le checkpoint v0.3."}
            </p>
          </Glass>
          <Glass className="p-5">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-3">Agents actifs</div>
            <div className="space-y-2">
              {AGENTS.filter(a => a.project === p.name).map(a => (
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
          <Glass className="p-4">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-3">Prochaines étapes</div>
            <div className="space-y-2">
              {[
                { label: "Finaliser webhooks Stripe", s: "En cours" },
                { label: "Valider migration DB v3", s: "En attente" },
                { label: "Tests de charge API", s: "À planifier" },
                { label: "Review sécurité finale", s: "À planifier" },
              ].map((step, i) => (
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
          <Glass className="p-4">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-3">PR ouvertes</div>
            <div className="space-y-2">
              {PRS.filter(pr => pr.status !== "merged").map(pr => (
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
    </div>
  );
}

// ─── PROJECTS LIST ────────────────────────────────────────────────────────────

function ProjectsScreen({ onOpenProject, onNewProject }: { onOpenProject: () => void; onNewProject: () => void }) {
  const { projects: PROJECTS } = useData();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-[#202124]">Tous les projets</h2>
        <button onClick={onNewProject} className="flex items-center gap-1.5 bg-[#5267D9] text-white text-[11px] px-3.5 py-2 rounded-xl font-medium hover:bg-[#4255C4] transition-all">
          <Plus size={12} />Nouveau projet
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {PROJECTS.map(p => <ProjectCard key={p.id} p={p} onClick={onOpenProject} />)}
      </div>
    </div>
  );
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────

function SettingsScreen() {
  const sections = ["Profil", "Apparence", "Notifications", "GitHub", "Sécurité", "Permissions", "Politiques Git", "Providers", "Intégrations"];
  const [active, setActive] = useState("GitHub");
  const rules = [
    { label: "Reviews obligatoires avant fusion", on: true },
    { label: "Tests CI obligatoires avant merge", on: true },
    { label: "Fusion automatique si checks passent", on: false },
    { label: "Validation humaine pour la production", on: true },
    { label: "Protection de la branche principale", on: true },
  ];
  return (
    <div className="flex gap-5 h-full">
      <div className="w-44 flex-shrink-0">
        <h2 className="text-[12px] font-semibold text-[#202124] mb-3">Paramètres</h2>
        <div className="space-y-0.5">
          {sections.map(s => (
            <button key={s} onClick={() => setActive(s)} className={cn("w-full text-left text-[12px] px-3 py-2 rounded-xl transition-all",
              active === s ? "bg-[#5267D9]/[0.08] text-[#5267D9] font-medium" : "text-[#74716B] hover:text-[#202124] hover:bg-black/[0.04]"
            )}>{s}</button>
          ))}
        </div>
      </div>
      <Glass className="flex-1 p-6 overflow-y-auto">
        <h3 className="text-[13px] font-semibold text-[#202124] mb-5">{active}</h3>
        {active === "GitHub" ? (
          <div className="space-y-5">
            <div>
              <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Organisation GitHub</label>
              <div className="flex items-center gap-3 bg-[#F7F4EE] border border-black/[0.07] rounded-xl px-3 py-2.5">
                <CheckCircle size={13} className="text-green-500" />
                <span className="text-[12px] text-[#202124]">mon-organisation</span>
                <span className="ml-auto text-[10px] text-green-600 font-medium">Connecté</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Règles de protection</label>
              <div className="space-y-2">
                {rules.map(r => (
                  <div key={r.label} className="flex items-center justify-between p-3 bg-[#F7F4EE] rounded-xl">
                    <span className="text-[12px] text-[#202124]">{r.label}</span>
                    <div className={cn("w-9 h-5 rounded-full relative cursor-pointer transition-colors", r.on ? "bg-[#5267D9]" : "bg-gray-200")}>
                      <div className={cn("w-3.5 h-3.5 rounded-full bg-white shadow-sm absolute top-[3px] transition-all", r.on ? "left-[19px]" : "left-[3px]")} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-[#74716B]">Section disponible dans la version complète.</div>
        )}
      </Glass>
    </div>
  );
}

// ─── NEW PROJECT ──────────────────────────────────────────────────────────────

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { actions, mode } = useData();
  const [step, setStep] = useState(1);
  const [objectiveText, setObjectiveText] = useState("");
  const [projectName, setProjectName] = useState("");
  const [autonomy, setAutonomy] = useState("autonomous_with_checkpoints");
  const [submitState, setSubmitState] = useState<{ busy: boolean; detail: string | null }>({ busy: false, detail: null });
  const total = 3;
  const launch = async () => {
    if (mode !== "live") { onClose(); return; }
    setSubmitState({ busy: true, detail: null });
    const result = await actions.createProject({
      name: projectName || objectiveText.slice(0, 60) || "Nouveau projet",
      objective: objectiveText,
      autonomy,
      criteria: [],
    });
    setSubmitState({ busy: false, detail: result.detail });
    if (result.ok) setTimeout(onClose, 1200);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white/96 backdrop-blur-xl rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.18)] border border-white/90 overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-black/[0.06]">
          <div>
            <h2 className="text-[14px] font-semibold text-[#202124]">Nouveau projet</h2>
            <p className="text-[10px] text-[#74716B] mt-0.5">Étape {step} sur {total}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-black/[0.04] text-[#74716B]"><X size={15} /></button>
        </div>
        <div className="h-1 bg-black/[0.04]">
          <div className="h-full bg-[#5267D9] transition-all duration-500" style={{ width: `${(step / total) * 100}%` }} />
        </div>
        <div className="p-6">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-[12px] font-semibold text-[#202124] mb-2">Que voulez-vous construire ?</label>
                <textarea
                  className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl p-4 text-[12px] text-[#202124] placeholder:text-[#74716B] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15 resize-none leading-relaxed"
                  rows={4}
                  value={objectiveText}
                  onChange={(e) => setObjectiveText(e.target.value)}
                  placeholder="Ex: Une plateforme SaaS de gestion de projets avec authentification OAuth, facturation Stripe, tableau de bord en temps réel et API REST documentée avec tests complets..."
                />
                <p className="text-[10px] text-[#74716B] mt-1.5">Soyez précis — AvityOS adaptera le plan, l'équipe et les estimations.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Nom du projet</label>
                  <input value={projectName} onChange={(e) => setProjectName(e.target.value)} className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl px-3 py-2.5 text-[12px] text-[#202124] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15" placeholder="Mon Projet SaaS" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Priorité</label>
                  <select className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl px-3 py-2.5 text-[12px] text-[#202124] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15 appearance-none">
                    <option>Haute</option><option>Normale</option><option>Faible</option>
                  </select>
                </div>
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Niveau d'autonomie</label>
                <div className="space-y-2">
                  {[
                    { v: "supervised", l: "Supervisé", d: "Validation humaine à chaque étape importante" },
                    { v: "checkpoints", l: "Autonome avec checkpoints", d: "Validation aux milestones clés uniquement" },
                    { v: "max", l: "Autonomie maximale", d: "Livraison directe, interventions minimales" },
                  ].map(opt => (
                    <label key={opt.v} className="flex items-start gap-3 p-3.5 rounded-xl bg-[#F7F4EE] hover:bg-[#F0EDE7] cursor-pointer transition-all">
                      <input type="radio" name="autonomy" value={opt.v} className="mt-0.5 accent-[#5267D9]" defaultChecked={opt.v === "checkpoints"} />
                      <div>
                        <div className="text-[12px] font-medium text-[#202124]">{opt.l}</div>
                        <div className="text-[10px] text-[#74716B]">{opt.d}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Budget mensuel maximal (€)</label>
                <input type="number" defaultValue={500} className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl px-3 py-2.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Providers autorisés</label>
                <div className="flex flex-wrap gap-2">
                  {["Anthropic Claude", "OpenAI GPT-4o", "DeepSeek", "Cursor"].map(pr => (
                    <label key={pr} className="flex items-center gap-2 text-[11px] bg-[#F7F4EE] border border-black/[0.06] px-3 py-1.5 rounded-xl cursor-pointer hover:bg-[#F0EDE7] transition-all">
                      <input type="checkbox" defaultChecked className="accent-[#5267D9]" />{pr}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-4">
              <div className="bg-[#F7F4EE] rounded-xl p-4">
                <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2 flex items-center gap-1.5">
                  <Brain size={11} className="text-[#5267D9]" />Compréhension AvityOS
                </div>
                <p className="text-[12px] text-[#202124] leading-relaxed">
                  {"Je vais créer une plateforme SaaS complète avec authentification sécurisée, facturation Stripe, tableau de bord en temps réel et API REST documentée. Estimation : 3-4 semaines, équipe de 5 agents IA, budget ~€250-350."}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-green-50 rounded-xl p-3 border border-green-100">
                  <div className="text-[10px] font-semibold text-green-700 mb-1">Phase 1 proposée</div>
                  <div className="text-[11px] text-green-600">Architecture & Setup CI/CD (3 jours)</div>
                </div>
                <div className="bg-[#F7F4EE] rounded-xl p-3">
                  <div className="text-[10px] font-semibold text-[#74716B] mb-1">Estimation indicative</div>
                  <div className="text-[11px] text-[#202124]">€250-350 · 3-4 semaines</div>
                </div>
              </div>
              <div className="bg-amber-50 rounded-xl p-3 border border-amber-100">
                <div className="text-[10px] font-semibold text-amber-700 mb-1.5 flex items-center gap-1.5"><AlertTriangle size={10} />Risques identifiés</div>
                <ul className="text-[10px] text-amber-700 space-y-0.5 ml-4 list-disc">
                  <li>Conformité PCI-DSS pour les paiements (validation requise)</li>
                  <li>Scalabilité temps réel à anticiper dès la conception</li>
                </ul>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between p-6 border-t border-black/[0.06]">
          <button onClick={() => step > 1 && setStep(s => s - 1)} disabled={step === 1} className="text-[12px] px-4 py-2 rounded-xl text-[#74716B] hover:bg-[#F7F4EE] transition-all disabled:opacity-30">
            Retour
          </button>
          <div className="flex items-center gap-3">
            {submitState.detail && <span className="text-[11px] text-[#5267D9]">{submitState.detail}</span>}
            <button
              onClick={() => step < total ? setStep(s => s + 1) : void launch()}
              disabled={submitState.busy}
              className="flex items-center gap-2 bg-[#5267D9] text-white text-[12px] px-5 py-2.5 rounded-xl font-medium hover:bg-[#4255C4] transition-all disabled:opacity-50"
            >
              {step === total ? <><Zap size={13} />{submitState.busy ? "Lancement…" : "Lancer le projet"}</> : <>Continuer<ArrowRight size={13} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── COMMAND PALETTE ──────────────────────────────────────────────────────────

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  useEffect(() => { if (!open) setQ(""); }, [open]);
  if (!open) return null;
  const items = q ? CMD_ITEMS.filter(i => i.label.toLowerCase().includes(q.toLowerCase())) : CMD_ITEMS;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" />
      <div className="relative w-[540px] bg-white/96 backdrop-blur-xl rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.22)] border border-white/90 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-black/[0.07]">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 5C2 3.34 3.34 2 5 2s3 1.34 3 3-1.34 3-3 3-3-1.34-3-3zM7 7.5L11 11" stroke="#74716B" strokeWidth="1.4" strokeLinecap="round"/></svg>
          <input
            autoFocus value={q} onChange={e => setQ(e.target.value)}
            placeholder="Rechercher une commande..."
            className="flex-1 bg-transparent text-[13px] text-[#202124] placeholder:text-[#74716B] outline-none"
          />
          <kbd className="text-[9px] bg-black/[0.05] px-2 py-1 rounded font-mono text-[#74716B]">ESC</kbd>
        </div>
        <div className="py-1.5 max-h-72 overflow-y-auto">
          {items.map((item, i) => {
            const Icon = item.icon;
            return (
              <button key={i} className={cn("w-full flex items-center gap-3 px-4 py-2.5 text-[12px] transition-colors", i === 0 && !q ? "bg-[#5267D9]/[0.05]" : "hover:bg-[#F7F4EE]")}>
                <div className="w-6 h-6 rounded-lg bg-[#F7F4EE] flex items-center justify-center flex-shrink-0">
                  <Icon size={12} className="text-[#74716B]" strokeWidth={1.5} />
                </div>
                <span className="flex-1 text-left text-[#202124]">{item.label}</span>
                {"sub" in item && item.sub && <span className="text-[10px] text-[#74716B]">{item.sub}</span>}
                {"shortcut" in item && item.shortcut && <kbd className="text-[9px] bg-black/[0.05] px-1.5 py-0.5 rounded font-mono text-[#74716B]">⌘{item.shortcut}</kbd>}
              </button>
            );
          })}
        </div>
        <div className="px-4 py-2.5 border-t border-black/[0.06] flex items-center gap-4 text-[9px] text-[#74716B]">
          <span>↑↓ naviguer</span><span>↵ sélectionner</span><span>ESC fermer</span>
        </div>
      </div>
    </div>
  );
}

// ─── MACOS MENU BAR ───────────────────────────────────────────────────────────

function MacOSMenuBar() {
  const { agents, interventions } = useData();
  return (
    <div className="h-6 bg-black/35 backdrop-blur-md flex items-center px-4 select-none flex-shrink-0">
      <span className="text-white text-[12px] font-semibold mr-6">AvityOS</span>
      {["Fichier", "Projet", "Agents", "Affichage", "Aide"].map(m => (
        <span key={m} className="text-white/80 text-[11px] mr-5 hover:text-white cursor-default">{m}</span>
      ))}
      <div className="ml-auto flex items-center gap-5 text-[10px] text-white/75">
        <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />{`${agents.length} agent${agents.length === 1 ? "" : "s"} actif${agents.length === 1 ? "" : "s"}`}</span>
        <span>{`${interventions.length} intervention${interventions.length === 1 ? "" : "s"}`}</span>
        <span className="text-white/60">{new Date().toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}</span>
      </div>
    </div>
  );
}

// ─── AGENTS SCREEN ───────────────────────────────────────────────────────────

function AgentsScreen() {
  return <TeamScreen />;
}

// ─── APP ─────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <AuthGate>
      <DataProvider>
        <AppShell />
      </DataProvider>
    </AuthGate>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "ready" | "token">("checking");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.projects()
      .then(() => setState("ready"))
      .catch((err) => setState(err instanceof ApiRequestError && err.status === 401 ? "token" : "ready"));
  }, []);

  if (state === "ready") return <>{children}</>;
  if (state === "checking") {
    return <div className="min-h-screen bg-[#F2EFE8] grid place-items-center text-sm text-[#74716B]">Connexion sécurisée…</div>;
  }

  return (
    <main className="min-h-screen bg-[#F2EFE8] grid place-items-center p-6">
      <form
        className="w-full max-w-md bg-white/80 backdrop-blur-xl rounded-3xl border border-white shadow-[0_20px_80px_rgba(32,33,36,0.10)] p-8"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          api.login(token.trim())
            .then(() => api.projects())
            .then(() => { setToken(""); setState("ready"); })
            .catch((err) => setError((err as Error).message));
        }}
      >
        <div className="w-11 h-11 rounded-2xl bg-[#5267D9]/10 text-[#5267D9] grid place-items-center mb-5"><Lock size={20} /></div>
        <h1 className="text-xl font-semibold text-[#202124]">Connecter AvityOS</h1>
        <p className="text-sm text-[#74716B] mt-2 mb-6">Saisis le token généré au premier démarrage du control plane. Il sera échangé contre une session HTTP-only.</p>
        <label htmlFor="avity-token" className="block text-xs font-medium text-[#202124] mb-2">Token du control plane</label>
        <input
          id="avity-token"
          type="password"
          autoComplete="off"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="w-full rounded-xl border border-black/10 bg-white px-3.5 py-3 text-sm outline-none focus:border-[#5267D9]/50 focus:ring-2 focus:ring-[#5267D9]/10"
        />
        {error && <p role="alert" className="text-xs text-red-600 mt-3">{error}</p>}
        <button type="submit" className="w-full mt-5 rounded-xl bg-[#5267D9] text-white text-sm font-medium py-3 hover:bg-[#4255C4]">Se connecter</button>
      </form>
    </main>
  );
}

function AppShell() {
  const [screen, setScreen] = useState("mission-control");
  const [cmdK, setCmdK] = useState(false);
  const [macOS, setMacOS] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showProject, setShowProject] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setCmdK(v => !v); }
      if (e.key === "Escape") { setCmdK(false); setShowNewProject(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleNav = (s: string) => { setScreen(s); setShowProject(false); };

  const renderContent = () => {
    if (showProject) return <ProjectDetailScreen onBack={() => setShowProject(false)} />;
    switch (screen) {
      case "interventions": return <InterventionsScreen />;
      case "executions": return <TerminalsScreen />;
      case "github": return <CodePRScreen />;
      case "providers": return <ProvidersScreen />;
      case "activity": return <ActivityScreen />;
      case "agents": return <AgentsScreen />;
      case "settings": return <SettingsScreen />;
      case "projects": return <ProjectsScreen onOpenProject={() => setShowProject(true)} onNewProject={() => setShowNewProject(true)} />;
      default: return <MissionControl onNewProject={() => setShowNewProject(true)} onOpenProject={() => setShowProject(true)} />;
    }
  };

  const inner = (
    <div className="flex h-full bg-[#F7F4EE]" style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <Sidebar current={showProject ? "projects" : screen} onChange={handleNav} macOS={macOS} />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar
          screen={showProject ? "projects" : screen}
          onNewProject={() => setShowNewProject(true)}
          onCmdK={() => setCmdK(true)}
          macOS={macOS}
          onToggleMacOS={() => setMacOS(v => !v)}
        />
        <div className="flex-1 overflow-y-auto p-5">{renderContent()}</div>
      </div>
    </div>
  );

  return (
    <>
      {macOS ? (
        <div className="min-h-screen bg-gradient-to-br from-slate-400 via-slate-300 to-indigo-200 flex flex-col overflow-hidden">
          <MacOSMenuBar />
          <div className="flex-1 flex items-start justify-center p-5 pt-3 overflow-hidden">
            <div
              className="w-full rounded-2xl overflow-hidden shadow-[0_32px_80px_rgba(0,0,0,0.38),0_0_0_1px_rgba(255,255,255,0.12)] relative"
              style={{ maxWidth: 1440, height: "calc(100vh - 4.5rem)" }}
            >
              <div className="h-10 bg-white/88 backdrop-blur-xl border-b border-black/[0.08] flex items-center px-4 gap-3 select-none flex-shrink-0">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-[#FF5F57] shadow-[0_0_0_0.5px_rgba(0,0,0,0.1)] cursor-pointer hover:brightness-90" />
                  <div className="w-3 h-3 rounded-full bg-[#FEBC2E] shadow-[0_0_0_0.5px_rgba(0,0,0,0.1)] cursor-pointer hover:brightness-90" />
                  <div className="w-3 h-3 rounded-full bg-[#28C840] shadow-[0_0_0_0.5px_rgba(0,0,0,0.1)] cursor-pointer hover:brightness-90" />
                </div>
                <div className="flex-1 text-center text-[11px] text-[#74716B] font-medium">AvityOS</div>
              </div>
              <div style={{ height: "calc(100% - 40px)" }}>{inner}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="h-screen overflow-hidden">{inner}</div>
      )}

      <CommandPalette open={cmdK} onClose={() => setCmdK(false)} />
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} />}
    </>
  );
}
