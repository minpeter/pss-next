import { describe, expect, it } from "vitest";
import { similarity } from "./matchers";

describe("similarity", () => {
  it("preserves long-comparison scores while using bounded matrix storage", () => {
    const length = 2048;
    const expected = "a".repeat(length);
    const actual = `${"a".repeat(length - 1)}b`;

    const result = similarity(expected).score(actual);

    expect(result.score).toBeCloseTo(1 - 1 / length, 12);
    expect(result.pass).toBe(false);
  });
});
