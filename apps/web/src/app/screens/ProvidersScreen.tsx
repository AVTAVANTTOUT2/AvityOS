import { AlertTriangle, Zap } from "lucide-react";
import {
  Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { ApiE2EScenarioStatus, ApiProviderStatusEntry } from "../../lib/api";
import { useData } from "../../lib/data";
import { Bar2, cn, Glass, StatusDot } from "../components/shared";

const STATUS_LABELS: Record<ApiE2EScenarioStatus, string> = {
  ready: "Prêt",
  blocked_operator_configuration: "Config. opérateur",
  blocked_missing_tool: "Outil manquant",
  blocked_missing_credentials: "Credentials manquants",
  blocked_product_gap: "Lacune produit",
};

const CHECK_LABELS: Record<string, string> = {
  mission_editor: "Éditeur de mission",
  distinct_reviewer: "Reviewer distinct",
  cross_provider_fallback: "Fallback inter-providers",
};

function providerDisplayName(name: string): string {
  const labels: Record<string, string> = {
    fake: "Fixture (fake)",
    openai: "OpenAI",
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    codex: "Codex CLI",
    "claude-code": "Claude Code CLI",
    cursor: "Cursor CLI",
    command: "Command CLI",
  };
  return labels[name] ?? name;
}

function statusBadgeClass(status: ApiE2EScenarioStatus): string {
  if (status === "ready") return "bg-green-50 text-green-700";
  if (status === "blocked_missing_credentials") return "bg-red-50 text-red-600";
  if (status === "blocked_missing_tool") return "bg-orange-50 text-orange-600";
  return "bg-amber-50 text-amber-700";
}

function ProviderReadinessCard({ provider, onConfigure, configureDisabled }: {
  provider: ApiProviderStatusEntry;
  onConfigure: () => void;
  configureDisabled: boolean;
}) {
  const credentialChannels = [...new Set(
    provider.reasons.flatMap((reason) => reason.environmentVariables),
  )];
  const missingTools = [...new Set(provider.reasons.flatMap((reason) => reason.tools))];

  return (
    <Glass className="p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-[13px] font-semibold text-[#202124]">{providerDisplayName(provider.name)}</div>
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="text-[9px] font-mono bg-[#F7F4EE] text-[#74716B] px-1.5 py-0.5 rounded">{provider.kind}</span>
            {provider.registered && (
              <span className="text-[9px] font-mono bg-[#F7F4EE] text-[#74716B] px-1.5 py-0.5 rounded">enregistré</span>
            )}
            {provider.workspaceEdits && (
              <span className="text-[9px] font-mono bg-[#F7F4EE] text-[#74716B] px-1.5 py-0.5 rounded">workspace</span>
            )}
          </div>
        </div>
        <div className={cn("flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full", statusBadgeClass(provider.status))}>
          <StatusDot status={provider.status === "ready" ? "healthy" : "warning"} />
          {STATUS_LABELS[provider.status]}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 mb-4">
        {[
          { l: "Binaire / sandbox", v: missingTools.length ? "Absent" : provider.kind === "cli" ? "Configuré" : "N/A" },
          { l: "Authentification", v: provider.reasons.some((r) => r.code === "auth_missing") ? "Manquante" : provider.real ? "Canal détecté" : "Fixture" },
          { l: "Chaîne globale", v: provider.inGlobalChain ? "Oui" : "Non" },
          { l: "Rôles mission", v: provider.routedRoles.length ? provider.routedRoles.join(", ") : "Aucun" },
        ].map((s) => (
          <div key={s.l} className="bg-[#F7F4EE] rounded-xl p-3">
            <div className="text-[9px] text-[#74716B] mb-0.5">{s.l}</div>
            <div className="text-[12px] font-semibold text-[#202124]">{s.v}</div>
          </div>
        ))}
      </div>

      {provider.reasons.length > 0 && (
        <div className="space-y-2 mb-4">
          {provider.reasons.map((reason) => (
            <div key={reason.code} className="rounded-xl bg-[#F7F4EE] px-3 py-2 text-[10px] text-[#202124]">
              <div className="font-medium">{reason.message}</div>
              {reason.environmentVariables.length > 0 && (
                <div className="text-[#74716B] mt-1">
                  Canaux : {reason.environmentVariables.join(", ")}
                </div>
              )}
              {reason.tools.length > 0 && (
                <div className="text-[#74716B] mt-1">
                  Outils : {reason.tools.join(", ")}
                </div>
              )}
              <div className="text-[#74716B] mt-1">{reason.remediation[0]}</div>
            </div>
          ))}
        </div>
      )}

      {credentialChannels.length > 0 && (
        <p className="text-[9px] text-[#74716B] mb-3">
          Seuls les noms de canaux sont affichés — jamais les valeurs des credentials.
        </p>
      )}

      <div className="mt-4 pt-4 border-t border-black/[0.05] flex items-center justify-between text-[10px]">
        <span className="flex items-center gap-1.5 text-[#74716B]">
          <Zap size={10} className="text-[#5267D9]" />
          Modèles : {provider.defaultModelConfigured || provider.reviewModelConfigured ? "routés" : "non configurés"}
        </span>
        <button
          type="button"
          onClick={onConfigure}
          disabled={configureDisabled}
          title={configureDisabled ? "Configuration côté control plane uniquement" : undefined}
          className={cn("text-[#5267D9] hover:underline", configureDisabled && "opacity-40 cursor-not-allowed hover:no-underline")}
        >
          Configurer
        </button>
      </div>
    </Glass>
  );
}

function DemoProviderCard({ provider, onConfigure }: {
  provider: { name: string; models: string[]; status: string; latency: string; rateLimit: number; tokens: string; cost: string; missions: number; health: number };
  onConfigure: () => void;
}) {
  return (
    <Glass className="p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-[13px] font-semibold text-[#202124]">{provider.name}</div>
          <div className="flex flex-wrap gap-1 mt-1">
            {provider.models.map((m) => (
              <span key={m} className="text-[9px] font-mono bg-[#F7F4EE] text-[#74716B] px-1.5 py-0.5 rounded">{m}</span>
            ))}
          </div>
        </div>
        <div className={cn("flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full", provider.status === "healthy" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-600")}>
          <StatusDot status={provider.status} />{provider.status === "healthy" ? "Opérationnel" : "Dégradé"}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5 mb-4">
        {[
          { l: "Latence", v: provider.latency },
          { l: "Tokens", v: provider.tokens },
          { l: "Coût total", v: provider.cost },
          { l: "Missions actives", v: String(provider.missions) },
        ].map((s) => (
          <div key={s.l} className="bg-[#F7F4EE] rounded-xl p-3">
            <div className="text-[9px] text-[#74716B] mb-0.5">{s.l}</div>
            <div className="text-[12px] font-semibold text-[#202124]">{s.v}</div>
          </div>
        ))}
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5 text-[10px]">
          <span className="text-[#74716B]">Rate limit utilisé</span>
          <span className={cn("font-semibold", provider.rateLimit > 85 ? "text-red-500" : provider.rateLimit > 70 ? "text-orange-500" : "text-[#202124]")}>{provider.rateLimit}%</span>
        </div>
        <Bar2 value={provider.rateLimit} color={provider.rateLimit > 85 ? "bg-red-400" : provider.rateLimit > 70 ? "bg-orange-400" : "bg-green-400"} />
      </div>
      <div className="mt-4 pt-4 border-t border-black/[0.05] flex items-center justify-between text-[10px]">
        <span className="flex items-center gap-1.5 text-[#74716B]"><Zap size={10} className="text-[#5267D9]" />Santé : {provider.health}%</span>
        <button type="button" onClick={onConfigure} className="text-[#5267D9] hover:underline">Configurer</button>
      </div>
    </Glass>
  );
}

export function ProvidersScreen({ onConfigure }: { onConfigure: () => void }) {
  const { providers: PROVIDERS, providersStatus, consumption: CONSUMPTION, mode } = useData();
  const liveProviders = providersStatus?.providers.filter((p) => p.registered || p.reasons.length > 0) ?? [];
  const fakeOnly = providersStatus
    ? !providersStatus.providers.some((p) => p.real && p.registered)
      && providersStatus.providers.some((p) => p.name === "fake" && p.registered)
    : false;
  const routingChecks = providersStatus?.checks.filter((c) => c.key === "distinct_reviewer" || c.key === "cross_provider_fallback") ?? [];

  return (
    <div className="space-y-5">
      {mode === "live" && providersStatus && (
        <>
          {fakeOnly && (
            <Glass className="p-4 border border-amber-200/80 bg-amber-50/60">
              <div className="flex items-start gap-2.5 text-[11px] text-amber-900">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">Fixture fake uniquement</div>
                  <p className="mt-1 leading-relaxed">
                    Seul le provider déterministe <span className="font-mono">fake</span> est enregistré.
                    Cela ne prouve pas une readiness live — configurez des providers réels côté control plane.
                  </p>
                </div>
              </div>
            </Glass>
          )}
          {routingChecks.some((c) => c.status !== "ready") && (
            <Glass className="p-4 border border-orange-200/80 bg-orange-50/50">
              <div className="text-[10px] font-semibold text-[#74716B] uppercase tracking-wide mb-2">Écarts reviewer / fallback</div>
              <div className="space-y-2">
                {routingChecks.filter((c) => c.status !== "ready").map((check) => (
                  <div key={check.key} className="text-[11px] text-[#202124]">
                    <span className="font-medium">{CHECK_LABELS[check.key] ?? check.key}</span>
                    {" — "}
                    <span className="text-[#74716B]">{check.detail}</span>
                    {check.reasons[0] && (
                      <div className="text-[10px] text-[#74716B] mt-0.5">{check.reasons[0].remediation[0]}</div>
                    )}
                  </div>
                ))}
              </div>
            </Glass>
          )}
          <p className="text-[10px] text-[#74716B]">{providersStatus.note}</p>
        </>
      )}

      <div className="grid grid-cols-2 gap-4">
        {mode === "live" && providersStatus
          ? liveProviders.map((p) => (
              <ProviderReadinessCard
                key={p.name}
                provider={p}
                onConfigure={onConfigure}
                configureDisabled
              />
            ))
          : PROVIDERS.map((p) => (
              <DemoProviderCard key={p.name} provider={p} onConfigure={onConfigure} />
            ))}
        {mode === "live" && providersStatus && liveProviders.length === 0 && (
          <Glass className="p-5 col-span-2 text-[12px] text-[#74716B]">
            Aucun provider enregistré sur le control plane.
          </Glass>
        )}
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
