import { describe, expect, it, vi } from "vitest";
import { SessionSelectorComponent } from "./session-selector";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const DOWN_ARROW = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

const sessions = [
  {
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/work",
    key: "cwd:/work#current",
    name: "main",
    updatedAt: "2026-01-03T00:00:00.000Z",
  },
  {
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/work",
    key: "cwd:/work#spike",
    name: "parser spike",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

const createSelector = () => {
  const onCancel = vi.fn();
  const onSelect = vi.fn();
  const selector = new SessionSelectorComponent({
    currentSessionKey: "cwd:/work#current",
    onCancel,
    onSelect,
    sessions,
  });
  const text = () =>
    selector
      .render(80)
      .map((line) => line.replace(ANSI_PATTERN, ""))
      .join("\n");
  return { onCancel, onSelect, selector, text };
};

describe("SessionSelectorComponent", () => {
  it("shows the current session first with name and key", () => {
    const { text } = createSelector();
    expect(text()).toContain("→ main ✓");
    expect(text()).toContain("cwd:/work#current");
  });

  it("filters by session name and selects with enter", () => {
    const { onSelect, selector, text } = createSelector();
    for (const char of "spike") {
      selector.handleInput(char);
    }
    expect(text()).toContain("→ parser spike");
    selector.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith("cwd:/work#spike");
  });

  it("moves with arrows and cancels with escape", () => {
    const { onCancel, onSelect, selector } = createSelector();
    selector.handleInput(DOWN_ARROW);
    selector.handleInput(ESCAPE);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
