export type RuntimeBlockScenario =
  | "candidate-fit-late-hit"
  | "candidate-too-broad-fallback"
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
  readonly controlProviderStartedAtMs: number;
  readonly controlSentAtMs: number;
  readonly controlStepStartedAtMs: number;
  readonly pathValid: true;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summarySpans: readonly RuntimeSummarySpan[];
  readonly targetProviderStartedAtMs: number;
  readonly targetSentAtMs: number;
  readonly targetStepStartedAtMs: number;
}

export interface RuntimeBlockTrial {
  readonly avoidedBlockMs: number;
  readonly blockAvoidanceRatio: number;
  readonly candidateApplied: boolean;
  readonly controlPreparationMs: number;
  readonly controlRequestMs: number;
  readonly gateDeltaMs: number;
  readonly overlapAtProviderStart: boolean;
  readonly pathValid: true;
  readonly preStepDeltaMs: number;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summaryCalls: number;
  readonly summaryServiceMs: number;
  readonly targetPreparationMs: number;
  readonly targetRequestMs: number;
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
  const controlPreparationMs = Math.max(
    0,
    observation.controlProviderStartedAtMs - observation.controlStepStartedAtMs
  );
  const controlRequestMs = Math.max(
    0,
    observation.controlProviderStartedAtMs - observation.controlSentAtMs
  );
  const targetPreparationMs = Math.max(
    0,
    observation.targetProviderStartedAtMs - observation.targetStepStartedAtMs
  );
  const gateDeltaMs = targetPreparationMs - controlPreparationMs;
  const targetRequestMs = Math.max(
    0,
    observation.targetProviderStartedAtMs - observation.targetSentAtMs
  );
  const userDeltaMs = targetRequestMs - controlRequestMs;
  const userBlockMs = Math.max(0, userDeltaMs);
  const targetPreStepMs = Math.max(
    0,
    observation.targetStepStartedAtMs - observation.targetSentAtMs
  );
  const controlPreStepMs = Math.max(
    0,
    observation.controlStepStartedAtMs - observation.controlSentAtMs
  );
  const preStepDeltaMs = targetPreStepMs - controlPreStepMs;
  const summaryServiceMs = sum(
    observation.summarySpans.map(({ endedAtMs, startedAtMs }) =>
      Math.max(0, endedAtMs - startedAtMs)
    )
  );
  const avoidedBlockMs = Math.max(0, summaryServiceMs - userBlockMs);
  return {
    avoidedBlockMs,
    blockAvoidanceRatio:
      summaryServiceMs === 0 ? 0 : avoidedBlockMs / summaryServiceMs,
    candidateApplied: observation.candidateApplied,
    controlPreparationMs,
    controlRequestMs,
    gateDeltaMs,
    overlapAtProviderStart: observation.summarySpans.some(
      ({ endedAtMs, startedAtMs }) =>
        startedAtMs <= observation.targetProviderStartedAtMs &&
        observation.targetProviderStartedAtMs < endedAtMs
    ),
    pathValid: observation.pathValid,
    preStepDeltaMs,
    repetition: observation.repetition,
    scenario: observation.scenario,
    summaryCalls: observation.summarySpans.length,
    summaryServiceMs,
    targetPreparationMs,
    targetRequestMs,
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
    userBlockMaxMs: Math.max(...blocks),
    userBlockMeanMs: mean(blocks),
    userBlockP50Ms: quantile(blocks, 0.5),
    userBlockP95Ms: quantile(blocks, 0.95),
    zeroBlockRate:
      matching.filter((trial) => trial.zeroBlock).length / matching.length,
  };
}

function mean(values: readonly number[]): number {
  return sum(values) / values.length;
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
  return values.reduce((total, value) => total + value, 0);
}
