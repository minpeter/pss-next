import { describe, expect, it } from "vitest";
import type { FixtureQuestion } from "./fixture";
import { scoreAnswers } from "./scorer";

const FULL_CONTROL_ERROR = /full-context control/i;

const question = (
  category: FixtureQuestion["category"],
  answer: string,
  text: string
): FixtureQuestion => ({ answer, category, question: text });

describe("scoreAnswers", () => {
  it("reports compacted accuracy separately from the full-context control", () => {
    const first = question("exact-recall", "alpha", "first?");
    const second = question("tool-history", "beta", "second?");

    const result = scoreAnswers(
      [first, second],
      new Map([
        [first, "alpha"],
        [second, "beta"],
      ]),
      new Map([
        [first, "alpha"],
        [second, "unknown"],
      ])
    );

    expect(result.arms.full.overall).toEqual({ correct: 2, total: 2 });
    expect(result.arms.compacted.overall).toEqual({ correct: 1, total: 2 });
    expect(result.headline).toEqual({ correct: 1, total: 2 });
  });

  it("invalidates a run when the full-context control is not perfect", () => {
    const first = question("exact-recall", "alpha", "first?");

    expect(() =>
      scoreAnswers(
        [first],
        new Map([[first, "unknown"]]),
        new Map([[first, "alpha"]])
      )
    ).toThrow(FULL_CONTROL_ERROR);
  });

  it("normalizes whitespace, case, and trailing periods", () => {
    const first = question("task-continuation", "Next Action", "next?");

    expect(
      scoreAnswers(
        [first],
        new Map([[first, " next   action. "]]),
        new Map([[first, "NEXT ACTION..."]])
      ).headline
    ).toEqual({ correct: 1, total: 1 });
  });
});
