import { z } from "zod";
import {
  AutonomyProfile,
  MissionState,
  TeamRole,
} from "./enums.js";
import { ClarificationAnswerValue } from "./clarification.js";
import { Id, MissionContract } from "./entities.js";

/** Stable machine-readable API error codes. */
export const ApiErrorCode = z.enum([
  "not_found",
  "validation_failed",
  "illegal_transition",
  "conflict",
  "policy_denied",
  "budget_exceeded",
  "provider_unavailable",
  "clarification_obsolete",
  "clarification_incomplete",
  "clarification_already_answered",
  "project_paused",
  "project_not_paused",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type Pagination = z.infer<typeof Pagination>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int(),
    offset: z.number().int(),
  });
}

// ── Requests ────────────────────────────────────────────────────────────────

const RepoPath = z.string().trim().min(1).max(4096);
const DefaultBranch = z.string().trim().min(1).max(255);
const ObjectiveText = z.string().trim().max(50_000);
const AcceptanceCriteria = z.array(z.string().trim().min(1).max(5000)).max(100);
const BudgetUsd = z.number().finite().nonnegative().max(1_000_000_000);
const BudgetWarnAtFraction = z.number().finite().min(0.01).max(1);
const GitHubRemoteUrl = z.string().trim().refine(
  (value) =>
    /^https?:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\.git)?$/i.test(value) ||
    /^git@github\.com:[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\.git)?$/i.test(value) ||
    /^ssh:\/\/git@github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\.git)?$/i.test(value),
  "must be a GitHub HTTPS or SSH repository URL",
);

const ProjectOnboardingFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  repoPath: RepoPath.nullable(),
  repoRemoteUrl: GitHubRemoteUrl.nullable(),
  defaultBranch: DefaultBranch,
  objective: ObjectiveText,
  acceptanceCriteria: AcceptanceCriteria,
  autonomyProfile: AutonomyProfile,
  budgetUsd: BudgetUsd.nullable(),
  budgetWarnAtFraction: BudgetWarnAtFraction,
};

function repositoryFieldsAgree(
  value: {
    repoPath?: string | null;
    repoRemoteUrl?: string | null;
    budgetUsd?: number | null;
    budgetWarnAtFraction?: number;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.repoPath === null && value.repoRemoteUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repoRemoteUrl"],
      message: "cannot be configured without a local repository path",
    });
  }
  if (value.budgetUsd === null && value.budgetWarnAtFraction !== undefined && value.budgetWarnAtFraction !== 0.8) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgetWarnAtFraction"],
      message: "cannot be customized without a project budget",
    });
  }
}

export const CreateProjectRequest = z
  .object({
    ...ProjectOnboardingFields,
    description: ProjectOnboardingFields.description.default(""),
    repoPath: ProjectOnboardingFields.repoPath.default(null),
    repoRemoteUrl: ProjectOnboardingFields.repoRemoteUrl.default(null),
    defaultBranch: ProjectOnboardingFields.defaultBranch.default("main"),
    objective: ProjectOnboardingFields.objective.default(""),
    acceptanceCriteria: ProjectOnboardingFields.acceptanceCriteria.default([]),
    autonomyProfile: ProjectOnboardingFields.autonomyProfile.default("autonomous_with_checkpoints"),
    budgetUsd: ProjectOnboardingFields.budgetUsd.default(null),
    budgetWarnAtFraction: ProjectOnboardingFields.budgetWarnAtFraction.default(0.8),
    /** Client-supplied idempotency key: retried creates must not duplicate. */
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .superRefine(repositoryFieldsAgree);
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z
  .object({
    ...ProjectOnboardingFields,
    objective: ObjectiveText.min(1, "objective cannot be empty; omit it to keep the current objective"),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "at least one project field is required")
  .superRefine(repositoryFieldsAgree);
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const SubmitObjectiveRequest = z.object({
  text: z.string().min(1).max(50_000),
  acceptanceCriteria: z.array(z.string()).default([]),
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type SubmitObjectiveRequest = z.infer<typeof SubmitObjectiveRequest>;

/**
 * Answer a whole clarification group atomically. Each answer is a typed
 * value; a legacy `answer` string is accepted only for `text` questions and
 * is normalized server-side into `{ type: "text", value }`.
 */
export const AnswerClarificationRequest = z
  .object({
    answers: z
      .array(
        z
          .object({
            questionId: Id,
            value: ClarificationAnswerValue.optional(),
            /** Legacy free-text answer; normalized to text values server-side. */
            answer: z.string().min(1).max(10_000).optional(),
          })
          .strict()
          .refine((entry) => entry.value !== undefined || entry.answer !== undefined, {
            message: "either value or answer is required",
          }),
      )
      .min(1)
      .max(20),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
export type AnswerClarificationRequest = z.infer<typeof AnswerClarificationRequest>;

export const PauseProjectRequest = z
  .object({
    reason: z.string().trim().max(2000).default(""),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
export type PauseProjectRequest = z.infer<typeof PauseProjectRequest>;

export const ResumeProjectRequest = z
  .object({
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ResumeProjectRequest = z.infer<typeof ResumeProjectRequest>;

export const ProjectPauseState = z.object({
  projectId: Id,
  status: z.enum(["active", "pausing", "paused", "resuming"]),
  reason: z.string().nullable(),
  actor: z.string().nullable(),
  previousStatus: z.string().nullable(),
  generation: z.number().int().min(0),
  pausedAt: z.string().datetime({ offset: true }).nullable(),
  resumedAt: z.string().datetime({ offset: true }).nullable(),
  cancellingRunIds: z.array(Id).default([]),
});
export type ProjectPauseState = z.infer<typeof ProjectPauseState>;

export const CreateMissionRequest = z.object({
  title: z.string().min(1).max(300),
  role: TeamRole,
  contract: MissionContract,
  planId: Id.nullable().default(null),
  milestoneId: Id.nullable().default(null),
  dependsOn: z.array(Id).default([]),
  priority: z.number().int().min(0).max(100).default(50),
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type CreateMissionRequest = z.infer<typeof CreateMissionRequest>;

export const TransitionMissionRequest = z.object({
  to: MissionState,
  reason: z.string().max(2000).default(""),
});
export type TransitionMissionRequest = z.infer<typeof TransitionMissionRequest>;

export const ResolveApprovalRequest = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(5000).default(""),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequest>;

export const EnrollWorkerRequest = z.object({
  name: z.string().min(1).max(120),
  capabilities: z.array(z.string()).default([]),
  maxConcurrentRuns: z.number().int().min(1).max(64).default(4),
});
export type EnrollWorkerRequest = z.infer<typeof EnrollWorkerRequest>;

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  uptimeSeconds: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
