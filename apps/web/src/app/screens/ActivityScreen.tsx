import { useState } from "react";
import { useData } from "../../lib/data";
import { cn, Glass } from "../components/shared";

type ResultFilter = "all" | "success" | "error" | "blocked";

const FILTERS: { id: ResultFilter; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "success", label: "Succès" },
  { id: "error", label: "Erreurs" },
  { id: "blocked", label: "Bloqués" },
];

export function ActivityScreen() {
  const { activity: ACTIVITY_LOG } = useData();
  const [filter, setFilter] = useState<ResultFilter>("all");
  const rStyle: Record<string, string> = { success: "text-green-600", error: "text-red-500", blocked: "text-orange-500" };
  const rLabel: Record<string, string> = { success: "✓ Succès", error: "✗ Erreur", blocked: "⚠ Bloqué" };
  const rows = filter === "all" ? ACTIVITY_LOG : ACTIVITY_LOG.filter(log => log.result === filter);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-[#202124]">Journal d'activité</h2>
        <div className="flex rounded-xl overflow-hidden border border-black/[0.07]">
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
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-[12px] text-[#74716B]">Aucun événement ne correspond au filtre.</td>
              </tr>
            )}
            {rows.map((log, i) => (
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
