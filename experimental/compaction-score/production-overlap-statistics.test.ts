import { describe, expect, it } from "vitest";
import { aggregateProductionOverlap } from "./production-overlap-analysis";
import type {
  ProductionOverlapPair,
  ProductionTurnTimestamps,
} from "./production-overlap-types";

const SCENARIO = "overlap-nonblocking";
const TIMESTAMPS: ProductionTurnTimestamps = {
  firstVisibleAtMs: 0,
  providerStartedAtMs: 0,
  sentAtMs: 0,
  stepStartedAtMs: 0,
  turnEndedAtMs: 0,
  turnStartedAtMs: 0,
};

function pair(repetition: number, value: number): ProductionOverlapPair {
  return {
    actualTurnDeltaMs: value,
    actualUserBlockMs: value,
    candidateApplied: true,
    completionDeltaMs: value,
    control: TIMESTAMPS,
    decisionDeltaMs: value,
    dispatchBlockMs: value,
    dispatchDeltaMs: value,
    order: "control-treatment",
    overlapAtProviderStart: true,
    pathValid: true,
    repetition,
    scenario: SCENARIO,
    summarySpans: [],
    treatment: TIMESTAMPS,
    zeroBlock: false,
  };
}

describe("production overlap statistics", () => {
  it("keeps maximum finite means and bootstrap bounds finite", () => {
    // Given
    const pairs = [pair(1, Number.MAX_VALUE), pair(2, Number.MAX_VALUE)];

    // When
    const aggregate = aggregateProductionOverlap(SCENARIO, pairs);

    // Then
    expect(aggregate.actualUserBlockMs).toEqual({
      max: Number.MAX_VALUE,
      mean: Number.MAX_VALUE,
      meanCi95: [Number.MAX_VALUE, Number.MAX_VALUE],
      p50: Number.MAX_VALUE,
      p95: Number.MAX_VALUE,
    });
    expect(JSON.stringify(aggregate)).not.toContain("null");
  });

  it("keeps opposite maximum finite measurements bounded", () => {
    // Given
    const pairs = [pair(1, -Number.MAX_VALUE), pair(2, Number.MAX_VALUE)];

    // When
    const aggregate = aggregateProductionOverlap(SCENARIO, pairs);

    // Then
    const distributions = [
      aggregate.actualUserBlockMs,
      aggregate.completionDeltaMs,
      aggregate.decisionDeltaMs,
      aggregate.dispatchBlockMs,
    ];
    expect(
      distributions.every((value) =>
        [
          value.max,
          value.mean,
          value.meanCi95[0],
          value.meanCi95[1],
          value.p50,
          value.p95,
        ].every(Number.isFinite)
      )
    ).toBe(true);
  });

  it("repeats bootstrap intervals exactly for the campaign seed", () => {
    // Given
    const pairs = [pair(1, 1), pair(2, 2), pair(3, 4)];

    // When
    const first = aggregateProductionOverlap(SCENARIO, pairs);
    const second = aggregateProductionOverlap(SCENARIO, pairs);

    // Then
    expect(first.actualUserBlockMs.meanCi95).toEqual(
      second.actualUserBlockMs.meanCi95
    );
  });
});
