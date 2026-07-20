import {
  E2EPreflightReport,
  E2E_PREFLIGHT_SCHEMA_VERSION,
  type E2EProviderSummary,
  type E2EScenarioReport,
  type E2EScenarioStatus,
} from "@avityos/contracts";
import type { ProviderAdapter } from "@avityos/providers";
import {
  effectiveBrainProviderChain,
  effectiveProviderChainForRole,
  providersRoutableForRoles,
  uniqueProviderChain,
  type ProviderRoutingInput,
} from "./provider-routing.js";

/**
 * Deterministic, secret-free readiness preflight for the chantier-4 live E2E
 * campaign. Given the providers the control plane actually registered (which
 * only happens when their credentials/binaries are present) plus the same
 * effective routing the Engine uses, it reports whether each mandatory
 * scenario is *runnable*.
 *
 * It never runs a provider and never asserts a scenario passed: statuses are
 * limited to `ready` / `blocked_missing_credentials` / `blocked_configuration`.
 * No credential value is read or surfaced — only provider names, capability
 * booleans and the names of the env vars a blocked scenario still needs.
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
  /** Non-secret GitHub host readiness (async detection happens at the boundary). */
  github: {
    gitAvailable: boolean;
    ghAvailable: boolean;
    credentialHintAvailable: boolean;
    ghAuthenticated: boolean;
    repositoryAccessVerified: boolean;
  };
  now?: () => Date;
}

/** The fixture provider is a deterministic engineering aid, never real evidence. */
const FIXTURE_PROVIDER = "fake";

function blocked(
  key: E2EScenarioReport["key"],
  title: string,
  status: Exclude<E2EScenarioStatus, "ready">,
  detail: string,
  requires: string[] = [],
): E2EScenarioReport {
  return { key, title, status, detail, requires };
}

function ready(
  key: E2EScenarioReport["key"],
  title: string,
  detail: string,
): E2EScenarioReport {
  return { key, title, status: "ready", detail, requires: [] };
}

export function buildE2EPreflight(inputs: E2EPreflightInputs): E2EPreflightReport {
  const now = inputs.now ?? (() => new Date());
  const routingInput: ProviderRoutingInput = {
    providerChain: inputs.providerChain,
    roleProviderChains: inputs.roleProviderChains,
  };
  const routableMissionProviders = providersRoutableForRoles(
    routingInput,
    inputs.missionRoles,
  );
  const brainChain = effectiveBrainProviderChain(routingInput);
  // Engine independent review inspects the global chain only.
  const reviewChain = uniqueProviderChain(inputs.providerChain);

  const providers: E2EProviderSummary[] = [...inputs.providers.entries()]
    .map(([name, adapter]) => {
      const inGlobalChain = inputs.providerChain.includes(name);
      const routedRoles = inputs.missionRoles.filter((role) =>
        effectiveProviderChainForRole(routingInput, role).includes(name),
      );
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
  const hasRealBrainProvider = realProviders.some((p) => brainChain.includes(p.name));

  const hasProvider = (name: string): boolean => inputs.providers.has(name);

  const scenarios: E2EScenarioReport[] = [];

  scenarios.push(
    hasRealBrainProvider
      ? ready(
          "real_planning",
          "Planning by a real reasoning provider",
          "A real provider is present in the effective brain (orchestrator) chain.",
        )
      : blocked(
          "real_planning",
          "Planning by a real reasoning provider",
          "blocked_missing_credentials",
          "No real provider is registered for the brain chain; only the deterministic fixture is available.",
          ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "AVITY_PROVIDER_CHAIN"],
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
        blocked(key, title, "blocked_missing_credentials", `The ${name} adapter is not registered.`, [env]),
      );
    } else if (!inputs.providers.get(name)!.capabilities().workspaceEdits) {
      scenarios.push(
        blocked(key, title, "blocked_configuration", `The ${name} adapter cannot author workspace edits.`),
      );
    } else if (!routableMissionProviders.has(name)) {
      scenarios.push(
        blocked(
          key,
          title,
          "blocked_configuration",
          `The ${name} adapter is registered and can edit workspaces, but it is not reachable through any effective mission-role provider chain.`,
          ["AVITY_PROVIDER_CHAIN", "AVITY_ROLE_PROVIDERS"],
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
    (provider) => provider !== FIXTURE_PROVIDER && inputs.providers.has(provider),
  );
  const canSelectDistinctReviewer = new Set(availableRealReviewProviders).size >= 2;

  scenarios.push(
    canSelectDistinctReviewer
      ? ready(
          "reviewer_distinct_from_author",
          "Reviewer distinct from author",
          "The engine reviewer chain contains at least two registered real providers.",
        )
      : availableRealReviewProviders.length === 1
        ? blocked(
            "reviewer_distinct_from_author",
            "Reviewer distinct from author",
            "blocked_configuration",
            "The engine reviewer chain contains only one registered real provider; a distinct reviewer requires a second real provider in that chain.",
            ["AVITY_PROVIDER_CHAIN", "AVITY_REVIEW_MODELS"],
          )
        : realProviders.length >= 1
          ? blocked(
              "reviewer_distinct_from_author",
              "Reviewer distinct from author",
              "blocked_configuration",
              "Real providers are registered but fewer than two appear in the engine reviewer chain.",
              ["AVITY_PROVIDER_CHAIN", "AVITY_REVIEW_MODELS"],
            )
          : blocked(
              "reviewer_distinct_from_author",
              "Reviewer distinct from author",
              "blocked_missing_credentials",
              "No real provider is registered.",
              ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AVITY_CODEX_BIN", "AVITY_CLAUDE_CODE_BIN", "AVITY_CURSOR_BIN"],
            ),
  );

  const routableRealEditors = realEditors.filter((p) => routableMissionProviders.has(p.name));
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
            "blocked_configuration",
            "Real workspace-editing providers are registered but none are reachable through an effective mission-role chain.",
            ["AVITY_PROVIDER_CHAIN", "AVITY_ROLE_PROVIDERS"],
          )
        : blocked(
            "bounded_correction_after_rejection",
            "Bounded correction after rejection",
            "blocked_missing_credentials",
            "No real workspace-editing provider is registered to author a correction.",
            ["AVITY_CODEX_BIN", "AVITY_CLAUDE_CODE_BIN", "AVITY_CURSOR_BIN"],
          ),
  );

  const effectiveChains = [
    brainChain,
    ...inputs.missionRoles.map((role) => effectiveProviderChainForRole(routingInput, role)),
  ];
  const hasCrossProviderFallback = effectiveChains.some((chain) => {
    const realAvailable = chain.filter(
      (provider) => provider !== FIXTURE_PROVIDER && inputs.providers.has(provider),
    );
    return new Set(realAvailable).size >= 2;
  });

  scenarios.push(
    hasCrossProviderFallback
      ? ready(
          "cross_provider_fallback",
          "Real cross-provider fallback",
          "At least one effective brain or mission-role chain contains two registered real providers.",
        )
      : blocked(
          "cross_provider_fallback",
          "Real cross-provider fallback",
          "blocked_configuration",
          "No effective brain or mission-role chain contains two registered real providers.",
          ["AVITY_PROVIDER_CHAIN", "AVITY_ROLE_PROVIDERS"],
        ),
  );

  const { github } = inputs;

  if (!github.gitAvailable) {
    scenarios.push(
      blocked(
        "branch_push",
        "Push a dedicated branch",
        "blocked_missing_credentials",
        "git is not available on the host.",
        ["git"],
      ),
    );
  } else if (!github.repositoryAccessVerified) {
    if (!github.ghAuthenticated) {
      scenarios.push(
        blocked(
          "branch_push",
          "Push a dedicated branch",
          "blocked_missing_credentials",
          "git is available but GitHub authentication has not been verified; credential hints alone are not sufficient.",
          ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"],
        ),
      );
    } else {
      scenarios.push(
        blocked(
          "branch_push",
          "Push a dedicated branch",
          "blocked_configuration",
          "gh is authenticated but repository access has not been verified for a concrete project; pass projectId to check a specific repository.",
          [],
        ),
      );
    }
  } else {
    scenarios.push(
      ready(
        "branch_push",
        "Push a dedicated branch",
        "git is available and repository access has been verified for a concrete project.",
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
        "blocked_missing_credentials",
        !github.ghAvailable
          ? "the gh CLI is not available on the host."
          : "git is not available on the host.",
        missing,
      ),
    );
  } else if (!github.ghAuthenticated) {
    scenarios.push(
      blocked(
        "draft_pull_request",
        "Create a draft pull request",
        "blocked_missing_credentials",
        "git and gh are available but GitHub authentication has not been verified; credential hints alone are not sufficient.",
        ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"],
      ),
    );
  } else if (!github.repositoryAccessVerified) {
    scenarios.push(
      blocked(
        "draft_pull_request",
        "Create a draft pull request",
        "blocked_configuration",
        "gh is authenticated but repository access has not been verified for a concrete project; pass projectId to check a specific repository.",
        [],
      ),
    );
  } else {
    scenarios.push(
      ready(
        "draft_pull_request",
        "Create a draft pull request",
        "git and gh are available, gh authentication succeeds, and repository access has been verified.",
      ),
    );
  }

  // Structural guarantee, not credential-dependent: the engine only marks
  // approved drafts ready and contains no merge operation.
  scenarios.push(
    ready(
      "no_autonomous_merge",
      "No autonomous merge",
      "Guaranteed by design: the engine marks approved drafts ready and never merges a pull request.",
    ),
  );

  const readyCount = scenarios.filter((s) => s.status === "ready").length;
  const blockedCount = scenarios.length - readyCount;
  const readiness = blockedCount === 0 ? "ready" : "incomplete";

  return E2EPreflightReport.parse({
    schemaVersion: E2E_PREFLIGHT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    readiness,
    usesFakeFixtureOnly: realProviders.length === 0,
    realProviderCount: realProviders.length,
    realWorkspaceEditorCount: realEditors.length,
    providers,
    github: inputs.github,
    scenarios,
    readyCount,
    blockedCount,
    note: "Preflight reports scenario runnability only; it never asserts that a live scenario passed.",
  });
}
