import type {
  RuntimeBlockAggregate,
  RuntimeBlockScenario,
  RuntimeBlockTrial,
} from "./runtime-block-time-types";

export function aggregateRuntimeBlockTrials(
  scenario: RuntimeBlockScenario,
  trials: readonly RuntimeBlockTrial[]
): RuntimeBlockAggregate {
  const matching = trials.filter((trial) => trial.scenario === scenario);
  if (matching.length === 0) {
    throw new TypeError(`No runtime block-time trials for ${scenario}.`);
  }
  const blocks = matching.map((trial) => trial.userBlockMs);
  return {
    blockAvoidanceRatioMean: mean(
      matching.map((trial) => trial.blockAvoidanceRatio)
    ),
    candidateAppliedRate:
      matching.filter((trial) => trial.candidateApplied).length /
      matching.length,
    gateDeltaMeanMs: mean(matching.map((trial) => trial.gateDeltaMs)),
    overlapRate:
      matching.filter((trial) => trial.overlapAtProviderStart).length /
      matching.length,
    preStepDeltaMeanMs: mean(matching.map((trial) => trial.preStepDeltaMs)),
    scenario,
    summaryCallsMean: mean(matching.map((trial) => trial.summaryCalls)),
    summaryServiceMeanMs: mean(matching.map((trial) => trial.summaryServiceMs)),
    trials: matching.length,
    userBlockMaxMs: blocks.reduce(
      (maximum, block) => Math.max(maximum, block),
      Number.NEGATIVE_INFINITY
    ),
    userBlockMeanMs: mean(blocks),
    userBlockP50Ms: quantile(blocks, 0.5),
    userBlockP95Ms: quantile(blocks, 0.95),
    userDeltaMeanMs: mean(matching.map((trial) => trial.userDeltaMs)),
    zeroBlockRate:
      matching.filter((trial) => trial.zeroBlock).length / matching.length,
  };
}

export function elapsed(endedAtMs: number, startedAtMs: number): number {
  return Math.max(0, finiteDifference(endedAtMs, startedAtMs));
}

export function finiteDifference(minuend: number, subtrahend: number): number {
  if (!(Number.isFinite(minuend) && Number.isFinite(subtrahend))) {
    throw new TypeError(
      "Cannot derive a non-finite runtime block-time measurement."
    );
  }
  if (subtrahend < 0 && minuend > Number.MAX_VALUE + subtrahend) {
    return Number.MAX_VALUE;
  }
  if (subtrahend > 0 && minuend < -Number.MAX_VALUE + subtrahend) {
    return -Number.MAX_VALUE;
  }
  return minuend - subtrahend;
}

export function sum(values: readonly number[]): number {
  return boundedSum(values, 1).value;
}

function mean(values: readonly number[]): number {
  const result = boundedSum(values, 1);
  return result.overflowed
    ? boundedSum(values, values.length).value
    : result.value / values.length;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) {
    throw new TypeError("Cannot summarize an empty distribution.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = sorted[Math.floor(index)];
  const upper = sorted[Math.ceil(index)];
  if (lower === undefined || upper === undefined) {
    throw new TypeError("Cannot summarize an empty distribution.");
  }
  return lower + (upper - lower) * (index - Math.floor(index));
}

function boundedSum(
  values: readonly number[],
  divisor: number
): { readonly overflowed: boolean; readonly value: number } {
  let overflowed = false;
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot summarize a non-finite measurement.");
    }
    const scaled = value / divisor;
    if (scaled > 0 && total > Number.MAX_VALUE - scaled) {
      overflowed = true;
      total = Number.MAX_VALUE;
    } else if (scaled < 0 && total < -Number.MAX_VALUE - scaled) {
      overflowed = true;
      total = -Number.MAX_VALUE;
    } else {
      total += scaled;
    }
  }
  return { overflowed, value: total };
}
