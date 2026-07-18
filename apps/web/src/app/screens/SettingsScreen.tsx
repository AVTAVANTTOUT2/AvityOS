import { useState } from "react";
import { Lock } from "lucide-react";
import { useData } from "../../lib/data";
import { cn, Glass, StatusDot } from "../components/shared";

const SECTIONS = ["GitHub", "Providers", "Profil", "Apparence", "Notifications", "Sécurité", "Permissions", "Politiques Git", "Intégrations"];

export function SettingsScreen({ initialSection }: { initialSection?: string }) {
  const { providers, mode } = useData();
  const [active, setActive] = useState(initialSection ?? "GitHub");
  return (
    <div className="flex gap-5 h-full">
      <div className="w-44 flex-shrink-0">
        <h2 className="text-[12px] font-semibold text-[#202124] mb-3">Paramètres</h2>
        <div className="space-y-0.5">
          {SECTIONS.map(s => (
            <button key={s} onClick={() => setActive(s)} className={cn("w-full text-left text-[12px] px-3 py-2 rounded-xl transition-all",
              active === s ? "bg-[#5267D9]/[0.08] text-[#5267D9] font-medium" : "text-[#74716B] hover:text-[#202124] hover:bg-black/[0.04]"
            )}>{s}</button>
          ))}
        </div>
      </div>
      <Glass className="flex-1 p-6 overflow-y-auto">
        <h3 className="text-[13px] font-semibold text-[#202124] mb-5">{active}</h3>
        {active === "GitHub" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 bg-[#F7F4EE] rounded-xl p-4">
              <Lock size={14} className="text-[#74716B] mt-0.5 flex-shrink-0" />
              <p className="text-[12px] text-[#202124] leading-relaxed">
                La configuration GitHub (remote, protection de branche, règles de fusion) est gérée
                côté control plane et appliquée par le moteur de policy. Elle n'est pas modifiable
                depuis cette interface : AvityOS ne fusionne jamais une PR lui-même et exige une
                review indépendante avant toute intégration.
              </p>
            </div>
            <p className="text-[11px] text-[#74716B]">
              Voir <span className="font-mono text-[10px]">docs/POLICIES.md</span> et la configuration du control plane pour modifier ces règles.
            </p>
          </div>
        )}
        {active === "Providers" && (
          <div className="space-y-3">
            {providers.length === 0 && (
              <p className="text-[12px] text-[#74716B]">
                {mode === "live" ? "Aucun provider enregistré sur le control plane." : "Providers visibles uniquement lorsque le control plane est connecté (ou en mode démo)."}
              </p>
            )}
            {providers.map(p => (
              <div key={p.name} className="flex items-center gap-3 bg-[#F7F4EE] rounded-xl px-4 py-3">
                <StatusDot status={p.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-[#202124]">{p.name}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {p.models.map(m => (
                      <span key={m} className="text-[9px] font-mono bg-white/80 text-[#74716B] px-1.5 py-0.5 rounded">{m}</span>
                    ))}
                  </div>
                </div>
                <span className="text-[10px] text-[#74716B]">{p.status === "healthy" ? "Opérationnel" : "Dégradé"}</span>
              </div>
            ))}
            <p className="text-[11px] text-[#74716B]">
              Les credentials et l'activation des providers se configurent côté control plane (lecture seule ici).
            </p>
          </div>
        )}
        {active !== "GitHub" && active !== "Providers" && (
          <div className="text-[12px] text-[#74716B]">Section disponible dans la version complète.</div>
        )}
      </Glass>
    </div>
  );
}
