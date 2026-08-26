import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildComparisonReport } from "./compare-pi-report";
import { writeComparePiReport } from "./compare-pi-storage";
import type { ArmResult, ComparisonRow } from "./compare-pi-types";
import type { CompactionFixture } from "./fixture";
import { buildHoldoutFixture } from "./holdout-fixtures";
import { qualityCalibrationItems } from "./quality-sweep-calibration";
import { runLiveQualityBudget } from "./quality-sweep-live";
import { buildScenarioFixture } from "./scenario-fixtures";

const BUDGET = 4096;
const SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
  "holdout-json",
  "holdout-cjk",
  "holdout-log",
] as const;

describe("live quality compare adapter", () => {
  it("dispatches the requested budget and consumes report evidence", async () => {
    // Given
    const outputDirectory = await mkdtemp(join(tmpdir(), "quality-live-"));
    const dispatched: string[][] = [];
    const dispatch = async (
      arguments_: readonly string[],
      budgetDirectory: string
    ): Promise<void> => {
      dispatched.push([...arguments_]);
      await mkdir(budgetDirectory, { recursive: true });
      const identity = {
        model: "quality-model",
        repetitions: 1,
        summaryMaxOutputTokens: BUDGET,
      };
      await writeComparePiReport(
        budgetDirectory,
        buildComparisonReport(SCENARIOS.map(comparisonRow), identity)
      );
    };

    try {
      // When
      const result = await runLiveQualityBudget({
        budget: BUDGET,
        dispatch,
        outputDirectory,
        repetitions: 1,
      });

      // Then
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toContain("compare-pi.ts");
      expect(dispatched[0]).toContain(String(BUDGET));
      expect(result.observations).toHaveLength(12);
      expect(
        result.observations.every(
          (observation) =>
            observation.sentOutputTokens[0] === BUDGET &&
            observation.evaluationAnswers?.full[0] !== undefined
        )
      ).toBe(true);
      expect(qualityCalibrationItems(result.observations, "live")).toHaveLength(
        12
      );
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });
});

function comparisonRow(scenario: (typeof SCENARIOS)[number]): ComparisonRow {
  const fixture = fixtureFor(scenario);
  return {
    pi: validArm(fixture),
    pss: validArm(fixture),
    repetition: 1,
    scenario,
  };
}

function validArm(fixture: CompactionFixture): ArmResult {
  const answers = fixture.questions.map((question) => question.answer);
  const total = answers.length;
  return {
    answers: { compacted: answers, full: answers },
    hops: [
      {
        compactionMs: 1,
        prefixTokens: 100,
        sentOutputTokens: BUDGET,
        summarizerInputTokens: 80,
        summaryTokens: 20,
      },
    ],
    score: {
      arms: {
        compacted: {
          overall: { correct: total, total },
          perCategory: [{ category: "exact-recall", correct: total, total }],
        },
        full: {
          overall: { correct: total, total },
          perCategory: [{ category: "exact-recall", correct: total, total }],
        },
      },
      disagreements: [],
      headline: { correct: total, total },
    },
    status: "valid",
  };
}

function fixtureFor(scenario: (typeof SCENARIOS)[number]): CompactionFixture {
  const seed = `compare-pi-${scenario}-1`;
  switch (scenario) {
    case "holdout-cjk":
    case "holdout-json":
    case "holdout-log":
      return buildHoldoutFixture(scenario, seed);
    case "baseline":
    case "boundary-noise":
    case "lifecycle":
      return buildScenarioFixture(scenario, seed);
    default:
      return assertNever(scenario);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported compare scenario: ${value}`);
}
