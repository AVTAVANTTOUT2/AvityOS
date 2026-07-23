import {
  summarizeE2EReadiness,
  TeamRole,
  type E2EScenarioStatus,
} from "@avityos/contracts";
import { type ProviderAdapter } from "@avityos/providers";
import {
  effectiveProviderChainForRole,
  providersRoutableForRoles,
  uniqueProviderChain,
} from "./provider-routing.js";
import type { CampaignFaultConfig } from "./campaign-fault.js";
import type { ExecutionMode } from "./provider-policy.js";
import { FIXTURE_PROVIDER_ID } from "./provider-policy.js";
import {
  PROVIDER_STATUS_ORDER,
  resolveProviderCliAuth,
} from "./providers.js";

export type ProviderStatusCategory = Exclude<E2EScenarioStatus, "ready">;

export interface ProviderStatusReason {
  code: string;
  category: ProviderStatusCategory;
  message: string;
  tools: string[];
  environmentVariables: string[];
  remediation: string[];
}

export interface ProviderStatusCheck {
  key:
    | "mission_editor"
    | "distinct_reviewer"
    | "cross_provider_fallback";
  status: E2EScenarioStatus;
  detail: string;
  reasons: ProviderStatusReason[];
}

export interface ProviderStatusEntry {
  name: string;
  kind: "fixture" | "http" | "cli";
  real: boolean;
  registered: boolean;
  status: E2EScenarioStatus;
  reasons: ProviderStatusReason[];
  workspaceEdits: boolean;
  inGlobalChain: boolean;
  missionRoutable: boolean;
  routedRoles: string[];
  defaultModelConfigured: boolean;
  reviewModelConfigured: boolean;
}

export interface ProviderStatusReport {
  schemaVersion: 1;
  generatedAt: string;
  executionMode: ExecutionMode;
  campaign: {
    faultInjection: {
      enabled: boolean;
      provider: string | null;
      category: string | null;
    };
  };
  providers: ProviderStatusEntry[];
  checks: ProviderStatusCheck[];
  note: string;
}

export interface BuildProviderStatusInput {
  env: NodeJS.ProcessEnv;
  executionMode: ExecutionMode;
  providers: Map<string, ProviderAdapter>;
  defaultModels: ReadonlyMap<string, string>;
  reviewModels: ReadonlyMap<string, string>;
  routing: {
    providerChain: readonly string[];
    roleProviderChains: ReadonlyMap<string, readonly string[]>;
    missionRoles: readonly string[];
  };
  campaignFault: CampaignFaultConfig | null;
  authRealHome?: string;
}

const MISSION_PROVIDER_IDS = new Set(["codex", "claude-code", "cursor"]);
const HTTP_PROVIDER_IDS = new Set(["openai", "anthropic", "deepseek"]);
const CLI_PROVIDER_IDS = new Set(["codex", "claude-code", "cursor", "command"]);

export function buildProviderStatus(input: BuildProviderStatusInput): ProviderStatusReport {
  const routingInput = {
    providerChain: uniqueProviderChain(input.routing.providerChain),
    roleProviderChains: input.routing.roleProviderChains,
  };
  const missionRoles = input.routing.missionRoles.filter((role) => role !== "orchestrator");
  const missionReachableProviders = providersRoutableForRoles(routingInput, missionRoles);

  const entries: ProviderStatusEntry[] = PROVIDER_STATUS_ORDER.map((name) => {
    const adapter = input.providers.get(name);
    const kind = providerKind(name);
    const reasons: ProviderStatusReason[] = [];
    const registered = Boolean(adapter);
    const workspaceEdits = adapter?.capabilities().workspaceEdits ?? false;
    const inGlobalChain = routingInput.providerChain.includes(name);
    const missionRoutable = missionReachableProviders.has(name);
    const routedRoles = TeamRole.options
      .filter((role) => role !== "orchestrator")
      .filter((role) => effectiveProviderChainForRole(routingInput, role).includes(name))
      .sort();

    const defaultModelConfigured = input.defaultModels.has(name);
    const reviewModelConfigured = input.reviewModels.has(name);

    if (kind === "cli" && isCliProviderName(name)) {
      const binaryConfigured = cliBinaryConfigured(name, input.env);
      if (!binaryConfigured) {
        reasons.push({
          code: "binary_missing",
          category: "blocked_missing_tool",
          message: `${name} binary is not configured`,
          tools: [name],
          environmentVariables: [cliBinaryEnv(name)],
          remediation: [
            `set ${cliBinaryEnv(name)} to the ${name} executable path`,
          ],
        });
      }
      const auth = resolveCliAuth(name, input.env, input.authRealHome);
      if (!auth.authenticated) {
        reasons.push({
          code: "auth_missing",
          category: "blocked_missing_credentials",
          message: auth.reason,
          tools: [],
          environmentVariables: auth.environmentVariables,
          remediation: auth.remediation,
        });
      }
    } else if (kind === "http") {
      const apiKeyEnv = httpApiKeyEnv(name);
      if (!input.env[apiKeyEnv]) {
        reasons.push({
          code: "auth_missing",
          category: "blocked_missing_credentials",
          message: `${name} API credentials are not configured`,
          tools: [],
          environmentVariables: [apiKeyEnv],
          remediation: [`set ${apiKeyEnv} with a valid credential`],
        });
      }
    }

    if (name !== FIXTURE_PROVIDER_ID && !defaultModelConfigured && !reviewModelConfigured) {
      reasons.push({
        code: "model_missing",
        category: "blocked_operator_configuration",
        message: `${name} is missing model routing in AVITY_DEFAULT_MODELS or AVITY_REVIEW_MODELS`,
        tools: [],
        environmentVariables: ["AVITY_DEFAULT_MODELS", "AVITY_REVIEW_MODELS"],
        remediation: [
          `add ${name}=<model> in AVITY_DEFAULT_MODELS or AVITY_REVIEW_MODELS`,
        ],
      });
    }

    if (MISSION_PROVIDER_IDS.has(name) && !missionRoutable) {
      reasons.push({
        code: "routing_missing",
        category: "blocked_operator_configuration",
        message: `${name} is not reachable through any mission role chain`,
        tools: [],
        environmentVariables: ["AVITY_PROVIDER_CHAIN", "AVITY_ROLE_PROVIDERS"],
        remediation: [
          `add ${name} to AVITY_PROVIDER_CHAIN or AVITY_ROLE_PROVIDERS for mission roles`,
        ],
      });
    }

    if (MISSION_PROVIDER_IDS.has(name) && registered && !workspaceEdits) {
      reasons.push({
        code: "workspace_edits_missing",
        category: "blocked_product_gap",
        message: `${name} is registered but cannot edit mission workspaces`,
        tools: [],
        environmentVariables: [],
        remediation: ["configure a mission provider that supports workspace edits"],
      });
    }

    if (name === FIXTURE_PROVIDER_ID && input.executionMode === "campaign") {
      reasons.push({
        code: "fixture_forbidden",
        category: "blocked_operator_configuration",
        message: "fake fixture is forbidden in campaign mode",
        tools: [],
        environmentVariables: ["AVITY_EXECUTION_MODE", "AVITY_PROVIDER_CHAIN"],
        remediation: ["remove fake from chain and use real providers only"],
      });
    }

    const status = summarizeStatus(reasons);
    return {
      name,
      kind,
      real: name !== FIXTURE_PROVIDER_ID,
      registered,
      status,
      reasons,
      workspaceEdits,
      inGlobalChain,
      missionRoutable,
      routedRoles,
      defaultModelConfigured,
      reviewModelConfigured,
    };
  });

  const checks = buildGlobalChecks(entries, routingInput, missionRoles);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    executionMode: input.executionMode,
    campaign: {
      faultInjection: {
        enabled: Boolean(input.campaignFault),
        provider: input.campaignFault?.provider ?? null,
        category: input.campaignFault?.category ?? null,
      },
    },
    providers: entries,
    checks,
    note:
      "Provider status reports only configuration and routing readiness. It never runs provider health checks or model discovery calls.",
  };
}

function buildGlobalChecks(
  providers: ProviderStatusEntry[],
  routing: {
    providerChain: readonly string[];
    roleProviderChains: ReadonlyMap<string, readonly string[]>;
  },
  missionRoles: readonly string[],
): ProviderStatusCheck[] {
  const readyMissionEditors = providers.filter(
    (provider) =>
      provider.real &&
      provider.status === "ready" &&
      provider.workspaceEdits &&
      provider.missionRoutable,
  );
  const missionEditorCheck: ProviderStatusCheck =
    readyMissionEditors.length > 0
      ? {
          key: "mission_editor",
          status: "ready",
          detail: "At least one real mission editor is routable and ready",
          reasons: [],
        }
      : {
          key: "mission_editor",
          status: "blocked_product_gap",
          detail: "No real mission editor is currently routable and ready",
          reasons: [
            {
              code: "no_real_editor",
              category: "blocked_product_gap",
              message: "no configured provider can both edit workspace and run missions",
              tools: [],
              environmentVariables: ["AVITY_PROVIDER_CHAIN", "AVITY_ROLE_PROVIDERS"],
              remediation: [
                "configure at least one real mission provider with workspace edits",
              ],
            },
          ],
        };

  const readyRealInGlobalChain = providers.filter(
    (provider) => provider.real && provider.status === "ready" && provider.inGlobalChain,
  );
  const distinctReviewerCheck: ProviderStatusCheck =
    readyRealInGlobalChain.length >= 2
      ? {
          key: "distinct_reviewer",
          status: "ready",
          detail: "Global chain can select a reviewer distinct from the author",
          reasons: [],
        }
      : {
          key: "distinct_reviewer",
          status: "blocked_operator_configuration",
          detail: "Distinct reviewer is impossible with current ready real providers",
          reasons: [
            {
              code: "distinct_reviewer_missing",
              category: "blocked_operator_configuration",
              message: "global chain exposes fewer than two ready real providers",
              tools: [],
              environmentVariables: ["AVITY_PROVIDER_CHAIN", "AVITY_REVIEW_MODELS"],
              remediation: [
                "configure at least two ready real providers in the global chain",
              ],
            },
          ],
        };

  const fallbackReady = missionRoles.some((role) => {
    const chain = effectiveProviderChainForRole(routing, role);
    const readyEditors = chain.filter((providerName) => {
      const provider = providers.find((entry) => entry.name === providerName);
      return provider?.real && provider.status === "ready" && provider.workspaceEdits;
    });
    return new Set(readyEditors).size >= 2;
  });
  const fallbackCheck: ProviderStatusCheck = fallbackReady
    ? {
        key: "cross_provider_fallback",
        status: "ready",
        detail: "At least one mission role has two ready real editors for fallback",
        reasons: [],
      }
    : {
        key: "cross_provider_fallback",
        status: "blocked_operator_configuration",
        detail: "No mission role has a two-provider real-editor fallback chain",
        reasons: [
          {
            code: "fallback_missing",
            category: "blocked_operator_configuration",
            message: "fallback requires at least two ready real mission editors in one effective role chain",
            tools: [],
            environmentVariables: ["AVITY_PROVIDER_CHAIN", "AVITY_ROLE_PROVIDERS"],
            remediation: [
              "route two real workspace-edit providers in the same mission role chain",
            ],
          },
        ],
      };

  return [missionEditorCheck, distinctReviewerCheck, fallbackCheck];
}

function summarizeStatus(reasons: readonly ProviderStatusReason[]): E2EScenarioStatus {
  return summarizeE2EReadiness(reasons.map((reason) => reason.category));
}

function providerKind(name: string): "fixture" | "http" | "cli" {
  if (name === FIXTURE_PROVIDER_ID) return "fixture";
  if (HTTP_PROVIDER_IDS.has(name)) return "http";
  return "cli";
}

function isCliProviderName(
  name: string,
): name is "codex" | "claude-code" | "cursor" | "command" {
  return CLI_PROVIDER_IDS.has(name);
}

function cliBinaryConfigured(name: string, env: NodeJS.ProcessEnv): boolean {
  const variable = cliBinaryEnv(name);
  return Boolean(env[variable]?.trim());
}

function cliBinaryEnv(name: string): string {
  if (name === "codex") return "AVITY_CODEX_BIN";
  if (name === "claude-code") return "AVITY_CLAUDE_CODE_BIN";
  if (name === "cursor") return "AVITY_CURSOR_BIN";
  return "AVITY_COMMAND_BIN";
}

function httpApiKeyEnv(name: string): string {
  if (name === "openai") return "OPENAI_API_KEY";
  if (name === "anthropic") return "ANTHROPIC_API_KEY";
  return "DEEPSEEK_API_KEY";
}

function resolveCliAuth(
  provider: "codex" | "claude-code" | "cursor" | "command",
  env: NodeJS.ProcessEnv,
  authRealHome?: string,
): {
  authenticated: boolean;
  reason: string;
  environmentVariables: string[];
  remediation: string[];
} {
  if (provider === "command") {
    return {
      authenticated: true,
      reason: "command provider does not require auth by default",
      environmentVariables: [],
      remediation: [],
    };
  }
  const result = resolveProviderCliAuth(provider, env, { realHome: authRealHome });
  return {
    authenticated: result.authenticated,
    reason: result.reason ?? `${provider} sandbox authentication is not configured`,
    environmentVariables: [...result.policy.allowedEnvironment],
    remediation:
      result.policy.allowedCredentialFiles.length > 0
        ? [
            `set one of [${result.policy.allowedEnvironment.join(", ")}] or provide one of [${result.policy.allowedCredentialFiles.join(", ")}]`,
          ]
        : result.policy.allowedEnvironment.length > 0
          ? [`set one of [${result.policy.allowedEnvironment.join(", ")}]`]
          : [],
  };
}
