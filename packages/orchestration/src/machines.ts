import type { MissionState, ProjectStatus, RunState } from "@avityos/contracts";

/**
 * Explicit transition tables. These are the single authority on legal state
 * changes; the control plane refuses any transition not listed here and the
 * property tests in machines.test.ts enforce structural invariants
 * (terminal states have no exits, every state is reachable).
 */

export const MISSION_TRANSITIONS: Readonly<Record<MissionState, readonly MissionState[]>> = {
  proposed: ["ready", "paused", "cancelled"],
  ready: ["assigned", "paused", "blocked", "cancelled"],
  assigned: ["running", "ready", "paused", "blocked", "cancelled"],
  running: ["result_submitted", "paused", "blocked", "retrying", "cancelled", "failed"],
  result_submitted: ["validating", "paused", "cancelled"],
  validating: ["review_required", "retrying", "blocked", "failed", "paused", "cancelled"],
  review_required: ["approved", "retrying", "blocked", "paused", "cancelled"],
  approved: ["integrated", "blocked", "paused", "cancelled"],
  integrated: ["completed", "failed", "paused"],
  completed: [],
  paused: [
    "ready",
    "assigned",
    "running",
    "result_submitted",
    "validating",
    "review_required",
    "approved",
    "integrated",
    "cancelled",
  ],
  blocked: ["ready", "paused", "cancelled", "failed"],
  retrying: ["assigned", "paused", "failed", "cancelled"],
  cancelled: [],
  failed: ["retrying", "paused"],
};

export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["starting", "cancelled"],
  starting: ["running", "failed", "cancelling"],
  running: ["succeeded", "failed", "timed_out", "paused", "cancelling"],
  paused: ["running", "cancelling"],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  succeeded: [],
  failed: [],
  timed_out: [],
};

/**
 * Project-level transitions. Pause is durable and blocks scheduling; resume
 * restores the recorded pre-pause status through the engine, never by inventing
 * an in-memory-only transition.
 */
export const PROJECT_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  draft: ["clarifying", "planning", "active", "archived"],
  clarifying: ["planning", "clarifying", "paused", "blocked", "draft", "archived"],
  planning: ["active", "clarifying", "paused", "blocked", "archived"],
  active: ["paused", "blocked", "completed", "clarifying", "planning", "archived"],
  paused: ["active", "planning", "clarifying", "blocked", "archived"],
  blocked: ["planning", "active", "clarifying", "paused", "archived"],
  completed: ["archived"],
  archived: [],
};

export const MISSION_TERMINAL_STATES: readonly MissionState[] = ["completed", "cancelled"];
export const RUN_TERMINAL_STATES: readonly RunState[] = [
  "cancelled",
  "succeeded",
  "failed",
  "timed_out",
];
export const PROJECT_TERMINAL_STATES: readonly ProjectStatus[] = ["archived"];

/** Mission states that atomic project pause must suspend. */
export const MISSION_PAUSEABLE_STATES: readonly MissionState[] = [
  "proposed",
  "ready",
  "assigned",
  "running",
  "result_submitted",
  "validating",
  "review_required",
  "approved",
  "integrated",
  "blocked",
  "retrying",
];

/** Run states that must be cancelled/fenced during atomic project pause. */
export const RUN_CANCELLABLE_ON_PAUSE: readonly RunState[] = [
  "queued",
  "starting",
  "running",
  "paused",
];

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: "mission" | "run" | "project",
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransitionMission(from: MissionState, to: MissionState): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

export function assertMissionTransition(from: MissionState, to: MissionState): void {
  if (!canTransitionMission(from, to)) throw new IllegalTransitionError("mission", from, to);
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) throw new IllegalTransitionError("run", from, to);
}

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_TRANSITIONS[from].includes(to);
}

export function assertProjectTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransitionProject(from, to)) throw new IllegalTransitionError("project", from, to);
}
