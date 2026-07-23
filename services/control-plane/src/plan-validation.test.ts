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
    requiredChecks: ["architecture_rule", "test"],
    checkCommands: {
      architecture_rule: ["git", "diff", "--check", "HEAD"],
      test: ["pnpm", "run", "test"],
    },
    expectedArtifacts: [],
    workspaceChangesRequired: true,
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
  availableChecks: {
    requiredChecks: ["architecture_rule", "test"],
    checkCommands: {
      architecture_rule: ["git", "diff", "--check", "HEAD"],
      test: ["pnpm", "run", "test"],
    },
  },
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
    expect(
      issuesOf(
        proposal([
          mission({
            requiredChecks: ["architecture_rule", "test"],
            checkCommands: { architecture_rule: ["git", "diff", "--check", "HEAD"] },
          }),
        ]),
      ).join(),
    ).toContain("without a real command");
    const denied = proposal([
      mission({ requiredChecks: ["test"], checkCommands: { test: ["rm", "-rf", "/"] } }),
    ]);
    expect(issuesOf(denied).join()).toContain("not allowed by policy");
    expect(issuesOf(proposal([mission({ checkCommands: { nonsense: ["git", "status"] } })])).join()).toContain(
      "unknown check kind",
    );
  });

  it("rejects omitted, unused and invented repository checks", () => {
    const omitted = mission({ requiredChecks: [], checkCommands: {} });
    expect(issuesOf(proposal([omitted])).join()).toContain("omits mandatory repository check");

    const invented = mission({
      checkCommands: {
        architecture_rule: ["git", "diff", "--check", "HEAD"],
        test: ["pnpm", "run", "does-not-exist"],
      },
    });
    expect(issuesOf(proposal([invented])).join()).toContain("does not match the repository snapshot");

    const unused = mission({
      requiredChecks: ["architecture_rule"],
      checkCommands: {
        architecture_rule: ["git", "diff", "--check", "HEAD"],
        test: ["pnpm", "run", "test"],
      },
    });
    expect(issuesOf(proposal([unused])).join()).toContain("unused check command");
  });

  it("rejects unsafe path patterns and workspace claims without a repository", () => {
    expect(issuesOf(proposal([mission({ allowedPaths: ["/etc/**"] })])).join()).toContain("unsafe path pattern");
    expect(issuesOf(proposal([mission({ allowedPaths: ["../outside/**"] })])).join()).toContain("unsafe path pattern");
    const noRepo = { ...ctx, repoAvailable: false };
    expect(issuesOf(proposal([mission({ allowedPaths: ["src/**"] })]), noRepo).join()).toContain(
      "no repository",
    );
    expect(
      issuesOf(
        proposal([mission({ allowedPaths: [], workspaceChangesRequired: true })]),
        noRepo,
      ).join(),
    ).toContain("requires workspace changes");
  });

  it("rejects writable paths and repository artifacts on read-only missions", () => {
    expect(
      issuesOf(
        proposal([mission({ workspaceChangesRequired: false })]),
      ).join(),
    ).toContain("declares writable paths");
    expect(
      issuesOf(
        proposal([
          mission({
            allowedPaths: [],
            expectedArtifacts: ["report.json"],
            workspaceChangesRequired: false,
          }),
        ]),
      ).join(),
    ).toContain("declares expected repository artifacts");
    expect(
      validatePlanProposal(
        proposal([
          mission({
            allowedPaths: [],
            expectedArtifacts: [],
            workspaceChangesRequired: false,
          }),
        ]),
        ctx,
      ),
    ).toEqual({ ok: true });
  });

  it("requires exact canonical paths for expected artifacts", () => {
    expect(
      issuesOf(
        proposal([
          mission({ expectedArtifacts: ["Modified src/feature.ts"] }),
        ]),
      ).join(),
    ).toContain("without a status label");
    expect(
      issuesOf(proposal([mission({ expectedArtifacts: ["src/**"] })])).join(),
    ).toContain("not a glob");
    expect(
      issuesOf(
        proposal([mission({ expectedArtifacts: ["src/feature.ts"] })]),
      ),
    ).toEqual([]);
  });

  it("rejects a mission budget above the project budget", () => {
    expect(issuesOf(proposal([mission({ budgetUsd: 500 })])).join()).toContain("exceeds the project budget");
  });

  it("rejects a milestone reference that does not exist", () => {
    expect(issuesOf(proposal([mission({ milestoneKey: "ghost" })])).join()).toContain("unknown milestone");
  });
});
