import { useState } from "react";
import { AlertTriangle, ArrowRight, Brain, Minus, Plus, X, Zap } from "lucide-react";
import type { Project } from "../../demo/fixtures";
import { useData } from "../../lib/data";

const AUTONOMY_OPTIONS = [
  { v: "supervised", l: "Supervisé", d: "Validation humaine à chaque étape importante" },
  { v: "autonomous_with_checkpoints", l: "Autonome avec checkpoints", d: "Validation aux jalons clés uniquement" },
  { v: "maximum_autonomy", l: "Autonomie maximale", d: "Interventions limitées aux décisions matérielles" },
];

export function NewProjectModal({ onClose, project }: { onClose: () => void; project?: Project }) {
  const { actions, mode } = useData();
  const editing = Boolean(project);
  const [step, setStep] = useState(1);
  const [projectName, setProjectName] = useState(project?.name ?? "");
  const [objectiveText, setObjectiveText] = useState(project?.goal === "—" ? "" : project?.goal ?? "");
  const [criteria, setCriteria] = useState(project?.acceptanceCriteria.length ? project.acceptanceCriteria : [""]);
  const [repositoryMode, setRepositoryMode] = useState<"existing" | "none">(project?.repoPath ? "existing" : "none");
  const [repoPath, setRepoPath] = useState(project?.repoPath ?? "");
  const [repoRemoteUrl, setRepoRemoteUrl] = useState(project?.repoRemoteUrl ?? "");
  const [defaultBranch, setDefaultBranch] = useState(project?.branch ?? "main");
  const [autonomy, setAutonomy] = useState(project?.autonomyProfile ?? "autonomous_with_checkpoints");
  const [budget, setBudget] = useState(project?.budgetUsd === null || project?.budgetUsd === undefined ? "" : String(project.budgetUsd));
  const [warningPercent, setWarningPercent] = useState(String(Math.round((project?.budgetWarnAtFraction ?? 0.8) * 100)));
  const [submitState, setSubmitState] = useState<{ busy: boolean; detail: string | null }>({ busy: false, detail: null });
  const total = 3;

  const updateCriterion = (index: number, value: string) => {
    setCriteria((items) => items.map((item, i) => i === index ? value : item));
  };

  const validate = (): string | null => {
    if (!projectName.trim()) return "Le nom du projet est obligatoire.";
    if (!objectiveText.trim()) return "L'objectif est obligatoire.";
    if (criteria.every((criterion) => !criterion.trim())) return "Ajoutez au moins un critère d'acceptation.";
    if (repositoryMode === "existing" && !repoPath.trim()) return "Le chemin du dépôt est obligatoire en mode import.";
    if (!defaultBranch.trim()) return "La branche principale est obligatoire.";
    const budgetValue = budget.trim() === "" ? null : Number(budget);
    if (budgetValue !== null && (!Number.isFinite(budgetValue) || budgetValue < 0)) return "Le budget doit être un montant positif ou nul.";
    const warning = Number(warningPercent);
    if (budget.trim() !== "" && (!Number.isFinite(warning) || warning < 1 || warning > 100)) return "Le seuil d'alerte doit être compris entre 1 et 100 %.";
    return null;
  };

  const launch = async () => {
    const error = validate();
    if (error) {
      setSubmitState({ busy: false, detail: error });
      return;
    }
    if (mode !== "live") {
      setSubmitState({ busy: false, detail: "Connexion live requise pour persister le projet." });
      return;
    }
    const input = {
      name: projectName.trim(),
      objective: objectiveText.trim(),
      acceptanceCriteria: criteria.map((criterion) => criterion.trim()).filter(Boolean),
      autonomyProfile: autonomy,
      repoPath: repositoryMode === "existing" ? repoPath.trim() : null,
      repoRemoteUrl: repositoryMode === "existing" && repoRemoteUrl.trim() ? repoRemoteUrl.trim() : null,
      defaultBranch: defaultBranch.trim(),
      budgetUsd: budget.trim() === "" ? null : Number(budget),
      ...(budget.trim() === "" ? {} : { budgetWarnAtFraction: Number(warningPercent) / 100 }),
    };
    setSubmitState({ busy: true, detail: null });
    const result = editing
      ? await actions.updateProject(project!.apiId ?? String(project!.id), input)
      : await actions.createProject(input);
    setSubmitState({ busy: false, detail: result.detail });
    if (result.ok) setTimeout(onClose, 700);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white/96 backdrop-blur-xl rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.18)] border border-white/90 overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-black/[0.06]">
          <div>
            <h2 className="text-[14px] font-semibold text-[#202124]">{editing ? "Modifier le projet" : "Nouveau projet"}</h2>
            <p className="text-[10px] text-[#74716B] mt-0.5">Étape {step} sur {total}</p>
          </div>
          <button aria-label="Fermer" onClick={onClose} className="p-2 rounded-xl hover:bg-black/[0.04] text-[#74716B]"><X size={15} /></button>
        </div>
        <div className="h-1 bg-black/[0.04]">
          <div className="h-full bg-[#5267D9] transition-all duration-500" style={{ width: `${(step / total) * 100}%` }} />
        </div>
        <div className="p-6 max-h-[66vh] overflow-y-auto">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label htmlFor="project-name" className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Nom du projet</label>
                <input id="project-name" value={projectName} onChange={(e) => setProjectName(e.target.value)} className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl px-3 py-2.5 text-[12px]" placeholder="Mon Projet SaaS" />
              </div>
              <div>
                <label htmlFor="project-objective" className="block text-[12px] font-semibold text-[#202124] mb-2">Objectif</label>
                <textarea id="project-objective" className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl p-4 text-[12px] resize-none leading-relaxed" rows={4} value={objectiveText} onChange={(e) => setObjectiveText(e.target.value)} placeholder="Décrivez le résultat logiciel attendu…" />
              </div>
              <fieldset>
                <legend className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Critères d'acceptation</legend>
                <div className="space-y-2">
                  {criteria.map((criterion, index) => (
                    <div key={index} className="flex gap-2">
                      <label className="sr-only" htmlFor={`criterion-${index}`}>Critère d'acceptation {index + 1}</label>
                      <input id={`criterion-${index}`} value={criterion} onChange={(e) => updateCriterion(index, e.target.value)} className="flex-1 bg-[#F7F4EE] border border-black/[0.06] rounded-xl px-3 py-2.5 text-[12px]" placeholder="Comportement observable et testable" />
                      <button aria-label={`Supprimer le critère ${index + 1}`} disabled={criteria.length === 1} onClick={() => setCriteria((items) => items.filter((_, i) => i !== index))} className="p-2 text-[#74716B] disabled:opacity-30"><Minus size={14} /></button>
                    </div>
                  ))}
                </div>
                <button onClick={() => setCriteria((items) => [...items, ""])} className="mt-2 flex items-center gap-1 text-[10px] text-[#5267D9]"><Plus size={11} />Ajouter un critère</button>
              </fieldset>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <fieldset>
                <legend className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Dépôt</legend>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex gap-2 p-3 rounded-xl bg-[#F7F4EE] text-[11px]"><input type="radio" name="repository-mode" checked={repositoryMode === "existing"} onChange={() => setRepositoryMode("existing")} />Importer un dépôt existant</label>
                  <label className="flex gap-2 p-3 rounded-xl bg-[#F7F4EE] text-[11px]"><input type="radio" name="repository-mode" checked={repositoryMode === "none"} onChange={() => setRepositoryMode("none")} />Créer sans dépôt</label>
                </div>
              </fieldset>
              {repositoryMode === "existing" && (
                <>
                  <div><label htmlFor="repo-path" className="block text-[10px] font-semibold text-[#74716B] mb-1">Chemin local du dépôt</label><input id="repo-path" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} className="w-full bg-[#F7F4EE] rounded-xl px-3 py-2.5 text-[12px] font-mono" placeholder="/Users/me/code/project" /></div>
                  <div><label htmlFor="repo-remote" className="block text-[10px] font-semibold text-[#74716B] mb-1">Remote GitHub</label><input id="repo-remote" value={repoRemoteUrl} onChange={(e) => setRepoRemoteUrl(e.target.value)} className="w-full bg-[#F7F4EE] rounded-xl px-3 py-2.5 text-[12px] font-mono" placeholder="git@github.com:owner/repo.git" /></div>
                </>
              )}
              <div><label htmlFor="default-branch" className="block text-[10px] font-semibold text-[#74716B] mb-1">Branche principale</label><input id="default-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} className="w-full bg-[#F7F4EE] rounded-xl px-3 py-2.5 text-[12px] font-mono" /></div>
              <p className="text-[10px] text-[#74716B]">Le serveur résout le chemin, vérifie le dépôt Git, la branche locale et la correspondance du remote GitHub avant toute persistance.</p>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-4">
              <fieldset>
                <legend className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Niveau d'autonomie</legend>
                <div className="space-y-2">
                  {AUTONOMY_OPTIONS.map((option) => (
                    <label key={option.v} className="flex items-start gap-3 p-3 rounded-xl bg-[#F7F4EE] text-[11px]"><input type="radio" name="autonomy" checked={autonomy === option.v} onChange={() => setAutonomy(option.v)} /><span><strong className="block text-[#202124]">{option.l}</strong><span className="text-[#74716B]">{option.d}</span></span></label>
                  ))}
                </div>
              </fieldset>
              <div className={budget.trim() === "" ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3"}>
                <div><label htmlFor="budget" className="block text-[10px] font-semibold text-[#74716B] mb-1">Budget maximal (USD)</label><input id="budget" type="number" min="0" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} className="w-full bg-[#F7F4EE] rounded-xl px-3 py-2.5 text-[12px]" placeholder="Sans limite" /></div>
                {budget.trim() !== "" && <div><label htmlFor="budget-warning" className="block text-[10px] font-semibold text-[#74716B] mb-1">Seuil d'alerte (%)</label><input id="budget-warning" type="number" min="1" max="100" value={warningPercent} onChange={(e) => setWarningPercent(e.target.value)} className="w-full bg-[#F7F4EE] rounded-xl px-3 py-2.5 text-[12px]" /></div>}
              </div>
              <div className="bg-[#F7F4EE] rounded-xl p-4 text-[11px] text-[#202124]"><div className="flex items-center gap-1.5 font-semibold mb-1"><Brain size={11} className="text-[#5267D9]" />Configuration persistée</div>{repositoryMode === "existing" ? `Dépôt ${repoPath}, branche ${defaultBranch}.` : "Projet sans dépôt local."} {criteria.filter(Boolean).length} critère(s), budget {budget || "sans limite"}.</div>
              <div className="bg-amber-50 rounded-xl p-3 border border-amber-100 text-[10px] text-amber-700 flex gap-2"><AlertTriangle size={12} className="mt-0.5" />Une erreur serveur est affichée sans créer le projet si le dépôt, la branche ou le remote ne sont pas valides.</div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between p-6 border-t border-black/[0.06]">
          <button onClick={() => step > 1 && setStep((value) => value - 1)} disabled={step === 1} className="text-[12px] px-4 py-2 rounded-xl text-[#74716B] disabled:opacity-30">Retour</button>
          <div className="flex items-center gap-3">
            {submitState.detail && <span role="status" className="max-w-xs text-right text-[10px] text-[#5267D9]">{submitState.detail}</span>}
            <button onClick={() => step < total ? setStep((value) => value + 1) : void launch()} disabled={submitState.busy} className="flex items-center gap-2 bg-[#5267D9] text-white text-[12px] px-5 py-2.5 rounded-xl font-medium disabled:opacity-50">
              {step === total ? <><Zap size={13} />{submitState.busy ? "Enregistrement…" : editing ? "Enregistrer" : "Créer le projet"}</> : <>Continuer<ArrowRight size={13} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
