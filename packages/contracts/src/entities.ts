import { z } from "zod";
import {
  AuthMethod,
  AutonomyProfile,
  BrainEntryKind,
  CheckpointKind,
  CheckpointStatus,
  InterventionStatus,
  MissionState,
  PolicyEffect,
  ProjectStatus,
  ProviderErrorCategory,
  RunState,
  TeamRole,
  WorkerStatus,
} from "./enums.js";

/** ISO-8601 timestamp string (UTC). */
export const Timestamp = z.string().datetime({ offset: true });

export const Id = z.string().min(1).max(64);

const base = {
  id: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

export const Project = z.object({
  ...base,
  workspaceId: Id,
  name: z.string().min(1).max(200),
  status: ProjectStatus,
  repoPath: z.string().nullable(),
  repoRemoteUrl: z.string().nullable(),
  defaultBranch: z.string().default("main"),
  autonomyProfile: AutonomyProfile,
  description: z.string().default(""),
});
export type Project = z.infer<typeof Project>;

export const Objective = z.object({
  ...base,
  projectId: Id,
  revision: z.number().int().min(1),
  text: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  analysisSummary: z.string().nullable(),
});
export type Objective = z.infer<typeof Objective>;

export const ClarificationQuestion = z.object({
  id: Id,
  question: z.string().min(1),
  options: z.array(z.string()).default([]),
  answer: z.string().nullable(),
});

export const Clarification = z.object({
  ...base,
  projectId: Id,
  objectiveId: Id,
  status: InterventionStatus,
  questions: z.array(ClarificationQuestion).min(1),
});
export type Clarification = z.infer<typeof Clarification>;

export const BrainEntry = z.object({
  ...base,
  projectId: Id,
  kind: BrainEntryKind,
  title: z.string().min(1).max(300),
  body: z.string(),
  /** Provenance: mission/run/objective/url that produced this knowledge. */
  sources: z.array(z.string()).default([]),
  supersededBy: Id.nullable(),
});
export type BrainEntry = z.infer<typeof BrainEntry>;

export const Milestone = z.object({
  id: Id,
  title: z.string().min(1),
  description: z.string().default(""),
  order: z.number().int().min(0),
});

export const Plan = z.object({
  ...base,
  projectId: Id,
  version: z.number().int().min(1),
  summary: z.string(),
  milestones: z.array(Milestone).default([]),
  active: z.boolean(),
});
export type Plan = z.infer<typeof Plan>;

export const MissionContract = z.object({
  objective: z.string().min(1),
  rationale: z.string().default(""),
  context: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  forbiddenPaths: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  requiredChecks: z.array(CheckpointKind).default([]),
  /**
   * Real commands (argv arrays) to run for each required check, executed in
   * the mission worktree. A check without a command cannot pass.
   */
  checkCommands: z.record(z.array(z.string())).default({}),
  budgetUsd: z.number().nonnegative().nullable().default(null),
  timeoutSeconds: z.number().int().positive().nullable().default(null),
  expectedArtifacts: z.array(z.string()).default([]),
});
export type MissionContract = z.infer<typeof MissionContract>;

export const Mission = z.object({
  ...base,
  projectId: Id,
  planId: Id.nullable(),
  milestoneId: Id.nullable(),
  title: z.string().min(1).max(300),
  role: TeamRole,
  state: MissionState,
  contract: MissionContract,
  branchName: z.string().nullable(),
  worktreePath: z.string().nullable(),
  correctionAttempts: z.number().int().min(0).default(0),
  maxCorrectionAttempts: z.number().int().min(0).default(3),
  priority: z.number().int().min(0).max(100).default(50),
  stateReason: z.string().nullable(),
});
export type Mission = z.infer<typeof Mission>;

export const MissionDependency = z.object({
  missionId: Id,
  dependsOnMissionId: Id,
});
export type MissionDependency = z.infer<typeof MissionDependency>;

export const AgentProfile = z.object({
  ...base,
  name: z.string().min(1).max(120),
  role: TeamRole,
  providerId: Id.nullable(),
  model: z.string().nullable(),
  systemPromptRef: z.string().nullable(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

export const AgentRun = z.object({
  ...base,
  projectId: Id,
  missionId: Id,
  agentProfileId: Id.nullable(),
  workerId: Id.nullable(),
  providerId: Id.nullable(),
  model: z.string().nullable(),
  state: RunState,
  exitReason: z.string().nullable(),
  errorCategory: ProviderErrorCategory.nullable(),
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  costUsd: z.number().min(0).default(0),
});
export type AgentRun = z.infer<typeof AgentRun>;

export const TerminalSession = z.object({
  ...base,
  projectId: Id,
  runId: Id.nullable(),
  workerId: Id.nullable(),
  command: z.string(),
  cwd: z.string(),
  state: RunState,
  exitCode: z.number().int().nullable(),
});
export type TerminalSession = z.infer<typeof TerminalSession>;

export const Provider = z.object({
  ...base,
  name: z.string().min(1).max(120),
  adapter: z.string().min(1),
  baseUrl: z.string().nullable(),
  authMethod: AuthMethod,
  enabled: z.boolean(),
  models: z.array(z.string()).default([]),
  defaultModel: z.string().nullable(),
});
export type Provider = z.infer<typeof Provider>;

export const QuotaState = z.object({
  providerId: Id,
  rateLimited: z.boolean(),
  resetAt: Timestamp.nullable(),
  remainingRequests: z.number().int().nullable(),
});
export type QuotaState = z.infer<typeof QuotaState>;

export const WorkerNode = z.object({
  ...base,
  name: z.string().min(1).max(120),
  status: WorkerStatus,
  capabilities: z.array(z.string()).default([]),
  lastHeartbeatAt: Timestamp.nullable(),
  maxConcurrentRuns: z.number().int().min(1).default(4),
});
export type WorkerNode = z.infer<typeof WorkerNode>;

export const Checkpoint = z.object({
  ...base,
  projectId: Id,
  missionId: Id,
  kind: CheckpointKind,
  status: CheckpointStatus,
  detail: z.string().default(""),
  evidenceRef: z.string().nullable(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const Approval = z.object({
  ...base,
  projectId: Id,
  missionId: Id.nullable(),
  status: InterventionStatus,
  title: z.string().min(1),
  description: z.string().default(""),
  decision: z.enum(["approved", "rejected"]).nullable(),
  decidedAt: Timestamp.nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const PullRequestRef = z.object({
  ...base,
  projectId: Id,
  missionId: Id.nullable(),
  number: z.number().int().nullable(),
  url: z.string().nullable(),
  branch: z.string(),
  title: z.string(),
  state: z.enum(["draft", "open", "merged", "closed"]),
});
export type PullRequestRef = z.infer<typeof PullRequestRef>;

export const UsageRecord = z.object({
  ...base,
  projectId: Id,
  runId: Id.nullable(),
  providerId: Id.nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

export const Budget = z.object({
  ...base,
  projectId: Id,
  limitUsd: z.number().positive(),
  spentUsd: z.number().min(0),
  warnAtFraction: z.number().min(0).max(1).default(0.8),
});
export type Budget = z.infer<typeof Budget>;

export const PolicyRule = z.object({
  id: Id,
  description: z.string().default(""),
  action: z.string().min(1),
  resource: z.string().default("*"),
  effect: PolicyEffect,
});

export const Policy = z.object({
  ...base,
  projectId: Id.nullable(),
  name: z.string().min(1),
  rules: z.array(PolicyRule).default([]),
});
export type Policy = z.infer<typeof Policy>;

export const PolicyDecision = z.object({
  ...base,
  projectId: Id.nullable(),
  missionId: Id.nullable(),
  action: z.string(),
  resource: z.string(),
  effect: PolicyEffect,
  ruleId: Id.nullable(),
  reason: z.string(),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const AuditEntry = z.object({
  id: Id,
  createdAt: Timestamp,
  projectId: Id.nullable(),
  actor: z.string(),
  action: z.string(),
  detail: z.string().default(""),
  /** Hash chain: SHA-256 of (previous entry hash + this entry's content). */
  entryHash: z.string(),
  previousHash: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
