import { describe, expect, it } from "vitest";
import {
  aggregateRuntimeBlockTrials,
  calculateRuntimeBlockTrial,
  type RuntimeBlockObservation,
  type RuntimeBlockTrial,
} from "./runtime-block-time-metrics";

const MAXIMUM = Number.MAX_VALUE;

const trial = {
  avoidedBlockMs: MAXIMUM,
  blockAvoidanceRatio: MAXIMUM,
  candidateApplied: false,
  controlPreparationMs: 0,
  controlProviderDispatchMs: 0,
  controlTtfvMs: 0,
  gateDeltaMs: MAXIMUM,
  overlapAtProviderStart: false,
  preStepDeltaMs: MAXIMUM,
  repetition: 1,
  scenario: "overlap-nonblocking",
  summaryCalls: MAXIMUM,
  summaryServiceMs: MAXIMUM,
  treatmentPreparationMs: 0,
  treatmentProviderDispatchMs: 0,
  treatmentTtfvMs: 0,
  userBlockMs: MAXIMUM,
  userDeltaMs: MAXIMUM,
  zeroBlock: false,
} as const satisfies RuntimeBlockTrial;

describe("runtime block-time metric overflow boundaries", () => {
  it("keeps every per-trial measurement finite when finite timestamps exceed the number range", () => {
    // Given
    const observation: RuntimeBlockObservation = {
      candidateApplied: false,
      controlFirstVisibleAtMs: MAXIMUM,
      controlProviderStartedAtMs: MAXIMUM,
      controlSentAtMs: -MAXIMUM,
      controlStepStartedAtMs: -MAXIMUM,
      repetition: 1,
      scenario: "overlap-nonblocking",
      summarySpans: [],
      targetFirstVisibleAtMs: MAXIMUM,
      targetProviderStartedAtMs: MAXIMUM,
      targetSentAtMs: -MAXIMUM,
      targetStepStartedAtMs: -MAXIMUM,
    };

    // When
    const result = calculateRuntimeBlockTrial(observation);
    const serialized = JSON.stringify(result);

    // Then
    expect(result).toEqual({
      avoidedBlockMs: 0,
      blockAvoidanceRatio: 0,
      candidateApplied: false,
      controlPreparationMs: MAXIMUM,
      controlProviderDispatchMs: MAXIMUM,
      controlTtfvMs: MAXIMUM,
      gateDeltaMs: 0,
      overlapAtProviderStart: false,
      preStepDeltaMs: 0,
      repetition: 1,
      scenario: "overlap-nonblocking",
      summaryCalls: 0,
      summaryServiceMs: 0,
      treatmentPreparationMs: MAXIMUM,
      treatmentProviderDispatchMs: MAXIMUM,
      treatmentTtfvMs: MAXIMUM,
      userBlockMs: 0,
      userDeltaMs: 0,
      zeroBlock: true,
    });
    expect(
      Object.values(result).every(
        (value) => typeof value !== "number" || Number.isFinite(value)
      )
    ).toBe(true);
    expect(serialized).not.toContain(":null");
  });

  it("keeps pre-step deltas finite when both finite elapsed times exceed the number range", () => {
    // Given
    const observation: RuntimeBlockObservation = {
      candidateApplied: false,
      controlFirstVisibleAtMs: 0,
      controlProviderStartedAtMs: MAXIMUM,
      controlSentAtMs: -MAXIMUM,
      controlStepStartedAtMs: MAXIMUM,
      repetition: 1,
      scenario: "overlap-nonblocking",
      summarySpans: [],
      targetFirstVisibleAtMs: 0,
      targetProviderStartedAtMs: MAXIMUM,
      targetSentAtMs: -MAXIMUM,
      targetStepStartedAtMs: MAXIMUM,
    };

    // When
    const result = calculateRuntimeBlockTrial(observation);

    // Then
    expect(result.preStepDeltaMs).toBe(0);
    expect(Number.isFinite(result.preStepDeltaMs)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(":null");
  });

  it("keeps a summary-service sum finite when finite span subtraction exceeds the number range", () => {
    // Given
    const observation: RuntimeBlockObservation = {
      candidateApplied: false,
      controlFirstVisibleAtMs: 0,
      controlProviderStartedAtMs: 0,
      controlSentAtMs: 0,
      controlStepStartedAtMs: 0,
      repetition: 1,
      scenario: "overlap-nonblocking",
      summarySpans: [
        {
          endedAtMs: MAXIMUM,
          kind: "summary",
          startedAtMs: -MAXIMUM,
          status: "completed",
        },
        {
          endedAtMs: MAXIMUM,
          kind: "summary",
          startedAtMs: -MAXIMUM,
          status: "completed",
        },
      ],
      targetFirstVisibleAtMs: 0,
      targetProviderStartedAtMs: 0,
      targetSentAtMs: 0,
      targetStepStartedAtMs: 0,
    };

    // When
    const result = calculateRuntimeBlockTrial(observation);

    // Then
    expect(result.summaryServiceMs).toBe(MAXIMUM);
    expect(result.avoidedBlockMs).toBe(MAXIMUM);
    expect(result.blockAvoidanceRatio).toBe(1);
  });

  it("keeps every aggregate mean finite when two finite measurements exceed the number range", () => {
    // Given
    const trials = [trial, { ...trial, repetition: 2 }];

    // When
    const result = aggregateRuntimeBlockTrials("overlap-nonblocking", trials);

    // Then
    expect({
      blockAvoidanceRatioMean: result.blockAvoidanceRatioMean,
      gateDeltaMeanMs: result.gateDeltaMeanMs,
      preStepDeltaMeanMs: result.preStepDeltaMeanMs,
      summaryCallsMean: result.summaryCallsMean,
      summaryServiceMeanMs: result.summaryServiceMeanMs,
      userBlockMeanMs: result.userBlockMeanMs,
      userDeltaMeanMs: result.userDeltaMeanMs,
    }).toEqual({
      blockAvoidanceRatioMean: MAXIMUM,
      gateDeltaMeanMs: MAXIMUM,
      preStepDeltaMeanMs: MAXIMUM,
      summaryCallsMean: MAXIMUM,
      summaryServiceMeanMs: MAXIMUM,
      userBlockMeanMs: MAXIMUM,
      userDeltaMeanMs: MAXIMUM,
    });
    expect(result.userBlockMaxMs).toBe(MAXIMUM);
    expect(result.userBlockP50Ms).toBe(MAXIMUM);
    expect(result.userBlockP95Ms).toBe(MAXIMUM);
  });
});
