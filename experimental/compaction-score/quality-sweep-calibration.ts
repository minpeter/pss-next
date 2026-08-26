import type { CompactionFixture } from "./fixture";
import { buildHoldoutFixture } from "./holdout-fixtures";
import type {
  CalibrationItem,
  QualitySweepMode,
  QualitySweepObservation,
} from "./quality-sweep-types";
import { buildScenarioFixture } from "./scenario-fixtures";

const SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
  "holdout-json",
  "holdout-cjk",
  "holdout-log",
] as const;
const CALIBRATION_BUDGET_PREFERENCE = [4096, 2048, 8192, 13_107] as const;

export function qualityCalibrationItems(
  observations: readonly QualitySweepObservation[],
  mode: QualitySweepMode
): readonly CalibrationItem[] {
  if (mode === "deterministic") {
    return sourceCalibrationItems();
  }
  const selected = new Map<string, QualitySweepObservation>();
  for (const budget of CALIBRATION_BUDGET_PREFERENCE) {
    for (const observation of observations) {
      if (
        observation.budget === budget &&
        observation.valid &&
        observation.evaluationAnswers !== undefined
      ) {
        const key = `${observation.arm}:${observation.scenario}`;
        if (!selected.has(key)) {
          selected.set(key, observation);
        }
      }
    }
  }
  return [...selected.values()].flatMap(candidateCalibrationItems);
}

function candidateCalibrationItems(
  observation: QualitySweepObservation
): readonly CalibrationItem[] {
  const scenario = SCENARIOS.find(
    (candidate) => candidate === observation.scenario
  );
  if (scenario === undefined || observation.evaluationAnswers === undefined) {
    return [];
  }
  const fixture = buildFixture(scenario, observation.fixtureSeed);
  const answers = observation.evaluationAnswers;
  if (
    answers.full.length !== fixture.questions.length ||
    answers.compacted.length !== fixture.questions.length
  ) {
    throw new TypeError("Quality sweep evaluation answer count mismatch.");
  }
  const question = fixture.questions[0];
  if (question === undefined) {
    throw new TypeError("Quality sweep calibration fixture is empty.");
  }
  return [
    {
      compactedAnswer: answers.compacted[0] ?? "",
      fullAnswer: answers.full[0] ?? "",
      messages: fixture.messages,
      questions: [question],
      scenario: `${scenario}:${observation.arm}:b${observation.budget}:r${observation.repetition}:q0`,
      seed: observation.fixtureSeed,
    },
  ];
}

function sourceCalibrationItems(): readonly CalibrationItem[] {
  return SCENARIOS.map((scenario) => {
    const seed = `quality-sweep-${scenario}-calibration`;
    const fixture = buildFixture(scenario, seed);
    return {
      messages: fixture.messages,
      questions: fixture.questions,
      scenario,
      seed,
    };
  });
}

function buildFixture(
  scenario: (typeof SCENARIOS)[number],
  seed: string
): CompactionFixture {
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
  throw new TypeError(`Unsupported quality calibration scenario: ${value}`);
}
