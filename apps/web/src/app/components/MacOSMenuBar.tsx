import { useData } from "../../lib/data";

export function MacOSMenuBar() {
  const { agents, interventions } = useData();
  return (
    <div className="h-6 bg-black/35 backdrop-blur-md flex items-center px-4 select-none flex-shrink-0">
      <span className="text-white text-[12px] font-semibold mr-6">AvityOS</span>
      {["Fichier", "Projet", "Agents", "Affichage", "Aide"].map(m => (
        <span key={m} className="text-white/80 text-[11px] mr-5 hover:text-white cursor-default">{m}</span>
      ))}
      <div className="ml-auto flex items-center gap-5 text-[10px] text-white/75">
        <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />{`${agents.length} agent${agents.length === 1 ? "" : "s"} actif${agents.length === 1 ? "" : "s"}`}</span>
        <span>{`${interventions.length} intervention${interventions.length === 1 ? "" : "s"}`}</span>
        <span className="text-white/60">{new Date().toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}</span>
      </div>
    </div>
  );
}
