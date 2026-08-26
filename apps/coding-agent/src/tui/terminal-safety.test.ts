import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "./terminal-safety";

describe("sanitizeTerminalText", () => {
  it("removes every terminal-active Unicode category", () => {
    // Given
    const input = "a\u0000b\u009bc\u202ed\u2066e\u2028f\u2029g\u{e0001}h";

    // When
    const result = sanitizeTerminalText(input, input.length);

    // Then
    expect(result).toBe("a^@b\\u009bcdefgh");
  });

  it("preserves normal Unicode and CJK text", () => {
    // Given
    const input = "Hello, 世界 😀 café";

    // When
    const result = sanitizeTerminalText(input);

    // Then
    expect(result).toBe(input);
  });

  it("bounds input before scanning without emitting a partial surrogate", () => {
    // Given
    const input = `safe😀${"x".repeat(10_000)}`;

    // When
    const result = sanitizeTerminalText(input, 5);

    // Then
    expect(result).toBe("safe");
  });

  it("removes malformed surrogate code units", () => {
    // Given
    const input = "a\ud800b\udc00c";

    // When
    const result = sanitizeTerminalText(input);

    // Then
    expect(result).toBe("abc");
  });
});
