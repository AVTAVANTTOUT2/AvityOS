import { z } from "zod";
import { Timestamp } from "./entities.js";

/**
 * Versioned, secret-free contract for the chantier-4 live E2E readiness
 * preflight. The preflight reports whether the environment can *run* each
 * mandatory live-delivery scenario — it never asserts that a scenario has
 * passed. Only provider presence, capability booleans and configuration
 * names appear here; credential values never do.
 */
export const E2E_PREFLIGHT_SCHEMA_VERSION = 1 as const;

/** The ten mandatory scenarios of the E2E live-validation milestone. */
export const E2EScenarioKey = z.enum([
  "real_planning",
  "codex_mission",
  "claude_code_mission",
  "cursor_mission",
  "reviewer_distinct_from_author",
  "bounded_correction_after_rejection",
  "cross_provider_fallback",
  "branch_push",
  "draft_pull_request",
  "no_autonomous_merge",
]);
export type E2EScenarioKey = z.infer<typeof E2EScenarioKey>;

/**
 * Runnability status. Never a success verdict: `ready` means the scenario
 * *can be attempted*, not that it succeeded.
 *   - `blocked_missing_credentials`: a required provider, binary or credential
 *     channel is absent (buildProviders only registers providers whose
 *     credentials/config are present).
 *   - `blocked_configuration`: providers exist but the configuration cannot
 *     satisfy the scenario (e.g. a registered adapter is not reachable through
 *     the effective reviewer or mission-role chain).
 */
export const E2EScenarioStatus = z.enum([
  "ready",
  "blocked_missing_credentials",
  "blocked_configuration",
]);
export type E2EScenarioStatus = z.infer<typeof E2EScenarioStatus>;

/** Secret-free summary of one registered provider, including effective routing. */
export const E2EProviderSummary = z
  .object({
    name: z.string().min(1),
    /** A real provider is any registered adapter other than the fake fixture. */
    real: z.boolean(),
    /** Whether the adapter can author repository changes (workspace edits). */
    workspaceEdits: z.boolean(),
    /** Present in AVITY_PROVIDER_CHAIN / providerChain global. */
    inGlobalChain: z.boolean(),
    /** Roles for which the provider appears in an effective chain. */
    routedRoles: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type E2EProviderSummary = z.infer<typeof E2EProviderSummary>;

/**
 * Non-secret GitHub host readiness. Credential *hints* are informational only;
 * readability, push capability and PR creation are verified separately.
 */
export const E2EGitHubReadiness = z
  .object({
    gitAvailable: z.boolean(),
    ghAvailable: z.boolean(),
    /**
     * Indicates that a potential credential channel exists.
     * This is not proof of valid authentication.
     */
    credentialHintAvailable: z.boolean(),
    /**
     * Result of a non-interactive `gh auth status` check.
     * false means gh is absent or not authenticated.
     */
    ghAuthenticated: z.boolean(),
    /**
     * Le dépôt courant est consultable par gh.
     * Cette valeur ne prouve aucun droit d’écriture.
     */
    repositoryReadable: z.boolean(),
    /**
     * Un push Git non interactif a été vérifié avec --dry-run.
     * Cette valeur ne dépend pas de la présence du CLI gh.
     */
    repositoryPushVerified: z.boolean(),
    /**
     * Les permissions GitHub du compte courant autorisent la création
     * d’une branche et d’une pull request dans ce dépôt.
     */
    pullRequestCreationVerified: z.boolean(),
  })
  .strict();
export type E2EGitHubReadiness = z.infer<typeof E2EGitHubReadiness>;

export const E2EScenarioReport = z
  .object({
    key: E2EScenarioKey,
    title: z.string().min(1),
    status: E2EScenarioStatus,
    /** Human-readable, secret-free explanation of the status. */
    detail: z.string().min(1),
    /** Names of the env vars / tooling a blocked scenario needs — never values. */
    requires: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type E2EScenarioReport = z.infer<typeof E2EScenarioReport>;

export const E2EPreflightReport = z
  .object({
    schemaVersion: z
      .literal(E2E_PREFLIGHT_SCHEMA_VERSION)
      .default(E2E_PREFLIGHT_SCHEMA_VERSION),
    generatedAt: Timestamp,
    /** `ready` only when every scenario is runnable. */
    readiness: z.enum(["ready", "incomplete"]),
    /** True when the only registered provider is the deterministic fixture. */
    usesFakeFixtureOnly: z.boolean(),
    realProviderCount: z.number().int().min(0),
    realWorkspaceEditorCount: z.number().int().min(0),
    providers: z.array(E2EProviderSummary),
    github: E2EGitHubReadiness,
    scenarios: z.array(E2EScenarioReport),
    readyCount: z.number().int().min(0),
    blockedCount: z.number().int().min(0),
    /** Explicit honesty guard printed with every report. */
    note: z.string().min(1),
  })
  .strict()
  .superRefine((report, ctx) => {
    const expectedKeys = new Set(E2EScenarioKey.options);
    const actualKeys = report.scenarios.map((scenario) => scenario.key);
    const uniqueKeys = new Set(actualKeys);

    if (report.scenarios.length !== E2EScenarioKey.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenarios"],
        message: `expected exactly ${E2EScenarioKey.options.length} scenarios`,
      });
    }

    if (uniqueKeys.size !== actualKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenarios"],
        message: "scenario keys must be unique",
      });
    }

    for (const key of expectedKeys) {
      if (!uniqueKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenarios"],
          message: `missing mandatory scenario: ${key}`,
        });
      }
    }

    const actualReadyCount = report.scenarios.filter(
      (scenario) => scenario.status === "ready",
    ).length;

    const actualBlockedCount = report.scenarios.length - actualReadyCount;

    if (report.readyCount !== actualReadyCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readyCount"],
        message: "readyCount does not match scenarios",
      });
    }

    if (report.blockedCount !== actualBlockedCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockedCount"],
        message: "blockedCount does not match scenarios",
      });
    }

    const expectedReadiness =
      actualBlockedCount === 0 ? "ready" : "incomplete";

    if (report.readiness !== expectedReadiness) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readiness"],
        message: "readiness does not match scenario statuses",
      });
    }
  });
export type E2EPreflightReport = z.infer<typeof E2EPreflightReport>;
