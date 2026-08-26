import {
  deadlineFullPareto,
  deadlineHistoricalPareto,
} from "./deadline-sweep-pareto";
import {
  auditDeadlineArm,
  deadlinePairedComparisons,
  deadlineScenarioAggregate,
} from "./deadline-sweep-statistics";
import {
  DEADLINE_SWEEP_SCENARIOS,
  type DeadlineArm,
  type DeadlineHistoricalEvidence,
  type DeadlineSweepReport,
} from "./deadline-sweep-types";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";

const REQUIRED_DEADLINES = [5000, 10_000, 15_000, 20_000] as const;

export function createDeadlineSweepReport(
  arms: readonly DeadlineArm[],
  historical: DeadlineHistoricalEvidence | null
): DeadlineSweepReport {
  const ordered = [...arms].sort(
    (left, right) => left.deadlineMs - right.deadlineMs
  );
  validateCampaign(ordered, historical);
  const first = ordered[0];
  if (first === undefined) {
    throw new TypeError("Deadline sweep requires matched 5s/10s/15s/20s arms.");
  }
  const scenarios = scenarioNames(ordered);
  const aggregates = Object.fromEntries(
    scenarios.map((scenario) => [
      scenario,
      Object.fromEntries(
        ordered.map((arm) => [
          String(arm.deadlineMs),
          deadlineScenarioAggregate(arm, scenario),
        ])
      ),
    ])
  );
  return {
    arms: Object.fromEntries(
      ordered.map((arm) => [String(arm.deadlineMs), auditDeadlineArm(arm)])
    ),
    createdAt: new Date().toISOString(),
    deadlinesMs: ordered.map((arm) => arm.deadlineMs),
    historical,
    historicalPareto: deadlineHistoricalPareto(
      aggregates,
      historical,
      scenarios
    ),
    inputEvidence: null,
    methodology: {
      bootstrapIterations: 10_000,
      bootstrapSeed: 15_081,
      pairedResampling: "whole-scenario-repetition-cells",
      rateInterval: "wilson-95",
    },
    mode: first.mode,
    model: first.model,
    paired: deadlinePairedComparisons(ordered, scenarios),
    pareto: deadlineFullPareto(aggregates, scenarios),
    scenarios: aggregates,
    schemaVersion: "deadline-sweep-v1",
  };
}

function validateCampaign(
  arms: readonly DeadlineArm[],
  historical: DeadlineHistoricalEvidence | null
): void {
  if (
    arms.length !== REQUIRED_DEADLINES.length ||
    arms.some((arm, index) => arm.deadlineMs !== REQUIRED_DEADLINES[index]) ||
    new Set(arms.map((arm) => arm.model)).size !== 1 ||
    new Set(arms.map((arm) => arm.mode)).size !== 1
  ) {
    throw new TypeError("Deadline sweep requires matched 5s/10s/15s/20s arms.");
  }
  if (
    arms[0]?.mode === "live" &&
    (historical === null || historical.model !== arms[0].model)
  ) {
    throw new TypeError(
      "Live deadline sweep requires model-matched historical evidence."
    );
  }
}

function scenarioNames(
  arms: readonly DeadlineArm[]
): readonly RuntimeBlockScenario[] {
  return DEADLINE_SWEEP_SCENARIOS.filter((scenario) =>
    arms.every((arm) =>
      arm.attempts.some((attempt) => attempt.scenario === scenario)
    )
  );
}
