import { describe, expect, it } from "vitest";
import {
  CreateProjectRequest,
  EventEnvelope,
  Mission,
  MissionState,
  ProviderErrorCategory,
  UpdateProjectRequest,
} from "./index.js";

describe("contracts", () => {
  it("parses a valid mission", () => {
    const mission = Mission.parse({
      id: "m1",
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
      projectId: "p1",
      planId: null,
      milestoneId: null,
      title: "Implement login endpoint",
      role: "backend",
      state: "proposed",
      contract: { objective: "Build POST /login" },
      branchName: null,
      worktreePath: null,
      stateReason: null,
    });
    expect(mission.correctionAttempts).toBe(0);
    expect(mission.contract.requiredChecks).toEqual([]);
  });

  it("rejects unknown mission states", () => {
    expect(MissionState.safeParse("done").success).toBe(false);
    expect(MissionState.safeParse("integrated").success).toBe(true);
  });

  it("applies request defaults", () => {
    const req = CreateProjectRequest.parse({ name: "Demo" });
    expect(req.autonomyProfile).toBe("autonomous_with_checkpoints");
    expect(req.repoPath).toBeNull();
    expect(req.defaultBranch).toBe("main");
    expect(req.budgetWarnAtFraction).toBe(0.8);
  });

  it("validates complete project onboarding fields", () => {
    const req = CreateProjectRequest.parse({
      name: "Demo",
      repoPath: "/srv/demo",
      repoRemoteUrl: "git@github.com:example/demo.git",
      defaultBranch: "develop",
      objective: "Deliver the complete onboarding flow",
      acceptanceCriteria: ["web persists every field", "CLI supports updates"],
      budgetUsd: 125,
      budgetWarnAtFraction: 0.75,
    });
    expect(req.acceptanceCriteria).toHaveLength(2);
    expect(req.repoRemoteUrl).toBe("git@github.com:example/demo.git");
    expect(UpdateProjectRequest.parse({ budgetUsd: 125 })).toEqual({ budgetUsd: 125 });
    expect(UpdateProjectRequest.safeParse({}).success).toBe(false);
    expect(CreateProjectRequest.safeParse({ name: "X", repoRemoteUrl: "https://github.com/x/y" }).success).toBe(false);
  });

  it("validates event envelopes with resume sequence", () => {
    const ev = EventEnvelope.parse({
      schemaVersion: 1,
      seq: 42,
      id: "e1",
      type: "mission.state_changed",
      projectId: "p1",
      missionId: "m1",
      runId: null,
      createdAt: "2026-07-17T10:00:00.000Z",
      payload: { from: "ready", to: "assigned" },
    });
    expect(ev.seq).toBe(42);
  });

  it("keeps provider error categories closed", () => {
    expect(ProviderErrorCategory.options).toContain("rate_limited");
    expect(ProviderErrorCategory.safeParse("weird").success).toBe(false);
  });
});
