import {
  aggregateRuntimeBlockTrials as aggregateRuntimeBlockTrialStatistics,
  elapsed,
  finiteDifference,
  sum,
} from "./runtime-block-time-statistics";
import type {
  RuntimeBlockAggregate,
  RuntimeBlockObservation,
  RuntimeBlockScenario,
  RuntimeBlockTrial,
} from "./runtime-block-time-types";

export type {
  RuntimeBlockAggregate,
  RuntimeBlockObservation,
  RuntimeBlockScenario,
  RuntimeBlockTrial,
  RuntimeSummarySpan,
} from "./runtime-block-time-types";

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
  const summaryServiceMs = sum(
    observation.summarySpans.map(({ endedAtMs, startedAtMs }) =>
      elapsed(endedAtMs, startedAtMs)
    )
  );
  const base: RuntimeBlockTrial = {
    avoidedBlockMs: elapsed(summaryServiceMs, userBlockMs),
    blockAvoidanceRatio:
      summaryServiceMs === 0
        ? 0
        : elapsed(summaryServiceMs, userBlockMs) / summaryServiceMs,
    candidateApplied: observation.candidateApplied,
    controlPreparationMs,
    controlProviderDispatchMs,
    controlTtfvMs,
    gateDeltaMs: finiteDifference(treatmentPreparationMs, controlPreparationMs),
    overlapAtProviderStart: observation.summarySpans.some(
      ({ endedAtMs, startedAtMs }) =>
        startedAtMs <= observation.targetProviderStartedAtMs &&
        observation.targetProviderStartedAtMs < endedAtMs
    ),
    preStepDeltaMs: finiteDifference(
      elapsed(observation.targetStepStartedAtMs, observation.targetSentAtMs),
      elapsed(observation.controlStepStartedAtMs, observation.controlSentAtMs)
    ),
    repetition: observation.repetition,
    scenario: observation.scenario,
    summaryCalls: observation.summarySpans.length,
    summaryServiceMs,
    treatmentPreparationMs,
    treatmentProviderDispatchMs,
    treatmentTtfvMs,
    userBlockMs,
    userDeltaMs,
    zeroBlock: isRuntimeUserBlockZero(userBlockMs),
  };
  const controlEnded = observation.controlTurnEndedAtMs;
  const targetEnded = observation.targetTurnEndedAtMs;
  if (
    controlEnded === undefined ||
    targetEnded === undefined ||
    observation.controlTurnStartedAtMs === undefined ||
    observation.targetTurnStartedAtMs === undefined ||
    observation.pairOrder === undefined ||
    observation.pathValid !== true
  ) {
    return base;
  }
  const controlCompletionMs = elapsed(
    controlEnded,
    observation.controlSentAtMs
  );
  const targetCompletionMs = elapsed(targetEnded, observation.targetSentAtMs);
  return {
    ...base,
    actualTurnDeltaMs: userDeltaMs,
    completionDeltaMs: finiteDifference(
      targetCompletionMs,
      controlCompletionMs
    ),
    controlCompletionMs,
    controlRequestMs: controlProviderDispatchMs,
    controlTimeToFirstVisibleMs: controlTtfvMs,
    dispatchBlockMs: Math.max(
      0,
      finiteDifference(treatmentProviderDispatchMs, controlProviderDispatchMs)
    ),
    pairOrder: observation.pairOrder,
    pathValid: true,
    targetCompletionMs,
    targetPreparationMs: treatmentPreparationMs,
    targetRequestMs: treatmentProviderDispatchMs,
    targetTimeToFirstVisibleMs: treatmentTtfvMs,
  };
}

export function isRuntimeUserBlockZero(userBlockMs: number): boolean {
  return userBlockMs <= ZERO_BLOCK_THRESHOLD_MS;
}

export function aggregateRuntimeBlockTrials(
  scenario: RuntimeBlockScenario,
  trials: readonly RuntimeBlockTrial[]
): RuntimeBlockAggregate {
  return aggregateRuntimeBlockTrialStatistics(scenario, trials);
}
