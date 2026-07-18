import { useState } from "react";
import { Bot, CheckCircle, Clock, Zap } from "lucide-react";
import { useData } from "../../lib/data";
import { cn, Glass } from "../components/shared";

export function InterventionsScreen() {
  const { interventions: INTERVENTIONS, actions, mode } = useData();
  const [sel, setSel] = useState<number | null>(null);
  const [freeText, setFreeText] = useState("");
  const intervention = INTERVENTIONS.find(i => i.id === sel) ?? INTERVENTIONS[0];
  if (!intervention) {
    return (
      <div className="p-6 text-sm text-[#74716B]">Aucune intervention en attente. Les agents poursuivent leur travail de manière autonome.</div>
    );
  }
  return (
    <div className="flex gap-4 h-full">
      <div className="w-72 flex-shrink-0 space-y-2">
        <h2 className="text-[13px] font-semibold text-[#202124] mb-4">
          Interventions requises <span className="ml-1 text-orange-600 bg-orange-50 text-[10px] px-2 py-0.5 rounded-full">{INTERVENTIONS.length}</span>
        </h2>
        {INTERVENTIONS.map(i => (
          <div
            key={i.id} onClick={() => setSel(i.id)}
            className={cn(
              "p-4 rounded-2xl border cursor-pointer transition-all",
              sel === i.id ? "bg-white/90 border-[#5267D9]/25 shadow-sm" : "bg-white/50 border-black/[0.06] hover:bg-white/70",
            )}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", i.urgency === "haute" ? "bg-orange-50 text-orange-600" : "bg-blue-50 text-[#5267D9]")}>
                {i.urgency === "haute" ? "Urgent" : "Normal"}
              </span>
              <span className="text-[10px] text-[#74716B]">{i.project}</span>
            </div>
            <div className="text-[11px] font-medium text-[#202124] leading-snug">
              {i.question.length > 72 ? i.question.slice(0, 72) + "…" : i.question}
            </div>
            <div className="text-[10px] text-[#74716B] mt-1.5 flex items-center gap-1.5">
              <Clock size={9} /><span>{i.time}</span>
              {i.blockedAgents.length > 0 && <span className="text-orange-500">· {i.blockedAgents.length} agent(s) bloqué(s)</span>}
            </div>
          </div>
        ))}
      </div>

      <Glass className="flex-1 p-6 overflow-y-auto">
        <div className="flex items-start gap-3 mb-5">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] text-[#74716B] bg-[#F7F4EE] px-2 py-1 rounded-lg">{intervention.project}</span>
              <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", intervention.urgency === "haute" ? "bg-orange-50 text-orange-600" : "bg-blue-50 text-[#5267D9]")}>
                {intervention.urgency === "haute" ? "Urgent" : "Normal"}
              </span>
            </div>
            <h1 className="text-[14px] font-semibold text-[#202124] leading-snug max-w-xl">{intervention.question}</h1>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-[#F7F4EE] rounded-xl p-4">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Pourquoi cette question ?</div>
            <p className="text-[12px] text-[#202124] leading-relaxed">{intervention.reason}</p>
          </div>
          <div className="bg-[#F7F4EE] rounded-xl p-4">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Impact</div>
            <p className="text-[12px] text-[#202124] leading-relaxed">{intervention.impact}</p>
          </div>
        </div>

        {intervention.blockedAgents.length > 0 && (
          <div className="mb-4">
            <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Agents bloqués</div>
            <div className="flex gap-2">
              {intervention.blockedAgents.map(a => (
                <span key={a} className="flex items-center gap-1.5 text-[11px] bg-red-50 text-red-600 border border-red-100 px-3 py-1.5 rounded-xl">
                  <Bot size={10} />{a}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mb-5">
          <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Options proposées</div>
          <div className="space-y-2">
            {intervention.options.map((opt, i) => (
              <div key={i} className={cn(
                "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all",
                opt === intervention.recommendation ? "bg-[#5267D9]/[0.04] border-[#5267D9]/25" : "bg-[#F7F4EE] border-transparent hover:border-black/10",
              )}>
                <div className={cn("w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center",
                  opt === intervention.recommendation ? "border-[#5267D9]" : "border-black/20"
                )}>
                  {opt === intervention.recommendation && <div className="w-2 h-2 rounded-full bg-[#5267D9]" />}
                </div>
                <span className="text-[12px] text-[#202124] flex-1">{opt}</span>
                {opt === intervention.recommendation && (
                  <span className="text-[9px] font-bold text-[#5267D9] bg-[#5267D9]/[0.08] px-2 py-0.5 rounded-full uppercase tracking-wide">Recommandé</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Réponse libre</div>
          <textarea
            className="w-full bg-[#F7F4EE] border border-black/[0.06] rounded-xl p-3 text-[12px] text-[#202124] placeholder:text-[#74716B] focus:outline-none focus:ring-2 focus:ring-[#5267D9]/15 resize-none"
            rows={3}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Ajoutez des précisions ou instructions supplémentaires..."
          />
        </div>

        <div className="flex gap-2.5">
          <button
            onClick={() => {
              if (mode !== "live") return;
              const apiId = (intervention as { apiId?: string }).apiId;
              if (apiId) void actions.answerIntervention(apiId, freeText || intervention.recommendation || "Approuvé", "approved");
              setFreeText("");
            }}
            className="flex items-center gap-2 bg-[#5267D9] text-white text-[12px] px-4 py-2.5 rounded-xl font-medium hover:bg-[#4255C4] transition-all">
            <CheckCircle size={13} />{freeText ? "Répondre" : "Répondre avec la recommandation"}
          </button>
          <button className="text-[12px] px-4 py-2.5 rounded-xl font-medium bg-white/80 border border-black/[0.07] text-[#202124] hover:bg-[#F7F4EE] transition-all">Reporter</button>
          <button
            onClick={() => {
              if (mode !== "live") return;
              const apiId = (intervention as { apiId?: string }).apiId;
              if (apiId) void actions.answerIntervention(apiId, freeText || "Refusé", "rejected");
              setFreeText("");
            }}
            className="text-[12px] px-4 py-2.5 rounded-xl font-medium text-red-500 hover:bg-red-50 transition-all">Refuser</button>
        </div>

        <div className="mt-4 text-[11px] text-[#74716B] bg-[#F7F4EE] px-3 py-2 rounded-xl flex items-center gap-2">
          <Zap size={11} className="text-[#5267D9]" />
          {"AvityOS reprendra automatiquement le projet avec cette décision."}
        </div>
      </Glass>
    </div>
  );
}
