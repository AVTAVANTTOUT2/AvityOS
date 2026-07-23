import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentRun,
  Approval,
  Checkpoint,
  E2ECampaignReport,
  E2EPreflightReport,
  EventEnvelope,
  Mission,
  PullRequestRef,
} from "@avityos/contracts";
import type { DoctorReport, ReadinessState } from "./diagnostics.js";
import { redactValue } from "./redact.js";

export const OPERATOR_CAMPAIGN_REPORT_FORMAT_VERSION = 1 as const;
const CAMPAIGN_REPORT_FILE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[A-Za-z0-9._-]+-(?:prepare|run)\.json$/;

export interface CampaignConfigurationSnapshot {
  readonly cliVersion: string;
  readonly controlPlaneUrl: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface CampaignReadinessSnapshot {
  readonly status: ReadinessState;
  readonly doctor: DoctorReport;
  readonly providerStatus: unknown;
  readonly preflight: E2EPreflightReport;
}

export interface CampaignEvidenceSnapshot {
  readonly project: unknown;
  readonly brain: unknown;
  readonly missions: readonly Mission[];
  readonly runs: readonly AgentRun[];
  readonly events: readonly EventEnvelope[];
  readonly checkpoints: readonly Checkpoint[];
  readonly interventions: {
    readonly approvals: readonly Approval[];
    readonly clarifications: readonly unknown[];
  };
  readonly pullRequests: readonly PullRequestRef[];
}

/**
 * Durable operator artifact. `readiness` describes whether a campaign may run;
 * only the nested versioned campaign contract describes observed outcomes.
 */
export interface OperatorCampaignReport {
  readonly formatVersion: typeof OPERATOR_CAMPAIGN_REPORT_FORMAT_VERSION;
  readonly generatedAt: string;
  readonly campaignId: string;
  readonly projectId: string;
  readonly command: "prepare" | "run";
  readonly readiness: CampaignReadinessSnapshot;
  readonly campaign: E2ECampaignReport;
  readonly configuration: CampaignConfigurationSnapshot;
  readonly evidence: CampaignEvidenceSnapshot;
  readonly recommendations: readonly string[];
}

export interface CampaignReportWriter {
  write(report: OperatorCampaignReport): Promise<string>;
}

export interface CampaignBaselineState {
  readonly brainRunIds: readonly string[];
  readonly missionIds: readonly string[];
  readonly runIds: readonly string[];
  readonly approvalIds: readonly string[];
  readonly clarificationIds: readonly string[];
  readonly pullRequestIds: readonly string[];
  readonly eventSeq: number;
}

export interface CampaignExecutionState {
  readonly version: 1;
  readonly status: "pending" | "terminal";
  readonly campaignId: string;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly objectiveId: string | null;
  readonly baseline: CampaignBaselineState;
}

export interface CampaignStateStore {
  loadPending(projectId: string): CampaignExecutionState | null;
  save(state: CampaignExecutionState): void;
  markTerminal(projectId: string, campaignId: string, updatedAt: string): void;
}

export interface CreateCampaignReportWriterOptions {
  readonly reportsDir: string;
  readonly operatorRoot?: string;
  readonly repositoryRoot?: string;
  readonly retentionCount: number;
}

export interface CreateCampaignStateStoreOptions {
  readonly operatorRoot: string;
  readonly reportsDir: string;
  readonly repositoryRoot?: string;
}

function pathIsInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function assertNoSymlinkComponents(rootPath: string, targetPath: string): void {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  if (!pathIsInside(root, target)) {
    throw new Error(`campaign reports path ${target} escapes operator root ${root}`);
  }
  const relativeTarget = relative(root, target);
  const components = relativeTarget ? relativeTarget.split(/[\\/]/) : [];
  let current = root;
  for (const component of ["", ...components]) {
    if (component) current = join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`campaign reports path contains symlink component: ${current}`);
    }
  }
}

function prepareReportsDirectory(options: CreateCampaignReportWriterOptions): void {
  const operatorRoot = options.operatorRoot ?? options.reportsDir;
  assertNoSymlinkComponents(operatorRoot, options.reportsDir);
  mkdirSync(options.reportsDir, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(operatorRoot, options.reportsDir);
  const canonicalReportsDir = realpathSync(options.reportsDir);
  if (options.repositoryRoot) {
    const canonicalRepositoryRoot = existsSync(options.repositoryRoot)
      ? realpathSync(options.repositoryRoot)
      : resolve(options.repositoryRoot);
    if (pathIsInside(canonicalRepositoryRoot, canonicalReportsDir)) {
      throw new Error("campaign reports directory must remain outside the repository");
    }
  }
  chmodSync(canonicalReportsDir, 0o700);
}

function statePath(options: CreateCampaignStateStoreOptions, projectId: string): string {
  return join(
    options.reportsDir,
    `${safeFileSegment(projectId, "projectId")}.campaign.state.json`,
  );
}

function writeOwnerOnlyAtomic(path: string, serialized: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`campaign state/report target cannot be a symlink: ${path}`);
  }
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, serialized, { mode: 0o600, flag: "wx" });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid campaign state: ${field} must be a string array`);
  }
  return [...value];
}

function parseCampaignState(value: unknown): CampaignExecutionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid campaign state: expected an object");
  }
  const state = value as Record<string, unknown>;
  const expectedKeys = [
    "baseline",
    "campaignId",
    "createdAt",
    "idempotencyKey",
    "objectiveId",
    "projectId",
    "status",
    "updatedAt",
    "version",
  ];
  if (Object.keys(state).sort().join(",") !== expectedKeys.join(",")) {
    throw new Error("invalid campaign state: unexpected or missing fields");
  }
  if (
    state.version !== 1 ||
    (state.status !== "pending" && state.status !== "terminal") ||
    typeof state.campaignId !== "string" ||
    typeof state.projectId !== "string" ||
    typeof state.idempotencyKey !== "string" ||
    typeof state.createdAt !== "string" ||
    typeof state.updatedAt !== "string" ||
    (state.objectiveId !== null && typeof state.objectiveId !== "string") ||
    !state.baseline ||
    typeof state.baseline !== "object" ||
    Array.isArray(state.baseline)
  ) {
    throw new Error("invalid campaign state: malformed scalar fields");
  }
  const baseline = state.baseline as Record<string, unknown>;
  const baselineKeys = [
    "approvalIds",
    "brainRunIds",
    "clarificationIds",
    "eventSeq",
    "missionIds",
    "pullRequestIds",
    "runIds",
  ];
  if (Object.keys(baseline).sort().join(",") !== baselineKeys.join(",")) {
    throw new Error("invalid campaign state: malformed baseline fields");
  }
  if (!Number.isSafeInteger(baseline.eventSeq) || Number(baseline.eventSeq) < 0) {
    throw new Error("invalid campaign state: baseline eventSeq must be non-negative");
  }
  return {
    version: 1,
    status: state.status,
    campaignId: state.campaignId,
    projectId: state.projectId,
    idempotencyKey: state.idempotencyKey,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    objectiveId: state.objectiveId,
    baseline: {
      brainRunIds: parseStringArray(baseline.brainRunIds, "brainRunIds"),
      missionIds: parseStringArray(baseline.missionIds, "missionIds"),
      runIds: parseStringArray(baseline.runIds, "runIds"),
      approvalIds: parseStringArray(baseline.approvalIds, "approvalIds"),
      clarificationIds: parseStringArray(baseline.clarificationIds, "clarificationIds"),
      pullRequestIds: parseStringArray(baseline.pullRequestIds, "pullRequestIds"),
      eventSeq: Number(baseline.eventSeq),
    },
  };
}

/**
 * Persist the restart-safe campaign identity and baseline before objective
 * submission. State files share the hardened operator reports directory.
 */
export function createCampaignStateStore(
  options: CreateCampaignStateStoreOptions,
): CampaignStateStore {
  const directoryOptions: CreateCampaignReportWriterOptions = {
    operatorRoot: options.operatorRoot,
    reportsDir: options.reportsDir,
    repositoryRoot: options.repositoryRoot,
    retentionCount: 1,
  };
  const load = (projectId: string): CampaignExecutionState | null => {
    prepareReportsDirectory(directoryOptions);
    const path = statePath(options, projectId);
    if (!existsSync(path)) return null;
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`campaign state target cannot be a symlink: ${path}`);
    }
    try {
      return parseCampaignState(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot load campaign state for project ${projectId}: ${detail}`);
    }
  };
  return {
    loadPending(projectId: string): CampaignExecutionState | null {
      const state = load(projectId);
      return state?.status === "pending" ? state : null;
    },
    save(state: CampaignExecutionState): void {
      prepareReportsDirectory(directoryOptions);
      writeOwnerOnlyAtomic(
        statePath(options, state.projectId),
        `${JSON.stringify(state, null, 2)}\n`,
      );
    },
    markTerminal(projectId: string, campaignId: string, updatedAt: string): void {
      const current = load(projectId);
      if (!current || current.campaignId !== campaignId) {
        throw new Error(`pending campaign ${campaignId} not found for project ${projectId}`);
      }
      this.save({ ...current, status: "terminal", updatedAt });
    },
  };
}

function safeFileSegment(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, dots, underscores, or hyphens`);
  }
  return value;
}

function timestampFileSegment(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`campaign report generatedAt is not a canonical timestamp: ${timestamp}`);
  }
  return timestamp.replaceAll(":", "-");
}

function redactReport(report: OperatorCampaignReport): OperatorCampaignReport {
  return redactValue(report) as OperatorCampaignReport;
}

function enforceRetention(reportsDir: string, retentionCount: number): void {
  const reportFiles = readdirSync(reportsDir)
    .filter((name) => CAMPAIGN_REPORT_FILE_PATTERN.test(name))
    .sort();
  for (const staleFile of reportFiles.slice(0, Math.max(0, reportFiles.length - retentionCount))) {
    rmSync(join(reportsDir, staleFile));
  }
}

/**
 * Create an atomic, owner-only report writer with deterministic lexicographic
 * retention. The caller supplies the Task-3 operator reports directory.
 */
export function createCampaignReportWriter(
  options: CreateCampaignReportWriterOptions,
): CampaignReportWriter {
  if (!Number.isSafeInteger(options.retentionCount) || options.retentionCount < 1) {
    throw new Error("campaign report retentionCount must be a positive integer");
  }
  if (options.repositoryRoot) {
    const reportRelativePath = relative(
      resolve(options.repositoryRoot),
      resolve(options.reportsDir),
    );
    if (
      reportRelativePath === "" ||
      (!reportRelativePath.startsWith("..") && !isAbsolute(reportRelativePath))
    ) {
      throw new Error("campaign reports directory must remain outside the repository");
    }
  }
  return {
    async write(report: OperatorCampaignReport): Promise<string> {
      prepareReportsDirectory(options);
      const fileName = [
        timestampFileSegment(report.generatedAt),
        safeFileSegment(report.campaignId, "campaignId"),
        report.command,
      ].join("-") + ".json";
      const reportPath = join(options.reportsDir, fileName);
      const temporaryPath = `${reportPath}.tmp-${process.pid}`;
      const serialized = `${JSON.stringify(redactReport(report), null, 2)}\n`;
      writeFileSync(temporaryPath, serialized, { mode: 0o600 });
      renameSync(temporaryPath, reportPath);
      chmodSync(reportPath, 0o600);
      enforceRetention(options.reportsDir, options.retentionCount);
      return reportPath;
    },
  };
}
