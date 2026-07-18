import { useState } from "react";
import { CheckCircle } from "lucide-react";
import { cn, Glass } from "../components/shared";

const SECTIONS = ["Profil", "Apparence", "Notifications", "GitHub", "Sécurité", "Permissions", "Politiques Git", "Providers", "Intégrations"];

export function SettingsScreen() {
  const [active, setActive] = useState("GitHub");
  const [rules, setRules] = useState([
    { label: "Reviews obligatoires avant fusion", on: true },
    { label: "Tests CI obligatoires avant merge", on: true },
    { label: "Fusion automatique si checks passent", on: false },
    { label: "Validation humaine pour la production", on: true },
    { label: "Protection de la branche principale", on: true },
  ]);
  const toggle = (label: string) =>
    setRules(rs => rs.map(r => (r.label === label ? { ...r, on: !r.on } : r)));
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
        {active === "GitHub" ? (
          <div className="space-y-5">
            <div>
              <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-1.5">Organisation GitHub</label>
              <div className="flex items-center gap-3 bg-[#F7F4EE] border border-black/[0.07] rounded-xl px-3 py-2.5">
                <CheckCircle size={13} className="text-green-500" />
                <span className="text-[12px] text-[#202124]">mon-organisation</span>
                <span className="ml-auto text-[10px] text-green-600 font-medium">Connecté</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Règles de protection</label>
              <div className="space-y-2">
                {rules.map(r => (
                  <div key={r.label} className="flex items-center justify-between p-3 bg-[#F7F4EE] rounded-xl">
                    <span className="text-[12px] text-[#202124]">{r.label}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.on}
                      aria-label={r.label}
                      onClick={() => toggle(r.label)}
                      className={cn("w-9 h-5 rounded-full relative cursor-pointer transition-colors", r.on ? "bg-[#5267D9]" : "bg-gray-200")}
                    >
                      <span className={cn("w-3.5 h-3.5 rounded-full bg-white shadow-sm absolute top-[3px] transition-all", r.on ? "left-[19px]" : "left-[3px]")} />
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-[#74716B] mt-2">Préférences locales à cette session — la politique effective est appliquée côté control plane.</p>
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-[#74716B]">Section disponible dans la version complète.</div>
        )}
      </Glass>
    </div>
  );
}
