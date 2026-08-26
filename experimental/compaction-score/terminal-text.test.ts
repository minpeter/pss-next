import { describe, expect, it } from "vitest";
import { renderComparisonMarkdown } from "./comparison-report";
import { isBoundedTerminalText } from "./terminal-text";

const arm = {
  compressionMean: null,
  invalid: 0,
  retained: 0,
  semanticRetained: 0,
  total: 0,
  valid: 0,
};

function artifact(model: string, status = "valid") {
  return {
    aggregate: { overall: { pi: arm, pss: arm } },
    model,
    rows: [{ pi: { status: "valid" }, pss: { status } }],
  };
}

describe("bounded terminal text UTF-16 admission", () => {
  it.each([
    ["lone high surrogate", "x\ud800y"],
    ["lone low surrogate", "x\udc00y"],
    ["reversed surrogate pair", "x\udc00\ud800y"],
    [
      "trailing high surrogate at the length boundary",
      `${"x".repeat(255)}\ud800`,
    ],
  ])("rejects a %s", (_name, value) => {
    // Given / When
    const accepted = isBoundedTerminalText(value, 256);

    // Then
    expect(accepted).toBe(false);
  });

  it.each(["提供者/café/🙂", "x\ud83d\ude42y"])(
    "preserves well-formed Unicode %#",
    (value) => {
      // Given / When
      const accepted = isBoundedTerminalText(value, 256);

      // Then
      expect(accepted).toBe(true);
    }
  );

  it("rejects overlong input before it can reach a renderer", () => {
    // Given
    const value = `${"x".repeat(1_000_000)}\ud800`;

    // When
    const accepted = isBoundedTerminalText(value, 256);

    // Then
    expect(accepted).toBe(false);
  });

  it.each([
    ["model", artifact("safe`|<model>\ud800")],
    ["status", artifact("safe-model", "valid\udc00")],
  ])("rejects a malformed %s before Markdown rendering", (_name, value) => {
    // Given / When
    const render = () => renderComparisonMarkdown(value);

    // Then
    expect(render).toThrow();
  });

  it("preserves valid astral, HTML, backtick, and pipe interactions", () => {
    // Given
    const value = artifact("模型🙂`|<model>");

    // When
    const markdown = renderComparisonMarkdown(value);

    // Then
    expect(markdown).toContain("模型🙂`|<model>");
  });
});
