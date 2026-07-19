import { describe, expect, it } from "vitest";
import { MissionState, ProjectStatus, RunState, type Mission, type MissionDependency } from "@avityos/contracts";
import {
  MISSION_TERMINAL_STATES,
  MISSION_TRANSITIONS,
  PROJECT_TERMINAL_STATES,
  PROJECT_TRANSITIONS,
  RUN_TERMINAL_STATES,
  RUN_TRANSITIONS,
  assertAcyclic,
  assertMissionTransition,
  assertProjectTransition,
  backoffMs,
  canTransitionMission,
  canTransitionProject,
  decideCorrection,
  decideFallback,
  DependencyCycleError,
  IllegalTransitionError,
  selectMissionsToStart,
  unblockedMissions,
} from "./index.js";

function mission(partial: Partial<Mission> & { id: string }): Mission {
  return {
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z",
    projectId: "p1",
    planId: null,
    milestoneId: null,
    title: partial.id,
    role: "backend",
    state: "proposed",
    contract: {
      objective: "x",
      rationale: "",
      context: [],
      allowedPaths: [],
      forbiddenPaths: [],
      acceptanceCriteria: [],
      requiredChecks: [],
      budgetUsd: null,
      timeoutSeconds: null,
      expectedArtifacts: [],
    },
    branchName: null,
    worktreePath: null,
    correctionAttempts: 0,
    maxCorrectionAttempts: 3,
    priority: 50,
    stateReason: null,
    ...partial,
  };
}

describe("mission state machine", () => {
  it("covers every state exactly once in the transition table", () => {
    expect(Object.keys(MISSION_TRANSITIONS).sort()).toEqual([...MissionState.options].sort());
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...RunState.options].sort());
    expect(Object.keys(PROJECT_TRANSITIONS).sort()).toEqual([...ProjectStatus.options].sort());
  });

  it("terminal states have no outgoing transitions", () => {
    for (const s of MISSION_TERMINAL_STATES) expect(MISSION_TRANSITIONS[s]).toEqual([]);
    for (const s of RUN_TERMINAL_STATES) {
      expect(RUN_TRANSITIONS[s]).toEqual([]);
    }
    for (const s of PROJECT_TERMINAL_STATES) expect(PROJECT_TRANSITIONS[s]).toEqual([]);
  });

  it("permits atomic project pause and resume transitions", () => {
    expect(canTransitionProject("active", "paused")).toBe(true);
    expect(canTransitionProject("planning", "paused")).toBe(true);
    expect(canTransitionProject("paused", "active")).toBe(true);
    expect(canTransitionProject("paused", "planning")).toBe(true);
    expect(() => assertProjectTransition("archived", "paused")).toThrow(IllegalTransitionError);
  });

  it("every transition targets a declared state", () => {
    for (const targets of Object.values(MISSION_TRANSITIONS)) {
      for (const t of targets) expect(MissionState.options).toContain(t);
    }
  });

  it("every non-initial state is reachable from proposed", () => {
    const reached = new Set<string>(["proposed"]);
    let frontier = ["proposed"] as (keyof typeof MISSION_TRANSITIONS)[];
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const s of frontier) {
        for (const t of MISSION_TRANSITIONS[s]) {
          if (!reached.has(t)) {
            reached.add(t);
            next.push(t);
          }
        }
      }
      frontier = next;
    }
    expect([...reached].sort()).toEqual([...MissionState.options].sort());
  });

  it("permits the happy path and rejects skips", () => {
    const happy: MissionState[] = [
      "proposed", "ready", "assigned", "running", "result_submitted",
      "validating", "review_required", "approved", "integrated", "completed",
    ];
    for (let i = 0; i < happy.length - 1; i++) {
      expect(canTransitionMission(happy[i]!, happy[i + 1]!)).toBe(true);
    }
    expect(() => assertMissionTransition("proposed", "completed")).toThrow(IllegalTransitionError);
    expect(() => assertMissionTransition("running", "approved")).toThrow(IllegalTransitionError);
    expect(() => assertMissionTransition("completed", "running")).toThrow(IllegalTransitionError);
  });
});

describe("dependency DAG", () => {
  it("detects cycles", () => {
    const deps: MissionDependency[] = [
      { missionId: "a", dependsOnMissionId: "b" },
      { missionId: "b", dependsOnMissionId: "c" },
      { missionId: "c", dependsOnMissionId: "a" },
    ];
    expect(() => assertAcyclic(deps)).toThrow(DependencyCycleError);
    expect(() => assertAcyclic(deps.slice(0, 2))).not.toThrow();
  });

  it("unblocks only proposed missions whose dependencies are satisfied", () => {
    const missions = [
      mission({ id: "a", state: "completed" }),
      mission({ id: "b", state: "running" }),
      mission({ id: "c", state: "proposed" }),
      mission({ id: "d", state: "proposed" }),
    ];
    const deps: MissionDependency[] = [
      { missionId: "c", dependsOnMissionId: "a" },
      { missionId: "d", dependsOnMissionId: "b" },
    ];
    expect(unblockedMissions(missions, deps).map((m) => m.id)).toEqual(["c"]);
  });
});

describe("correction loop", () => {
  it("retries below the limit and escalates at the limit", () => {
    expect(decideCorrection(mission({ id: "m", correctionAttempts: 0 }))).toEqual({
      kind: "retry",
      attempt: 1,
    });
    expect(decideCorrection(mission({ id: "m", correctionAttempts: 3 })).kind).toBe("escalate");
  });
});

describe("fallback policy", () => {
  const base = {
    attempt: 0,
    maxRetries: 3,
    retryAfterMs: null,
    maxWaitMs: 120_000,
    alternateModelsAvailable: true,
    alternateProvidersAllowed: true,
  };

  it("never retries auth or policy errors", () => {
    expect(decideFallback({ ...base, category: "auth" }).action).toBe("escalate_user");
    expect(decideFallback({ ...base, category: "policy_denied" }).action).toBe("escalate_user");
  });

  it("waits for a rate-limit reset within the policy budget", () => {
    const d = decideFallback({ ...base, category: "rate_limited", retryAfterMs: 30_000 });
    expect(d).toMatchObject({ action: "wait_for_reset", waitMs: 30_000 });
  });

  it("switches when the reset exceeds the wait budget", () => {
    const d = decideFallback({ ...base, category: "rate_limited", retryAfterMs: 600_000 });
    expect(d.action).toBe("switch_model");
  });

  it("escalates when no alternative is allowed", () => {
    const d = decideFallback({
      ...base,
      category: "quota_exhausted",
      alternateModelsAvailable: false,
      alternateProvidersAllowed: false,
    });
    expect(d.action).toBe("escalate_user");
  });

  it("backs off exponentially with a cap", () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(10)).toBe(60_000);
  });

  it("retries transient failures until the retry budget is spent", () => {
    expect(decideFallback({ ...base, category: "transient_network" }).action).toBe("retry_backoff");
    expect(decideFallback({ ...base, category: "transient_network", attempt: 3 }).action).toBe(
      "switch_model",
    );
  });
});

describe("scheduler", () => {
  const limits = { maxConcurrentRuns: 3, maxConcurrentRunsPerProject: 2 };

  it("respects global and per-project limits deterministically", () => {
    const ready = [
      mission({ id: "m1", state: "ready", priority: 90 }),
      mission({ id: "m2", state: "ready", priority: 80 }),
      mission({ id: "m3", state: "ready", priority: 70, projectId: "p2" }),
      mission({ id: "m4", state: "ready", priority: 60, projectId: "p2" }),
    ];
    const running = [mission({ id: "r1", state: "running" })];
    const picked = selectMissionsToStart(ready, running, limits);
    // capacity 2; p1 already has 1 running so only m1 fits from p1, then m3.
    expect(picked.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("returns nothing at capacity", () => {
    const running = [
      mission({ id: "r1", state: "running" }),
      mission({ id: "r2", state: "running", projectId: "p2" }),
      mission({ id: "r3", state: "running", projectId: "p3" }),
    ];
    expect(selectMissionsToStart([mission({ id: "m", state: "ready" })], running, limits)).toEqual([]);
  });
});
