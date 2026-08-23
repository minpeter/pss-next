export type RuntimeBlockScenario =
  | "candidate-fit-late-hit"
  | "candidate-fit-hard-block"
  | "overlap-nonblocking"
  | "prepared-hit"
  | "repeated-failure-overflow-recovery"
  | "summary-failure-retry-hit";

export interface RuntimeSummarySpan {
  readonly endedAtMs: number;
  readonly kind: "summary";
  readonly startedAtMs: number;
  readonly status: "completed" | "error";
}

export interface RuntimeBlockObservation {
  readonly candidateApplied: boolean;
  readonly controlFirstVisibleAtMs: number;
  readonly controlProviderStartedAtMs: number;
  readonly controlSentAtMs: number;
  readonly controlStepStartedAtMs: number;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summarySpans: readonly RuntimeSummarySpan[];
  readonly targetFirstVisibleAtMs: number;
  readonly targetProviderStartedAtMs: number;
  readonly targetSentAtMs: number;
  readonly targetStepStartedAtMs: number;
}

export interface RuntimeBlockTrial {
  readonly avoidedBlockMs: number;
  readonly blockAvoidanceRatio: number;
  readonly candidateApplied: boolean;
  readonly controlPreparationMs: number;
  readonly controlProviderDispatchMs: number;
  readonly controlTtfvMs: number;
  readonly gateDeltaMs: number;
  readonly overlapAtProviderStart: boolean;
  readonly preStepDeltaMs: number;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summaryCalls: number;
  readonly summaryServiceMs: number;
  readonly treatmentPreparationMs: number;
  readonly treatmentProviderDispatchMs: number;
  readonly treatmentTtfvMs: number;
  readonly userBlockMs: number;
  readonly userDeltaMs: number;
  readonly zeroBlock: boolean;
}

export interface RuntimeBlockAggregate {
  readonly blockAvoidanceRatioMean: number;
  readonly candidateAppliedRate: number;
  readonly gateDeltaMeanMs: number;
  readonly overlapRate: number;
  readonly preStepDeltaMeanMs: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summaryCallsMean: number;
  readonly summaryServiceMeanMs: number;
  readonly trials: number;
  readonly userBlockMaxMs: number;
  readonly userBlockMeanMs: number;
  readonly userBlockP50Ms: number;
  readonly userBlockP95Ms: number;
  readonly userDeltaMeanMs: number;
  readonly zeroBlockRate: number;
}

const ZERO_BLOCK_THRESHOLD_MS = 10;

export function calculateRuntimeBlockTrial(
  observation: RuntimeBlockObservation
): RuntimeBlockTrial {
  const controlPreparationMs = elapsed(
    observation.controlProviderStartedAtMs,
    observation.controlStepStartedAtMs
  );
  const controlProviderDispatchMs = elapsed(
    observation.controlProviderStartedAtMs,
    observation.controlSentAtMs
  );
  const treatmentPreparationMs = elapsed(
    observation.targetProviderStartedAtMs,
    observation.targetStepStartedAtMs
  );
  const gateDeltaMs = finiteDifference(
    treatmentPreparationMs,
    controlPreparationMs
  );
  const treatmentProviderDispatchMs = elapsed(
    observation.targetProviderStartedAtMs,
    observation.targetSentAtMs
  );
  const controlTtfvMs = elapsed(
    observation.controlFirstVisibleAtMs,
    observation.controlSentAtMs
  );
  const treatmentTtfvMs = elapsed(
    observation.targetFirstVisibleAtMs,
    observation.targetSentAtMs
  );
  const userDeltaMs = finiteDifference(treatmentTtfvMs, controlTtfvMs);
  const userBlockMs = Math.max(0, userDeltaMs);
  const targetPreStepMs = elapsed(
    observation.targetStepStartedAtMs,
    observation.targetSentAtMs
  );
  const controlPreStepMs = elapsed(
    observation.controlStepStartedAtMs,
    observation.controlSentAtMs
  );
  const preStepDeltaMs = finiteDifference(targetPreStepMs, controlPreStepMs);
  const summaryServiceMs = sum(
    observation.summarySpans.map(({ endedAtMs, startedAtMs }) =>
      elapsed(endedAtMs, startedAtMs)
    )
  );
  const avoidedBlockMs = elapsed(summaryServiceMs, userBlockMs);
  return {
    avoidedBlockMs,
    blockAvoidanceRatio:
      summaryServiceMs === 0 ? 0 : avoidedBlockMs / summaryServiceMs,
    candidateApplied: observation.candidateApplied,
    controlPreparationMs,
    controlProviderDispatchMs,
    controlTtfvMs,
    gateDeltaMs,
    overlapAtProviderStart: observation.summarySpans.some(
      ({ endedAtMs, startedAtMs }) =>
        startedAtMs <= observation.targetProviderStartedAtMs &&
        observation.targetProviderStartedAtMs < endedAtMs
    ),
    preStepDeltaMs,
    repetition: observation.repetition,
    scenario: observation.scenario,
    summaryCalls: observation.summarySpans.length,
    summaryServiceMs,
    treatmentPreparationMs,
    treatmentProviderDispatchMs,
    treatmentTtfvMs,
    userDeltaMs,
    userBlockMs,
    zeroBlock: userBlockMs <= ZERO_BLOCK_THRESHOLD_MS,
  };
}

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
    summaryServiceMeanMs: mean(matching.map((trial) => trial.summaryServiceMs)),
    summaryCallsMean: mean(matching.map((trial) => trial.summaryCalls)),
    trials: matching.length,
    userDeltaMeanMs: mean(matching.map((trial) => trial.userDeltaMs)),
    userBlockMaxMs: blocks.reduce(
      (maximum, block) => Math.max(maximum, block),
      Number.NEGATIVE_INFINITY
    ),
    userBlockMeanMs: mean(blocks),
    userBlockP50Ms: quantile(blocks, 0.5),
    userBlockP95Ms: quantile(blocks, 0.95),
    zeroBlockRate:
      matching.filter((trial) => trial.zeroBlock).length / matching.length,
  };
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
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new TypeError("Cannot summarize an empty distribution.");
  }
  return lower + (upper - lower) * (index - lowerIndex);
}

function sum(values: readonly number[]): number {
  return boundedSum(values, 1).value;
}

function elapsed(endedAtMs: number, startedAtMs: number): number {
  return Math.max(0, finiteDifference(endedAtMs, startedAtMs));
}

function finiteDifference(minuend: number, subtrahend: number): number {
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
