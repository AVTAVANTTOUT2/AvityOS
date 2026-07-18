import { useState } from "react";
import { AlertTriangle, Clock, ExternalLink, Pause, Square } from "lucide-react";
import { useData } from "../../lib/data";
import { cn, Glass, StatusDot } from "../components/shared";

type SessionFilter = "all" | "running" | "blocked";

const FILTERS: { id: SessionFilter; label: string }[] = [
  { id: "all", label: "Toutes" },
  { id: "running", label: "En exécution" },
  { id: "blocked", label: "Bloquées" },
];

export function TerminalsScreen() {
  const { agents, kanban, providers, termOut: TERM_OUT } = useData();
  const [filter, setFilter] = useState<SessionFilter>("all");

  const sessions = agents.filter(a => a.mission !== "—");
  const shown = sessions.filter(a =>
    filter === "all" ? true : filter === "blocked" ? a.status === "blocked" : a.status !== "blocked",
  );
  const allCards = Object.values(kanban).flat();
  const branchFor = (name: string) => allCards.find(c => c.agent === name && c.branch !== "—")?.branch ?? "—";
  const saturated = providers.find(p => p.rateLimit > 85);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-[13px] font-semibold text-[#202124]">Sessions actives</h2>
        <span className="text-[10px] text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-medium">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex rounded-xl overflow-hidden border border-black/[0.07]">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn("text-[10px] px-3 py-1.5 transition-all", filter === f.id ? "bg-[#5267D9] text-white" : "bg-white/80 text-[#74716B] hover:bg-[#F7F4EE]")}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 && (
        <div className="p-6 text-sm text-[#74716B]">
          {sessions.length === 0 ? "Aucune session d'exécution en cours." : "Aucune session ne correspond au filtre."}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {shown.map(s => (
          <Glass key={s.id} className="overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-black/[0.06] bg-white/50">
              <StatusDot status={s.status} />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-semibold text-[#202124] truncate">{s.name}</div>
                <div className="text-[9px] text-[#74716B] truncate">{s.mission}</div>
              </div>
              <div className="flex items-center gap-1 text-[9px] text-[#74716B]"><Clock size={9} /><span>{s.project}</span></div>
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
                  <div className="text-gray-500 text-[9px]">En attente d'une décision utilisateur — voir Interventions</div>
                </div>
              ) : TERM_OUT.length === 0 ? (
                <div className="text-gray-500">Aucune sortie terminal disponible.</div>
              ) : (
                TERM_OUT.map((line, i) => (
                  <div key={i} className={cn(
                    "whitespace-pre",
                    line.startsWith(">") ? "text-[#7B93FF]" :
                    line.startsWith("✓") || line.startsWith("PASS") || line.startsWith("All tests") ? "text-green-400" :
                    "text-[#A0A0A0]",
                  )}>
                    {line || " "}
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center gap-3 px-4 py-2 border-t border-black/[0.06] bg-white/30 text-[9px] text-[#74716B]">
              <span className="font-mono bg-[#F7F4EE] px-1.5 py-0.5 rounded text-[8px]">{branchFor(s.name)}</span>
              <span>{s.model}</span>
              <span className="ml-auto">{s.context} tokens</span>
            </div>
          </Glass>
        ))}
      </div>

      {saturated && (
        <Glass className="p-4 border !border-orange-200/60 !bg-orange-50/30">
          <div className="flex items-center gap-3">
            <AlertTriangle size={15} className="text-orange-500 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-[12px] font-semibold text-orange-700">{`Rate limit élevé — ${saturated.name} (${saturated.rateLimit}%)`}</div>
              <div className="text-[11px] text-orange-600 mt-0.5">Le moteur bascule automatiquement vers un provider de repli si la limite est atteinte.</div>
            </div>
          </div>
        </Glass>
      )}
    </div>
  );
}
