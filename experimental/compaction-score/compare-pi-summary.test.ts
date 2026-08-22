import { describe, expect, it } from "vitest";
import { assemblePiSummary } from "./compare-pi";

describe("pi summary assembly", () => {
  it("caps the assembled summary when provider output exceeds the character budget", () => {
    // Given
    const maxCharacters = 4 * Math.floor(0.8 * 16_384);
    const providerSummary = "x".repeat(maxCharacters + 1);
    const fileOperations = {
      edited: new Set(["src/changed.ts"]),
      read: new Set<string>(),
    };

    // When
    const summary = assemblePiSummary(providerSummary, fileOperations);

    // Then
    expect(summary).toHaveLength(maxCharacters);
  });
});
