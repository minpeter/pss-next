import { describe, expect, it } from "vitest";
import { distribution, wilson95 } from "./report-statistics";

describe("distribution", () => {
  it.each([Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects the non-finite input %s",
    (value) => {
      // Given
      const values = [value];

      // When
      const result = () => distribution(values);

      // Then
      expect(result).toThrow(RangeError);
    }
  );

  it("keeps a 150k-row finite distribution bounded without argument spread", () => {
    // Given
    const values = Array.from({ length: 150_000 }, () => Number.MAX_VALUE);

    // When
    const result = distribution(values);

    // Then
    expect(result).toEqual({
      max: Number.MAX_VALUE,
      mean: Number.MAX_VALUE,
      min: Number.MAX_VALUE,
      quantiles: { p50: Number.MAX_VALUE, p95: Number.MAX_VALUE },
      standardDeviation: 0,
    });
  });

  it("summarizes a singleton maximum finite value", () => {
    // Given
    const values = [Number.MAX_VALUE];

    // When
    const result = distribution(values);

    // Then
    expect(result.mean).toBe(Number.MAX_VALUE);
    expect(result.quantiles).toEqual({
      p50: Number.MAX_VALUE,
      p95: Number.MAX_VALUE,
    });
  });

  it("keeps opposite maximum finite values bounded", () => {
    // Given
    const values = [-Number.MAX_VALUE, Number.MAX_VALUE];

    // When
    const result = distribution(values);

    // Then
    expect(result.mean).toBe(0);
    expect(result.quantiles.p50).toBe(0);
    expect(result.standardDeviation).toBe(Number.MAX_VALUE);
    expect(JSON.stringify(result)).not.toContain("null");
  });

  it("rejects an empty distribution explicitly", () => {
    // Given
    const values: readonly number[] = [];

    // When
    const result = () => distribution(values);

    // Then
    expect(result).toThrow(RangeError);
  });
});

describe("wilson95", () => {
  it("rejects a zero total", () => {
    // Given
    const correct = 0;
    const total = 0;

    // When
    const result = () => wilson95(correct, total);

    // Then
    expect(result).toThrow(RangeError);
  });

  it.each([
    Number.NEGATIVE_INFINITY,
    -1,
    0.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects the invalid total %s", (total) => {
    // Given
    const correct = 0;

    // When
    const result = () => wilson95(correct, total);

    // Then
    expect(result).toThrow(RangeError);
  });

  it.each([
    Number.NEGATIVE_INFINITY,
    -1,
    0.5,
    2,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects the invalid correct count %s", (correct) => {
    // Given
    const total = 1;

    // When
    const result = () => wilson95(correct, total);

    // Then
    expect(result).toThrow(RangeError);
  });
});
