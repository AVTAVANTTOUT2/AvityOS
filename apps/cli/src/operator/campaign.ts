import { randomUUID } from "node:crypto";
import {
  E2ECampaignReport,
  E2EPreflightReport,
  E2EScenarioKey,
  type AgentRun,
  type Approval,
  type Checkpoint,
  type E2ECampaignEvidence,
  type E2ECampaignResultStatus,
  type E2EPreflightReport as E2EPreflightReportType,
  type EventEnvelope,
  type Mission,
  type PullRequestRef,
} from "@avityos/contracts";
import type { DoctorReport, ReadinessState } from "./diagnostics.js";
import {
  OPERATOR_CAMPAIGN_REPORT_FORMAT_VERSION,
  type CampaignConfigurationSnapshot,
  type CampaignEvidenceSnapshot,
  type CampaignReportWriter,
  type OperatorCampaignReport,
} from "./campaign-report.js";
import { redactText, redactValue } from "./redact.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 150;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_POLLS = 1_000;
const LIVE_OBJECTIVE =
  "Execute the complete AvityOS live fixture campaign, including real planning, provider missions, independent review, bounded correction, fallback evidence, branch publication, and a pull request without merging it.";
const LIVE_ACCEPTANCE_CRITERIA = [
  "Use real configured providers and preserve provider provenance.",
  "Complete normal and bounded correction paths with observable public evidence.",
  "Publish a campaign branch and create a draft or ready-for-review pull request.",
  "Never merge the pull request automatically.",
] as const;

const READINESS_PRIORITY: readonly ReadinessState[] = [
  "blocked_product_gap",
  "blocked_missing_tool",
  "blocked_missing_credentials",
  "blocked_operator_configuration",
  "ready",
];

export interface PublicCampaignApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface CampaignDependencies {
  readonly api: PublicCampaignApi;
  readonly collectDoctor: () => Promise<DoctorReport>;
  readonly configuration: CampaignConfigurationSnapshot;
  readonly reportWriter?: CampaignReportWriter;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly confirmProject?: (projectId: string) => Promise<string | undefined>;
}

export interface PrepareLiveCampaignOptions {
  readonly projectId: string;
  readonly allowFaultInjection?: boolean;
}

export interface RunLiveCampaignOptions extends PrepareLiveCampaignOptions {
  readonly isTTY: boolean;
  readonly confirmedProjectId?: string;
  readonly pullRequestPolicy?: "draft" | "ready-for-review";
  readonly maxPolls?: number;
  readonly pollIntervalMs?: number;
}

export interface CampaignCommandResult {
  readonly ok: boolean;
  readonly report: OperatorCampaignReport;
  readonly reportPath: string | null;
}

interface ProviderStatusShape {
  readonly executionMode?: unknown;
  readonly campaign?: {
    readonly faultInjection?: {
      readonly enabled?: unknown;
      readonly provider?: unknown;
      readonly category?: unknown;
    };
  };
  readonly checks?: readonly { readonly status?: unknown; readonly detail?: unknown }[];
}

interface PublicSnapshot {
  readonly project: unknown;
  readonly brain: unknown;
  readonly missions: readonly Mission[];
  readonly runs: readonly AgentRun[];
  readonly events: readonly EventEnvelope[];
  readonly checkpoints: readonly Checkpoint[];
  readonly approvals: readonly Approval[];
  readonly clarifications: readonly unknown[];
  readonly pullRequests: readonly PullRequestRef[];
}

interface ReadinessCollection {
  readonly doctor: DoctorReport;
  readonly providerStatus: unknown;
  readonly preflight: E2EPreflightReportType;
  readonly status: ReadinessState;
  readonly recommendations: readonly string[];
}

function assertProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId)) {
    throw new Error("project id must be a non-empty public API identifier");
  }
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function summarizeReadiness(statuses: readonly ReadinessState[]): ReadinessState {
  return READINESS_PRIORITY.find((status) => statuses.includes(status)) ?? "ready";
}

function isReadinessState(value: unknown): value is ReadinessState {
  return typeof value === "string" && READINESS_PRIORITY.includes(value as ReadinessState);
}

function providerReadiness(
  providerStatus: unknown,
  allowFaultInjection: boolean,
): { readonly status: ReadinessState; readonly recommendations: readonly string[] } {
  const snapshot = providerStatus as ProviderStatusShape;
  const checkStatuses = (snapshot.checks ?? [])
    .map((check) => check.status)
    .filter(isReadinessState);
  const recommendations = (snapshot.checks ?? [])
    .filter((check) => check.status !== "ready" && typeof check.detail === "string")
    .map((check) => redactText(String(check.detail)));
  const fault = snapshot.campaign?.faultInjection;
  if (fault?.enabled === true && !allowFaultInjection) {
    const provider = typeof fault.provider === "string" ? redactText(fault.provider) : "configured provider";
    return {
      status: "blocked_operator_configuration",
      recommendations: [
        ...recommendations,
        `Fault injection targets ${provider}; rerun with --allow-fault-injection only for the explicitly authorized fallback scenario.`,
      ],
    };
  }
  if (snapshot.executionMode !== "campaign") {
    return {
      status: "blocked_operator_configuration",
      recommendations: [
        ...recommendations,
        "Start the control plane with AVITY_EXECUTION_MODE=campaign before a live campaign.",
      ],
    };
  }
  return {
    status: summarizeReadiness(checkStatuses.length > 0 ? checkStatuses : ["ready"]),
    recommendations,
  };
}

function preflightRecommendations(preflight: E2EPreflightReportType): string[] {
  return preflight.scenarios.flatMap((scenario) =>
    scenario.reasons.flatMap((reason) =>
      reason.remediation.map((remediation) => `${scenario.key}: ${redactText(remediation)}`),
    ),
  );
}

async function collectReadiness(
  projectId: string,
  allowFaultInjection: boolean,
  dependencies: CampaignDependencies,
): Promise<ReadinessCollection> {
  const doctor = await dependencies.collectDoctor();
  const [providerStatus, preflightValue] = await Promise.all([
    dependencies.api.get<unknown>("/v1/providers/status"),
    dependencies.api.get<unknown>(
      `/v1/e2e/preflight?projectId=${encodeURIComponent(projectId)}`,
    ),
  ]);
  const preflight = E2EPreflightReport.parse(preflightValue);
  const provider = providerReadiness(providerStatus, allowFaultInjection);
  return {
    doctor,
    providerStatus: redactValue(providerStatus),
    preflight,
    status: summarizeReadiness([
      doctor.readiness,
      provider.status,
      preflight.readiness,
    ]),
    recommendations: [
      ...doctor.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.id}: ${redactText(check.detail)}`),
      ...provider.recommendations,
      ...preflightRecommendations(preflight),
    ],
  };
}

function campaignId(now: Date): string {
  return `campaign-${now.toISOString().replace(/[^0-9]/g, "")}-${randomUUID()}`;
}

function emptyEvidence(): CampaignEvidenceSnapshot {
  return {
    project: null,
    brain: null,
    missions: [],
    runs: [],
    events: [],
    checkpoints: [],
    interventions: { approvals: [], clarifications: [] },
    pullRequests: [],
  };
}

function aggregateResult(
  results: readonly { readonly status: E2ECampaignResultStatus }[],
): E2ECampaignResultStatus {
  const statuses = results.map((result) => result.status);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("not_attempted")) return "not_attempted";
  return "passed";
}

function buildCampaignContract(
  input: {
    readonly generatedAt: string;
    readonly campaignId: string;
    readonly projectId: string;
    readonly statuses: ReadonlyMap<
      (typeof E2EScenarioKey.options)[number],
      {
        readonly status: E2ECampaignResultStatus;
        readonly detail: string;
        readonly evidence: readonly E2ECampaignEvidence[];
      }
    >;
    readonly note: string;
  },
): E2ECampaignReport {
  const results = E2EScenarioKey.options.map((key) => {
    const observed = input.statuses.get(key);
    if (!observed) throw new Error(`campaign result is missing mandatory scenario ${key}`);
    return {
      key,
      status: observed.status,
      detail: redactText(observed.detail),
      evidence: [...observed.evidence],
    };
  });
  const count = (status: E2ECampaignResultStatus): number =>
    results.filter((result) => result.status === status).length;
  return E2ECampaignReport.parse({
    schemaVersion: 2,
    generatedAt: input.generatedAt,
    campaignId: input.campaignId,
    projectId: input.projectId,
    result: aggregateResult(results),
    results,
    passedCount: count("passed"),
    failedCount: count("failed"),
    blockedCount: count("blocked"),
    notAttemptedCount: count("not_attempted"),
    note: redactText(input.note),
  });
}

function prepareStatuses(
  preflight: E2EPreflightReportType,
): Map<
  (typeof E2EScenarioKey.options)[number],
  { status: E2ECampaignResultStatus; detail: string; evidence: E2ECampaignEvidence[] }
> {
  return new Map(preflight.scenarios.map((scenario) => [
    scenario.key,
    scenario.status === "ready"
      ? {
          status: "not_attempted" as const,
          detail: "Ready to attempt; prepare performs no execution.",
          evidence: [],
        }
      : {
          status: "blocked" as const,
          detail: `Not attempted because readiness is ${scenario.status}: ${scenario.detail}`,
          evidence: [],
        },
  ]));
}

function safeConfiguration(
  configuration: CampaignConfigurationSnapshot,
): CampaignConfigurationSnapshot {
  return redactValue(configuration) as CampaignConfigurationSnapshot;
}

async function persist(
  report: OperatorCampaignReport,
  writer: CampaignReportWriter | undefined,
): Promise<CampaignCommandResult> {
  const reportPath = writer ? await writer.write(report) : null;
  return {
    ok: report.command === "prepare"
      ? report.readiness.status === "ready"
      : report.campaign.result === "passed",
    report,
    reportPath,
  };
}

function baseReport(
  command: "prepare" | "run",
  generatedAt: string,
  id: string,
  projectId: string,
  readiness: ReadinessCollection,
  campaign: E2ECampaignReport,
  configuration: CampaignConfigurationSnapshot,
  evidence: CampaignEvidenceSnapshot,
  recommendations: readonly string[],
): OperatorCampaignReport {
  return {
    formatVersion: OPERATOR_CAMPAIGN_REPORT_FORMAT_VERSION,
    generatedAt,
    campaignId: id,
    projectId,
    command,
    readiness: {
      status: readiness.status,
      doctor: redactValue(readiness.doctor) as DoctorReport,
      providerStatus: readiness.providerStatus,
      preflight: readiness.preflight,
    },
    campaign,
    configuration: safeConfiguration(configuration),
    evidence: redactValue(evidence) as CampaignEvidenceSnapshot,
    recommendations: recommendations.map(redactText),
  };
}

/**
 * Perform the live campaign preparation exclusively through GET endpoints.
 * Every scenario remains `not_attempted` unless readiness itself is blocked.
 */
export async function prepareLiveCampaign(
  options: PrepareLiveCampaignOptions,
  dependencies: CampaignDependencies,
): Promise<CampaignCommandResult> {
  assertProjectId(options.projectId);
  const now = (dependencies.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  const id = campaignId(now);
  const readiness = await collectReadiness(
    options.projectId,
    options.allowFaultInjection === true,
    dependencies,
  );
  const project = await dependencies.api.get<unknown>(
    `/v1/projects/${encodeURIComponent(options.projectId)}/configuration`,
  );
  const campaign = buildCampaignContract({
    generatedAt,
    campaignId: id,
    projectId: options.projectId,
    statuses: prepareStatuses(readiness.preflight),
    note: "Preparation reports runnability only; no live scenario was attempted or passed.",
  });
  const evidence = { ...emptyEvidence(), project: redactValue(project) };
  return persist(
    baseReport(
      "prepare",
      generatedAt,
      id,
      options.projectId,
      readiness,
      campaign,
      dependencies.configuration,
      evidence,
      readiness.recommendations,
    ),
    dependencies.reportWriter,
  );
}

async function exactConfirmation(
  options: RunLiveCampaignOptions,
  dependencies: CampaignDependencies,
): Promise<void> {
  const confirmation = options.confirmedProjectId ??
    (options.isTTY ? await dependencies.confirmProject?.(options.projectId) : undefined);
  if (confirmation === options.projectId) return;
  if (options.isTTY) {
    throw new Error(`campaign confirmation did not exactly match project ${options.projectId}`);
  }
  throw new Error(
    `non-interactive campaign run requires --confirm-project ${options.projectId}`,
  );
}

function itemArray<T>(value: { readonly items?: readonly T[] }): readonly T[] {
  return Array.isArray(value.items) ? value.items : [];
}

async function collectPublicSnapshot(
  projectId: string,
  api: PublicCampaignApi,
): Promise<PublicSnapshot> {
  const encodedProjectId = encodeURIComponent(projectId);
  const [
    project,
    brain,
    missionsResponse,
    runsResponse,
    eventsResponse,
    approvalsResponse,
    clarificationsResponse,
    pullRequestsResponse,
  ] = await Promise.all([
    api.get<unknown>(`/v1/projects/${encodedProjectId}/configuration`),
    api.get<unknown>(`/v1/projects/${encodedProjectId}/brain/state`),
    api.get<{ items: Mission[] }>(`/v1/projects/${encodedProjectId}/missions`),
    api.get<{ items: AgentRun[] }>(`/v1/runs?projectId=${encodedProjectId}`),
    api.get<{ items: EventEnvelope[] }>(
      `/v1/events?projectId=${encodedProjectId}&afterSeq=0`,
    ),
    api.get<{ items: Approval[] }>(`/v1/approvals?projectId=${encodedProjectId}`),
    api.get<{ items: unknown[] }>(
      `/v1/projects/${encodedProjectId}/clarifications?status=open`,
    ),
    api.get<{ items: PullRequestRef[] }>(`/v1/prs?projectId=${encodedProjectId}`),
  ]);
  const missions = itemArray(missionsResponse);
  const missionDetails = await Promise.all(missions.map((mission) =>
    api.get<{ checkpoints?: Checkpoint[] }>(
      `/v1/missions/${encodeURIComponent(mission.id)}`,
    )
  ));
  return {
    project,
    brain,
    missions,
    runs: itemArray(runsResponse),
    events: itemArray(eventsResponse),
    checkpoints: missionDetails.flatMap((detail) => detail.checkpoints ?? []),
    approvals: itemArray(approvalsResponse),
    clarifications: itemArray(clarificationsResponse),
    pullRequests: itemArray(pullRequestsResponse),
  };
}

function publicEvidence(reference: string): E2ECampaignEvidence {
  return { source: "public_api", provider: null, reference: redactText(reference) };
}

function providerEvidence(provider: string, runId: string): E2ECampaignEvidence {
  return {
    source: "provider_run",
    provider,
    reference: redactText(`run:${runId}`),
  };
}

function objectRecords(value: unknown, key: string): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate)
    ? candidate.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object")
    : [];
}

function runProvider(run: AgentRun): string | null {
  return typeof run.providerId === "string" && run.providerId !== "fake"
    ? run.providerId
    : null;
}

function passed(
  detail: string,
  evidence: readonly E2ECampaignEvidence[],
): { status: "passed"; detail: string; evidence: readonly E2ECampaignEvidence[] } {
  return { status: "passed", detail, evidence };
}

function failed(
  detail: string,
): { status: "failed"; detail: string; evidence: readonly E2ECampaignEvidence[] } {
  return { status: "failed", detail, evidence: [] };
}

function isGitHubPullRequest(pullRequest: PullRequestRef): pullRequest is PullRequestRef & {
  readonly number: number;
  readonly url: string;
} {
  if (pullRequest.number === null || pullRequest.url === null) return false;
  try {
    const url = new URL(pullRequest.url);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.endsWith(`/pull/${pullRequest.number}`);
  } catch {
    return false;
  }
}

function observedStatuses(
  snapshot: PublicSnapshot,
  acceptedPullRequest: PullRequestRef,
): Map<
  (typeof E2EScenarioKey.options)[number],
  {
    status: E2ECampaignResultStatus;
    detail: string;
    evidence: readonly E2ECampaignEvidence[];
  }
> {
  const statuses = new Map<
    (typeof E2EScenarioKey.options)[number],
    {
      status: E2ECampaignResultStatus;
      detail: string;
      evidence: readonly E2ECampaignEvidence[];
    }
  >();
  const brainRuns = objectRecords(snapshot.brain, "runs");
  const liveBrainRun = brainRuns.find((run) =>
    run.provenance === "live" && run.state === "succeeded" && typeof run.id === "string");
  statuses.set("real_planning", liveBrainRun
    ? passed("Observed a successful live planning run.", [
        publicEvidence(`brain-run:${String(liveBrainRun.id)}`),
      ])
    : failed("No successful live planning run was exposed by the public brain state."));

  for (const [key, provider] of [
    ["codex_mission", "codex"],
    ["claude_code_mission", "claude-code"],
    ["cursor_mission", "cursor"],
  ] as const) {
    const run = snapshot.runs.find((candidate) =>
      candidate.state === "succeeded" && runProvider(candidate) === provider);
    const failedCheckpoint = run
      ? snapshot.checkpoints.find((checkpoint) =>
          checkpoint.missionId === run.missionId && checkpoint.status === "failed")
      : undefined;
    statuses.set(key, run && !failedCheckpoint
      ? passed(`Observed a successful ${provider} provider run.`, [
          providerEvidence(provider, run.id),
        ])
      : failed(failedCheckpoint
          ? `Provider ${provider} run succeeded but checkpoint ${failedCheckpoint.id} failed.`
          : `No successful ${provider} provider run was exposed by the public API.`));
  }

  const missionById = new Map(snapshot.missions.map((mission) => [mission.id, mission]));
  const reviewerProviders = new Set(snapshot.runs
    .filter((run) => missionById.get(run.missionId)?.role === "review")
    .map(runProvider)
    .filter((provider): provider is string => provider !== null));
  const authorProviders = new Set(snapshot.runs
    .filter((run) => missionById.get(run.missionId)?.role !== "review")
    .map(runProvider)
    .filter((provider): provider is string => provider !== null));
  const distinctReviewer = [...reviewerProviders].find((provider) => !authorProviders.has(provider));
  statuses.set("reviewer_distinct_from_author", distinctReviewer && authorProviders.size > 0
    ? passed("Observed a reviewer provider distinct from mission authors.", [
        publicEvidence(`reviewer-provider:${distinctReviewer}`),
      ])
    : failed("Public run provenance does not prove reviewer/author separation."));

  const correctedMission = snapshot.missions.find((mission) =>
    mission.correctionAttempts > 0 &&
    ["approved", "integrated", "completed"].includes(mission.state));
  statuses.set("bounded_correction_after_rejection", correctedMission
    ? passed("Observed a successful bounded correction after rejection.", [
        publicEvidence(`mission:${correctedMission.id}:corrections:${correctedMission.correctionAttempts}`),
      ])
    : failed("No completed mission exposes a bounded correction attempt."));

  const fallback = snapshot.events.find((event) =>
    event.type === "provider.fallback" && event.payload.action === "switch_provider");
  statuses.set("cross_provider_fallback", fallback
    ? passed("Observed a public cross-provider fallback event.", [
        publicEvidence(`event:${fallback.id}`),
      ])
    : failed("No public switch_provider fallback event was observed."));

  const githubPullRequest = isGitHubPullRequest(acceptedPullRequest);
  const pullRequestEvidence: E2ECampaignEvidence = githubPullRequest
    ? { source: "github", provider: null, reference: redactText(acceptedPullRequest.url) }
    : publicEvidence(`pull-request:${acceptedPullRequest.id}`);
  statuses.set("branch_push", githubPullRequest
    ? passed(
        "A GitHub pull request proves that the campaign branch reached its remote.",
        [pullRequestEvidence],
      )
    : failed("The public pull-request record has no verifiable GitHub URL and number."));
  statuses.set("draft_pull_request", githubPullRequest
    ? passed(
        `Observed GitHub pull request ${acceptedPullRequest.state} under the selected policy.`,
        [pullRequestEvidence],
      )
    : failed("The public pull-request record does not prove a GitHub pull request."));
  statuses.set("no_autonomous_merge", passed(
    "Observed pull request remains unmerged; the runner contains no merge operation.",
    [pullRequestEvidence],
  ));
  return statuses;
}

function mergedStatuses(
  pullRequest: PullRequestRef,
): Map<
  (typeof E2EScenarioKey.options)[number],
  { status: E2ECampaignResultStatus; detail: string; evidence: E2ECampaignEvidence[] }
> {
  return new Map(E2EScenarioKey.options.map((key) => [
    key,
    key === "no_autonomous_merge" || key === "draft_pull_request"
      ? {
          status: "failed" as const,
          detail: `Pull request ${pullRequest.id} is merged; live campaign policy forbids merged state.`,
          evidence: [],
        }
      : {
          status: "failed" as const,
          detail: "Campaign evidence is invalid because the observed pull request is merged.",
          evidence: [],
        },
  ]));
}

function blockedRunStatuses(
  preflight: E2EPreflightReportType,
  detail: string,
): Map<
  (typeof E2EScenarioKey.options)[number],
  { status: E2ECampaignResultStatus; detail: string; evidence: E2ECampaignEvidence[] }
> {
  return new Map(preflight.scenarios.map((scenario) => [
    scenario.key,
    {
      status: "blocked" as const,
      detail: scenario.status === "ready"
        ? detail
        : `${detail} ${scenario.key} readiness is ${scenario.status}: ${scenario.detail}`,
      evidence: [],
    },
  ]));
}

function acceptedByPolicy(
  pullRequest: PullRequestRef,
  policy: "draft" | "ready-for-review",
): boolean {
  return policy === "ready-for-review"
    ? pullRequest.state === "open"
    : pullRequest.state === "draft" || pullRequest.state === "open";
}

function snapshotEvidence(snapshot: PublicSnapshot): CampaignEvidenceSnapshot {
  return {
    project: snapshot.project,
    brain: snapshot.brain,
    missions: snapshot.missions,
    runs: snapshot.runs,
    events: snapshot.events,
    checkpoints: snapshot.checkpoints,
    interventions: {
      approvals: snapshot.approvals,
      clarifications: snapshot.clarifications,
    },
    pullRequests: snapshot.pullRequests,
  };
}

function interventionRecommendations(
  projectId: string,
  snapshot: PublicSnapshot,
): string[] {
  const recommendations: string[] = [];
  if (snapshot.clarifications.length > 0) {
    recommendations.push(
      `Answer the open clarification for project ${projectId} through the public clarification command, then rerun the campaign.`,
    );
  }
  for (const approval of snapshot.approvals.filter((item) => item.status === "open")) {
    recommendations.push(
      `Resolve public approval ${approval.id} explicitly, then rerun the campaign.`,
    );
  }
  return recommendations;
}

/**
 * Submit one idempotent fixture objective after exact confirmation, poll only
 * bounded public endpoints, and stop at the configured unmerged PR state.
 */
export async function runLiveCampaign(
  options: RunLiveCampaignOptions,
  dependencies: CampaignDependencies,
): Promise<CampaignCommandResult> {
  assertProjectId(options.projectId);
  const maxPolls = positiveBoundedInteger(options.maxPolls, DEFAULT_MAX_POLLS, MAX_POLLS, "maxPolls");
  const pollIntervalMs = positiveBoundedInteger(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  const now = (dependencies.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  const id = campaignId(now);
  const readiness = await collectReadiness(
    options.projectId,
    options.allowFaultInjection === true,
    dependencies,
  );
  if (readiness.status !== "ready") {
    const campaign = buildCampaignContract({
      generatedAt,
      campaignId: id,
      projectId: options.projectId,
      statuses: blockedRunStatuses(
        readiness.preflight,
        `Campaign submission refused because aggregate readiness is ${readiness.status}.`,
      ),
      note: "Campaign was blocked before objective submission; no execution mutation occurred.",
    });
    return persist(
      baseReport(
        "run",
        generatedAt,
        id,
        options.projectId,
        readiness,
        campaign,
        dependencies.configuration,
        emptyEvidence(),
        readiness.recommendations,
      ),
      dependencies.reportWriter,
    );
  }

  await exactConfirmation(options, dependencies);
  await dependencies.api.post(
    `/v1/projects/${encodeURIComponent(options.projectId)}/objectives`,
    {
      text: LIVE_OBJECTIVE,
      acceptanceCriteria: [...LIVE_ACCEPTANCE_CRITERIA],
      idempotencyKey: id,
    },
  );

  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const policy = options.pullRequestPolicy ?? "draft";
  let latestSnapshot: PublicSnapshot | null = null;
  let terminalStatuses: ReturnType<typeof observedStatuses> | null = null;
  let terminalNote = "";
  let recommendations = [...readiness.recommendations];

  for (let poll = 0; poll < maxPolls; poll += 1) {
    latestSnapshot = await collectPublicSnapshot(options.projectId, dependencies.api);
    recommendations = [
      ...readiness.recommendations,
      ...interventionRecommendations(options.projectId, latestSnapshot),
    ];
    const merged = latestSnapshot.pullRequests.find((pullRequest) => pullRequest.state === "merged");
    if (merged) {
      terminalStatuses = mergedStatuses(merged);
      terminalNote = `Campaign failed because pull request ${merged.id} was already merged.`;
      break;
    }
    const closed = latestSnapshot.pullRequests.find((pullRequest) => pullRequest.state === "closed");
    if (closed) {
      terminalStatuses = blockedRunStatuses(
        readiness.preflight,
        `Campaign failed because pull request ${closed.id} is closed.`,
      );
      for (const key of E2EScenarioKey.options) {
        const current = terminalStatuses.get(key);
        if (current) terminalStatuses.set(key, { ...current, status: "failed" });
      }
      terminalNote = `Campaign failed because pull request ${closed.id} is closed.`;
      break;
    }
    const accepted = latestSnapshot.pullRequests.find((pullRequest) =>
      acceptedByPolicy(pullRequest, policy));
    if (accepted) {
      terminalStatuses = observedStatuses(latestSnapshot, accepted);
      terminalNote =
        `Campaign stopped at unmerged pull request ${accepted.id} (${accepted.state}); no merge was attempted.`;
      break;
    }
    if (
      latestSnapshot.clarifications.length > 0 ||
      latestSnapshot.approvals.some((approval) => approval.status === "open")
    ) {
      terminalStatuses = blockedRunStatuses(
        readiness.preflight,
        "Campaign needs an explicit operator response through the public intervention API.",
      );
      terminalNote = "Campaign is blocked on an actionable operator intervention.";
      break;
    }
    if (poll + 1 < maxPolls) await sleep(pollIntervalMs);
  }

  if (!latestSnapshot) {
    throw new Error("campaign polling produced no public API snapshot");
  }
  if (!terminalStatuses) {
    terminalStatuses = blockedRunStatuses(
      readiness.preflight,
      `Campaign polling reached its bound (${maxPolls} polls) before an acceptable pull request appeared.`,
    );
    for (const key of E2EScenarioKey.options) {
      const current = terminalStatuses.get(key);
      if (current) terminalStatuses.set(key, { ...current, status: "failed" });
    }
    terminalNote =
      `Campaign failed after ${maxPolls} bounded polls without an acceptable pull request.`;
    recommendations.push(
      `Inspect project ${options.projectId} missions, runs, events, and interventions through the public CLI before retrying.`,
    );
  }

  const campaign = buildCampaignContract({
    generatedAt,
    campaignId: id,
    projectId: options.projectId,
    statuses: terminalStatuses,
    note: terminalNote,
  });
  return persist(
    baseReport(
      "run",
      generatedAt,
      id,
      options.projectId,
      readiness,
      campaign,
      dependencies.configuration,
      snapshotEvidence(latestSnapshot),
      recommendations,
    ),
    dependencies.reportWriter,
  );
}
