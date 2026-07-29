import { visibleWidth } from "@earendil-works/pi-tui";
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
  it("shows each session as one compact line", () => {
    const { text } = createSelector();
    const rendered = text();
    expect(rendered).toContain(
      "→ main · #current  updated 2026-01-03T00:00:00.000Z ✓"
    );
    expect(rendered).toContain(
      "parser spike · #spike  updated 2026-01-02T00:00:00.000Z"
    );
    expect(rendered).not.toContain("cwd:/work");
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

  it("starts filtered from an initial query", () => {
    const onSelect = vi.fn();
    const selector = new SessionSelectorComponent({
      currentSessionKey: "cwd:/work#current",
      initialQuery: "spike",
      onCancel: vi.fn(),
      onSelect,
      sessions,
    });
    const rendered = selector
      .render(80)
      .map((line) => line.replace(ANSI_PATTERN, ""))
      .join("\n");
    expect(rendered).toContain("→ parser spike");
    expect(rendered).not.toContain("main ✓");
    selector.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith("cwd:/work#spike");
  });

  it("does not match queries against the shared cwd prefix", () => {
    const selector = new SessionSelectorComponent({
      currentSessionKey: "cwd:/home/minpeter/project#aaaaaaaa",
      initialQuery: "m",
      onCancel: vi.fn(),
      onSelect: vi.fn(),
      sessions: [
        {
          createdAt: "",
          cwd: "/home/minpeter/project",
          key: "cwd:/home/minpeter/project#aaaaaaaa",
          name: "main",
          updatedAt: "2026-07-29",
        },
        {
          createdAt: "",
          cwd: "/home/minpeter/project",
          key: "cwd:/home/minpeter/project#bbbbbbbb",
          updatedAt: "2026-07-28",
        },
        {
          createdAt: "",
          cwd: "/home/minpeter/project",
          key: "cwd:/home/minpeter/project",
          updatedAt: "2026-07-27",
        },
      ],
    });
    const rendered = selector
      .render(80)
      .map((line) => line.replace(ANSI_PATTERN, ""))
      .join("\n");
    expect(rendered).toContain("→ main · #aaaaaaaa  updated 2026-07-29 ✓");
    expect(rendered).not.toContain("#bbbbbbbb");
    expect(rendered).not.toContain("2026-07-27");
  });

  it("moves with arrows and cancels with escape", () => {
    const { onCancel, onSelect, selector } = createSelector();
    selector.handleInput(DOWN_ARROW);
    selector.handleInput(ESCAPE);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps every rendered line within narrow terminal bounds", () => {
    const { selector } = createSelector();
    const lines = selector.render(40);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(
      lines.filter((line) =>
        line.replace(ANSI_PATTERN, "").includes("Resume a session")
      )
    ).toHaveLength(1);
  });
});
