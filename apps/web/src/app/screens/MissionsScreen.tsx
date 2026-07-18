import { useState } from "react";
import { Bot, Pause, Play, X, XCircle } from "lucide-react";
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

export function MissionsScreen({ project }: { project?: string }) {
  const { kanban: KANBAN, actions, mode } = useData();
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const columns = Object.fromEntries(
    Object.entries(KANBAN).map(([col, cards]) => [col, project ? cards.filter(c => c.project === project) : cards]),
  );
  const allCards = Object.values(columns).flat();
  const selCard = allCards.find(c => c.id === sel);

  const runTransition = async (apiId: string, to: string) => {
    setBusy(true);
    const result = await actions.transitionMission(apiId, to);
    setBusy(false);
    setFeedback(result.detail);
  };

  return (
    <div className="flex gap-4 h-full">
      <div className="flex-1 overflow-x-auto">
        <div className="flex gap-3 pb-4 min-w-max h-full">
          {Object.entries(columns).map(([col, cards]) => (
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
          <MissionActions
            apiId={selCard.apiId}
            state={selCard.state}
            live={mode === "live"}
            busy={busy}
            feedback={feedback}
            onTransition={runTransition}
          />
        </Glass>
      )}
    </div>
  );
}

const PAUSABLE_STATES = ["ready", "assigned", "running"];
const TERMINAL_STATES = ["completed", "cancelled"];

function MissionActions({ apiId, state, live, busy, feedback, onTransition }: {
  apiId?: string;
  state?: string;
  live: boolean;
  busy: boolean;
  feedback: string | null;
  onTransition: (apiId: string, to: string) => void;
}) {
  const canAct = live && !!apiId && !!state;
  const offTitle = live ? "État de mission inconnu" : "Disponible uniquement connecté au control plane";
  const resumable = state === "paused";
  const pausable = !!state && PAUSABLE_STATES.includes(state);
  const cancellable = !!state && !TERMINAL_STATES.includes(state);
  return (
    <div className="mt-5 pt-4 border-t border-black/[0.05] space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          disabled={!canAct || busy || (!pausable && !resumable)}
          title={canAct ? (pausable || resumable ? undefined : `Transition indisponible depuis l'état « ${state} »`) : offTitle}
          onClick={() => apiId && onTransition(apiId, resumable ? "ready" : "paused")}
          className="flex items-center gap-1.5 justify-center text-[11px] bg-[#F7F4EE] text-[#202124] py-2 rounded-xl transition-all enabled:hover:bg-[#F0EDE7] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {resumable ? <><Play size={10} />Reprendre</> : <><Pause size={10} />Pause</>}
        </button>
        <button
          disabled={!canAct || busy || !cancellable}
          title={canAct ? (cancellable ? undefined : "Mission déjà terminée") : offTitle}
          onClick={() => apiId && onTransition(apiId, "cancelled")}
          className="flex items-center gap-1.5 justify-center text-[11px] bg-[#F7F4EE] text-red-500 py-2 rounded-xl transition-all enabled:hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <XCircle size={10} />Annuler
        </button>
      </div>
      {feedback && <div className="text-[10px] text-[#74716B]">{feedback}</div>}
      {!canAct && (
        <div className="text-[10px] text-[#74716B]">Actions de mission disponibles uniquement en mode live.</div>
      )}
    </div>
  );
}
