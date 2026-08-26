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

  it("rejects finite inputs when a derived metric overflows", () => {
    // Given
    const values = [Number.MAX_VALUE, Number.MAX_VALUE];

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
