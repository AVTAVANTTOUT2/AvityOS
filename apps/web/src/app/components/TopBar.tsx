import { Bell, Monitor, Plus, RefreshCw } from "lucide-react";
import { useData } from "../../lib/data";
import { cn } from "./shared";

export function TopBar({ screen, onNewProject, onCmdK, macOS, onToggleMacOS }: {
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
