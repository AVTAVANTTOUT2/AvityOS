import {
  LayoutGrid, Folder, Inbox, Terminal, GitPullRequest,
  Cpu, Activity, Settings, Bot, TrendingUp,
} from "lucide-react";
import { useData } from "../../lib/data";
import { cn } from "./shared";

export const NAV = [
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

export function Sidebar({ current, onChange, macOS }: { current: string; onChange: (s: string) => void; macOS: boolean }) {
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
