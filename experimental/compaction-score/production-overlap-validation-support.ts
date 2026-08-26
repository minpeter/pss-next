import { object } from "./production-overlap-parse";
import type {
  ProductionOverlapAttempt,
  ProductionOverlapPair,
} from "./production-overlap-types";

export function validateMethodology(raw: unknown): void {
  const methodology = object(raw, "methodology");
  if (
    methodology.bootstrapIterations !== 10_000 ||
    methodology.bootstrapSeed !== 4242 ||
    methodology.compactionDeadlineMs !== 60_000 ||
    methodology.decisionDelta !== "treatment-context-gate-vs-control-no-gate" ||
    methodology.pairedModelClient !== "shared-sequential" ||
    methodology.pathValidityDenominator !== "completed-pairs" ||
    methodology.primaryUserBlock !==
      "paired-first-visible-delta-clamped-at-zero" ||
    methodology.rateInterval !== "wilson-95"
  ) {
    throw new TypeError("Production overlap methodology is invalid.");
  }
}

export function attemptKey(attempt: ProductionOverlapAttempt): string {
  return `${attempt.scenario}:${attempt.repetition}`;
}

export function pairKey(pair: ProductionOverlapPair): string {
  return `${pair.scenario}:${pair.repetition}`;
}

export function pairMetric(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Production overlap pair metrics are inconsistent.");
  }
  return value;
}

export function close(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= 1e-6;
}
