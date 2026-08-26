import { describe, expect, it } from "vitest";
import { createTuiErrorPresentation } from "./error-presentation";

const COMPLETE_C1_ESCAPES = /^(?:\\u0085)*$/;

describe("createTuiErrorPresentation output bounds", () => {
  it("caps expanded terminal escapes without splitting an escape token", () => {
    // Given
    const presentation = {
      message: "\u0085".repeat(4096),
      title: "safe",
    };

    // When
    const result = createTuiErrorPresentation(presentation);

    // Then
    expect(result.message.length).toBeLessThanOrEqual(4096);
    expect(result.message).toMatch(COMPLETE_C1_ESCAPES);
  });

  it("preserves complete ordinary Unicode code points at the output bound", () => {
    // Given
    const title = "😀".repeat(64);

    // When
    const result = createTuiErrorPresentation({ message: "safe", title });

    // Then
    expect(result.title).toBe(title);
    expect(result.title.length).toBe(128);
  });
});
