import { describe, expect, it } from "vitest";
import {
  deadlinePairedComparisons,
  deadlineScenarioAggregate,
} from "./deadline-sweep-statistics";
import type { DeadlineArm } from "./deadline-sweep-types";

const SCENARIO = "overlap-nonblocking";

function arm(deadlineMs: number, latencies: readonly number[]): DeadlineArm {
  return {
    attempts: latencies.map((_, index) => ({
      repetition: index + 1,
      scenario: SCENARIO,
      status: "completed",
    })),
    createdAt: "2026-08-15T00:00:00.000Z",
    deadlineMs,
    mode: "live",
    model: "test",
    source: "test",
    trials: latencies.map((decisionLatencyMs, index) => ({
      candidateApplied: true,
      deadlineMs,
      decisionLatencyMs,
      outcome: "provider-started",
      pathValid: true,
      providerStarted: true,
      repetition: index + 1,
      scenario: SCENARIO,
      summaryCallsStarted: decisionLatencyMs,
      summarySpans: [],
    })),
  };
}

describe("deadline sweep scenario statistics", () => {
  it("preserves all-error scenario evidence without crashing", () => {
    // Given / When
    const aggregate = deadlineScenarioAggregate(
      {
        attempts: [
          {
            message: "setup failed",
            repetition: 1,
            scenario: "overlap-nonblocking",
            status: "error",
          },
        ],
        createdAt: "2026-08-15T00:00:00.000Z",
        deadlineMs: 10_000,
        mode: "live",
        model: "test",
        source: "test",
        trials: [],
      },
      SCENARIO
    );

    // Then
    expect(aggregate).toMatchObject({
      attemptErrors: 1,
      attempts: 1,
      completed: 0,
      decisionLatencyMs: { mean: 0, meanCi95: [0, 0] },
      reliability: { rate: 0 },
    });
  });

  it("keeps maximum finite latency means and bootstrap bounds finite", () => {
    // Given
    const input = arm(10_000, [Number.MAX_VALUE, Number.MAX_VALUE]);

    // When
    const aggregate = deadlineScenarioAggregate(input, SCENARIO);

    // Then
    expect(aggregate.decisionLatencyMs).toEqual({
      max: Number.MAX_VALUE,
      mean: Number.MAX_VALUE,
      meanCi95: [Number.MAX_VALUE, Number.MAX_VALUE],
      p95: Number.MAX_VALUE,
    });
    expect(aggregate.summaryCallsMean).toBe(Number.MAX_VALUE);
    expect(
      JSON.stringify({
        decisionLatencyMs: aggregate.decisionLatencyMs,
        summaryCallsMean: aggregate.summaryCallsMean,
      })
    ).not.toContain("null");
  });

  it("rejects a paired finite latency subtraction that exceeds the number range", () => {
    // Given
    const arms = [
      arm(10_000, [Number.MAX_VALUE]),
      arm(20_000, [-Number.MAX_VALUE]),
    ];

    // When
    const result = () => deadlinePairedComparisons(arms, [SCENARIO]);

    // Then
    expect(result).toThrow(RangeError);
  });

  it("repeats bootstrap intervals exactly for the campaign seed", () => {
    // Given
    const input = arm(10_000, [1, 2, 4]);

    // When
    const first = deadlineScenarioAggregate(input, SCENARIO);
    const second = deadlineScenarioAggregate(input, SCENARIO);

    // Then
    expect(first.decisionLatencyMs.meanCi95).toEqual(
      second.decisionLatencyMs.meanCi95
    );
  });
});
