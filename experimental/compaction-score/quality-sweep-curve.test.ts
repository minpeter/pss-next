import { describe, expect, it } from "vitest";
import {
  budgetAtQuality,
  isotonicCurve,
  matchQualityCurves,
} from "./quality-sweep-curve";
import { observedSummaryOutputTokens } from "./quality-sweep-live";

describe("matched-quality curves", () => {
  it("records the actual output cap sent for every compaction hop", () => {
    expect(
      observedSummaryOutputTokens([
        { sentOutputTokens: 256 },
        { sentOutputTokens: 128 },
      ])
    ).toEqual([256, 128]);
  });

  it("pools non-monotone retention before inverse interpolation", () => {
    const curve = isotonicCurve([
      { budget: 100, correct: 80, total: 100 },
      { budget: 200, correct: 60, total: 100 },
      { budget: 300, correct: 90, total: 100 },
    ]);

    expect(curve.map(({ retention }) => retention)).toEqual([0.7, 0.7, 0.9]);
    expect(budgetAtQuality(curve, 0.8)).toBeCloseTo(250);
  });

  it("does not extrapolate beyond either observed quality range", () => {
    const pss = [
      { budget: 100, correct: 80, total: 100 },
      { budget: 200, correct: 90, total: 100 },
    ];
    const pi = [
      { budget: 100, correct: 70, total: 100 },
      { budget: 200, correct: 85, total: 100 },
    ];

    const matched = matchQualityCurves(pss, pi, [0.75, 0.85, 0.9]);

    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ piBudget: 200, quality: 0.85 });
    expect(matched[0]?.pssBudget).toBeCloseTo(150);
  });
});
