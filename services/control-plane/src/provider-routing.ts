/**
 * Deterministic provider-routing helpers shared by the Engine and the E2E
 * readiness preflight. No I/O — pure functions only — so both paths compute
 * identical effective chains.
 */

export interface ProviderRoutingInput {
  providerChain: readonly string[];
  roleProviderChains: ReadonlyMap<string, readonly string[]>;
}

/** Stable de-duplication preserving first-seen order. */
export function uniqueProviderChain(providers: readonly string[]): string[] {
  return [...new Set(providers.filter(Boolean))];
}

/**
 * Effective fallback chain for a team role: role-preferred providers first,
 * then the global chain (same composition as the Engine mission author path).
 */
export function effectiveProviderChainForRole(
  input: ProviderRoutingInput,
  role: string,
): string[] {
  return uniqueProviderChain([
    ...(input.roleProviderChains.get(role) ?? []),
    ...input.providerChain,
  ]);
}

/** Effective chain used by the brain / orchestrator reasoning pipeline. */
export function effectiveBrainProviderChain(
  input: ProviderRoutingInput,
): string[] {
  return effectiveProviderChainForRole(input, "orchestrator");
}

/**
 * Roles for which `providerName` appears in the effective chain.
 * Does not invent roles from the global chain alone — only roles present in
 * `roleProviderChains` (plus any explicitly queried via other helpers).
 */
export function routedRolesForProvider(
  input: ProviderRoutingInput,
  providerName: string,
): string[] {
  const roles = new Set<string>();

  for (const [role] of input.roleProviderChains) {
    if (effectiveProviderChainForRole(input, role).includes(providerName)) {
      roles.add(role);
    }
  }

  return [...roles].sort();
}

/** Union of providers reachable through the effective chain of any given role. */
export function providersRoutableForRoles(
  input: ProviderRoutingInput,
  roles: readonly string[],
): Set<string> {
  const result = new Set<string>();

  for (const role of roles) {
    for (const provider of effectiveProviderChainForRole(input, role)) {
      result.add(provider);
    }
  }

  return result;
}

/**
 * Select a reviewer distinct from the author when one exists in `chain` and is
 * registered. Mirrors the Engine independent-review selection.
 */
export function selectDistinctReviewerProvider(
  chain: readonly string[],
  availableProviders: ReadonlySet<string>,
  authorProvider: string,
): string {
  return (
    chain.find(
      (provider) =>
        provider !== authorProvider && availableProviders.has(provider),
    ) ?? authorProvider
  );
}
