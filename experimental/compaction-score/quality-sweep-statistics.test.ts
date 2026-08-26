import { describe, expect, it } from "vitest";
import { aggregateQualityCells } from "./quality-sweep-analysis";
import type { QualitySweepObservation } from "./quality-sweep-types";

function observation(
  overrides: Partial<QualitySweepObservation>
): QualitySweepObservation {
  return {
    arm: "pss",
    budget: 100,
    compressionRatio: 1,
    controlCorrect: 1,
    controlPassed: true,
    controlTotal: 1,
    correct: 1,
    costUsd: null,
    fixtureSeed: "statistics",
    latencyMs: 1,
    repetition: 1,
    scenario: "baseline",
    sentOutputTokens: [100],
    summarizerInputTokens: 0,
    summaryTokens: 0,
    total: 1,
    valid: true,
    ...overrides,
  };
}

describe("quality sweep statistics", () => {
  it("keeps maximum finite observation means finite", () => {
    // Given
    const observations = [
      observation({
        compressionRatio: Number.MAX_VALUE,
        latencyMs: Number.MAX_VALUE,
      }),
      observation({
        compressionRatio: Number.MAX_VALUE,
        latencyMs: Number.MAX_VALUE,
        repetition: 2,
      }),
    ];

    // When
    const cells = aggregateQualityCells(observations);

    // Then
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      compressionRatioMean: Number.MAX_VALUE,
      latencyMeanMs: Number.MAX_VALUE,
    });
  });

  it("rejects a finite token total that exceeds the number range", () => {
    // Given
    const observations = [
      observation({ summaryTokens: Number.MAX_VALUE }),
      observation({ repetition: 2, summaryTokens: Number.MAX_VALUE }),
    ];

    // When
    const result = () => aggregateQualityCells(observations);

    // Then
    expect(result).toThrow(RangeError);
  });

  it("preserves a singleton nullable mean boundary", () => {
    // Given
    const observations = [
      observation({ compressionRatio: null, latencyMs: Number.MAX_VALUE }),
    ];

    // When
    const cells = aggregateQualityCells(observations);

    // Then
    expect(cells[0]).toMatchObject({
      compressionRatioMean: null,
      latencyMeanMs: Number.MAX_VALUE,
    });
  });

  it("preserves the empty-cell boundary", () => {
    // Given
    const observations: readonly QualitySweepObservation[] = [];

    // When
    const cells = aggregateQualityCells(observations);

    // Then
    expect(cells).toEqual([]);
  });
});
