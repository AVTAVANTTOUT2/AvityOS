import {
  chmodSync,
  mkdirSync,
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

export interface CreateCampaignReportWriterOptions {
  readonly reportsDir: string;
  readonly repositoryRoot?: string;
  readonly retentionCount: number;
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
      mkdirSync(options.reportsDir, { recursive: true, mode: 0o700 });
      chmodSync(options.reportsDir, 0o700);
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
