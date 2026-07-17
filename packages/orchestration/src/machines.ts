import type { MissionState, RunState } from "@avityos/contracts";

/**
 * Explicit transition tables. These are the single authority on legal state
 * changes; the control plane refuses any transition not listed here and the
 * property tests in machines.test.ts enforce structural invariants
 * (terminal states have no exits, every state is reachable).
 */

export const MISSION_TRANSITIONS: Readonly<Record<MissionState, readonly MissionState[]>> = {
  proposed: ["ready", "cancelled"],
  ready: ["assigned", "paused", "blocked", "cancelled"],
  assigned: ["running", "ready", "paused", "blocked", "cancelled"],
  running: ["result_submitted", "paused", "blocked", "retrying", "cancelled", "failed"],
  result_submitted: ["validating", "cancelled"],
  validating: ["review_required", "retrying", "failed", "cancelled"],
  review_required: ["approved", "retrying", "blocked", "cancelled"],
  approved: ["integrated", "blocked", "cancelled"],
  integrated: ["completed", "failed"],
  completed: [],
  paused: ["ready", "running", "cancelled"],
  blocked: ["ready", "cancelled", "failed"],
  retrying: ["assigned", "failed", "cancelled"],
  cancelled: [],
  failed: ["retrying"],
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

export const MISSION_TERMINAL_STATES: readonly MissionState[] = ["completed", "cancelled"];
export const RUN_TERMINAL_STATES: readonly RunState[] = [
  "cancelled",
  "succeeded",
  "failed",
  "timed_out",
];

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: "mission" | "run",
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
