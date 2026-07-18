import { CheckpointKind, type BrainPlanProposal } from "@avityos/contracts";
import { DependencyCycleError, assertAcyclic } from "@avityos/orchestration";
import { isCommandAllowed, type CommandPolicy } from "@avityos/policy";

export interface PlanValidationContext {
  /** Acceptance criteria of the objective revision the plan must cover. */
  acceptanceCriteria: readonly string[];
  /** Whether the project has a server-validated repository. */
  repoAvailable: boolean;
  /** Policy for the real check commands missions declare. */
  checkCommandPolicy: CommandPolicy;
  /** Project budget; a single mission may not exceed it. */
  projectBudgetUsd: number | null;
}

export type PlanValidationResult = { ok: true } | { ok: false; issues: string[] };

function isUnsafePathPattern(pattern: string): boolean {
  return pattern.startsWith("/") || pattern.split("/").includes("..");
}

/**
 * Deterministic validation of an AI plan proposal (already schema-validated).
 * Nothing durable is created unless every rule passes: known and acyclic
 * dependencies, full acceptance-criteria coverage, policy-conformant paths
 * and commands, sane budgets/timeouts and no logical duplicates. Issues are
 * returned verbatim so a bounded repair prompt can fix them.
 */
export function validatePlanProposal(
  plan: BrainPlanProposal,
  ctx: PlanValidationContext,
): PlanValidationResult {
  const issues: string[] = [];

  const milestoneKeys = new Set<string>();
  for (const milestone of plan.milestones) {
    if (milestoneKeys.has(milestone.key)) issues.push(`duplicate milestone key: ${milestone.key}`);
    milestoneKeys.add(milestone.key);
  }

  const missionKeys = new Set<string>();
  const objectivesSeen = new Map<string, string>();
  for (const mission of plan.missions) {
    if (missionKeys.has(mission.key)) issues.push(`duplicate mission key: ${mission.key}`);
    missionKeys.add(mission.key);
    const duplicateOf = objectivesSeen.get(mission.objective.trim().toLowerCase());
    if (duplicateOf) issues.push(`mission ${mission.key} duplicates the objective of mission ${duplicateOf}`);
    else objectivesSeen.set(mission.objective.trim().toLowerCase(), mission.key);
    if (!milestoneKeys.has(mission.milestoneKey)) {
      issues.push(`mission ${mission.key} references unknown milestone: ${mission.milestoneKey}`);
    }
  }

  for (const mission of plan.missions) {
    for (const dep of mission.dependsOn) {
      if (dep === mission.key) issues.push(`mission ${mission.key} depends on itself`);
      else if (!missionKeys.has(dep)) issues.push(`mission ${mission.key} has unknown dependency: ${dep}`);
    }
  }

  if (issues.length === 0) {
    try {
      assertAcyclic(
        plan.missions.flatMap((mission) =>
          mission.dependsOn.map((dep) => ({ missionId: mission.key, dependsOnMissionId: dep })),
        ),
      );
    } catch (err) {
      if (err instanceof DependencyCycleError) issues.push(`dependency cycle: ${err.cycle.join(" -> ")}`);
      else throw err;
    }
  }

  if (ctx.acceptanceCriteria.length > 0) {
    const covered = new Set<number>();
    for (const mission of plan.missions) {
      for (const index of mission.coversCriteria) {
        if (index >= ctx.acceptanceCriteria.length) {
          issues.push(`mission ${mission.key} covers unknown acceptance criterion index ${index}`);
        } else {
          covered.add(index);
        }
      }
    }
    for (let index = 0; index < ctx.acceptanceCriteria.length; index += 1) {
      if (!covered.has(index)) {
        issues.push(
          `acceptance criterion ${index} is not covered by any mission: ${ctx.acceptanceCriteria[index]!.slice(0, 120)}`,
        );
      }
    }
  }

  for (const mission of plan.missions) {
    for (const pattern of [...mission.allowedPaths, ...mission.forbiddenPaths]) {
      if (isUnsafePathPattern(pattern)) {
        issues.push(`mission ${mission.key} declares an unsafe path pattern: ${pattern}`);
      }
    }
    for (const [kind, argv] of Object.entries(mission.checkCommands)) {
      if (!CheckpointKind.safeParse(kind).success) {
        issues.push(`mission ${mission.key} declares a command for unknown check kind: ${kind}`);
        continue;
      }
      const verdict = isCommandAllowed(ctx.checkCommandPolicy, argv);
      if (verdict.effect !== "allow") {
        issues.push(`mission ${mission.key} check ${kind} command is not allowed by policy: ${verdict.reason}`);
      }
    }
    for (const kind of mission.requiredChecks) {
      const argv = mission.checkCommands[kind];
      if (!argv || argv.length === 0) {
        issues.push(`mission ${mission.key} requires check ${kind} without a real command`);
      }
      if (!ctx.repoAvailable) {
        issues.push(`mission ${mission.key} requires check ${kind} but the project has no repository to run it in`);
      }
    }
    if (!ctx.repoAvailable && mission.allowedPaths.length > 0) {
      issues.push(`mission ${mission.key} declares workspace paths but the project has no repository`);
    }
    if (
      ctx.projectBudgetUsd !== null &&
      mission.budgetUsd !== null &&
      mission.budgetUsd > ctx.projectBudgetUsd
    ) {
      issues.push(
        `mission ${mission.key} budget $${mission.budgetUsd} exceeds the project budget $${ctx.projectBudgetUsd}`,
      );
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
