import { describe, expect, it } from "vitest";
import type { TrialRecord } from "./report";
import { summarizeTrials } from "./report";

const RECORD_COUNTS = [100_000, 150_000] as const;
const WORK_SAMPLE_SIZE = 2000;
const MAX_ARRAY_ITERATIONS_PER_RECORD = 50;

const validRecord: TrialRecord = {
  fixtureSeed: "fixture-performance",
  hops: [
    {
      endSeqExclusive: 80,
      prefixTokens: 1000,
      summaryTokens: 250,
    },
  ],
  id: "performance-record",
  prefixTokens: 1000,
  repetition: 1,
  scenario: "baseline",
  score: {
    arms: {
      compacted: {
        overall: { correct: 2, total: 2 },
        perCategory: [{ category: "exact-recall", correct: 2, total: 2 }],
      },
      full: {
        overall: { correct: 2, total: 2 },
        perCategory: [{ category: "exact-recall", correct: 2, total: 2 }],
      },
    },
    disagreements: [],
    headline: { correct: 2, total: 2 },
  },
  status: "valid",
  summaryTokens: 250,
};

describe("summarizeTrials performance bounds", () => {
  it("uses linearly bounded array iteration when one scenario has many records", () => {
    // Given
    const records = Array.from({ length: WORK_SAMPLE_SIZE }, () => validRecord);
    const originalIterator = Array.prototype[Symbol.iterator];
    let iterations = 0;

    function* countedIterator<T>(this: T[]): ArrayIterator<T> {
      for (const value of originalIterator.call(this)) {
        iterations += 1;
        if (iterations > WORK_SAMPLE_SIZE * MAX_ARRAY_ITERATIONS_PER_RECORD) {
          throw new RangeError(
            "summarizeTrials exceeded its linear work bound"
          );
        }
        yield value;
      }
    }

    Array.prototype[Symbol.iterator] = countedIterator;

    // When
    try {
      summarizeTrials(records);
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }

    // Then
    expect(iterations).toBeLessThanOrEqual(
      WORK_SAMPLE_SIZE * MAX_ARRAY_ITERATIONS_PER_RECORD
    );
  });

  it.each(RECORD_COUNTS)(
    "aggregates %i records without variadic argument overflow",
    (recordCount) => {
      // Given
      const records = Array.from({ length: recordCount }, () => validRecord);

      // When
      const report = summarizeTrials(records);

      // Then
      expect(report).toEqual({
        compression: {
          byHop: [
            {
              hop: 1,
              ratio: {
                max: 0.25,
                mean: 0.25,
                min: 0.25,
                quantiles: { p50: 0.25, p95: 0.25 },
                standardDeviation: 0,
              },
            },
          ],
          byScenario: [
            {
              ratio: {
                max: 0.25,
                mean: 0.25,
                min: 0.25,
                quantiles: { p50: 0.25, p95: 0.25 },
                standardDeviation: 0,
              },
              scenario: "baseline",
            },
          ],
          ratio: {
            max: 0.25,
            mean: 0.25,
            min: 0.25,
            quantiles: { p50: 0.25, p95: 0.25 },
            standardDeviation: 0,
          },
          savings: {
            max: 0.75,
            mean: 0.75,
            min: 0.75,
            quantiles: { p50: 0.75, p95: 0.75 },
            standardDeviation: 0,
          },
        },
        retention: {
          aggregate: {
            accuracy: 1,
            correct: recordCount * 2,
            total: recordCount * 2,
            wilson95: { high: expect.any(Number), low: expect.any(Number) },
          },
          byCategory: [
            {
              accuracy: 1,
              category: "exact-recall",
              correct: recordCount * 2,
              total: recordCount * 2,
              wilson95: { high: expect.any(Number), low: expect.any(Number) },
            },
          ],
          byScenario: [
            {
              accuracy: 1,
              correct: recordCount * 2,
              scenario: "baseline",
              total: recordCount * 2,
              wilson95: { high: expect.any(Number), low: expect.any(Number) },
            },
          ],
          disagreements: [],
          trialAccuracy: {
            max: 1,
            mean: 1,
            min: 1,
            quantiles: { p50: 1, p95: 1 },
            standardDeviation: 0,
          },
        },
        trials: {
          attempted: recordCount,
          invalidByStatus: {},
          valid: recordCount,
        },
      });
    }
  );
});
