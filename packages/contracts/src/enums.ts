import { z } from "zod";

/**
 * Closed enumerations shared by the orchestration engine, services and
 * clients. These are wire-format values: renaming one is a breaking contract
 * change and requires a schemaVersion bump where the enum crosses a boundary.
 */

export const MissionState = z.enum([
  "proposed",
  "ready",
  "assigned",
  "running",
  "result_submitted",
  "validating",
  "review_required",
  "approved",
  "integrated",
  "completed",
  "paused",
  "blocked",
  "retrying",
  "cancelled",
  "failed",
]);
export type MissionState = z.infer<typeof MissionState>;

export const RunState = z.enum([
  "queued",
  "starting",
  "running",
  "paused",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "timed_out",
]);
export type RunState = z.infer<typeof RunState>;

export const ProjectStatus = z.enum([
  "draft",
  "clarifying",
  "planning",
  "active",
  "paused",
  "blocked",
  "completed",
  "archived",
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const ProviderErrorCategory = z.enum([
  "auth",
  "quota_exhausted",
  "rate_limited",
  "transient_network",
  "invalid_request",
  "context_overflow",
  "tool_failure",
  "agent_crash",
  "policy_denied",
  "unknown",
]);
export type ProviderErrorCategory = z.infer<typeof ProviderErrorCategory>;

export const AuthMethod = z.enum(["api_key", "cli_session", "oauth", "none"]);
export type AuthMethod = z.infer<typeof AuthMethod>;

export const AutonomyProfile = z.enum([
  "supervised",
  "autonomous_with_checkpoints",
  "maximum_autonomy",
]);
export type AutonomyProfile = z.infer<typeof AutonomyProfile>;

export const TeamRole = z.enum([
  "product",
  "architecture",
  "frontend",
  "backend",
  "infrastructure",
  "cybersecurity",
  "qa",
  "review",
  "documentation",
  "orchestrator",
]);
export type TeamRole = z.infer<typeof TeamRole>;

export const BrainEntryKind = z.enum([
  "fact",
  "assumption",
  "proposal",
  "decision",
  "risk",
  "question",
  "convention",
]);
export type BrainEntryKind = z.infer<typeof BrainEntryKind>;

export const CheckpointKind = z.enum([
  "build",
  "lint",
  "typecheck",
  "test",
  "coverage",
  "dependency_scan",
  "secret_scan",
  "architecture_rule",
  "policy",
  "review",
  "human_approval",
]);
export type CheckpointKind = z.infer<typeof CheckpointKind>;

export const CheckpointStatus = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "waived",
]);
export type CheckpointStatus = z.infer<typeof CheckpointStatus>;

export const InterventionStatus = z.enum(["open", "answered", "expired", "withdrawn"]);
export type InterventionStatus = z.infer<typeof InterventionStatus>;

export const FallbackAction = z.enum([
  "wait_for_reset",
  "retry_backoff",
  "switch_model",
  "switch_provider",
  "pause_lower_priority",
  "escalate_user",
]);
export type FallbackAction = z.infer<typeof FallbackAction>;

export const PolicyEffect = z.enum(["allow", "deny", "require_approval"]);
export type PolicyEffect = z.infer<typeof PolicyEffect>;

export const WorkerStatus = z.enum(["online", "draining", "offline", "revoked"]);
export type WorkerStatus = z.infer<typeof WorkerStatus>;

/** Pipeline steps of the central AI brain (chantier 2). */
export const BrainStep = z.enum(["analysis", "architecture", "plan"]);
export type BrainStep = z.infer<typeof BrainStep>;

export const BrainRunState = z.enum(["running", "succeeded", "failed"]);
export type BrainRunState = z.infer<typeof BrainRunState>;

/**
 * Provenance of AI-produced planning artifacts. `fake_fixture` marks output
 * from the deterministic offline fixture provider and must never be
 * presented as real AI planning evidence.
 */
export const BrainProvenance = z.enum(["live", "fake_fixture"]);
export type BrainProvenance = z.infer<typeof BrainProvenance>;

/** Evidence-based causes that may produce a new plan version. */
export const ReplanTrigger = z.enum([
  "objective_revised",
  "mission_failed",
  "check_unsatisfiable",
  "architecture_invalidated",
  "dependency_invalid",
  "new_evidence",
]);
export type ReplanTrigger = z.infer<typeof ReplanTrigger>;

export const EventType = z.enum([
  "project.created",
  "project.updated",
  "project.status_changed",
  "objective.submitted",
  "objective.analyzed",
  "clarification.requested",
  "clarification.answered",
  "plan.created",
  "plan.updated",
  "plan.replanned",
  "brain.step_changed",
  "mission.created",
  "mission.state_changed",
  "mission.correction_loop",
  "run.state_changed",
  "run.output",
  "run.usage",
  "terminal.output",
  "git.branch_created",
  "git.commit_created",
  "git.pr_opened",
  "git.pr_updated",
  "checkpoint.updated",
  "approval.requested",
  "approval.resolved",
  "approval.withdrawn",
  "policy.decision",
  "provider.status_changed",
  "provider.fallback",
  "worker.status_changed",
  "budget.threshold",
  "audit.entry",
]);
export type EventType = z.infer<typeof EventType>;
