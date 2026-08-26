import { describe, expect, it } from "vitest";
import type { CompactionFixture } from "./fixture";
import { buildHoldoutFixture } from "./holdout-fixtures";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { buildScenarioFixture } from "./scenario-fixtures";
import { runCompactionTrial } from "./trial-runner";

const SUMMARY_MAX_OUTPUT_TOKENS = 2048;
const COMPARISON_SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
  "holdout-json",
  "holdout-cjk",
  "holdout-log",
] as const;

type ComparisonScenario = (typeof COMPARISON_SCENARIOS)[number];

function buildComparisonFixture(
  scenario: ComparisonScenario,
  seed: string
): CompactionFixture {
  switch (scenario) {
    case "holdout-json":
    case "holdout-cjk":
    case "holdout-log":
      return buildHoldoutFixture(scenario, seed);
    case "baseline":
    case "lifecycle":
    case "boundary-noise":
      return buildScenarioFixture(scenario, seed);
    default:
      throw new TypeError(`Unknown comparison scenario: ${scenario}`);
  }
}

describe("comparison fixture summary budget", () => {
  it.each(COMPARISON_SCENARIOS)(
    "sends the shared provider output budget for %s",
    async (scenario) => {
      // Given
      const fixtureSeed = `compare-pi-${scenario}-1`;
      const fixture = buildComparisonFixture(scenario, fixtureSeed);
      const calls: MockLanguageModelV4CallOptions[] = [];
      const answers = JSON.stringify({
        answers: fixture.questions.map((question, index) => ({
          answer: question.answer,
          id: `q${index}`,
        })),
      });
      const model = createMockLanguageModelV4((options) => {
        calls.push(options);
        return Promise.resolve(
          mockLanguageModelV4Text(
            calls.length <= fixture.compactionEnds.length
              ? "structured summary"
              : answers
          )
        );
      });

      // When
      const record = await runCompactionTrial({
        attempt: 1,
        fixture,
        fixtureSeed,
        id: `comparison-budget-${scenario}`,
        model,
        repetition: 1,
        summaryMaxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      });

      // Then
      expect(record.status).toBe("valid");
      expect(
        calls
          .slice(0, fixture.compactionEnds.length)
          .map(({ maxOutputTokens }) => maxOutputTokens)
      ).toEqual(
        Array.from(
          { length: fixture.compactionEnds.length },
          () => SUMMARY_MAX_OUTPUT_TOKENS
        )
      );
    }
  );
});
