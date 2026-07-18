import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { DataProvider } from "../lib/data";
import { CommandPalette } from "./components/CommandPalette";
import { MacOSMenuBar } from "./components/MacOSMenuBar";
import { NewProjectModal } from "./components/NewProjectModal";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ActivityScreen } from "./screens/ActivityScreen";
import { CodePRScreen } from "./screens/CodePRScreen";
import { InterventionsScreen } from "./screens/InterventionsScreen";
import { MissionControl } from "./screens/MissionControl";
import { ProjectDetailScreen } from "./screens/ProjectDetailScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { ProvidersScreen } from "./screens/ProvidersScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TeamScreen } from "./screens/TeamScreen";
import { TerminalsScreen } from "./screens/TerminalsScreen";

export default function App() {
  return (
    <AuthGate>
      <DataProvider>
        <AppShell />
      </DataProvider>
    </AuthGate>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "ready" | "token">("checking");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.projects()
      .then(() => setState("ready"))
      .catch((err) => setState(err instanceof ApiRequestError && err.status === 401 ? "token" : "ready"));
  }, []);

  if (state === "ready") return <>{children}</>;
  if (state === "checking") {
    return <div className="min-h-screen bg-[#F2EFE8] grid place-items-center text-sm text-[#74716B]">Connexion sécurisée…</div>;
  }

  return (
    <main className="min-h-screen bg-[#F2EFE8] grid place-items-center p-6">
      <form
        className="w-full max-w-md bg-white/80 backdrop-blur-xl rounded-3xl border border-white shadow-[0_20px_80px_rgba(32,33,36,0.10)] p-8"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          api.login(token.trim())
            .then(() => api.projects())
            .then(() => { setToken(""); setState("ready"); })
            .catch((err) => setError((err as Error).message));
        }}
      >
        <div className="w-11 h-11 rounded-2xl bg-[#5267D9]/10 text-[#5267D9] grid place-items-center mb-5"><Lock size={20} /></div>
        <h1 className="text-xl font-semibold text-[#202124]">Connecter AvityOS</h1>
        <p className="text-sm text-[#74716B] mt-2 mb-6">Saisis le token généré au premier démarrage du control plane. Il sera échangé contre une session HTTP-only.</p>
        <label htmlFor="avity-token" className="block text-xs font-medium text-[#202124] mb-2">Token du control plane</label>
        <input
          id="avity-token"
          type="password"
          autoComplete="off"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="w-full rounded-xl border border-black/10 bg-white px-3.5 py-3 text-sm outline-none focus:border-[#5267D9]/50 focus:ring-2 focus:ring-[#5267D9]/10"
        />
        {error && <p role="alert" className="text-xs text-red-600 mt-3">{error}</p>}
        <button type="submit" className="w-full mt-5 rounded-xl bg-[#5267D9] text-white text-sm font-medium py-3 hover:bg-[#4255C4]">Se connecter</button>
      </form>
    </main>
  );
}

function AppShell() {
  const [screen, setScreen] = useState("mission-control");
  const [cmdK, setCmdK] = useState(false);
  const [macOS, setMacOS] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showProject, setShowProject] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setCmdK(v => !v); }
      if (e.key === "Escape") { setCmdK(false); setShowNewProject(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleNav = (s: string) => { setScreen(s); setShowProject(false); };

  const renderContent = () => {
    if (showProject) return <ProjectDetailScreen onBack={() => setShowProject(false)} />;
    switch (screen) {
      case "interventions": return <InterventionsScreen />;
      case "executions": return <TerminalsScreen />;
      case "github": return <CodePRScreen />;
      case "providers": return <ProvidersScreen />;
      case "activity": return <ActivityScreen />;
      case "agents": return <TeamScreen />;
      case "settings": return <SettingsScreen />;
      case "projects": return <ProjectsScreen onOpenProject={() => setShowProject(true)} onNewProject={() => setShowNewProject(true)} />;
      default: return <MissionControl onNewProject={() => setShowNewProject(true)} onOpenProject={() => setShowProject(true)} />;
    }
  };

  const inner = (
    <div className="flex h-full bg-[#F7F4EE]" style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <Sidebar current={showProject ? "projects" : screen} onChange={handleNav} macOS={macOS} />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar
          screen={showProject ? "projects" : screen}
          onNewProject={() => setShowNewProject(true)}
          onCmdK={() => setCmdK(true)}
          macOS={macOS}
          onToggleMacOS={() => setMacOS(v => !v)}
        />
        <div className="flex-1 overflow-y-auto p-5">{renderContent()}</div>
      </div>
    </div>
  );

  return (
    <>
      {macOS ? (
        <div className="min-h-screen bg-gradient-to-br from-slate-400 via-slate-300 to-indigo-200 flex flex-col overflow-hidden">
          <MacOSMenuBar />
          <div className="flex-1 flex items-start justify-center p-5 pt-3 overflow-hidden">
            <div
              className="w-full rounded-2xl overflow-hidden shadow-[0_32px_80px_rgba(0,0,0,0.38),0_0_0_1px_rgba(255,255,255,0.12)] relative"
              style={{ maxWidth: 1440, height: "calc(100vh - 4.5rem)" }}
            >
              <div className="h-10 bg-white/88 backdrop-blur-xl border-b border-black/[0.08] flex items-center px-4 gap-3 select-none flex-shrink-0">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-[#FF5F57] shadow-[0_0_0_0.5px_rgba(0,0,0,0.1)] cursor-pointer hover:brightness-90" />
                  <div className="w-3 h-3 rounded-full bg-[#FEBC2E] shadow-[0_0_0_0.5px_rgba(0,0,0,0.1)] cursor-pointer hover:brightness-90" />
                  <div className="w-3 h-3 rounded-full bg-[#28C840] shadow-[0_0_0_0.5px_rgba(0,0,0,0.1)] cursor-pointer hover:brightness-90" />
                </div>
                <div className="flex-1 text-center text-[11px] text-[#74716B] font-medium">AvityOS</div>
              </div>
              <div style={{ height: "calc(100% - 40px)" }}>{inner}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="h-screen overflow-hidden">{inner}</div>
      )}

      <CommandPalette open={cmdK} onClose={() => setCmdK(false)} onNavigate={handleNav} onNewProject={() => setShowNewProject(true)} />
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} />}
    </>
  );
}
