import { Plus } from "lucide-react";
import { useData } from "../../lib/data";
import { ProjectCard } from "../components/ProjectCard";

export function ProjectsScreen({ onOpenProject, onNewProject }: { onOpenProject: () => void; onNewProject: () => void }) {
  const { projects: PROJECTS } = useData();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-[#202124]">Tous les projets</h2>
        <button onClick={onNewProject} className="flex items-center gap-1.5 bg-[#5267D9] text-white text-[11px] px-3.5 py-2 rounded-xl font-medium hover:bg-[#4255C4] transition-all">
          <Plus size={12} />Nouveau projet
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {PROJECTS.map(p => <ProjectCard key={p.id} p={p} onClick={onOpenProject} />)}
      </div>
    </div>
  );
}
