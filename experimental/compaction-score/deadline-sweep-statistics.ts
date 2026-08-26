import type {
  DeadlineArm,
  DeadlineArmAudit,
  DeadlineArmTrial,
  DeadlineDistribution,
  DeadlinePairedComparison,
  DeadlineRate,
  DeadlineScenarioAggregate,
} from "./deadline-sweep-types";
import {
  bootstrapMeanCi95,
  finiteMean,
  finiteQuantile,
  finiteRatio,
  finiteWilson95,
  requireFinite,
  sortedFiniteValues,
} from "./finite-statistics";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";

const BOOTSTRAP_ITERATIONS = 10_000;
const BOOTSTRAP_SEED = 15_081;

export function deadlineScenarioAggregate(
  arm: DeadlineArm,
  scenario: RuntimeBlockScenario
): DeadlineScenarioAggregate {
  const attempts = arm.attempts.filter(
    (attempt) => attempt.scenario === scenario
  );
  const trials = arm.trials.filter((trial) => trial.scenario === scenario);
  const timeouts = trials.filter((trial) => trial.outcome === "timeout");
  return {
    attemptErrors: attempts.filter((attempt) => attempt.status !== "completed")
      .length,
    attempts: attempts.length,
    candidateApplied: rate(
      trials.filter((trial) => trial.candidateApplied).length,
      trials.length
    ),
    completed: trials.length,
    decisionLatencyMs:
      trials.length === 0
        ? emptyDistribution()
        : distribution(
            trials.map((trial) => trial.decisionLatencyMs),
            `${arm.deadlineMs}:${scenario}`
          ),
    pathValid: rate(
      trials.filter((trial) => trial.pathValid === true).length,
      trials.length
    ),
    providerStarted: rate(
      trials.filter((trial) => trial.providerStarted).length,
      trials.length
    ),
    reliability: rate(trials.length, attempts.length),
    summaryCallsMean:
      trials.length === 0
        ? 0
        : finiteMean(trials.map((trial) => trial.summaryCallsStarted)),
    timeout: rate(timeouts.length, trials.length),
    typedTimeoutIntegrity:
      timeouts.length === 0
        ? null
        : rate(timeouts.filter(isTypedTimeout).length, timeouts.length),
  };
}

function emptyDistribution(): DeadlineDistribution {
  return { max: 0, mean: 0, meanCi95: [0, 0], p95: 0 };
}

export function auditDeadlineArm(arm: DeadlineArm): DeadlineArmAudit {
  const timeouts = arm.trials.filter((trial) => trial.outcome === "timeout");
  return {
    attemptErrors: arm.attempts.filter(
      (attempt) => attempt.status !== "completed"
    ).length,
    cells: arm.attempts.length,
    completed: arm.trials.length,
    finiteLatencies: arm.trials.every(
      (trial) =>
        Number.isFinite(trial.decisionLatencyMs) && trial.decisionLatencyMs >= 0
    ),
    pathPolicy: arm.deadlineMs === 5000 ? "legacy-unverified" : "required",
    typedTimeouts: timeouts.every(isTypedTimeout),
    uniqueCells: new Set(
      arm.attempts.map((attempt) => `${attempt.scenario}:${attempt.repetition}`)
    ).size,
  };
}

export function deadlinePairedComparisons(
  arms: readonly DeadlineArm[],
  scenarios: readonly RuntimeBlockScenario[]
): readonly DeadlinePairedComparison[] {
  return arms.flatMap((from, fromIndex) =>
    arms.slice(fromIndex + 1).flatMap((to) =>
      scenarios.flatMap((scenario) => {
        const pairs = pairTrials(from, to, scenario);
        if (pairs.length === 0) {
          return [];
        }
        const deltas = pairs.map(([left, right]) =>
          requireFinite(
            right.decisionLatencyMs - left.decisionLatencyMs,
            "Deadline latency delta"
          )
        );
        return [
          {
            candidateAppliedDelta:
              finiteMean(
                pairs.map(([, trial]) => Number(trial.candidateApplied))
              ) -
              finiteMean(
                pairs.map(([trial]) => Number(trial.candidateApplied))
              ),
            fromDeadlineMs: from.deadlineMs,
            latencyDeltaMeanCi95: bootstrapMeanCi95(deltas, {
              iterations: BOOTSTRAP_ITERATIONS,
              random: seededRandom(
                `${BOOTSTRAP_SEED}:${from.deadlineMs}:${to.deadlineMs}:${scenario}`
              ),
            }),
            latencyDeltaMeanMs: finiteMean(deltas),
            pairs: pairs.length,
            providerStartedDelta:
              finiteMean(
                pairs.map(([, trial]) => Number(trial.providerStarted))
              ) -
              finiteMean(pairs.map(([trial]) => Number(trial.providerStarted))),
            scenario,
            toDeadlineMs: to.deadlineMs,
          },
        ];
      })
    )
  );
}

function pairTrials(
  left: DeadlineArm,
  right: DeadlineArm,
  scenario: RuntimeBlockScenario
): readonly (readonly [DeadlineArmTrial, DeadlineArmTrial])[] {
  const rightByRepetition = new Map(
    right.trials
      .filter((trial) => trial.scenario === scenario)
      .map((trial) => [trial.repetition, trial])
  );
  return left.trials
    .filter((trial) => trial.scenario === scenario)
    .flatMap((trial) => {
      const match = rightByRepetition.get(trial.repetition);
      if (match === undefined) {
        return [];
      }
      const pair: readonly [DeadlineArmTrial, DeadlineArmTrial] = [
        trial,
        match,
      ];
      return [pair];
    });
}

function distribution(
  values: readonly number[],
  identity: string
): DeadlineDistribution {
  const sorted = sortedFiniteValues(values);
  const maximum = sorted.at(-1);
  if (maximum === undefined) {
    throw new RangeError(`No completed deadline trials for ${identity}.`);
  }
  return {
    max: maximum,
    mean: finiteMean(values),
    meanCi95: bootstrapMeanCi95(values, {
      iterations: BOOTSTRAP_ITERATIONS,
      random: seededRandom(`${BOOTSTRAP_SEED}:${identity}`),
    }),
    p95: finiteQuantile(sorted, 0.95),
  };
}

function rate(correct: number, total: number): DeadlineRate {
  return total === 0
    ? { rate: 0, wilson95: [0, 0] }
    : {
        rate: finiteRatio(correct, total),
        wilson95: finiteWilson95(correct, total),
      };
}

function isTypedTimeout(trial: DeadlineArmTrial): boolean {
  return (
    trial.errorCategory === "timeout" &&
    trial.errorCode === "COMPACTION_DEADLINE_EXCEEDED"
  );
}

function seededRandom(seed: string): () => number {
  let state = [...seed].reduce(
    (total, character) => total + character.charCodeAt(0),
    0
  );
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}
