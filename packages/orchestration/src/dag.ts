import type { Mission, MissionDependency, MissionState } from "@avityos/contracts";

export class DependencyCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Mission dependency cycle: ${cycle.join(" -> ")}`);
    this.name = "DependencyCycleError";
  }
}

/** Throws DependencyCycleError if the dependency graph contains a cycle. */
export function assertAcyclic(deps: readonly MissionDependency[]): void {
  const adjacency = new Map<string, string[]>();
  for (const d of deps) {
    const list = adjacency.get(d.missionId) ?? [];
    list.push(d.dependsOnMissionId);
    adjacency.set(d.missionId, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  function visit(node: string): void {
    if (done.has(node)) return;
    if (visiting.has(node)) {
      throw new DependencyCycleError([...stack.slice(stack.indexOf(node)), node]);
    }
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) visit(next);
    stack.pop();
    visiting.delete(node);
    done.add(node);
  }

  for (const node of adjacency.keys()) visit(node);
}

const SATISFIED: readonly MissionState[] = ["completed", "integrated", "approved"];

/**
 * Missions in `proposed` whose dependencies are all satisfied — the set the
 * control plane may legally promote to `ready`.
 */
export function unblockedMissions(
  missions: readonly Mission[],
  deps: readonly MissionDependency[],
): Mission[] {
  const stateById = new Map(missions.map((m) => [m.id, m.state]));
  const depsById = new Map<string, string[]>();
  for (const d of deps) {
    const list = depsById.get(d.missionId) ?? [];
    list.push(d.dependsOnMissionId);
    depsById.set(d.missionId, list);
  }
  return missions.filter((m) => {
    if (m.state !== "proposed") return false;
    const wanted = depsById.get(m.id) ?? [];
    return wanted.every((dep) => SATISFIED.includes(stateById.get(dep) ?? "proposed"));
  });
}
