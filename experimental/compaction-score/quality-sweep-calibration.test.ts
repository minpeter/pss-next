import { describe, expect, it } from "vitest";
import { qualityCalibrationItems } from "./quality-sweep-calibration";
import { buildScenarioFixture } from "./scenario-fixtures";

describe("quality sweep calibration sampling", () => {
  it("falls back to the nearest captured budget when 4096 is unavailable", () => {
    const fixture = buildScenarioFixture("baseline", "fallback-seed");
    const answers = fixture.questions.map((question) => question.answer);
    const items = qualityCalibrationItems(
      [
        {
          arm: "pss",
          budget: 2048,
          compressionRatio: 0.25,
          controlCorrect: fixture.questions.length,
          controlPassed: true,
          controlTotal: fixture.questions.length,
          correct: fixture.questions.length,
          costUsd: null,
          evaluationAnswers: { compacted: answers, full: answers },
          fixtureSeed: "fallback-seed",
          latencyMs: 10,
          repetition: 1,
          scenario: "baseline",
          sentOutputTokens: [2048],
          summarizerInputTokens: 8192,
          summaryTokens: 2048,
          total: fixture.questions.length,
          valid: true,
        },
      ],
      "live"
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.scenario).toContain("baseline:pss:b2048");
    expect(items[0]?.questions).toHaveLength(1);
  });
});
