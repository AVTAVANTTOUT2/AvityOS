import type {
  E2EPreflightReport,
  E2EProviderSummary,
  E2EScenarioReport,
  E2EScenarioStatus,
} from "@avityos/contracts";
import { E2E_PREFLIGHT_SCHEMA_VERSION } from "@avityos/contracts";
import type { ProviderAdapter } from "@avityos/providers";

/**
 * Deterministic, secret-free readiness preflight for the chantier-4 live E2E
 * campaign. Given the providers the control plane actually registered (which
 * only happens when their credentials/binaries are present) plus the active
 * routing, it reports whether each mandatory scenario is *runnable*.
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
  /** GitHub tooling and credential channels detected at the host boundary. */
  git: boolean;
  gh: boolean;
  /** True when at least one of GH_TOKEN / GITHUB_TOKEN / SSH_AUTH_SOCK is set. */
  githubCredential: boolean;
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
  const chainSet = new Set(inputs.providerChain);

  const providers: E2EProviderSummary[] = [...inputs.providers.entries()]
    .map(([name, adapter]) => ({
      name,
      real: name !== FIXTURE_PROVIDER,
      workspaceEdits: adapter.capabilities().workspaceEdits,
      inChain: chainSet.has(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const realProviders = providers.filter((p) => p.real);
  const realEditors = realProviders.filter((p) => p.workspaceEdits);
  const realInChain = realProviders.filter((p) => p.inChain);

  // The brain prefers the orchestrator role chain, then the global chain; a
  // real analyst/planner does not need workspace-edit capability.
  const brainChain = new Set<string>([
    ...(inputs.roleProviderChains.get("orchestrator") ?? []),
    ...inputs.providerChain,
  ]);
  const hasRealBrainProvider = realProviders.some((p) => brainChain.has(p.name));

  const hasProvider = (name: string): boolean => inputs.providers.has(name);

  const scenarios: E2EScenarioReport[] = [];

  scenarios.push(
    hasRealBrainProvider
      ? ready(
          "real_planning",
          "Planning by a real reasoning provider",
          "A real provider is present in the brain (orchestrator/global) chain.",
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
    } else {
      scenarios.push(ready(key, title, `The ${name} adapter is registered with workspace-edit capability.`));
    }
  }

  scenarios.push(
    realProviders.length >= 2
      ? ready(
          "reviewer_distinct_from_author",
          "Reviewer distinct from author",
          "At least two real providers are registered, so an independent reviewer can differ from the author.",
        )
      : realProviders.length === 1
        ? blocked(
            "reviewer_distinct_from_author",
            "Reviewer distinct from author",
            "blocked_configuration",
            "Only one real provider is registered; a distinct reviewer requires a second real provider.",
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

  scenarios.push(
    realEditors.length >= 1
      ? ready(
          "bounded_correction_after_rejection",
          "Bounded correction after rejection",
          "A real workspace-editing provider can re-run a rejected mission for bounded correction.",
        )
      : blocked(
          "bounded_correction_after_rejection",
          "Bounded correction after rejection",
          "blocked_missing_credentials",
          "No real workspace-editing provider is registered to author a correction.",
          ["AVITY_CODEX_BIN", "AVITY_CLAUDE_CODE_BIN", "AVITY_CURSOR_BIN"],
        ),
  );

  scenarios.push(
    realInChain.length >= 2
      ? ready(
          "cross_provider_fallback",
          "Real cross-provider fallback",
          "The fallback chain contains at least two real providers, so a real fallback can occur.",
        )
      : blocked(
          "cross_provider_fallback",
          "Real cross-provider fallback",
          "blocked_configuration",
          "Fewer than two real providers are in the active chain; a real cross-provider fallback cannot occur.",
          ["AVITY_PROVIDER_CHAIN"],
        ),
  );

  const gitStatus: E2EScenarioStatus = inputs.git && inputs.githubCredential ? "ready" : "blocked_missing_credentials";
  const gitDetail = inputs.git
    ? inputs.githubCredential
      ? "git and a GitHub credential channel are available for pushing a branch."
      : "git is available but no GitHub credential channel (GH_TOKEN / GITHUB_TOKEN / SSH_AUTH_SOCK) is set."
    : "git is not available on the host.";
  const gitRequires = [
    ...(inputs.git ? [] : ["git"]),
    ...(inputs.githubCredential ? [] : ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]),
  ];
  scenarios.push(
    gitStatus === "ready"
      ? ready("branch_push", "Push a dedicated branch", gitDetail)
      : blocked("branch_push", "Push a dedicated branch", gitStatus, gitDetail, gitRequires),
  );

  const prReady = inputs.git && inputs.gh && inputs.githubCredential;
  const prDetail = prReady
    ? "git, the gh CLI and a GitHub credential channel are available to open a draft PR."
    : !inputs.gh
      ? "the gh CLI is not available on the host."
      : gitDetail;
  const prRequires = [
    ...(inputs.gh ? [] : ["gh"]),
    ...gitRequires,
  ];
  scenarios.push(
    prReady
      ? ready("draft_pull_request", "Create a draft pull request", prDetail)
      : blocked("draft_pull_request", "Create a draft pull request", "blocked_missing_credentials", prDetail, prRequires),
  );

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

  return {
    schemaVersion: E2E_PREFLIGHT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    readiness: blockedCount === 0 ? "ready" : "incomplete",
    usesFakeFixtureOnly: realProviders.length === 0,
    realProviderCount: realProviders.length,
    realWorkspaceEditorCount: realEditors.length,
    providers,
    scenarios,
    readyCount,
    blockedCount,
    note: "Preflight reports scenario runnability only; it never asserts that a live scenario passed.",
  };
}
