import { describe, expect, it } from "vitest";
import { type CompactionFixture, validateCompactionFixture } from "./fixture";

describe("validateCompactionFixture", () => {
  it("rejects a fixture with no questions", () => {
    // Given
    const fixture: CompactionFixture = {
      compactionEnds: [1],
      messages: [
        { content: "before", role: "assistant" },
        { content: "after", role: "user" },
      ],
      questions: [],
      scenario: "baseline",
    };

    // When
    const result = () => validateCompactionFixture(fixture);

    // Then
    expect(result).toThrow(TypeError);
  });
});
