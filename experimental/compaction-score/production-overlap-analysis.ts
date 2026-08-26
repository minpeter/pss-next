import {
  bootstrapMeanCi95,
  finiteMean,
  finiteQuantile,
  finiteRatio,
  finiteWilson95,
  sortedFiniteValues,
} from "./finite-statistics";
import { PRODUCTION_OVERLAP_COMPACTION_DEADLINE_MS } from "./production-overlap-options";
import {
  assertPairedObservation,
  assertPairedTrial,
  type PairedRuntimeBlockObservation,
} from "./production-overlap-pair-validation";
import type {
  ProductionOverlapAggregate,
  ProductionOverlapPair,
  ProductionTurnTimestamps,
} from "./production-overlap-types";
import type {
  RuntimeBlockObservation,
  RuntimeBlockScenario,
  RuntimeBlockTrial,
} from "./runtime-block-time-metrics";

const BOOTSTRAP_ITERATIONS = 10_000;
const BOOTSTRAP_SEED = 4242;

export function productionOverlapPair(
  observation: RuntimeBlockObservation,
  trial: RuntimeBlockTrial
): ProductionOverlapPair {
  assertPairedObservation(observation);
  assertPairedTrial(trial);
  const control = timestamps(observation, "control");
  const treatment = timestamps(observation, "target");
  assertMonotonic(control);
  assertMonotonic(treatment);
  return {
    actualTurnDeltaMs: trial.actualTurnDeltaMs,
    actualUserBlockMs: trial.userBlockMs,
    candidateApplied: trial.candidateApplied,
    completionDeltaMs: trial.completionDeltaMs,
    control,
    decisionDeltaMs: trial.gateDeltaMs,
    dispatchBlockMs: trial.dispatchBlockMs,
    dispatchDeltaMs: trial.targetRequestMs - trial.controlRequestMs,
    order: trial.pairOrder,
    overlapAtProviderStart: trial.overlapAtProviderStart,
    pathValid: trial.pathValid,
    repetition: trial.repetition,
    scenario: trial.scenario,
    summarySpans: observation.summarySpans,
    treatment,
    zeroBlock: trial.zeroBlock,
  };
}

export function aggregateProductionOverlap(
  scenario: RuntimeBlockScenario,
  pairs: readonly ProductionOverlapPair[]
): ProductionOverlapAggregate {
  const matching = pairs.filter((pair) => pair.scenario === scenario);
  if (matching.length === 0) {
    throw new TypeError(`No production overlap pairs for ${scenario}.`);
  }
  return {
    actualUserBlockMs: distribution(
      matching.map((pair) => pair.actualUserBlockMs),
      scenario,
      "user"
    ),
    candidateApplied: rate(
      matching.filter((pair) => pair.candidateApplied).length,
      matching.length
    ),
    completionDeltaMs: distribution(
      matching.map((pair) => pair.completionDeltaMs),
      scenario,
      "completion"
    ),
    decisionDeltaMs: distribution(
      matching.map((pair) => pair.decisionDeltaMs),
      scenario,
      "decision"
    ),
    dispatchBlockMs: distribution(
      matching.map((pair) => pair.dispatchBlockMs),
      scenario,
      "dispatch"
    ),
    overlap: rate(
      matching.filter((pair) => pair.overlapAtProviderStart).length,
      matching.length
    ),
    pathValid: rate(
      matching.filter((pair) => pair.pathValid).length,
      matching.length
    ),
    scenario,
    validPairs: matching.length,
    zeroBlock: rate(
      matching.filter((pair) => pair.zeroBlock).length,
      matching.length
    ),
  };
}

export const productionOverlapMethodology = {
  bootstrapIterations: BOOTSTRAP_ITERATIONS,
  bootstrapSeed: BOOTSTRAP_SEED,
  compactionDeadlineMs: PRODUCTION_OVERLAP_COMPACTION_DEADLINE_MS,
  decisionDelta: "treatment-context-gate-vs-control-no-gate",
  pairedModelClient: "shared-sequential",
  pathValidityDenominator: "completed-pairs",
  primaryUserBlock: "paired-first-visible-delta-clamped-at-zero",
  rateInterval: "wilson-95",
} as const;

function timestamps(
  observation: PairedRuntimeBlockObservation,
  arm: "control" | "target"
): ProductionTurnTimestamps {
  return arm === "control"
    ? {
        firstVisibleAtMs: observation.controlFirstVisibleAtMs,
        providerStartedAtMs: observation.controlProviderStartedAtMs,
        sentAtMs: observation.controlSentAtMs,
        stepStartedAtMs: observation.controlStepStartedAtMs,
        turnEndedAtMs: observation.controlTurnEndedAtMs,
        turnStartedAtMs: observation.controlTurnStartedAtMs,
      }
    : {
        firstVisibleAtMs: observation.targetFirstVisibleAtMs,
        providerStartedAtMs: observation.targetProviderStartedAtMs,
        sentAtMs: observation.targetSentAtMs,
        stepStartedAtMs: observation.targetStepStartedAtMs,
        turnEndedAtMs: observation.targetTurnEndedAtMs,
        turnStartedAtMs: observation.targetTurnStartedAtMs,
      };
}

function assertMonotonic(value: ProductionTurnTimestamps): void {
  const ordered = [
    value.sentAtMs,
    value.turnStartedAtMs,
    value.stepStartedAtMs,
    value.providerStartedAtMs,
    value.firstVisibleAtMs,
    value.turnEndedAtMs,
  ];
  if (
    ordered.some((item, index) => {
      const previous = ordered[index - 1];
      return previous !== undefined && item < previous;
    })
  ) {
    throw new TypeError("Production overlap timestamps are not monotonic.");
  }
}

function distribution(
  values: readonly number[],
  scenario: string,
  metric: string
): ProductionOverlapAggregate["actualUserBlockMs"] {
  const sorted = sortedFiniteValues(values);
  const maximum = sorted.at(-1);
  if (maximum === undefined) {
    throw new RangeError("Production overlap distribution is empty.");
  }
  return {
    max: maximum,
    mean: finiteMean(values),
    meanCi95: bootstrapMeanCi95(values, {
      iterations: BOOTSTRAP_ITERATIONS,
      random: seededRandom(`${BOOTSTRAP_SEED}:${scenario}:${metric}`),
    }),
    p50: finiteQuantile(sorted, 0.5),
    p95: finiteQuantile(sorted, 0.95),
  };
}

function rate(
  correct: number,
  total: number
): {
  readonly rate: number;
  readonly wilson95: readonly [number, number];
} {
  return {
    rate: finiteRatio(correct, total),
    wilson95: finiteWilson95(correct, total),
  };
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
