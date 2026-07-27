import { describe, expect, it, vi } from "vitest";
import { boundedLcsMatches } from "./bounded-lcs";
import { parseDiffSection, renderDiffGroup } from "./diff";
import { markChangedTokens } from "./highlight";

const padding = (prefix: string): string[] =>
  Array.from({ length: 254 }, (_, index) => `${prefix}-${index}`);

describe("bounded diff alignment", () => {
  it.each([
    {
      emptySide: "right",
      left: new Array<string>(65_537).fill("removed"),
      right: [],
    },
    {
      emptySide: "left",
      left: [],
      right: new Array<string>(65_537).fill("added"),
    },
  ])(
    "avoids matrix allocation when $emptySide side is empty",
    ({ left, right }) => {
      // Given
      const arrayFrom = vi.spyOn(Array, "from");
      const callsBefore = arrayFrom.mock.calls.length;

      // When
      const matches = boundedLcsMatches(left, right);
      const allocationCount = arrayFrom.mock.calls.length - callsBefore;
      arrayFrom.mockRestore();

      // Then
      expect(matches).toEqual([]);
      expect(allocationCount).toBe(0);
    }
  );

  it("falls back to edge matching for pathological token matrices", () => {
    const shared = Array.from({ length: 20 }, (_, index) => `shared-${index}`);
    const oldTokens = [
      "prefix",
      ...shared,
      ...padding("old").slice(0, 235),
      "suffix",
    ];
    const newTokens = [
      "prefix",
      ...padding("new").slice(0, 235),
      ...shared,
      "suffix",
    ];

    const { newChanged, oldChanged } = markChangedTokens(oldTokens, newTokens);

    expect(oldChanged[1]).toBe(true);
    expect(newChanged.at(-21)).toBe(true);
  });

  it("renders moved middle lines as edits instead of allocating a full matrix", () => {
    const removed = ["prefix", "moved", ...padding("old"), "suffix"];
    const added = ["prefix", ...padding("new"), "moved", "suffix"];
    const output = [
      "diff:",
      "@@ edit 1",
      ...removed.map((text, index) => `-${index + 1}|${text}`),
      ...added.map((text, index) => `+${index + 1}|${text}`),
    ].join("\n");
    const [group] = parseDiffSection(output) ?? [];

    expect(group).toBeDefined();
    const rendered = renderDiffGroup(group ?? []);
    expect(rendered.match(/moved/g)).toHaveLength(2);
  });

  it("orders paired edits by final-side line positions", () => {
    const [group] =
      parseDiffSection(
        [
          "diff:",
          "@@ edit 1",
          "-10|old value",
          "-11|keep",
          "+2|new value",
          "+3|keep",
        ].join("\n")
      ) ?? [];

    const rendered = renderDiffGroup(group ?? []);
    expect(rendered.indexOf("old value")).toBeLessThan(
      rendered.indexOf("keep")
    );
  });
});
