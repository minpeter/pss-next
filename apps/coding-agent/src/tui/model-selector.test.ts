import { describe, expect, it, vi } from "vitest";
import { ModelSelectorComponent } from "./model-selector";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const DOWN_ARROW = "\x1b[B";
const UP_ARROW = "\x1b[A";
const ENTER = "\r";
const ESCAPE = "\x1b";

const createSelector = (overrides?: {
  currentModelId?: string;
  modelIds?: string[];
}) => {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const selector = new ModelSelectorComponent({
    currentModelId: overrides?.currentModelId ?? "model-b",
    modelIds: overrides?.modelIds ?? ["model-a", "model-b", "model-c"],
    onCancel,
    onSelect,
  });
  const plainLines = () =>
    selector.render(60).map((line) => line.replace(ANSI_PATTERN, ""));
  return { onCancel, onSelect, plainLines, selector };
};

describe("ModelSelectorComponent", () => {
  it("lists the current model first, marked and selected", () => {
    const { plainLines } = createSelector();
    const lines = plainLines();

    const currentLine = lines.find((line) => line.includes("→"));
    expect(currentLine).toContain("→ model-b ✓");
  });

  it("moves the selection with arrow keys and wraps around", () => {
    const { onSelect, plainLines, selector } = createSelector();

    selector.handleInput(DOWN_ARROW);
    expect(plainLines().find((line) => line.includes("→"))).toContain(
      "model-a"
    );

    // Wrap: current order is [model-b, model-a, model-c]; two ups from
    // index 1 land on the last item.
    selector.handleInput(UP_ARROW);
    selector.handleInput(UP_ARROW);
    expect(plainLines().find((line) => line.includes("→"))).toContain(
      "model-c"
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("confirms the highlighted model with Enter", () => {
    const { onSelect, selector } = createSelector();

    selector.handleInput(DOWN_ARROW);
    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("model-a");
  });

  it("cancels with Escape without selecting", () => {
    const { onCancel, onSelect, selector } = createSelector();

    selector.handleInput(ESCAPE);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("filters with typed text and selects the top match", () => {
    const { onSelect, plainLines, selector } = createSelector({
      currentModelId: "gpt-5",
      modelIds: ["gpt-5", "claude-sonnet-4", "deepseek-v4-flash-free"],
    });

    for (const char of "deepseek") {
      selector.handleInput(char);
    }
    const lines = plainLines();
    expect(lines.find((line) => line.includes("→"))).toContain(
      "deepseek-v4-flash-free"
    );
    expect(lines.join("\n")).not.toContain("claude-sonnet-4");

    selector.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith("deepseek-v4-flash-free");
  });

  it("shows a no-match hint instead of selecting when the filter is empty", () => {
    const { onSelect, plainLines, selector } = createSelector();

    for (const char of "zzz") {
      selector.handleInput(char);
    }
    expect(plainLines().join("\n")).toContain("No matching models");

    selector.handleInput(ENTER);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("windows long catalogs and shows a scroll indicator", () => {
    const modelIds = Array.from({ length: 30 }, (_, i) => `model-${i}`);
    const { plainLines } = createSelector({
      currentModelId: "model-0",
      modelIds,
    });

    const rendered = plainLines().join("\n");
    expect(rendered).toContain("(1/30)");
    expect(rendered).not.toContain("model-29");
  });

  it("renders untrusted model ids as terminal-safe text", () => {
    const maliciousId = "model\x1b]52;c;not-a-clipboard\x07";
    const { plainLines } = createSelector({
      currentModelId: maliciousId,
      modelIds: [maliciousId],
    });

    const rendered = plainLines().join("\n");
    expect(rendered).not.toContain("\x1b]52");
    expect(rendered).toContain("model^[]52;c;not-a-clipboard^G");
  });

  it("settles only once", () => {
    const { onCancel, onSelect, selector } = createSelector();

    selector.handleInput(ENTER);
    selector.handleInput(ENTER);
    selector.handleInput(ESCAPE);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
