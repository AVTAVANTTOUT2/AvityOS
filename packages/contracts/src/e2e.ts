import { z } from "zod";
import { Timestamp } from "./entities.js";

/**
 * Versioned, secret-free contract for the chantier-4 live E2E readiness
 * preflight. The preflight reports whether the environment can *run* each
 * mandatory live-delivery scenario — it never asserts that a scenario has
 * passed. Only provider presence, capability booleans and configuration
 * names appear here; credential values never do.
 */
export const E2E_PREFLIGHT_SCHEMA_VERSION = 2 as const;
export const E2E_CAMPAIGN_REPORT_SCHEMA_VERSION = 2 as const;

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
 * Closed runnability vocabulary. `ready` means only that an attempt may start;
 * campaign outcomes use the separate E2ECampaignResultStatus contract.
 */
export const E2EScenarioStatus = z.enum([
  "ready",
  "blocked_operator_configuration",
  "blocked_missing_tool",
  "blocked_missing_credentials",
  "blocked_product_gap",
]);
export type E2EScenarioStatus = z.infer<typeof E2EScenarioStatus>;

/** The four failure categories accepted by structured readiness diagnostics. */
export const E2EBlockedStatus = z.enum([
  "blocked_operator_configuration",
  "blocked_missing_tool",
  "blocked_missing_credentials",
  "blocked_product_gap",
]);
export type E2EBlockedStatus = z.infer<typeof E2EBlockedStatus>;

const READINESS_PRIORITY: readonly E2EScenarioStatus[] = [
  "blocked_product_gap",
  "blocked_missing_tool",
  "blocked_missing_credentials",
  "blocked_operator_configuration",
  "ready",
];

/**
 * Returns the most actionable aggregate readiness state using stable severity
 * order. Product gaps outrank host fixes, while `ready` is returned only when
 * every supplied scenario is ready.
 */
export function summarizeE2EReadiness(
  statuses: readonly E2EScenarioStatus[],
): E2EScenarioStatus {
  return (
    READINESS_PRIORITY.find((status) => statuses.includes(status)) ?? "ready"
  );
}

const CREDENTIAL_VALUE_PATTERN =
  /(?:\bBearer\s+\S+|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|\bsk_(?:live|test)_[A-Za-z0-9]{12,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}|\bglpat-[A-Za-z0-9_-]{12,}|\bnpm_[A-Za-z0-9]{20,}|\bAIza[0-9A-Za-z_-]{35}|(?:api[_-]?key|token|secret)\s*[=:]\s*\S+)/i;

function isSecretFree(value: string): boolean {
  return !CREDENTIAL_VALUE_PATTERN.test(value);
}

const SecretFreeText = z
  .string()
  .min(1)
  .refine(isSecretFree, "must not contain a credential-like value");

const SecretFreeIdentifier = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+/_-]*$/)
  .refine(isSecretFree, "must not contain a credential-like value");

/** Structured, secret-free reason attached to one blocked readiness check. */
export const E2EReadinessReason = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    category: E2EBlockedStatus,
    message: SecretFreeText,
    tools: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)),
    environmentVariables: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
    remediation: z.array(SecretFreeText).min(1),
  })
  .strict()
  .superRefine((reason, ctx) => {
    if (reason.category === "blocked_missing_tool" && reason.tools.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tools"],
        message: "missing-tool reasons must name at least one tool",
      });
    }
    if (
      reason.category === "blocked_missing_credentials" &&
      reason.environmentVariables.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["environmentVariables"],
        message: "missing-credentials reasons must name a credential channel",
      });
    }
  });
export type E2EReadinessReason = z.infer<typeof E2EReadinessReason>;

/** Secret-free summary of one registered provider, including effective routing. */
export const E2EProviderSummary = z
  .object({
    name: SecretFreeIdentifier,
    /** A real provider is any registered adapter other than the fake fixture. */
    real: z.boolean(),
    /** Whether the adapter can author repository changes (workspace edits). */
    workspaceEdits: z.boolean(),
    /** Present in AVITY_PROVIDER_CHAIN / providerChain global. */
    inGlobalChain: z.boolean(),
    /** Roles for which the provider appears in an effective chain. */
    routedRoles: z.array(z.string().min(1)),
  })
  .strict();
export type E2EProviderSummary = z.infer<typeof E2EProviderSummary>;

/**
 * Non-secret GitHub host readiness. Credential *hints* are informational only;
 * readability, push dry-run outcome and observed repository role are separate
 * non-mutating signals — never proof that a live push or PR will succeed.
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
     * Une tentative de push non mutante vers le remote configuré a réussi.
     *
     * Cela confirme que la commande peut être préparée et que certaines erreurs
     * immédiates d’accès ou de configuration ne sont pas survenues.
     *
     * Cela ne prouve pas qu’un véritable push serait accepté par les rulesets,
     * les hooks distants ou toutes les politiques serveur.
     */
    repositoryPushDryRunSucceeded: z.boolean(),
    /**
     * Le rôle GitHub observé pour le compte courant est WRITE, MAINTAIN ou ADMIN.
     *
     * Cela indique un rôle de dépôt compatible avec un workflow de Pull Request,
     * mais ne prouve pas que le credential actif possède toutes les permissions
     * fines nécessaires, notamment `Pull requests: write`.
     */
    repositoryWriteRoleObserved: z.boolean(),
  })
  .strict();
export type E2EGitHubReadiness = z.infer<typeof E2EGitHubReadiness>;

/** One effective engine provider chain associated with a mission role. */
export const E2ERoleRouting = z
  .object({
    role: SecretFreeIdentifier,
    providers: z.array(SecretFreeIdentifier),
  })
  .strict();
export type E2ERoleRouting = z.infer<typeof E2ERoleRouting>;

/**
 * Secret-free snapshot of the registered provider chains that the engine can
 * actually traverse. Configured-but-unregistered adapters are intentionally
 * absent and are represented by scenario diagnostics instead.
 */
export const E2EEffectiveRouting = z
  .object({
    globalChain: z.array(SecretFreeIdentifier),
    brainChain: z.array(SecretFreeIdentifier),
    reviewerChain: z.array(SecretFreeIdentifier),
    missionRoleChains: z.array(E2ERoleRouting),
  })
  .strict();
export type E2EEffectiveRouting = z.infer<typeof E2EEffectiveRouting>;

export const E2EScenarioReport = z
  .object({
    key: E2EScenarioKey,
    title: SecretFreeText,
    status: E2EScenarioStatus,
    /** Human-readable, secret-free explanation of the status. */
    detail: SecretFreeText,
    /** Empty for ready checks; one or more typed reasons for blocked checks. */
    reasons: z.array(E2EReadinessReason),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    if (scenario.status === "ready" && scenario.reasons.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasons"],
        message: "ready scenarios cannot contain blocker reasons",
      });
      return;
    }
    if (scenario.status !== "ready" && scenario.reasons.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasons"],
        message: "blocked scenarios require at least one reason",
      });
    }
    for (const [index, reason] of scenario.reasons.entries()) {
      if (reason.category !== scenario.status) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reasons", index, "category"],
          message: "reason category must match scenario status",
        });
      }
    }
  });
export type E2EScenarioReport = z.infer<typeof E2EScenarioReport>;

export const E2EPreflightReport = z
  .object({
    schemaVersion: z.literal(E2E_PREFLIGHT_SCHEMA_VERSION),
    generatedAt: Timestamp,
    /** Aggregate of scenario statuses using summarizeE2EReadiness. */
    readiness: E2EScenarioStatus,
    /** True when the only registered provider is the deterministic fixture. */
    usesFakeFixtureOnly: z.boolean(),
    realProviderCount: z.number().int().min(0),
    realWorkspaceEditorCount: z.number().int().min(0),
    providers: z.array(E2EProviderSummary),
    effectiveRouting: E2EEffectiveRouting,
    github: E2EGitHubReadiness,
    scenarios: z.array(E2EScenarioReport),
    readyCount: z.number().int().min(0),
    blockedCount: z.number().int().min(0),
    /** Explicit honesty guard printed with every report. */
    note: SecretFreeText,
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

    const expectedReadiness = summarizeE2EReadiness(
      report.scenarios.map((scenario) => scenario.status),
    );

    if (report.readiness !== expectedReadiness) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readiness"],
        message: "readiness does not match scenario statuses",
      });
    }

    // Provider counts are honesty signals: a real-provider count that does not
    // match the provider list, or a duplicated provider name, could understate
    // fixture-only usage or double-count a real adapter. Pin both to the array.
    const actualRealProviderCount = report.providers.filter(
      (provider) => provider.real,
    ).length;

    if (report.realProviderCount !== actualRealProviderCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["realProviderCount"],
        message: "realProviderCount does not match providers",
      });
    }

    const actualRealWorkspaceEditorCount = report.providers.filter(
      (provider) => provider.real && provider.workspaceEdits,
    ).length;

    if (report.realWorkspaceEditorCount !== actualRealWorkspaceEditorCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["realWorkspaceEditorCount"],
        message: "realWorkspaceEditorCount does not match providers",
      });
    }

    const providerNames = report.providers.map((provider) => provider.name);
    if (new Set(providerNames).size !== providerNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providers"],
        message: "provider names must be unique",
      });
    }

    for (const provider of report.providers) {
      if (provider.real !== (provider.name !== "fake")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providers"],
          message: `${provider.name} has an incoherent real-provider flag`,
        });
      }
    }

    if (report.usesFakeFixtureOnly !== (actualRealProviderCount === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["usesFakeFixtureOnly"],
        message: "usesFakeFixtureOnly does not match providers",
      });
    }

    const registeredProviders = new Set(providerNames);
    const routeChains: [string, string[]][] = [
      ["globalChain", report.effectiveRouting.globalChain],
      ["brainChain", report.effectiveRouting.brainChain],
      ["reviewerChain", report.effectiveRouting.reviewerChain],
      ...report.effectiveRouting.missionRoleChains.map(
        (route): [string, string[]] => [
          `missionRoleChains.${route.role}`,
          route.providers,
        ],
      ),
    ];
    for (const [path, chain] of routeChains) {
      if (new Set(chain).size !== chain.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["effectiveRouting", path],
          message: "effective provider chains must not contain duplicates",
        });
      }
      for (const provider of chain) {
        if (!registeredProviders.has(provider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["effectiveRouting", path],
            message: `effective routing references unregistered provider: ${provider}`,
          });
        }
      }
    }

    const routedRoles = report.effectiveRouting.missionRoleChains.map(
      (route) => route.role,
    );
    if (new Set(routedRoles).size !== routedRoles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveRouting", "missionRoleChains"],
        message: "mission role routes must be unique",
      });
    }

    for (const provider of report.providers) {
      if (
        provider.inGlobalChain !==
        report.effectiveRouting.globalChain.includes(provider.name)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providers"],
          message: `${provider.name} inGlobalChain disagrees with effective routing`,
        });
      }
      const actualRoles = report.effectiveRouting.missionRoleChains
        .filter((route) => route.providers.includes(provider.name))
        .map((route) => route.role)
        .sort();
      if (
        provider.routedRoles.length !== actualRoles.length ||
        [...provider.routedRoles].sort().some(
          (role, index) => role !== actualRoles[index],
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providers"],
          message: `${provider.name} routedRoles disagrees with effective routing`,
        });
      }
    }

    const providerByName = new Map(
      report.providers.map((provider) => [provider.name, provider]),
    );
    const scenarioByKey = new Map(
      report.scenarios.map((scenario) => [scenario.key, scenario]),
    );
    const rejectUnsupportedReadyClaim = (
      key: E2EScenarioKey,
      supported: boolean,
      message: string,
    ): void => {
      if (scenarioByKey.get(key)?.status === "ready" && !supported) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenarios"],
          message,
        });
      }
    };

    const isRealRegistered = (name: string): boolean =>
      providerByName.get(name)?.real === true;
    const isRealEditor = (name: string): boolean => {
      const provider = providerByName.get(name);
      return provider?.real === true && provider.workspaceEdits;
    };
    const missionChains = report.effectiveRouting.missionRoleChains.map(
      (route) => route.providers,
    );
    rejectUnsupportedReadyClaim(
      "real_planning",
      report.effectiveRouting.brainChain.some(isRealRegistered),
      "ready real_planning requires a registered real provider in the brain chain",
    );
    for (const [key, providerName] of [
      ["codex_mission", "codex"],
      ["claude_code_mission", "claude-code"],
      ["cursor_mission", "cursor"],
    ] as const) {
      rejectUnsupportedReadyClaim(
        key,
        isRealEditor(providerName) &&
          missionChains.some((chain) => chain.includes(providerName)),
        `ready ${key} requires its registered workspace editor in a mission route`,
      );
    }
    rejectUnsupportedReadyClaim(
      "reviewer_distinct_from_author",
      new Set(
        report.effectiveRouting.reviewerChain.filter(isRealRegistered),
      ).size >= 2,
      "ready reviewer separation requires two registered real providers",
    );
    rejectUnsupportedReadyClaim(
      "bounded_correction_after_rejection",
      missionChains.some((chain) => chain.some(isRealEditor)),
      "ready correction requires a registered real workspace editor in a mission route",
    );
    rejectUnsupportedReadyClaim(
      "cross_provider_fallback",
      new Set(
        report.effectiveRouting.brainChain.filter(isRealRegistered),
      ).size >= 2 ||
        missionChains.some(
          (chain) =>
            new Set(chain.filter(isRealEditor)).size >= 2,
        ),
      "ready fallback requires two real brain providers or two real workspace editors in one mission chain",
    );
    rejectUnsupportedReadyClaim(
      "branch_push",
      report.github.gitAvailable &&
        report.github.repositoryPushDryRunSucceeded,
      "ready branch_push requires git and a successful non-mutating push dry-run",
    );
    rejectUnsupportedReadyClaim(
      "draft_pull_request",
      report.github.gitAvailable &&
        report.github.ghAvailable &&
        report.github.ghAuthenticated &&
        report.github.repositoryPushDryRunSucceeded &&
        report.github.repositoryWriteRoleObserved,
      "ready draft_pull_request lacks required GitHub readiness evidence",
    );
  });
export type E2EPreflightReport = z.infer<typeof E2EPreflightReport>;

/** Observed campaign verdicts. These values are intentionally disjoint from readiness. */
export const E2ECampaignResultStatus = z.enum([
  "passed",
  "failed",
  "blocked",
  "not_attempted",
]);
export type E2ECampaignResultStatus = z.infer<
  typeof E2ECampaignResultStatus
>;

/** Origin of one campaign evidence reference. */
export const E2ECampaignEvidenceSource = z.enum([
  "provider_run",
  "public_api",
  "git",
  "github",
  "fake_fixture",
]);
export type E2ECampaignEvidenceSource = z.infer<
  typeof E2ECampaignEvidenceSource
>;

/**
 * Structured evidence provenance. Provider runs must identify their adapter;
 * system evidence must not invent one.
 */
export const E2ECampaignEvidence = z
  .object({
    source: E2ECampaignEvidenceSource,
    provider: SecretFreeIdentifier.nullable(),
    reference: SecretFreeText,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.source === "provider_run" && evidence.provider === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "provider-run evidence must identify its provider",
      });
    }
    if (evidence.source !== "provider_run" && evidence.provider !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "non-provider evidence cannot claim a provider",
      });
    }
  });
export type E2ECampaignEvidence = z.infer<typeof E2ECampaignEvidence>;

/** Observed outcome and evidence references for one mandatory scenario. */
export const E2ECampaignScenarioResult = z
  .object({
    key: E2EScenarioKey,
    status: E2ECampaignResultStatus,
    detail: SecretFreeText,
    evidence: z.array(E2ECampaignEvidence),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "passed" && result.evidence.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "passed campaign scenarios require observed evidence",
      });
    }
    if (result.status === "passed") {
      for (const [index, evidence] of result.evidence.entries()) {
        const provider = evidence.provider?.toLowerCase();
        if (
          evidence.source === "fake_fixture" ||
          provider === "fake" ||
          provider === "fake_fixture"
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["evidence", index],
            message: "fake fixtures cannot prove a passed live campaign scenario",
          });
        }
      }
    }
    if (
      result.status === "not_attempted" &&
      result.evidence.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "not-attempted scenarios cannot contain execution evidence",
      });
    }
  });
export type E2ECampaignScenarioResult = z.infer<
  typeof E2ECampaignScenarioResult
>;

function summarizeCampaignResult(
  results: readonly E2ECampaignResultStatus[],
): E2ECampaignResultStatus {
  if (results.includes("failed")) {
    return "failed";
  }
  if (results.includes("blocked")) {
    return "blocked";
  }
  if (results.includes("not_attempted")) {
    return "not_attempted";
  }
  return "passed";
}

/**
 * Versioned result of an attempted (or explicitly not attempted) campaign.
 * It never accepts `ready`, because preflight readiness is not execution proof.
 */
export const E2ECampaignReport = z
  .object({
    schemaVersion: z.literal(E2E_CAMPAIGN_REPORT_SCHEMA_VERSION),
    generatedAt: Timestamp,
    campaignId: SecretFreeIdentifier,
    projectId: SecretFreeIdentifier,
    result: E2ECampaignResultStatus,
    results: z.array(E2ECampaignScenarioResult),
    passedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    blockedCount: z.number().int().min(0),
    notAttemptedCount: z.number().int().min(0),
    note: SecretFreeText,
  })
  .strict()
  .superRefine((report, ctx) => {
    const keys = report.results.map((result) => result.key);
    const uniqueKeys = new Set(keys);
    if (
      report.results.length !== E2EScenarioKey.options.length ||
      uniqueKeys.size !== keys.length ||
      E2EScenarioKey.options.some((key) => !uniqueKeys.has(key))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["results"],
        message: "campaign report must contain each mandatory scenario once",
      });
    }

    const counts: Record<E2ECampaignResultStatus, number> = {
      passed: 0,
      failed: 0,
      blocked: 0,
      not_attempted: 0,
    };
    for (const result of report.results) {
      counts[result.status] += 1;
    }
    for (const [field, expected] of [
      ["passedCount", counts.passed],
      ["failedCount", counts.failed],
      ["blockedCount", counts.blocked],
      ["notAttemptedCount", counts.not_attempted],
    ] as const) {
      if (report[field] !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} does not match campaign results`,
        });
      }
    }

    if (
      report.result !==
      summarizeCampaignResult(report.results.map((result) => result.status))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "aggregate campaign result does not match scenario results",
      });
    }
  });
export type E2ECampaignReport = z.infer<typeof E2ECampaignReport>;
