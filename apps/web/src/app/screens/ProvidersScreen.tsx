import { Zap } from "lucide-react";
import {
  Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useData } from "../../lib/data";
import { Bar2, cn, Glass, StatusDot } from "../components/shared";

export function ProvidersScreen({ onConfigure }: { onConfigure: () => void }) {
  const { providers: PROVIDERS, consumption: CONSUMPTION } = useData();
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        {PROVIDERS.map(p => (
          <Glass key={p.name} className="p-5">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-[13px] font-semibold text-[#202124]">{p.name}</div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {p.models.map(m => (
                    <span key={m} className="text-[9px] font-mono bg-[#F7F4EE] text-[#74716B] px-1.5 py-0.5 rounded">{m}</span>
                  ))}
                </div>
              </div>
              <div className={cn("flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full", p.status === "healthy" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-600")}>
                <StatusDot status={p.status} />{p.status === "healthy" ? "Opérationnel" : "Dégradé"}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5 mb-4">
              {[
                { l: "Latence", v: p.latency },
                { l: "Tokens", v: p.tokens },
                { l: "Coût total", v: p.cost },
                { l: "Missions actives", v: String(p.missions) },
              ].map(s => (
                <div key={s.l} className="bg-[#F7F4EE] rounded-xl p-3">
                  <div className="text-[9px] text-[#74716B] mb-0.5">{s.l}</div>
                  <div className="text-[12px] font-semibold text-[#202124]">{s.v}</div>
                </div>
              ))}
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5 text-[10px]">
                <span className="text-[#74716B]">Rate limit utilisé</span>
                <span className={cn("font-semibold", p.rateLimit > 85 ? "text-red-500" : p.rateLimit > 70 ? "text-orange-500" : "text-[#202124]")}>{p.rateLimit}%</span>
              </div>
              <Bar2 value={p.rateLimit} color={p.rateLimit > 85 ? "bg-red-400" : p.rateLimit > 70 ? "bg-orange-400" : "bg-green-400"} />
            </div>
            <div className="mt-4 pt-4 border-t border-black/[0.05] flex items-center justify-between text-[10px]">
              <span className="flex items-center gap-1.5 text-[#74716B]"><Zap size={10} className="text-[#5267D9]" />Santé : {p.health}%</span>
              <button onClick={onConfigure} className="text-[#5267D9] hover:underline">Configurer</button>
            </div>
          </Glass>
        ))}
      </div>
      <Glass className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[13px] font-semibold text-[#202124]">Consommation tokens — par jour</h3>
          <span className="text-[10px] text-[#74716B]">{CONSUMPTION.length ? `${CONSUMPTION.length} jour${CONSUMPTION.length > 1 ? "s" : ""} d'activité` : "aucune donnée"}</span>
        </div>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={CONSUMPTION} barSize={18}>
              <XAxis dataKey="day" tick={{ fontSize: 9, fill: "#74716B" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: "#74716B" }} axisLine={false} tickLine={false} width={28} />
              <Tooltip
                contentStyle={{ background: "white", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 10, fontSize: 10 }}
                formatter={(v: number) => [`${v}k tokens`, ""]}
              />
              <Bar dataKey="tokens" fill="#5267D9" radius={[4, 4, 0, 0]} fillOpacity={0.75} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Glass>
    </div>
  );
}
