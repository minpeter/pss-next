import { describe, expect, it } from "vitest";
import { linearQuantile, summarizeLatencies } from "./profile-statistics";

describe("profile statistics", () => {
  it("interpolates finite quantiles with the linear (n-1)q method", () => {
    expect(linearQuantile([0, 10, 20, 30], 0.25)).toBe(7.5);
    expect(linearQuantile([30, 0, 20, 10], 0.95)).toBeCloseTo(28.5);
  });

  it("rejects empty, non-finite, and out-of-range inputs", () => {
    expect(() => linearQuantile([], 0.5)).toThrow();
    expect(() => linearQuantile([1, Number.POSITIVE_INFINITY], 0.5)).toThrow();
    expect(() => linearQuantile([1], 1.1)).toThrow();
  });

  it("summarizes observed latency without performance thresholds", () => {
    expect(summarizeLatencies([1, 2, 3])).toEqual({
      count: 3,
      maxMs: 3,
      meanMs: 2,
      minMs: 1,
      p50Ms: 2,
      p95Ms: 2.9,
      p99Ms: 2.98,
    });
  });
});
