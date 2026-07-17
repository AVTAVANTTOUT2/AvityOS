import { z } from "zod";
import {
  AutonomyProfile,
  MissionState,
  TeamRole,
} from "./enums.js";
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

export const CreateProjectRequest = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
  repoPath: z.string().nullable().default(null),
  repoRemoteUrl: z.string().url().nullable().default(null),
  autonomyProfile: AutonomyProfile.default("autonomous_with_checkpoints"),
  /** Client-supplied idempotency key: retried creates must not duplicate. */
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const SubmitObjectiveRequest = z.object({
  text: z.string().min(1).max(50_000),
  acceptanceCriteria: z.array(z.string()).default([]),
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type SubmitObjectiveRequest = z.infer<typeof SubmitObjectiveRequest>;

export const AnswerClarificationRequest = z.object({
  answers: z
    .array(z.object({ questionId: Id, answer: z.string().min(1) }))
    .min(1),
});
export type AnswerClarificationRequest = z.infer<typeof AnswerClarificationRequest>;

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
