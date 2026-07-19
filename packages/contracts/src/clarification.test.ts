import { describe, expect, it } from "vitest";
import {
  AnswerClarificationRequest,
  BrainClarificationProposal,
  CLARIFICATION_SCHEMA_VERSION,
  Clarification,
  ClarificationAnswerType,
  ClarificationQuestion,
} from "./index.js";

describe("clarification contracts", () => {
  it("accepts a valid structured clarification group", () => {
    const group = Clarification.parse({
      id: "clr_1",
      createdAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
      projectId: "prj_1",
      objectiveId: "obj_1",
      status: "open",
      schemaVersion: CLARIFICATION_SCHEMA_VERSION,
      round: 1,
      provenance: "live",
      providerId: "openai",
      model: "gpt-test",
      brainRunId: "brr_1",
      questions: [
        {
          id: "clq_1",
          logicalKey: "acceptance-criteria",
          category: "acceptance_criteria",
          question: "What must be true?",
          reason: "Coverage requires measurable criteria.",
          answerType: "text",
          options: [],
          required: true,
          acceptanceCriteriaRefs: [],
          blockedDecisions: ["plan"],
          blockedMissions: [],
          displayOrder: 0,
          status: "pending",
          answer: null,
          answerValue: null,
        },
      ],
    });
    expect(group.schemaVersion).toBe(1);
    expect(group.questions[0]?.logicalKey).toBe("acceptance-criteria");
  });

  it("rejects an invalid answer type", () => {
    expect(ClarificationAnswerType.safeParse("json_blob").success).toBe(false);
  });

  it("rejects a question without a logical key", () => {
    expect(
      ClarificationQuestion.safeParse({
        id: "clq_1",
        category: "other",
        question: "Missing key?",
        reason: "test",
        answerType: "text",
      }).success,
    ).toBe(false);
  });

  it("rejects incoherent choice options", () => {
    expect(
      ClarificationQuestion.safeParse({
        id: "clq_1",
        logicalKey: "choice",
        category: "decision",
        question: "Pick one",
        reason: "needed",
        answerType: "single_choice",
        options: [{ key: "only", label: "Only one option" }],
        required: true,
        displayOrder: 0,
        status: "pending",
        answer: null,
        answerValue: null,
      }).success,
    ).toBe(false);
  });

  it("rejects incomplete answer payloads", () => {
    expect(AnswerClarificationRequest.safeParse({ answers: [] }).success).toBe(false);
    expect(
      AnswerClarificationRequest.safeParse({
        answers: [{ questionId: "clq_1" }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown or extra answer fields", () => {
    expect(
      AnswerClarificationRequest.safeParse({
        answers: [{ questionId: "clq_1", answer: "ok", surprise: true }],
      }).success,
    ).toBe(false);
  });

  it("keeps clarification proposal schema versioned and closed", () => {
    expect(
      BrainClarificationProposal.safeParse({
        summary: "Need decisions",
        needsClarification: true,
        questions: [
          {
            key: "scope",
            category: "scope",
            question: "What is out of scope?",
            reason: "Bounds the plan",
            answerType: "text",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      BrainClarificationProposal.safeParse({
        summary: "Need decisions",
        needsClarification: true,
        questions: [],
      }).success,
    ).toBe(false);
  });
});
