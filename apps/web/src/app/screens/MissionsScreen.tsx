import { useState } from "react";
import { Bot, Eye, Pause, Plus, RotateCcw, X } from "lucide-react";
import { useData } from "../../lib/data";
import { cn, Glass } from "../components/shared";

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

export function MissionsScreen() {
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
