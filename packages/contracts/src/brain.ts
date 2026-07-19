import { z } from "zod";
import {
  BrainProvenance,
  BrainRunState,
  BrainStep,
  CheckpointKind,
  ProviderErrorCategory,
  ReplanTrigger,
  TeamRole,
} from "./enums.js";
import { Id, MissionDependency, Plan, Timestamp } from "./entities.js";

/**
 * Versioned contracts of the central AI brain (chantier 2). These schemas are
 * the source of truth for what a reasoning provider may propose; the
 * deterministic control plane validates every proposal against them before
 * anything durable is created. Providers only ever produce logical keys —
 * definitive SQLite identifiers are always minted server-side.
 */
export const BRAIN_SCHEMA_VERSION = 1 as const;

/** Provenance pointer to the artifact that supports a statement. */
export const EvidenceRef = z.object({
  kind: z.enum([
    "file",
    "git",
    "manifest",
    "script",
    "check",
    "doc",
    "objective",
    "mission",
    "run",
    "checkpoint",
    "decision",
    "user",
  ]),
  ref: z.string().min(1).max(500),
  detail: z.string().max(2000).default(""),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

const SnapshotDocument = z.object({
  path: z.string().min(1).max(500),
  content: z.string(),
  truncated: z.boolean(),
});

/**
 * Bounded, server-built and redacted view of the persisted repository.
 * Built exclusively from the server-validated `project.repoPath` — never from
 * model- or client-supplied paths — and never contains secrets, binaries or
 * anything outside the Git-tracked tree.
 */
export const RepoSnapshot = z.object({
  schemaVersion: z.literal(BRAIN_SCHEMA_VERSION),
  branch: z.string(),
  commit: z.string(),
  workingTreeClean: z.boolean(),
  /** Tracked file paths, bounded; `truncatedFileCount` counts the rest. */
  fileTree: z.array(z.string()).max(2000),
  truncatedFileCount: z.number().int().min(0),
  /** README/architecture documentation excerpts. */
  documents: z.array(SnapshotDocument).max(20),
  /** Manifest/configuration excerpts (package.json, lockfiles, …). */
  manifests: z.array(SnapshotDocument).max(20),
  /** Runnable scripts declared by the repository (name -> command). */
  scripts: z.record(z.string()),
  /** Languages detected from tracked file extensions. */
  languages: z.array(z.string()).max(30),
  /** Deterministically detected checks that really exist in this repository. */
  availableChecks: z.object({
    requiredChecks: z.array(CheckpointKind),
    checkCommands: z.record(z.array(z.string())),
  }),
  /** SHA-256 of the canonical snapshot content (identity + drift detection). */
  hash: z.string(),
  evidence: z.array(EvidenceRef).max(100),
});
export type RepoSnapshot = z.infer<typeof RepoSnapshot>;

export const BrainRisk = z.object({
  title: z.string().min(1).max(300),
  severity: z.enum(["low", "medium", "high"]),
  detail: z.string().max(2000).default(""),
  mitigation: z.string().max(2000).default(""),
}).strict();
export type BrainRisk = z.infer<typeof BrainRisk>;

/** Step 1 — structured analysis of the objective against the repository. */
export const BrainObjectiveAnalysis = z.object({
  summary: z.string().min(1).max(5000),
  objectiveClarity: z.enum(["clear", "ambiguous"]),
  feasibility: z.enum(["feasible", "risky", "infeasible"]),
  constraints: z.array(z.string().min(1).max(1000)).max(50).default([]),
  assumptions: z.array(z.string().min(1).max(1000)).max(50).default([]),
  risks: z.array(BrainRisk).max(50).default([]),
  /** References into the repository snapshot that support the analysis. */
  evidence: z.array(EvidenceRef).max(100).default([]),
}).strict();
export type BrainObjectiveAnalysis = z.infer<typeof BrainObjectiveAnalysis>;

/** Step 2 — proposed architecture with decisions, constraints and risks. */
export const BrainArchitectureProposal = z.object({
  overview: z.string().min(1).max(10_000),
  components: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        responsibility: z.string().min(1).max(2000),
        paths: z.array(z.string().min(1).max(500)).max(50).default([]),
      }).strict(),
    )
    .min(1)
    .max(50),
  decisions: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        rationale: z.string().min(1).max(2000),
      }).strict(),
    )
    .max(50)
    .default([]),
  constraints: z.array(z.string().min(1).max(1000)).max(50).default([]),
  assumptions: z.array(z.string().min(1).max(1000)).max(50).default([]),
  risks: z.array(BrainRisk).max(50).default([]),
  evidence: z.array(EvidenceRef).max(100).default([]),
}).strict();
export type BrainArchitectureProposal = z.infer<typeof BrainArchitectureProposal>;

/** Stable logical key produced by the model, resolved server-side to an id. */
export const LogicalKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/);

/** Step 3 — a mission proposed by the AI. Ids stay server-side. */
export const PlannedMission = z.object({
  key: LogicalKey,
  title: z.string().min(1).max(300),
  objective: z.string().min(1).max(5000),
  rationale: z.string().min(1).max(5000),
  role: TeamRole,
  milestoneKey: LogicalKey,
  dependsOn: z.array(LogicalKey).max(50).default([]),
  acceptanceCriteria: z.array(z.string().min(1).max(2000)).min(1).max(50),
  /** Indices of the objective's acceptance criteria this mission covers. */
  coversCriteria: z.array(z.number().int().min(0).max(99)).max(100).default([]),
  allowedPaths: z.array(z.string().min(1).max(500)).max(100).default([]),
  forbiddenPaths: z.array(z.string().min(1).max(500)).max(100).default([]),
  requiredChecks: z.array(CheckpointKind).max(20).default([]),
  /** Real argv commands for each required check; a check without one fails. */
  checkCommands: z.record(z.array(z.string().min(1).max(500)).min(1).max(50)).default({}),
  expectedArtifacts: z.array(z.string().min(1).max(500)).max(50).default([]),
  budgetUsd: z.number().finite().nonnegative().nullable().default(null),
  timeoutSeconds: z.number().int().min(30).max(86_400).default(900),
  escalationConditions: z.array(z.string().min(1).max(1000)).max(20).default([]),
  priority: z.number().int().min(0).max(100).default(50),
}).strict();
export type PlannedMission = z.infer<typeof PlannedMission>;

export const PlannedMilestone = z.object({
  key: LogicalKey,
  title: z.string().min(1).max(300),
  description: z.string().max(2000).default(""),
  order: z.number().int().min(0),
}).strict();
export type PlannedMilestone = z.infer<typeof PlannedMilestone>;

/** Step 3 — the versioned plan/DAG proposal, validated deterministically. */
export const BrainPlanProposal = z.object({
  summary: z.string().min(1).max(5000),
  milestones: z.array(PlannedMilestone).min(1).max(50),
  missions: z.array(PlannedMission).min(1).max(200),
}).strict();
export type BrainPlanProposal = z.infer<typeof BrainPlanProposal>;

/**
 * One durable attempt of one brain pipeline step. Inputs/outputs are
 * persisted redacted; `provenance` marks fixture output explicitly.
 */
export const BrainRun = z.object({
  id: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  projectId: Id,
  objectiveId: Id,
  step: BrainStep,
  state: BrainRunState,
  attempt: z.number().int().min(1),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  provenance: BrainProvenance,
  errorCategory: ProviderErrorCategory.nullable(),
  errorDetail: z.string().nullable(),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  costUsd: z.number().min(0).default(0),
  /** Validated structured output of the step (redacted), when it succeeded. */
  output: z.unknown().nullable(),
});
export type BrainRun = z.infer<typeof BrainRun>;

/** Really persisted brain state exposed to Web/CLI — never optimistic. */
export const BrainStateResponse = z.object({
  projectId: Id,
  objectiveId: Id.nullable(),
  status: z.enum(["idle", "clarifying", "running", "planned", "blocked", "failed", "paused"]),
  currentStep: BrainStep.nullable(),
  runs: z.array(BrainRun),
  analysis: BrainObjectiveAnalysis.nullable(),
  architecture: BrainArchitectureProposal.nullable(),
  plan: Plan.nullable(),
  dependencies: z.array(MissionDependency),
  replanCount: z.number().int().min(0),
  clarificationRound: z.number().int().min(0).default(0),
  lastReplan: z
    .object({
      trigger: ReplanTrigger,
      cause: z.string(),
      sources: z.array(z.string()),
      planVersion: z.number().int().min(1),
    })
    .nullable(),
});
export type BrainStateResponse = z.infer<typeof BrainStateResponse>;
