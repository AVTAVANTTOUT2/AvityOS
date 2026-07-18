import { useState } from "react";
import { Bot, CheckCircle, Code, Eye, GitBranch, Shield } from "lucide-react";
import { useData } from "../../lib/data";
import { cn, Glass } from "../components/shared";

export function CodePRScreen() {
  const { prs: PRS, diff: DIFF } = useData();
  const [selIdx, setSelIdx] = useState(0);
  const selPR = PRS[selIdx] ?? PRS[0];
  if (!selPR) {
    return <div className="p-6 text-sm text-[#74716B]">Aucune pull request pour le moment.</div>;
  }
  return (
    <div className="flex gap-4 h-full">
      <div className="w-72 flex-shrink-0 space-y-2">
        <h2 className="text-[13px] font-semibold text-[#202124] mb-4">Pull Requests</h2>
        {PRS.map(pr => (
          <div
            key={pr.id} onClick={() => setSelIdx(PRS.indexOf(pr))}
            className={cn("p-4 rounded-2xl border cursor-pointer transition-all", selPR.id === pr.id ? "bg-white/90 border-[#5267D9]/25 shadow-sm" : "bg-white/50 border-black/[0.06] hover:bg-white/70")}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono text-[9px] text-[#74716B]">{pr.id}</span>
              <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide",
                pr.status === "merged" ? "bg-purple-50 text-purple-600" : pr.status === "approved" ? "bg-green-50 text-green-700" : "bg-blue-50 text-[#5267D9]"
              )}>
                {pr.status === "merged" ? "Fusionnée" : pr.status === "approved" ? "Approuvée" : "En review"}
              </span>
            </div>
            <div className="text-[11px] font-medium text-[#202124] leading-snug mb-2">
              {pr.title.length > 55 ? pr.title.slice(0, 55) + "…" : pr.title}
            </div>
            <div className="flex items-center gap-2 text-[9px] text-[#74716B]">
              <span>{pr.files} fichiers</span>
              <span className={cn("px-1.5 py-0.5 rounded", pr.risk === "faible" ? "bg-green-50 text-green-700" : pr.risk === "moyenne" ? "bg-orange-50 text-orange-600" : "bg-red-50 text-red-600")}>
                Risque {pr.risk}
              </span>
            </div>
          </div>
        ))}
      </div>

      <Glass className="flex-1 overflow-hidden flex flex-col">
        <div className="p-5 border-b border-black/[0.06]">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-[10px] text-[#74716B]">{selPR.id}</span>
            <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide",
              selPR.status === "merged" ? "bg-purple-100 text-purple-700" : selPR.status === "approved" ? "bg-green-100 text-green-700" : "bg-blue-100 text-[#5267D9]"
            )}>
              {selPR.status === "merged" ? "Fusionnée" : selPR.status === "approved" ? "Approuvée" : "En review"}
            </span>
          </div>
          <h3 className="text-[13px] font-semibold text-[#202124] mb-3">{selPR.title}</h3>
          <div className="flex flex-wrap gap-4 text-[10px] text-[#74716B]">
            <span className="flex items-center gap-1.5"><Bot size={10} />{selPR.agent}</span>
            <span className="flex items-center gap-1.5"><Eye size={10} />Review : {selPR.reviewer}</span>
            <span className="flex items-center gap-1.5"><GitBranch size={10} className="font-mono" />{selPR.branch}</span>
            <span className="flex items-center gap-1.5"><Code size={10} />{selPR.files} fichiers</span>
            <span className={cn("flex items-center gap-1.5", selPR.tests === "passing" ? "text-green-600" : "text-red-500")}>
              <CheckCircle size={10} />Tests {selPR.tests === "passing" ? "passent" : "échoués"}
            </span>
          </div>
          <div className="mt-3 text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-3 py-2 rounded-xl flex items-center gap-2">
            <Shield size={11} />
            <span>Un agent ne peut pas valider son propre travail — review indépendante par {selPR.reviewer}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto bg-[#1C1C1E] font-mono text-[10px] p-4">
          {DIFF.length === 0 && (
            <div className="text-[#7A7A7A]">Aucun diff à afficher pour cette pull request.</div>
          )}
          {DIFF.map((line, i) => (
            <div key={i} className={cn("px-2 py-0.5 leading-relaxed whitespace-pre",
              line.t === "add" ? "bg-green-900/40 text-green-300" :
              line.t === "del" ? "bg-red-900/40 text-red-300" :
              line.t === "meta" ? "text-blue-400" : "text-[#7A7A7A]"
            )}>
              {line.c}
            </div>
          ))}
        </div>
        {selPR.status !== "merged" && (
          <div className="p-4 border-t border-black/[0.06] flex gap-2.5">
            <button className="flex items-center gap-2 bg-green-500 text-white text-[11px] px-4 py-2 rounded-xl font-medium hover:bg-green-600 transition-all">
              <CheckCircle size={12} />Approuver et fusionner
            </button>
            <button className="text-[11px] px-4 py-2 rounded-xl border border-black/[0.07] bg-white/80 text-[#202124] hover:bg-[#F7F4EE] transition-all">
              Demander des corrections
            </button>
            <button className="ml-auto text-[11px] px-4 py-2 rounded-xl text-red-500 hover:bg-red-50 transition-all">Refuser</button>
          </div>
        )}
      </Glass>
    </div>
  );
}
