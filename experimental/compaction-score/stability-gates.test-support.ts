import { expect } from "vitest";
import type { BenchmarkScenario } from "./fixture";
import type { TrialSummary } from "./report";
import {
  evaluateStabilityComparison,
  type StabilityGateCode,
} from "./stability-gates";

type Distribution = NonNullable<TrialSummary["compression"]>["ratio"] & {
  readonly quantiles: { readonly p50: number; readonly p95: number };
};

export type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

type ComparableTrialSummary = Omit<
  TrialSummary,
  "compression" | "retention"
> & {
  readonly compression: NonNullable<TrialSummary["compression"]> & {
    readonly byScenario: readonly {
      readonly ratio: Distribution;
      readonly scenario: BenchmarkScenario;
    }[];
  };
  readonly retention: NonNullable<TrialSummary["retention"]> & {
    readonly disagreements: readonly {
      readonly arm: "compacted" | "full";
      readonly category: string;
      readonly count: number;
      readonly fingerprint: string;
      readonly scenario: BenchmarkScenario;
    }[];
  };
};

const distribution = (mean: number, max = mean): Mutable<Distribution> => ({
  max,
  mean,
  min: Math.min(mean, max),
  quantiles: { p50: mean, p95: mean },
  standardDeviation: 0,
});

export const summary = (): Mutable<ComparableTrialSummary> => ({
  compression: {
    byHop: [
      { hop: 1, ratio: distribution(0.3, 0.4) },
      { hop: 2, ratio: distribution(0.25, 0.35) },
    ],
    byScenario: [
      { ratio: distribution(0.3), scenario: "baseline" },
      { ratio: distribution(0.3), scenario: "lifecycle" },
    ],
    ratio: distribution(0.3, 0.4),
    savings: distribution(0.7, 0.8),
  },
  retention: {
    aggregate: {
      accuracy: 1,
      correct: 8,
      total: 8,
      wilson95: { high: 1, low: 0.67 },
    },
    byCategory: [
      {
        accuracy: 1,
        category: "exact-recall",
        correct: 4,
        total: 4,
        wilson95: { high: 1, low: 0.51 },
      },
      {
        accuracy: 1,
        category: "tool-history",
        correct: 4,
        total: 4,
        wilson95: { high: 1, low: 0.51 },
      },
    ],
    byScenario: [
      {
        accuracy: 1,
        correct: 4,
        scenario: "baseline",
        total: 4,
        wilson95: { high: 1, low: 0.51 },
      },
      {
        accuracy: 1,
        correct: 4,
        scenario: "lifecycle",
        total: 4,
        wilson95: { high: 1, low: 0.51 },
      },
    ],
    disagreements: [],
    trialAccuracy: distribution(1),
  },
  trials: { attempted: 4, invalidByStatus: {}, valid: 4 },
});

export const mutatedDecision = (
  mutate: (candidate: Mutable<ReturnType<typeof summary>>) => void
) => {
  const baseline = summary();
  const candidate = structuredClone(baseline);
  mutate(candidate);
  return evaluateStabilityComparison(baseline, candidate);
};

export const expectCode = (
  decision: ReturnType<typeof evaluateStabilityComparison>,
  code: StabilityGateCode
) => {
  expect(decision.passed).toBe(false);
  expect(decision.failures.map((failure) => failure.code)).toContain(code);
  expect(
    decision.failures.find((failure) => failure.code === code)?.payload
  ).toEqual(expect.any(Object));
};
