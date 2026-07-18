import { useEffect, useState } from "react";
import {
  Activity, Folder, GitPullRequest, Inbox, Plus, Terminal,
  type LucideIcon,
} from "lucide-react";
import { useData } from "../../lib/data";
import { cn } from "./shared";

interface Command {
  icon: LucideIcon;
  label: string;
  sub?: string;
  shortcut?: string;
  run: () => void;
}

export function CommandPalette({ open, onClose, onNavigate, onNewProject }: {
  open: boolean;
  onClose: () => void;
  onNavigate: (screen: string) => void;
  onNewProject: () => void;
}) {
  const { projects, interventions, prs } = useData();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => { if (!open) { setQ(""); setActive(0); } }, [open]);
  if (!open) return null;

  const go = (screen: string) => { onClose(); onNavigate(screen); };
  const openPr = prs.find(pr => pr.status !== "merged");
  const commands: Command[] = [
    { icon: Plus, label: "Créer un nouveau projet", shortcut: "N", run: () => { onClose(); onNewProject(); } },
    ...projects.map(p => ({
      icon: Folder,
      label: `Ouvrir ${p.name}`,
      sub: p.phase,
      run: () => go("projects"),
    })),
    {
      icon: Inbox,
      label: "Répondre à une intervention",
      sub: interventions.length ? `${interventions.length} en attente` : "aucune en attente",
      run: () => go("interventions"),
    },
    ...(openPr ? [{ icon: GitPullRequest, label: `Consulter ${openPr.id}`, sub: "En review", run: () => go("github") }] : []),
    { icon: Terminal, label: "Ouvrir les exécutions", shortcut: "T", run: () => go("executions") },
    { icon: Activity, label: "Voir le journal d'activité", run: () => go("activity") },
  ];
  const items = q ? commands.filter(i => i.label.toLowerCase().includes(q.toLowerCase())) : commands;
  const activeIdx = Math.min(active, Math.max(items.length - 1, 0));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" />
      <div className="relative w-[540px] bg-white/96 backdrop-blur-xl rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.22)] border border-white/90 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-black/[0.07]">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 5C2 3.34 3.34 2 5 2s3 1.34 3 3-1.34 3-3 3-3-1.34-3-3zM7 7.5L11 11" stroke="#74716B" strokeWidth="1.4" strokeLinecap="round"/></svg>
          <input
            autoFocus value={q}
            onChange={e => { setQ(e.target.value); setActive(0); }}
            onKeyDown={e => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => Math.min(i + 1, items.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
              if (e.key === "Enter") { e.preventDefault(); items[activeIdx]?.run(); }
            }}
            placeholder="Rechercher une commande..."
            className="flex-1 bg-transparent text-[13px] text-[#202124] placeholder:text-[#74716B] outline-none"
          />
          <kbd className="text-[9px] bg-black/[0.05] px-2 py-1 rounded font-mono text-[#74716B]">ESC</kbd>
        </div>
        <div className="py-1.5 max-h-72 overflow-y-auto">
          {items.length === 0 && (
            <div className="px-4 py-3 text-[12px] text-[#74716B]">Aucune commande ne correspond.</div>
          )}
          {items.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                onClick={() => item.run()}
                onMouseEnter={() => setActive(i)}
                className={cn("w-full flex items-center gap-3 px-4 py-2.5 text-[12px] transition-colors", i === activeIdx ? "bg-[#5267D9]/[0.05]" : "hover:bg-[#F7F4EE]")}
              >
                <div className="w-6 h-6 rounded-lg bg-[#F7F4EE] flex items-center justify-center flex-shrink-0">
                  <Icon size={12} className="text-[#74716B]" strokeWidth={1.5} />
                </div>
                <span className="flex-1 text-left text-[#202124]">{item.label}</span>
                {item.sub && <span className="text-[10px] text-[#74716B]">{item.sub}</span>}
                {item.shortcut && <kbd className="text-[9px] bg-black/[0.05] px-1.5 py-0.5 rounded font-mono text-[#74716B]">⌘{item.shortcut}</kbd>}
              </button>
            );
          })}
        </div>
        <div className="px-4 py-2.5 border-t border-black/[0.06] flex items-center gap-4 text-[9px] text-[#74716B]">
          <span>↑↓ naviguer</span><span>↵ sélectionner</span><span>ESC fermer</span>
        </div>
      </div>
    </div>
  );
}
