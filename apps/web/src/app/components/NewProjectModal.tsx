import { useState } from "react";
import { AlertTriangle, ArrowRight, Brain, X, Zap } from "lucide-react";
import { useData } from "../../lib/data";
import { cn } from "./shared";

const AUTONOMY_OPTIONS = [
  { v: "supervised", l: "Supervisé", d: "Validation humaine à chaque étape importante" },
  { v: "autonomous_with_checkpoints", l: "Autonome avec checkpoints", d: "Validation aux milestones clés uniquement" },
  { v: "maximum_autonomy", l: "Autonomie maximale", d: "Livraison directe, interventions minimales" },
];

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { actions, mode } = useData();
  const [step, setStep] = useState(1);
  const [objectiveText, setObjectiveText] = useState("");
  const [projectName, setProjectName] = useState("");
  const [autonomy, setAutonomy] = useState("autonomous_with_checkpoints");
  const [submitState, setSubmitState] = useState<{ busy: boolean; detail: string | null }>({ busy: false, detail: null });
  const total = 3;
  const launch = async () => {
    if (mode !== "live") { onClose(); return; }
    setSubmitState({ busy: true, detail: null });
    const result = await actions.createProject({
      name: projectName || objectiveText.slice(0, 60) || "Nouveau projet",
      objective: objectiveText,
      autonomy,
      criteria: [],
    });
    setSubmitState({ busy: false, detail: result.detail });
    if (result.ok) setTimeout(onClose, 1200);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white/96 backdrop-blur-xl rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.18)] border border-white/90 overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-black/[0.06]">
          <div>
            <h2 className="text-[14px] font-semibold text-[#202124]">Nouveau projet</h2>
            <p className="text-[10px] text-[#74716B] mt-0.5">Étape {step} sur {total}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-black/[0.04] text-[#74716B]"><X size={15} /></button>
        </div>
        <div className="h-1 bg-black/[0.04]">
          <div className="h-full bg-[#5267D9] transition-all duration-500" style={{ width: `${(step / total) * 100}%` }} />
        </div>
        <div className="p-6">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-[12px] font-semibold text-[#202124] mb-2">Que voulez-vous construire ?</label>
                <textarea
                  className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl p-4 text-[12px] text-[#202124] placeholder:text-[#74716B] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15 resize-none leading-relaxed"
                  rows={4}
                  value={objectiveText}
                  onChange={(e) => setObjectiveText(e.target.value)}
                  placeholder="Ex: Une plateforme SaaS de gestion de projets avec authentification OAuth, facturation Stripe, tableau de bord en temps réel et API REST documentée avec tests complets..."
                />
                <p className="text-[10px] text-[#74716B] mt-1.5">Soyez précis — AvityOS adaptera le plan, l'équipe et les estimations.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Nom du projet</label>
                  <input value={projectName} onChange={(e) => setProjectName(e.target.value)} className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl px-3 py-2.5 text-[12px] text-[#202124] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15" placeholder="Mon Projet SaaS" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Priorité</label>
                  <select className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl px-3 py-2.5 text-[12px] text-[#202124] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15 appearance-none">
                    <option>Haute</option><option>Normale</option><option>Faible</option>
                  </select>
                </div>
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Niveau d'autonomie</label>
                <div className="space-y-2">
                  {AUTONOMY_OPTIONS.map(opt => (
                    <label key={opt.v} className="flex items-start gap-3 p-3.5 rounded-xl bg-[#F7F4EE] hover:bg-[#F0EDE7] cursor-pointer transition-all">
                      <input
                        type="radio"
                        name="autonomy"
                        value={opt.v}
                        className="mt-0.5 accent-[#5267D9]"
                        checked={autonomy === opt.v}
                        onChange={() => setAutonomy(opt.v)}
                      />
                      <div>
                        <div className="text-[12px] font-medium text-[#202124]">{opt.l}</div>
                        <div className="text-[10px] text-[#74716B]">{opt.d}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Budget mensuel maximal (€)</label>
                <input type="number" defaultValue={500} className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl px-3 py-2.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Providers autorisés</label>
                <div className="flex flex-wrap gap-2">
                  {["Anthropic Claude", "OpenAI GPT-4o", "DeepSeek", "Cursor"].map(pr => (
                    <label key={pr} className="flex items-center gap-2 text-[11px] bg-[#F7F4EE] border border-black/[0.06] px-3 py-1.5 rounded-xl cursor-pointer hover:bg-[#F0EDE7] transition-all">
                      <input type="checkbox" defaultChecked className="accent-[#5267D9]" />{pr}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-4">
              <div className="bg-[#F7F4EE] rounded-xl p-4">
                <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2 flex items-center gap-1.5">
                  <Brain size={11} className="text-[#5267D9]" />Récapitulatif
                </div>
                <p className="text-[12px] text-[#202124] leading-relaxed">
                  {objectiveText
                    ? `« ${objectiveText.slice(0, 220)}${objectiveText.length > 220 ? "…" : ""} »`
                    : "Aucun objectif saisi — revenez à l'étape 1 pour décrire ce que vous voulez construire."}
                </p>
                <p className="text-[11px] text-[#74716B] mt-2">
                  Mode : {AUTONOMY_OPTIONS.find(o => o.v === autonomy)?.l}. L'objectif sera soumis au control plane,
                  qui pourra demander des clarifications avant de planifier.
                </p>
              </div>
              <div className="bg-amber-50 rounded-xl p-3 border border-amber-100">
                <div className="text-[10px] font-semibold text-amber-700 mb-1.5 flex items-center gap-1.5"><AlertTriangle size={10} />À savoir</div>
                <ul className="text-[10px] text-amber-700 space-y-0.5 ml-4 list-disc">
                  <li>Les estimations de durée et de coût seront produites lors de la planification.</li>
                  <li>Les clarifications éventuelles apparaîtront dans Interventions.</li>
                </ul>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between p-6 border-t border-black/[0.06]">
          <button onClick={() => step > 1 && setStep(s => s - 1)} disabled={step === 1} className="text-[12px] px-4 py-2 rounded-xl text-[#74716B] hover:bg-[#F7F4EE] transition-all disabled:opacity-30">
            Retour
          </button>
          <div className="flex items-center gap-3">
            {submitState.detail && <span className="text-[11px] text-[#5267D9]">{submitState.detail}</span>}
            <button
              onClick={() => step < total ? setStep(s => s + 1) : void launch()}
              disabled={submitState.busy}
              className="flex items-center gap-2 bg-[#5267D9] text-white text-[12px] px-5 py-2.5 rounded-xl font-medium hover:bg-[#4255C4] transition-all disabled:opacity-50"
            >
              {step === total ? <><Zap size={13} />{submitState.busy ? "Lancement…" : "Lancer le projet"}</> : <>Continuer<ArrowRight size={13} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
