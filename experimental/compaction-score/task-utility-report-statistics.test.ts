import { describe, expect, it } from "vitest";
import { createTaskUtilityReport } from "./task-utility-report";
import type { TaskUtilityPair } from "./task-utility-types";

function pair(repetition: number, durationMs: number): TaskUtilityPair {
  const validation = {
    checks: [{ id: "statistics", passed: true }],
    passed: true,
  };
  return {
    arms: [
      {
        arm: "full",
        assistantOutput: "ok",
        costUsd: null,
        durationMs,
        events: [],
        initialValidation: validation,
        passed: true,
        summary: null,
        validation,
        workspace: "/tmp/full",
      },
      {
        arm: "compact",
        assistantOutput: "ok",
        costUsd: null,
        durationMs,
        events: [],
        initialValidation: validation,
        passed: true,
        summary: null,
        validation,
        workspace: "/tmp/compact",
      },
    ],
    classification: "retained-success",
    compactPassed: true,
    fixture: "statistics",
    fullPassed: true,
    order: "full-compact",
    repetition,
  };
}

function report(pairs: readonly TaskUtilityPair[]) {
  return createTaskUtilityReport({
    mode: "deterministic",
    model: "statistics",
    pairs,
    repetitions: pairs.length,
  });
}

describe("task utility report statistics", () => {
  it("keeps maximum finite latency means and bootstrap bounds finite", () => {
    // Given
    const pairs = [pair(1, Number.MAX_VALUE), pair(2, Number.MAX_VALUE)];

    // When
    const result = report(pairs);

    // Then
    expect(result.summary.fullLatencyMs).toEqual({
      max: Number.MAX_VALUE,
      mean: Number.MAX_VALUE,
      meanCi95: [Number.MAX_VALUE, Number.MAX_VALUE],
      p95: Number.MAX_VALUE,
    });
    expect(result.summary.compactLatencyMs).toEqual(
      result.summary.fullLatencyMs
    );
    expect(JSON.stringify(result.summary.fullLatencyMs)).not.toContain("null");
  });

  it("preserves the empty latency boundary", () => {
    // Given
    const pairs: readonly TaskUtilityPair[] = [];

    // When
    const result = report(pairs);

    // Then
    expect(result.summary.fullLatencyMs).toEqual({
      max: 0,
      mean: 0,
      meanCi95: [0, 0],
      p95: 0,
    });
    expect(result.summary.compactLatencyMs).toEqual(
      result.summary.fullLatencyMs
    );
  });

  it("repeats bootstrap intervals exactly for the campaign seed", () => {
    // Given
    const pairs = [pair(1, 1), pair(2, 2), pair(3, 4)];

    // When
    const first = report(pairs);
    const second = report(pairs);

    // Then
    expect(first.summary.fullLatencyMs.meanCi95).toEqual(
      second.summary.fullLatencyMs.meanCi95
    );
  });
});
