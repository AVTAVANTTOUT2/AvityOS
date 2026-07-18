import { useCallback, useEffect, useState } from "react";
import { Brain, RefreshCw } from "lucide-react";
import { api, type ApiBrainState } from "../../lib/api";
import { useData } from "../../lib/data";
import { cn, Glass } from "./shared";

const STATUS_LABELS: Record<string, string> = {
  idle: "Aucun objectif",
  clarifying: "Clarification requise",
  running: "Planification IA en cours",
  planned: "Plan actif persisté",
  blocked: "Bloqué — intervention requise",
  failed: "Échec de planification",
};

const STEP_LABELS: Record<string, string> = {
  analysis: "Analyse",
  architecture: "Architecture",
  plan: "Plan / DAG",
};

/**
 * Persisted state of the central AI brain. Everything shown here comes from
 * the control plane's durable tables (brain runs, plan versions, replans) —
 * no optimistic or invented state.
 */
export function BrainPanel({ projectId }: { projectId: string }) {
  const { mode } = useData();
  const [state, setState] = useState<ApiBrainState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (mode !== "live") return;
    api
      .brainState(projectId)
      .then((next) => {
        setState(next);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [projectId, mode]);

  useEffect(() => {
    load();
  }, [load]);

  if (mode === "demo") {
    return (
      <Glass className="p-5">
        <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <Brain size={11} className="text-[#5267D9]" />Cerveau du projet
        </div>
        <p className="text-[11px] text-[#74716B]">Mode Démo : l'état réel du cerveau n'est pas disponible.</p>
      </Glass>
    );
  }

  return (
    <Glass className="p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide flex items-center gap-1.5">
          <Brain size={11} className="text-[#5267D9]" />Cerveau du projet
        </div>
        <button onClick={load} className="inline-flex items-center gap-1 text-[10px] text-[#5267D9]">
          <RefreshCw size={10} />Rafraîchir
        </button>
      </div>
      {error && <p className="text-[11px] text-red-600">Erreur : {error}</p>}
      {!error && !state && <p className="text-[11px] text-[#74716B]">Chargement de l'état persisté…</p>}
      {state && (
        <div className="space-y-3 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[#202124]">{STATUS_LABELS[state.status] ?? state.status}</span>
            {state.currentStep && (
              <span className="text-[9px] px-2 py-0.5 rounded-full bg-[#5267D9]/10 text-[#5267D9]">
                {STEP_LABELS[state.currentStep] ?? state.currentStep}
              </span>
            )}
            {state.plan?.provenance === "fake_fixture" && (
              <span className="text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide bg-orange-50 text-orange-600">
                Fixture
              </span>
            )}
          </div>
          {state.plan ? (
            <div className="p-2.5 rounded-xl bg-[#F7F4EE]">
              <div className="text-[10px] text-[#74716B]">
                Plan v{state.plan.version}
                {state.plan.providerId && ` — ${state.plan.providerId}/${state.plan.model}`}
                {state.plan.snapshotHash && ` — snapshot ${state.plan.snapshotHash.slice(0, 8)}`}
              </div>
              <div className="text-[#202124] leading-snug">{state.plan.summary}</div>
              {state.plan.replanTrigger && (
                <div className="mt-1 text-[10px] text-orange-600">
                  Replanifié ({state.plan.replanTrigger}) : {state.plan.replanCause}
                </div>
              )}
            </div>
          ) : (
            <p className="text-[#74716B]">Aucun plan persisté pour l'objectif courant.</p>
          )}
          {state.analysis && (
            <div>
              <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1">Analyse persistée</div>
              <p className="text-[#202124] leading-snug">{state.analysis.summary}</p>
              <div className="text-[10px] text-[#74716B] mt-0.5">Faisabilité : {state.analysis.feasibility}</div>
              {state.analysis.risks.length > 0 && (
                <ul className="list-disc ml-4 mt-1 text-[10px] text-[#74716B]">
                  {state.analysis.risks.slice(0, 4).map((risk) => (
                    <li key={risk.title}>
                      {risk.title} ({risk.severity})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {state.architecture && (
            <div>
              <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1">Architecture proposée</div>
              <p className="text-[#202124] leading-snug">{state.architecture.overview.slice(0, 400)}</p>
            </div>
          )}
          <div>
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1">
              Exécutions du cerveau ({state.runs.length}) — dépendances : {state.dependencies.length} — replans : {state.replanCount}
            </div>
            <div className="space-y-1">
              {state.runs.length === 0 && <p className="text-[#74716B]">Aucune exécution persistée.</p>}
              {state.runs.slice(-6).map((run) => (
                <div key={run.id} className="flex items-center gap-2 text-[10px]">
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full flex-shrink-0",
                      run.state === "succeeded" ? "bg-green-500" : run.state === "failed" ? "bg-red-500" : "bg-orange-400",
                    )}
                  />
                  <span className="text-[#202124]">{STEP_LABELS[run.step] ?? run.step}</span>
                  <span className="text-[#74716B]">
                    {run.state} — tentative {run.attempt} — {run.providerId}/{run.model} [{run.provenance}]
                  </span>
                  {run.errorDetail && <span className="text-red-600 truncate">{run.errorDetail.slice(0, 80)}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Glass>
  );
}
