import { Bot, Clock, GitBranch, TrendingUp, Zap } from "lucide-react";
import type { Project as ProjectCardData } from "../../demo/fixtures";
import { Bar2, cn, Glass } from "./shared";

export function ProjectCard({ p, onClick }: { p: ProjectCardData; onClick: () => void }) {
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
