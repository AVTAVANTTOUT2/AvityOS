import { useState } from "react";
import { Bot } from "lucide-react";
import type { Agent } from "../../demo/fixtures";
import { useData } from "../../lib/data";
import { cn, Glass } from "../components/shared";

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

export function TeamScreen() {
  const { agents: AGENTS } = useData();
  const [view, setView] = useState<"org" | "list">("org");
  const [lead, ...rest] = AGENTS;
  const midRow = rest.slice(0, 2);
  const bottomRow = rest.slice(2);
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

      {AGENTS.length === 0 ? (
        <div className="p-6 text-sm text-[#74716B]">Aucun agent actif pour le moment.</div>
      ) : view === "org" ? (
        <Glass className="p-8">
          <div className="flex flex-col items-center gap-5">
            {lead && <AgentNode agent={lead} size="lg" />}
            {midRow.length > 0 && (
              <>
                <div className="w-px h-5 bg-black/10" />
                <div className="flex gap-6">
                  {midRow.map(a => <AgentNode key={a.id} agent={a} />)}
                </div>
              </>
            )}
            {bottomRow.length > 0 && (
              <>
                <div className="w-full h-px bg-black/[0.06]" />
                <div className="flex gap-4 flex-wrap justify-center">
                  {bottomRow.map(a => <AgentNode key={a.id} agent={a} size="sm" />)}
                </div>
              </>
            )}
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
