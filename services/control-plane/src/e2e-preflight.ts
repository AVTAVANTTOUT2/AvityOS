import {
  E2EPreflightReport,
  E2E_PREFLIGHT_SCHEMA_VERSION,
  summarizeE2EReadiness,
  type E2EBlockedStatus,
  type E2EEffectiveRouting,
  type E2EProviderSummary,
  type E2EReadinessReason,
  type E2EScenarioReport,
  type E2EScenarioStatus,
} from "@avityos/contracts";
import type { ProviderAdapter } from "@avityos/providers";
import {
  effectiveBrainProviderChain,
  effectiveProviderChainForRole,
  uniqueProviderChain,
  type ProviderRoutingInput,
} from "./provider-routing.js";

/**
 * Deterministic, secret-free readiness preflight for the chantier-4 live E2E
 * campaign. Given the providers the control plane actually registered plus
 * the same effective routing the Engine uses, it reports whether each
 * mandatory scenario is *runnable*.
 *
 * It never runs a provider and never asserts a scenario passed. No credential
 * value is read or surfaced: diagnostics contain only names, booleans,
 * credential-channel identifiers, and actionable remediation.
 */
export interface E2EPreflightInputs {
  providers: Map<string, ProviderAdapter>;
  /** Active provider fallback chain (first = preferred). */
  providerChain: string[];
  /** Team-role routing; the orchestrator entry seeds the brain chain. */
  roleProviderChains: ReadonlyMap<string, readonly string[]>;
  /**
   * Mission roles used to evaluate effective mission-role chains.
   * Must come from the shared TeamRole contract / Engine snapshot — never
   * inferred from registered providers alone.
   */
  missionRoles: readonly string[];
  /**
   * Secret-free startup readiness from the provider-status snapshot. When
   * supplied, a registered adapter is runnable only when its binary, auth,
   * model and routing checks are all ready.
   */
  providerReadiness?: ReadonlyMap<
    string,
    {
      status: E2EScenarioStatus;
      reasons: readonly E2EReadinessReason[];
    }
  >;
  /** Non-secret GitHub host readiness (async detection happens at the boundary). */
  github: {
    gitAvailable: boolean;
    ghAvailable: boolean;
    credentialHintAvailable: boolean;
    ghAuthenticated: boolean;
    repositoryReadable: boolean;
    repositoryPushDryRunSucceeded: boolean;
    repositoryWriteRoleObserved: boolean;
  };
  /**
   * Whether a concrete repository publication target (project repoPath +
   * repoRemoteUrl) was configured for this preflight. When false, the readiness
   * detector never attempted a repository-scoped push dry-run, so a false
   * `repositoryPushDryRunSucceeded` reflects a missing remote configuration —
   * an operator-configuration gap — rather than absent credentials. This signal
   * is derived at the request boundary (never from ambient process env) so the
   * classification is hermetic and independent of the host's credential hints.
   * Defaults to true to preserve the credential-driven classification for
   * callers that already evaluated a concrete target.
   */
  repositoryTargetConfigured?: boolean;
  now?: () => Date;
}

/** The fixture provider is a deterministic engineering aid, never real evidence. */
const FIXTURE_PROVIDER = "fake";

function blocked(
  key: E2EScenarioReport["key"],
  title: string,
  status: E2EBlockedStatus,
  code: string,
  detail: string,
  options: {
    tools?: string[];
    environmentVariables?: string[];
    remediation: string[];
  },
): E2EScenarioReport {
  const reason: E2EReadinessReason = {
    code,
    category: status,
    message: detail,
    tools: options.tools ?? [],
    environmentVariables: options.environmentVariables ?? [],
    remediation: options.remediation,
  };
  return { key, title, status, detail, reasons: [reason] };
}

function ready(
  key: E2EScenarioReport["key"],
  title: string,
  detail: string,
): E2EScenarioReport {
  return { key, title, status: "ready", detail, reasons: [] };
}

export function buildE2EPreflight(inputs: E2EPreflightInputs): E2EPreflightReport {
  const now = inputs.now ?? (() => new Date());
  const routingInput: ProviderRoutingInput = {
    providerChain: inputs.providerChain,
    roleProviderChains: inputs.roleProviderChains,
  };
  const registeredChain = (chain: readonly string[]): string[] =>
    uniqueProviderChain(chain).filter((provider) =>
      inputs.providers.has(provider),
    );
  const brainChain = registeredChain(
    effectiveBrainProviderChain(routingInput),
  );
  // Engine independent review inspects the global chain only.
  const reviewChain = registeredChain(inputs.providerChain);
  const missionRoles = [...new Set(inputs.missionRoles)];
  const missionRoleChains = missionRoles.map((role) => ({
    role,
    providers: registeredChain(
      effectiveProviderChainForRole(routingInput, role),
    ),
  }));
  const routableMissionProviders = new Set(
    missionRoleChains.flatMap((route) => route.providers),
  );
  const effectiveRouting: E2EEffectiveRouting = {
    globalChain: registeredChain(inputs.providerChain),
    brainChain,
    reviewerChain: reviewChain,
    missionRoleChains,
  };

  const providers: E2EProviderSummary[] = [...inputs.providers.entries()]
    .map(([name, adapter]) => {
      const inGlobalChain = effectiveRouting.globalChain.includes(name);
      const routedRoles = missionRoleChains
        .filter((route) => route.providers.includes(name))
        .map((route) => route.role)
        .sort();
      return {
        name,
        real: name !== FIXTURE_PROVIDER,
        workspaceEdits: adapter.capabilities().workspaceEdits,
        inGlobalChain,
        routedRoles,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const realProviders = providers.filter((p) => p.real);
  const realEditors = realProviders.filter((p) => p.workspaceEdits);

  const hasProvider = (name: string): boolean => inputs.providers.has(name);
  const providerReadiness = (name: string) =>
    inputs.providerReadiness?.get(name);
  const providerIsReady = (name: string): boolean => {
    if (!inputs.providerReadiness) return true;
    return providerReadiness(name)?.status === "ready";
  };
  const hasRealBrainProvider = realProviders.some(
    (provider) =>
      brainChain.includes(provider.name) && providerIsReady(provider.name),
  );

  const scenarios: E2EScenarioReport[] = [];

  scenarios.push(
    hasRealBrainProvider
      ? ready(
          "real_planning",
          "Planning by a real reasoning provider",
          "A real provider is present in the effective brain (orchestrator) chain.",
        )
      : realProviders.length > 0
        ? blocked(
            "real_planning",
            "Planning by a real reasoning provider",
            "blocked_operator_configuration",
            "real_brain_provider_not_routed",
            "Real providers are registered, but none appears in the effective brain chain.",
            {
              environmentVariables: [
                "AVITY_PROVIDER_CHAIN",
                "AVITY_ROLE_PROVIDERS",
              ],
              remediation: [
                "Route a registered real reasoning provider through the orchestrator chain.",
              ],
            },
          )
        : blocked(
            "real_planning",
            "Planning by a real reasoning provider",
            "blocked_missing_credentials",
            "no_real_brain_provider",
            "No real reasoning provider is registered for the brain chain.",
            {
              environmentVariables: [
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "DEEPSEEK_API_KEY",
              ],
              remediation: [
                "Configure credentials for a real reasoning provider and include it in the orchestrator route.",
              ],
            },
          ),
  );

  const missionProviders: { name: string; key: E2EScenarioReport["key"]; env: string }[] = [
    { name: "codex", key: "codex_mission", env: "AVITY_CODEX_BIN" },
    { name: "claude-code", key: "claude_code_mission", env: "AVITY_CLAUDE_CODE_BIN" },
    { name: "cursor", key: "cursor_mission", env: "AVITY_CURSOR_BIN" },
  ];
  for (const { name, key, env } of missionProviders) {
    const title = `Mission executed by ${name}`;
    if (!hasProvider(name)) {
      scenarios.push(
        blocked(
          key,
          title,
          "blocked_missing_tool",
          "mission_adapter_unavailable",
          `The ${name} adapter is not registered because its local executable is unavailable.`,
          {
            tools: [name],
            environmentVariables: [env],
            remediation: [
              `Install ${name}, configure ${env}, and restart the control plane.`,
            ],
          },
        ),
      );
    } else if (!providerIsReady(name)) {
      const readiness = providerReadiness(name);
      const reasons = readiness?.reasons.length
        ? [...readiness.reasons]
        : [
            {
              code: "provider_readiness_missing",
              category: "blocked_operator_configuration" as const,
              message: `${name} has no provider-readiness snapshot`,
              tools: [],
              environmentVariables: [],
              remediation: [
                "Restart the control plane so provider readiness can be evaluated.",
              ],
            },
          ];
      scenarios.push({
        key,
        title,
        status: readiness?.status ?? "blocked_operator_configuration",
        detail:
          reasons[0]?.message ??
          `The ${name} adapter is registered but is not ready.`,
        reasons,
      });
    } else if (!inputs.providers.get(name)!.capabilities().workspaceEdits) {
      scenarios.push(
        blocked(
          key,
          title,
          "blocked_product_gap",
          "workspace_edits_unsupported",
          `The ${name} adapter cannot author workspace edits.`,
          {
            remediation: [
              `Use a ${name} adapter version that declares workspace-edit capability.`,
            ],
          },
        ),
      );
    } else if (!routableMissionProviders.has(name)) {
      scenarios.push(
        blocked(
          key,
          title,
          "blocked_operator_configuration",
          "mission_provider_not_routed",
          `The ${name} adapter is registered and can edit workspaces, but it is not reachable through any effective mission-role provider chain.`,
          {
            environmentVariables: [
              "AVITY_PROVIDER_CHAIN",
              "AVITY_ROLE_PROVIDERS",
            ],
            remediation: [
              `Add ${name} to the global chain or an effective mission-role chain.`,
            ],
          },
        ),
      );
    } else {
      scenarios.push(
        ready(
          key,
          title,
          `The ${name} adapter is registered, can edit workspaces, and is reachable through an effective mission-role chain.`,
        ),
      );
    }
  }

  const availableRealReviewProviders = reviewChain.filter(
    (provider) =>
      provider !== FIXTURE_PROVIDER &&
      inputs.providers.has(provider) &&
      providerIsReady(provider),
  );
  const canSelectDistinctReviewer = new Set(availableRealReviewProviders).size >= 2;

  scenarios.push(
    canSelectDistinctReviewer
      ? ready(
          "reviewer_distinct_from_author",
          "Reviewer distinct from author",
          "The engine reviewer chain contains at least two registered real providers.",
        )
      : realProviders.length >= 2
        ? blocked(
            "reviewer_distinct_from_author",
            "Reviewer distinct from author",
            "blocked_operator_configuration",
            "distinct_reviewer_not_routed",
            "Multiple real providers are registered, but fewer than two appear in the engine reviewer chain.",
            {
              environmentVariables: [
                "AVITY_PROVIDER_CHAIN",
                "AVITY_REVIEW_MODELS",
              ],
              remediation: [
                "Route at least two registered real providers through the reviewer chain.",
              ],
            },
          )
        : blocked(
            "reviewer_distinct_from_author",
            "Reviewer distinct from author",
            "blocked_missing_credentials",
            "second_reviewer_provider_missing",
            "Fewer than two real providers are registered for independent review.",
            {
              environmentVariables: [
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "AVITY_CODEX_BIN",
                "AVITY_CLAUDE_CODE_BIN",
                "AVITY_CURSOR_BIN",
              ],
              remediation: [
                "Configure and route a second real provider for independent review.",
              ],
            },
          ),
  );

  const routableRealEditors = realEditors.filter(
    (provider) =>
      routableMissionProviders.has(provider.name) &&
      providerIsReady(provider.name),
  );
  scenarios.push(
    routableRealEditors.length >= 1
      ? ready(
          "bounded_correction_after_rejection",
          "Bounded correction after rejection",
          "A real workspace-editing provider is reachable through an effective mission-role chain for bounded correction.",
        )
      : realEditors.length >= 1
        ? blocked(
            "bounded_correction_after_rejection",
            "Bounded correction after rejection",
            "blocked_operator_configuration",
            "correction_provider_not_routed",
            "Real workspace-editing providers are registered but none are reachable through an effective mission-role chain.",
            {
              environmentVariables: [
                "AVITY_PROVIDER_CHAIN",
                "AVITY_ROLE_PROVIDERS",
              ],
              remediation: [
                "Route a registered workspace-editing provider through a mission role.",
              ],
            },
          )
        : blocked(
            "bounded_correction_after_rejection",
            "Bounded correction after rejection",
            "blocked_missing_credentials",
            "correction_provider_missing",
            "No real workspace-editing provider is registered to author a correction.",
            {
              environmentVariables: [
                "AVITY_CODEX_BIN",
                "AVITY_CLAUDE_CODE_BIN",
                "AVITY_CURSOR_BIN",
              ],
              remediation: [
                "Configure a real workspace-editing provider for corrective missions.",
              ],
            },
          ),
  );

  const hasBrainFallback =
    new Set(
      brainChain.filter(
        (provider) =>
          provider !== FIXTURE_PROVIDER && providerIsReady(provider),
      ),
    )
      .size >= 2;
  const hasMissionFallback = missionRoleChains.some(
    (route) =>
      new Set(
        route.providers.filter(
          (provider) =>
            provider !== FIXTURE_PROVIDER &&
            providerIsReady(provider) &&
            inputs.providers.get(provider)?.capabilities().workspaceEdits ===
              true,
        ),
      ).size >= 2,
  );
  const hasCrossProviderFallback = hasBrainFallback || hasMissionFallback;

  scenarios.push(
    hasCrossProviderFallback
      ? ready(
          "cross_provider_fallback",
          "Real cross-provider fallback",
          hasBrainFallback
            ? "The effective brain chain contains at least two registered real reasoning providers."
            : "An effective mission-role chain contains at least two registered real workspace editors.",
        )
      : realEditors.length >= 2
        ? blocked(
            "cross_provider_fallback",
            "Real cross-provider fallback",
            "blocked_operator_configuration",
            "fallback_providers_not_co_routed",
            "Multiple real workspace editors are registered, but no effective chain contains two of them.",
            {
              environmentVariables: [
                "AVITY_PROVIDER_CHAIN",
                "AVITY_ROLE_PROVIDERS",
              ],
              remediation: [
                "Place at least two registered real workspace editors in one effective provider chain.",
              ],
            },
          )
        : realProviders.length >= 2
          ? blocked(
              "cross_provider_fallback",
              "Real cross-provider fallback",
              "blocked_product_gap",
              "fallback_workspace_editor_gap",
              "Multiple real providers are registered, but fewer than two can author workspace edits.",
              {
                remediation: [
                  "Use at least two registered real providers that declare workspace-edit capability.",
                ],
              },
            )
        : blocked(
            "cross_provider_fallback",
            "Real cross-provider fallback",
            "blocked_missing_credentials",
            "fallback_provider_missing",
            "Cross-provider fallback requires at least two registered real providers.",
            {
              environmentVariables: [
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "AVITY_CODEX_BIN",
                "AVITY_CLAUDE_CODE_BIN",
                "AVITY_CURSOR_BIN",
              ],
              remediation: [
                "Configure and co-route at least two real providers.",
              ],
            },
          ),
  );

  const { github } = inputs;
  const repositoryTargetConfigured = inputs.repositoryTargetConfigured ?? true;

  if (!github.gitAvailable) {
    scenarios.push(
      blocked(
        "branch_push",
        "Push a dedicated branch",
        "blocked_missing_tool",
        "git_unavailable",
        "git is not available on the host.",
        {
          tools: ["git"],
          remediation: ["Install git and run preflight again."],
        },
      ),
    );
  } else if (!repositoryTargetConfigured) {
    scenarios.push(
      blocked(
        "branch_push",
        "Push a dedicated branch",
        "blocked_operator_configuration",
        "project_remote_not_configured",
        "No repository remote is configured for the project, so the non-mutating push dry-run cannot run. This is a missing operator configuration, not absent credentials.",
        {
          remediation: [
            "Configure the project repository remote (repoRemoteUrl) and run preflight with the project's id before attempting a live push.",
          ],
        },
      ),
    );
  } else if (
    !github.repositoryPushDryRunSucceeded &&
    !github.credentialHintAvailable
  ) {
    scenarios.push(
      blocked(
        "branch_push",
        "Push a dedicated branch",
        "blocked_missing_credentials",
        "git_credentials_missing",
        "No GitHub credential channel is available for the configured project remote.",
        {
          environmentVariables: [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "SSH_AUTH_SOCK",
          ],
          remediation: [
            "Configure a protected GitHub credential channel and repeat the non-mutating push dry-run.",
          ],
        },
      ),
    );
  } else if (!github.repositoryPushDryRunSucceeded) {
    scenarios.push(
      blocked(
        "branch_push",
        "Push a dedicated branch",
        "blocked_operator_configuration",
        "push_dry_run_failed",
        "The configured project remote did not pass the non-mutating dry-run push preflight. This may be caused by credentials, connectivity, repository configuration or remote policy. Pass projectId to run a non-mutating dry-run push against the exact remote configured for a concrete project.",
        {
          remediation: [
            "Verify the project remote, repository access, connectivity, and remote policy before retrying preflight.",
          ],
        },
      ),
    );
  } else {
    scenarios.push(
      ready(
        "branch_push",
        "Push a dedicated branch",
        "A non-mutating dry-run push succeeded against the exact remote configured for the project. This does not prove that a real remote ref update will pass all server-side rules or hooks.",
      ),
    );
  }

  if (!github.gitAvailable || !github.ghAvailable) {
    const missing = [
      ...(github.gitAvailable ? [] : ["git"]),
      ...(github.ghAvailable ? [] : ["gh"]),
    ];
    scenarios.push(
      blocked(
        "draft_pull_request",
        "Create a draft pull request",
        "blocked_missing_tool",
        "github_cli_tool_missing",
        !github.ghAvailable
          ? "the gh CLI is not available on the host."
          : "git is not available on the host.",
        {
          tools: missing,
          remediation: [
            "Install the missing Git and GitHub CLI tools, then run preflight again.",
          ],
        },
      ),
    );
  } else if (!github.ghAuthenticated) {
    scenarios.push(
      blocked(
        "draft_pull_request",
        "Create a draft pull request",
        "blocked_missing_credentials",
        "github_authentication_missing",
        "git and gh are available but GitHub authentication has not been verified; credential hints alone are not sufficient.",
        {
          environmentVariables: [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "SSH_AUTH_SOCK",
          ],
          remediation: [
            "Authenticate gh through a protected credential channel and run preflight again.",
          ],
        },
      ),
    );
  } else if (!repositoryTargetConfigured) {
    scenarios.push(
      blocked(
        "draft_pull_request",
        "Create a draft pull request",
        "blocked_operator_configuration",
        "project_remote_not_configured",
        "git and gh are ready and authenticated, but no repository remote is configured for the project, so the pre-Pull-Request push dry-run cannot run.",
        {
          remediation: [
            "Configure the project repository remote (repoRemoteUrl) and run preflight with the project's id before attempting a Pull Request.",
          ],
        },
      ),
    );
  } else if (!github.repositoryPushDryRunSucceeded) {
    scenarios.push(
      blocked(
        "draft_pull_request",
        "Create a draft pull request",
        "blocked_operator_configuration",
        "pull_request_push_precondition_failed",
        "The account may have a compatible GitHub repository role, but the configured remote did not pass the non-mutating dry-run push required before attempting a Pull Request.",
        {
          remediation: [
            "Correct the configured project remote or repository access before attempting a Pull Request.",
          ],
        },
      ),
    );
  } else if (!github.repositoryWriteRoleObserved) {
    scenarios.push(
      blocked(
        "draft_pull_request",
        "Create a draft pull request",
        "blocked_operator_configuration",
        "repository_write_role_missing",
        "gh is authenticated, but the observed repository role is not WRITE, MAINTAIN or ADMIN.",
        {
          remediation: [
            "Grant the authenticated account WRITE, MAINTAIN, or ADMIN access to the project repository.",
          ],
        },
      ),
    );
  } else {
    scenarios.push(
      ready(
        "draft_pull_request",
        "Create a draft pull request",
        "The configured remote passed the non-mutating push dry-run, gh authentication succeeded, and the account reports a WRITE, MAINTAIN or ADMIN repository role. The preflight does not prove token-specific Pull Requests write permission or final server-side acceptance.",
      ),
    );
  }
  // Structural guarantee, not credential-dependent: the engine retains
  // approved pull requests as drafts and contains no merge operation.
  scenarios.push(
    ready(
      "no_autonomous_merge",
      "No autonomous merge",
      "Guaranteed by design: the engine retains approved pull requests as drafts and never merges them.",
    ),
  );

  const readyCount = scenarios.filter((s) => s.status === "ready").length;
  const blockedCount = scenarios.length - readyCount;
  const readiness = summarizeE2EReadiness(
    scenarios.map((scenario) => scenario.status),
  );

  return E2EPreflightReport.parse({
    schemaVersion: E2E_PREFLIGHT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    readiness,
    usesFakeFixtureOnly: realProviders.length === 0,
    realProviderCount: realProviders.length,
    realWorkspaceEditorCount: realEditors.length,
    providers,
    effectiveRouting,
    github: inputs.github,
    scenarios,
    readyCount,
    blockedCount,
    note: "Preflight reports whether a live attempt appears runnable from non-mutating checks. It never guarantees that a real push, remote rule evaluation or Pull Request creation will succeed.",
  });
}
