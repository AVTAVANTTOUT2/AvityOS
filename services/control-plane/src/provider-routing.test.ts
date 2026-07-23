import { describe, expect, it } from "vitest";
import {
  effectiveProviderChainForRole,
  reviewerProviderChain,
  selectDistinctReviewerProvider,
  uniqueProviderChain,
} from "./provider-routing.js";

describe("provider-routing", () => {
  it("deduplicates a provider chain while preserving first-seen order", () => {
    expect(uniqueProviderChain(["codex", "fake", "codex", "claude-code"])).toEqual([
      "codex",
      "fake",
      "claude-code",
    ]);
  });

  it("builds the effective role chain as role-preferred then global", () => {
    const input = {
      providerChain: ["fake", "codex"],
      roleProviderChains: new Map([["backend", ["claude-code", "codex"]]]),
    };
    expect(effectiveProviderChainForRole(input, "backend")).toEqual([
      "claude-code",
      "codex",
      "fake",
    ]);
  });

  it("does not select a reviewer that is registered but absent from the chain", () => {
    const selected = selectDistinctReviewerProvider(
      ["codex", "fake"],
      new Set(["codex", "anthropic", "fake"]),
      "codex",
    );
    // anthropic is registered but not in the review chain, so it cannot be chosen.
    // The next chain entry that is available is "fake" (engine-compatible behaviour).
    expect(selected).toBe("fake");
    expect(selected).not.toBe("anthropic");
  });

  it("selects a distinct reviewer when one exists in the chain", () => {
    const selected = selectDistinctReviewerProvider(
      ["codex", "anthropic", "fake"],
      new Set(["codex", "anthropic", "fake"]),
      "codex",
    );
    expect(selected).toBe("anthropic");
  });

  it("orders every distinct reviewer before the author fallback", () => {
    expect(
      reviewerProviderChain(
        ["codex", "claude-code", "cursor", "claude-code"],
        new Set(["codex", "claude-code", "cursor"]),
        "codex",
      ),
    ).toEqual(["claude-code", "cursor", "codex"]);
  });
});
