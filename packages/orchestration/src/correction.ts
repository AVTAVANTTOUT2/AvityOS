import type { Mission } from "@avityos/contracts";

export type CorrectionDecision =
  | { kind: "retry"; attempt: number }
  | { kind: "escalate"; reason: string };

/**
 * Bounded correction loop: a mission that failed validation/review may be
 * retried until maxCorrectionAttempts, then must escalate. Never recursive,
 * never silent.
 */
export function decideCorrection(mission: Mission): CorrectionDecision {
  const next = mission.correctionAttempts + 1;
  if (next > mission.maxCorrectionAttempts) {
    return {
      kind: "escalate",
      reason: `Correction limit reached (${mission.maxCorrectionAttempts} attempts) for mission ${mission.id}`,
    };
  }
  return { kind: "retry", attempt: next };
}
