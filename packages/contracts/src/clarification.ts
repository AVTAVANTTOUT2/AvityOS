import { z } from "zod";
import { BrainProvenance, InterventionStatus } from "./enums.js";
import { Id, Timestamp } from "./entities.js";
import { LogicalKey } from "./brain.js";

/**
 * Versioned contracts for structured, grouped AI clarifications (chantier 3).
 * The model proposes questions; the control plane alone persists and transitions.
 */
export const CLARIFICATION_SCHEMA_VERSION = 1 as const;

/** Closed answer types that the control plane can validate and exploit. */
export const ClarificationAnswerType = z.enum([
  "text",
  "boolean",
  "single_choice",
  "multi_choice",
  "number",
  "budget",
  "path_scope",
]);
export type ClarificationAnswerType = z.infer<typeof ClarificationAnswerType>;

export const ClarificationQuestionStatus = z.enum([
  "pending",
  "answered",
  "obsolete",
  "cancelled",
]);
export type ClarificationQuestionStatus = z.infer<typeof ClarificationQuestionStatus>;

export const ClarificationCategory = z.enum([
  "acceptance_criteria",
  "scope",
  "constraint",
  "decision",
  "budget",
  "path_scope",
  "other",
]);
export type ClarificationCategory = z.infer<typeof ClarificationCategory>;

/**
 * Provenance of a clarification group. `deterministic_policy` marks the
 * control-plane gate (never presented as AI). `live` / `fake_fixture` mark
 * ProviderAdapter output.
 */
export const ClarificationProvenance = z.enum([
  "live",
  "fake_fixture",
  "deterministic_policy",
]);
export type ClarificationProvenance = z.infer<typeof ClarificationProvenance>;

const ClarificationOption = z.object({
  key: LogicalKey,
  label: z.string().min(1).max(500),
}).strict();

/** Typed answer value — never an unvalidated arbitrary object. */
export const ClarificationAnswerValue = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string().min(1).max(10_000) }).strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("single_choice"), value: LogicalKey }).strict(),
  z.object({
    type: z.literal("multi_choice"),
    value: z.array(LogicalKey).min(1).max(50),
  }).strict(),
  z.object({ type: z.literal("number"), value: z.number().finite() }).strict(),
  z.object({
    type: z.literal("budget"),
    value: z.number().finite().nonnegative().max(1_000_000_000),
  }).strict(),
  z.object({
    type: z.literal("path_scope"),
    value: z.array(z.string().min(1).max(500)).min(1).max(100),
  }).strict(),
]);
export type ClarificationAnswerValue = z.infer<typeof ClarificationAnswerValue>;

/**
 * One material question. Logical keys are stable across rounds; SQLite ids
 * are minted server-side when the group is persisted.
 */
export const ClarificationQuestion = z
  .object({
    id: Id,
    logicalKey: LogicalKey,
    category: ClarificationCategory,
    question: z.string().min(1).max(2000),
    reason: z.string().min(1).max(2000),
    answerType: ClarificationAnswerType,
    options: z.array(ClarificationOption).max(50).default([]),
    required: z.boolean().default(true),
    acceptanceCriteriaRefs: z.array(z.number().int().min(0).max(99)).max(50).default([]),
    blockedDecisions: z.array(z.string().min(1).max(300)).max(20).default([]),
    blockedMissions: z.array(LogicalKey).max(50).default([]),
    displayOrder: z.number().int().min(0).max(999).default(0),
    status: ClarificationQuestionStatus.default("pending"),
    /** Display/serialization of the typed answer; null while pending. */
    answer: z.string().nullable().default(null),
    answerValue: ClarificationAnswerValue.nullable().default(null),
  })
  .strict()
  .superRefine((question, ctx) => {
    const choiceTypes: ClarificationAnswerType[] = ["single_choice", "multi_choice"];
    if (choiceTypes.includes(question.answerType) && question.options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: `${question.answerType} requires at least two options`,
      });
    }
    if (!choiceTypes.includes(question.answerType) && question.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: `${question.answerType} must not declare options`,
      });
    }
    const keys = question.options.map((option) => option.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "option keys must be unique",
      });
    }
  });
export type ClarificationQuestion = z.infer<typeof ClarificationQuestion>;

/** One durable grouped intervention — all questions of a round together. */
export const Clarification = z.object({
  id: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  projectId: Id,
  objectiveId: Id,
  status: InterventionStatus,
  schemaVersion: z.literal(CLARIFICATION_SCHEMA_VERSION).default(CLARIFICATION_SCHEMA_VERSION),
  round: z.number().int().min(1).max(20).default(1),
  provenance: ClarificationProvenance,
  providerId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  brainRunId: Id.nullable().default(null),
  questions: z.array(ClarificationQuestion).min(1).max(20),
});
export type Clarification = z.infer<typeof Clarification>;

/**
 * Provider-proposed clarification set (no server ids). Validated strictly
 * before the control plane mints durable identifiers.
 */
export const BrainClarificationProposal = z
  .object({
    summary: z.string().min(1).max(2000),
    needsClarification: z.boolean(),
    questions: z
      .array(
        z
          .object({
            key: LogicalKey,
            category: ClarificationCategory,
            question: z.string().min(1).max(2000),
            reason: z.string().min(1).max(2000),
            answerType: ClarificationAnswerType,
            options: z.array(ClarificationOption).max(50).default([]),
            required: z.boolean().default(true),
            acceptanceCriteriaRefs: z.array(z.number().int().min(0).max(99)).max(50).default([]),
            blockedDecisions: z.array(z.string().min(1).max(300)).max(20).default([]),
            blockedMissions: z.array(LogicalKey).max(50).default([]),
            displayOrder: z.number().int().min(0).max(999).default(0),
          })
          .strict()
          .superRefine((question, ctx) => {
            const choiceTypes: ClarificationAnswerType[] = ["single_choice", "multi_choice"];
            if (choiceTypes.includes(question.answerType) && question.options.length < 2) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["options"],
                message: `${question.answerType} requires at least two options`,
              });
            }
            if (!choiceTypes.includes(question.answerType) && question.options.length > 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["options"],
                message: `${question.answerType} must not declare options`,
              });
            }
          }),
      )
      .max(20)
      .default([]),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    if (proposal.needsClarification && proposal.questions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions"],
        message: "needsClarification requires at least one question",
      });
    }
    if (!proposal.needsClarification && proposal.questions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions"],
        message: "questions must be empty when needsClarification is false",
      });
    }
    const keys = proposal.questions.map((question) => question.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions"],
        message: "question keys must be unique within a round",
      });
    }
  });
export type BrainClarificationProposal = z.infer<typeof BrainClarificationProposal>;

/** Re-export BrainProvenance for callers that only import clarification. */
export type { BrainProvenance };
