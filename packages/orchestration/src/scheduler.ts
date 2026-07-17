import type { Mission } from "@avityos/contracts";

export interface SchedulingLimits {
  /** Host-level cap on simultaneously running missions across all projects. */
  maxConcurrentRuns: number;
  /** Per-project cap; there is deliberately no fixed product-level limit. */
  maxConcurrentRunsPerProject: number;
}

/**
 * Pick which `ready` missions to start given current running missions and
 * configured resource-safety limits. Deterministic: priority desc, then
 * creation time asc, then id asc.
 */
export function selectMissionsToStart(
  ready: readonly Mission[],
  running: readonly Mission[],
  limits: SchedulingLimits,
): Mission[] {
  const capacity = limits.maxConcurrentRuns - running.length;
  if (capacity <= 0) return [];

  const perProject = new Map<string, number>();
  for (const m of running) {
    perProject.set(m.projectId, (perProject.get(m.projectId) ?? 0) + 1);
  }

  const sorted = [...ready].sort(
    (a, b) =>
      b.priority - a.priority ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );

  const selected: Mission[] = [];
  for (const mission of sorted) {
    if (selected.length >= capacity) break;
    const projectCount = perProject.get(mission.projectId) ?? 0;
    if (projectCount >= limits.maxConcurrentRunsPerProject) continue;
    selected.push(mission);
    perProject.set(mission.projectId, projectCount + 1);
  }
  return selected;
}
