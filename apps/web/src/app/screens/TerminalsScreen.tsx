import { useState } from "react";
import { AlertTriangle, Square } from "lucide-react";
import { useData } from "../../lib/data";
import { cn, Glass, StatusDot } from "../components/shared";

type SessionFilter = "all" | "active" | "finished";

const FILTERS: { id: SessionFilter; label: string }[] = [
  { id: "all", label: "Toutes" },
  { id: "active", label: "En cours" },
  { id: "finished", label: "Terminées" },
];

const ACTIVE_STATES = ["queued", "starting", "running", "cancelling", "paused"];

const STATE_LABELS: Record<string, string> = {
  queued: "En file", starting: "Démarrage", running: "En cours", paused: "En pause",
  cancelling: "Annulation…", succeeded: "Terminé", failed: "Échec",
  cancelled: "Annulé", timed_out: "Expiré",
};

const STATE_DOT: Record<string, string> = {
  queued: "planning", starting: "execution", running: "execution", paused: "warning",
  cancelling: "warning", succeeded: "good", failed: "error", cancelled: "offline", timed_out: "error",
};

export function TerminalsScreen() {
  const { terminals, providers, actions, mode } = useData();
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [feedback, setFeedback] = useState<string | null>(null);

  const isActive = (state: string) => ACTIVE_STATES.includes(state);
  const shown = terminals.filter(t =>
    filter === "all" ? true : filter === "active" ? isActive(t.state) : !isActive(t.state),
  );
  const saturated = providers.find(p => p.rateLimit > 85);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-[13px] font-semibold text-[#202124]">Sessions terminal</h2>
        <span className="text-[10px] text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-medium">
          {terminals.length} session{terminals.length === 1 ? "" : "s"}
        </span>
        {feedback && <span className="text-[10px] text-[#5267D9]">{feedback}</span>}
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
          {terminals.length === 0 ? "Aucune session terminal enregistrée." : "Aucune session ne correspond au filtre."}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {shown.map(t => {
          const cancellable = mode === "live" && isActive(t.state);
          return (
            <Glass key={t.id} className="overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 border-b border-black/[0.06] bg-white/50">
                <StatusDot status={STATE_DOT[t.state] ?? "offline"} />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold text-[#202124] font-mono truncate">{t.command}</div>
                  <div className="text-[9px] text-[#74716B] truncate">{t.project}</div>
                </div>
                <span className="text-[9px] text-[#74716B]">{STATE_LABELS[t.state] ?? t.state}</span>
                <button
                  disabled={!cancellable}
                  title={cancellable ? "Annuler cette session" : mode === "live" ? "Session déjà terminée" : "Disponible uniquement connecté au control plane"}
                  aria-label={`Annuler ${t.command}`}
                  onClick={async () => {
                    const r = await actions.cancelTerminal(t.id);
                    setFeedback(r.detail);
                  }}
                  className="p-1.5 rounded-lg text-[#74716B] transition-all enabled:hover:bg-black/[0.05] enabled:hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Square size={10} />
                </button>
              </div>
              <div className="bg-[#1C1C1E] p-4 h-44 overflow-y-auto font-mono text-[10px] leading-relaxed">
                {t.logs.length === 0 ? (
                  <div className="text-gray-500">Aucune sortie pour cette session.</div>
                ) : (
                  t.logs.map((line, i) => (
                    <div key={i} className={cn(
                      "whitespace-pre",
                      line.startsWith(">") ? "text-[#7B93FF]" :
                      line.startsWith("✓") || line.startsWith("PASS") || line.startsWith("All tests") ? "text-green-400" :
                      line.startsWith("✗") ? "text-red-400" :
                      "text-[#A0A0A0]",
                    )}>
                      {line || " "}
                    </div>
                  ))
                )}
              </div>
              <div className="flex items-center gap-3 px-4 py-2 border-t border-black/[0.06] bg-white/30 text-[9px] text-[#74716B]">
                <span className="font-mono bg-[#F7F4EE] px-1.5 py-0.5 rounded text-[8px]">{t.id}</span>
                <span>{t.logs.length} ligne{t.logs.length === 1 ? "" : "s"}</span>
                <span className="ml-auto">{t.exitCode !== null ? `code de sortie ${t.exitCode}` : STATE_LABELS[t.state] ?? t.state}</span>
              </div>
            </Glass>
          );
        })}
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
