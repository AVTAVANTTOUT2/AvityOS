import {
  ProviderErrorCategory,
  type ProviderErrorCategory as ProviderErrorCategoryName,
} from "@avityos/contracts";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  RunHandle,
  StartRunInput,
} from "@avityos/providers";
import type { ExecutionMode } from "./provider-policy.js";
import { ExecutionModeError, FIXTURE_PROVIDER_ID } from "./provider-policy.js";

export interface CampaignFaultConfig {
  provider: string;
  category: ProviderErrorCategoryName;
}

/**
 * Parse optional campaign-only fault injection configuration.
 *
 * The fault is explicit and one-shot:
 * - disabled unless both env vars are present;
 * - forbidden outside `campaign` execution mode;
 * - forbidden for the fixture provider (`fake`);
 * - requires a currently registered provider.
 */
export function resolveCampaignFault(
  env: NodeJS.ProcessEnv,
  mode: ExecutionMode,
  availableProviders: ReadonlySet<string>,
): CampaignFaultConfig | null {
  const provider = env.AVITY_CAMPAIGN_FAULT_PROVIDER?.trim();
  const categoryRaw = env.AVITY_CAMPAIGN_FAULT_CATEGORY?.trim();
  if (!provider && !categoryRaw) return null;
  if (!provider || !categoryRaw) {
    throw new ExecutionModeError(
      "AVITY_CAMPAIGN_FAULT_PROVIDER and AVITY_CAMPAIGN_FAULT_CATEGORY must be set together",
    );
  }
  if (mode !== "campaign") {
    throw new ExecutionModeError(
      `campaign fault injection is forbidden in '${mode}' mode; set AVITY_EXECUTION_MODE=campaign explicitly`,
    );
  }
  if (provider === FIXTURE_PROVIDER_ID) {
    throw new ExecutionModeError("campaign fault injection cannot target the fixture provider 'fake'");
  }
  if (!availableProviders.has(provider)) {
    throw new ExecutionModeError(
      `campaign fault injection target '${provider}' is not a registered provider`,
    );
  }
  const parsed = ProviderErrorCategory.safeParse(categoryRaw);
  if (!parsed.success) {
    throw new ExecutionModeError(
      `invalid AVITY_CAMPAIGN_FAULT_CATEGORY=${categoryRaw}; expected one of: ${ProviderErrorCategory.options.join(", ")}`,
    );
  }
  return { provider, category: parsed.data };
}

/**
 * Wrap exactly one provider with a deterministic one-shot normalized failure.
 * The first run emits a synthetic error event, then all subsequent runs
 * delegate to the original adapter unchanged.
 */
export function applyCampaignFaultInjection(
  providers: Map<string, ProviderAdapter>,
  fault: CampaignFaultConfig | null,
): Map<string, ProviderAdapter> {
  if (!fault) return new Map(providers);
  const wrapped = new Map(providers);
  const base = wrapped.get(fault.provider);
  if (!base) return wrapped;
  wrapped.set(fault.provider, new OneShotFaultAdapter(base, fault));
  return wrapped;
}

class OneShotFaultAdapter implements ProviderAdapter {
  readonly name: string;
  readonly contractVersion: ProviderAdapter["contractVersion"];
  private consumed = false;

  constructor(
    private readonly inner: ProviderAdapter,
    private readonly fault: CampaignFaultConfig,
  ) {
    this.name = inner.name;
    this.contractVersion = inner.contractVersion;
  }

  capabilities(): ProviderCapabilities {
    return this.inner.capabilities();
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels();
  }

  healthy(): Promise<boolean> {
    return this.inner.healthy();
  }

  startRun(input: StartRunInput): RunHandle {
    if (!this.consumed) {
      this.consumed = true;
      const category = this.fault.category;
      const providerName = this.inner.name;
      async function* events() {
        yield {
          type: "error" as const,
          category,
          message: `campaign fault injection (${category}) for provider ${providerName}`,
        };
      }
      return {
        events: events(),
        cancel: async () => {},
      };
    }
    return this.inner.startRun(input);
  }
}
