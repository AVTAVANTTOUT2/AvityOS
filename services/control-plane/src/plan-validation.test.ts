import { describe, expect, it } from "vitest";
import type { BrainPlanProposal } from "@avityos/contracts";
import { DEFAULT_ENGINE_CONFIG } from "./engine.js";
import { validatePlanProposal, type PlanValidationContext } from "./plan-validation.js";

function mission(overrides: Partial<BrainPlanProposal["missions"][number]> = {}): BrainPlanProposal["missions"][number] {
  return {
    key: "mission-1",
    title: "Implement the feature",
    objective: "Implement the feature end to end",
    rationale: "Required by the objective",
    role: "backend",
    milestoneKey: "deliver",
    dependsOn: [],
    acceptanceCriteria: ["it works"],
    coversCriteria: [0],
    allowedPaths: ["src/**"],
    forbiddenPaths: ["**/.env"],
    requiredChecks: [],
    checkCommands: {},
    expectedArtifacts: [],
    budgetUsd: null,
    timeoutSeconds: 900,
    escalationConditions: [],
    priority: 50,
    ...overrides,
  };
}

function proposal(missions: BrainPlanProposal["missions"]): BrainPlanProposal {
  return {
    summary: "test plan",
    milestones: [{ key: "deliver", title: "Deliver", description: "", order: 0 }],
    missions,
  };
}

const ctx: PlanValidationContext = {
  acceptanceCriteria: ["criterion zero"],
  repoAvailable: true,
  checkCommandPolicy: DEFAULT_ENGINE_CONFIG.checkCommandPolicy,
  projectBudgetUsd: 100,
};

function issuesOf(plan: BrainPlanProposal, context: PlanValidationContext = ctx): string[] {
  const verdict = validatePlanProposal(plan, context);
  return verdict.ok ? [] : verdict.issues;
}

describe("deterministic plan validation", () => {
  it("accepts a valid plan with parallel and ordered missions", () => {
    const plan = proposal([
      mission({ key: "a", coversCriteria: [0] }),
      mission({ key: "b", objective: "second independent objective", coversCriteria: [] }),
      mission({ key: "c", objective: "final join", dependsOn: ["a", "b"], coversCriteria: [] }),
    ]);
    expect(validatePlanProposal(plan, ctx)).toEqual({ ok: true });
  });

  it("rejects unknown dependencies and self-dependencies", () => {
    expect(issuesOf(proposal([mission({ dependsOn: ["ghost"] })])).join()).toContain("unknown dependency");
    expect(issuesOf(proposal([mission({ dependsOn: ["mission-1"] })])).join()).toContain("depends on itself");
  });

  it("rejects dependency cycles", () => {
    const plan = proposal([
      mission({ key: "a", dependsOn: ["b"], coversCriteria: [0] }),
      mission({ key: "b", objective: "other objective", dependsOn: ["a"], coversCriteria: [] }),
    ]);
    expect(issuesOf(plan).join()).toContain("dependency cycle");
  });

  it("rejects duplicate mission keys and duplicated logical objectives", () => {
    const duplicateKeys = proposal([mission(), mission({ objective: "different text", coversCriteria: [] })]);
    expect(issuesOf(duplicateKeys).join()).toContain("duplicate mission key");
    const duplicateLogic = proposal([
      mission({ key: "a", coversCriteria: [0] }),
      mission({ key: "b", coversCriteria: [] }),
    ]);
    expect(issuesOf(duplicateLogic).join()).toContain("duplicates the objective");
  });

  it("requires every acceptance criterion to be covered by a mission", () => {
    const context = { ...ctx, acceptanceCriteria: ["first", "second"] };
    const plan = proposal([mission({ coversCriteria: [0] })]);
    expect(issuesOf(plan, context).join()).toContain("criterion 1 is not covered");
    expect(issuesOf(proposal([mission({ coversCriteria: [0, 7] })])).join()).toContain("unknown acceptance criterion index 7");
  });

  it("rejects required checks without real commands and policy-denied commands", () => {
    expect(issuesOf(proposal([mission({ requiredChecks: ["test"] })])).join()).toContain("without a real command");
    const denied = proposal([
      mission({ requiredChecks: ["test"], checkCommands: { test: ["rm", "-rf", "/"] } }),
    ]);
    expect(issuesOf(denied).join()).toContain("not allowed by policy");
    expect(issuesOf(proposal([mission({ checkCommands: { nonsense: ["git", "status"] } })])).join()).toContain(
      "unknown check kind",
    );
  });

  it("rejects unsafe path patterns and workspace claims without a repository", () => {
    expect(issuesOf(proposal([mission({ allowedPaths: ["/etc/**"] })])).join()).toContain("unsafe path pattern");
    expect(issuesOf(proposal([mission({ allowedPaths: ["../outside/**"] })])).join()).toContain("unsafe path pattern");
    const noRepo = { ...ctx, repoAvailable: false };
    expect(issuesOf(proposal([mission({ allowedPaths: ["src/**"] })]), noRepo).join()).toContain(
      "no repository",
    );
  });

  it("rejects a mission budget above the project budget", () => {
    expect(issuesOf(proposal([mission({ budgetUsd: 500 })])).join()).toContain("exceeds the project budget");
  });

  it("rejects a milestone reference that does not exist", () => {
    expect(issuesOf(proposal([mission({ milestoneKey: "ghost" })])).join()).toContain("unknown milestone");
  });
});
