import { describe, expect, it } from "vitest";
import {
  enforceSummaryOutputBudget,
  estimateSummaryOutputTokens,
} from "./summary-output-budget";

describe("summary output budget enforcement", () => {
  it("hard-caps provider text with the benchmark token estimator", () => {
    const result = enforceSummaryOutputBudget(
      "alpha beta gamma delta epsilon",
      3
    );

    expect(result).toEqual({
      estimatedTokens: 3,
      text: "alpha beta g",
      truncated: true,
    });
    expect(estimateSummaryOutputTokens(result.text)).toBeLessThanOrEqual(3);
  });

  it("preserves text already within budget", () => {
    expect(enforceSummaryOutputBudget("done", 8)).toEqual({
      estimatedTokens: 1,
      text: "done",
      truncated: false,
    });
  });
});
