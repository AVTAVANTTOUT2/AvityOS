import { describe, expect, it } from "vitest";
import {
  expectedArtifactPathIssue,
  normalizeLegacyExpectedArtifactReference,
} from "./artifact-reference.js";

describe("expected artifact references", () => {
  it("accepts exact portable repository-relative file paths", () => {
    expect(expectedArtifactPathIssue("src/features/incident.ts")).toBeNull();
    expect(expectedArtifactPathIssue("README.md")).toBeNull();
  });

  it("rejects prose labels, globs and unsafe paths in new plans", () => {
    expect(expectedArtifactPathIssue("Modified src/incident.ts")).toContain(
      "without a status label",
    );
    expect(expectedArtifactPathIssue("`src/incident.ts`")).toContain(
      "without a status label",
    );
    expect(expectedArtifactPathIssue("src/**")).toContain("not a glob");
    expect(expectedArtifactPathIssue("../secret.txt")).toContain(
      "parent-directory",
    );
    expect(expectedArtifactPathIssue("/tmp/result.txt")).toContain(
      "repository-relative",
    );
  });

  it("normalizes only bounded legacy status labels for persisted plans", () => {
    expect(
      normalizeLegacyExpectedArtifactReference("Modified src/incident.ts"),
    ).toBe("src/incident.ts");
    expect(
      normalizeLegacyExpectedArtifactReference("Created: `README.md`"),
    ).toBe("README.md");
    expect(
      normalizeLegacyExpectedArtifactReference("reports/Modified summary.md"),
    ).toBe("reports/Modified summary.md");
  });
});
