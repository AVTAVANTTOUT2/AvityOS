import { Bot, Cpu, Folder, GitPullRequest, Inbox, Plus } from "lucide-react";
import {
  Area, AreaChart, ResponsiveContainer, Tooltip, XAxis,
} from "recharts";
import { useData } from "../../lib/data";
import { ProjectCard } from "../components/ProjectCard";
import { Bar2, cn, Glass, StatusDot } from "../components/shared";

export function MissionControl({ onNewProject, onOpenProject, onOpenInterventions }: {
  onNewProject: () => void;
  onOpenProject: (id: number | string) => void;
  onOpenInterventions: () => void;
}) {
  const { projects: PROJECTS, interventions: INTERVENTIONS, consumption: CONSUMPTION, providers: PROVIDERS, agents, prs, kanban } = useData();
  const blocked = PROJECTS.filter(p => p.health === "blocked").length;
  const urgent = INTERVENTIONS.filter(i => i.urgency === "haute").length;
  const openPrs = prs.filter(pr => pr.status !== "merged").length;
  const totalCost = CONSUMPTION.reduce((sum, c) => sum + c.cost, 0);
  const missionsInFlight = (kanban["En cours"]?.length ?? 0) + (kanban["En validation"]?.length ?? 0);
  const stats = [
    { label: "Projets actifs", value: String(PROJECTS.length), sub: blocked ? `dont ${blocked} bloqué${blocked > 1 ? "s" : ""}` : "aucun bloqué", Icon: Folder, color: "text-[#5267D9]" },
    { label: "Agents actifs", value: String(agents.length), sub: `${missionsInFlight} mission${missionsInFlight === 1 ? "" : "s"} en cours`, Icon: Bot, color: "text-green-600" },
    { label: "Interventions", value: String(INTERVENTIONS.length), sub: urgent ? `${urgent} urgente${urgent > 1 ? "s" : ""}` : "aucune urgente", Icon: Inbox, color: "text-orange-500" },
    { label: "PR en attente", value: String(openPrs), sub: `${prs.length} au total`, Icon: GitPullRequest, color: "text-purple-600" },
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-4">
        {stats.map(s => (
          <Glass key={s.label} className="p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] text-[#74716B] font-medium">{s.label}</span>
              <s.Icon size={14} className={s.color} strokeWidth={1.5} />
            </div>
            <div className="text-2xl font-semibold text-[#202124]">{s.value}</div>
            <div className="text-[10px] text-[#74716B] mt-0.5">{s.sub}</div>
          </Glass>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_300px] gap-4">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-[#202124]">Projets en cours</h2>
            <button onClick={onNewProject} className="text-[11px] text-[#5267D9] hover:underline flex items-center gap-1">
              <Plus size={11} />Nouveau projet
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {PROJECTS.map(p => <ProjectCard key={p.id} p={p} onClick={() => onOpenProject(p.id)} />)}
          </div>
        </div>

        <div className="space-y-4">
          <Glass className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Inbox size={13} className="text-orange-500" strokeWidth={1.5} />
              <span className="text-[12px] font-semibold text-[#202124]">Interventions urgentes</span>
              <span className="ml-auto text-[10px] font-semibold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">{INTERVENTIONS.length}</span>
            </div>
            <div className="space-y-2">
              {INTERVENTIONS.slice(0, 2).map(i => (
                <div key={i.id} onClick={onOpenInterventions} className="p-3 rounded-xl bg-[#F7F4EE] hover:bg-[#F0EDE7] cursor-pointer transition-colors">
                  <div className="flex items-start gap-2">
                    <div className={cn("w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0", i.urgency === "haute" ? "bg-orange-400" : "bg-blue-400")} />
                    <div>
                      <div className="text-[11px] font-medium text-[#202124] leading-snug">
                        {i.question.length > 62 ? i.question.slice(0, 62) + "…" : i.question}
                      </div>
                      <div className="text-[10px] text-[#74716B] mt-0.5">{i.project} · {i.time}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Glass>

          <Glass className="p-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-semibold text-[#202124]">Consommation</span>
              <span className="text-[10px] text-[#74716B]">7 jours</span>
            </div>
            <div className="text-xl font-semibold text-[#202124] mt-1">{`$${totalCost.toFixed(2)}`}</div>
            <div className="text-[10px] text-[#74716B] mb-2">{CONSUMPTION.length ? `sur ${CONSUMPTION.length} jour${CONSUMPTION.length > 1 ? "s" : ""} d'activité` : "aucune consommation enregistrée"}</div>
            <Bar2 value={Math.min(100, Math.round(totalCost))} />
            <div className="mt-4 h-20">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={CONSUMPTION} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#5267D9" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#5267D9" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="cost" stroke="#5267D9" strokeWidth={1.5} fill="url(#cg)" dot={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 9, fill: "#74716B" }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "white", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 10, fontSize: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}
                    formatter={(v: number) => [`€${v}`, "Coût"]}
                    labelStyle={{ color: "#74716B" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Glass>

          <Glass className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Cpu size={13} className="text-[#74716B]" strokeWidth={1.5} />
              <span className="text-[12px] font-semibold text-[#202124]">Providers</span>
            </div>
            <div className="space-y-2">
              {PROVIDERS.map(p => (
                <div key={p.name} className="flex items-center gap-2">
                  <StatusDot status={p.status} />
                  <span className="text-[11px] text-[#202124] flex-1 truncate">{p.name}</span>
                  <span className="text-[10px] text-[#74716B]">{p.latency}</span>
                  <span className={cn("text-[9px] font-medium px-1.5 py-0.5 rounded-full", p.rateLimit > 85 ? "bg-red-50 text-red-600" : p.rateLimit > 70 ? "bg-orange-50 text-orange-600" : "bg-green-50 text-green-700")}>
                    {p.rateLimit}%
                  </span>
                </div>
              ))}
            </div>
          </Glass>
        </div>
      </div>
    </div>
  );
}
