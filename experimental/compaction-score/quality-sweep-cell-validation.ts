import {
  array,
  boolean,
  nonnegativeInteger,
  nullableFinite,
  object,
  positiveInteger,
} from "./quality-sweep-parse";

export interface ParsedQualityObservation {
  readonly arm: "pi" | "pss";
  readonly budget: number;
  readonly compressionRatio: number | null;
  readonly controlCorrect: number;
  readonly controlPassed: boolean;
  readonly controlTotal: number;
  readonly correct: number;
  readonly latencyMs: number | null;
  readonly sentOutputTokens: readonly number[];
  readonly summarizerInputTokens: number;
  readonly summaryTokens: number;
  readonly total: number;
  readonly valid: boolean;
}

export function validateQualityCells(
  cells: readonly unknown[],
  observations: readonly ParsedQualityObservation[]
): void {
  if (cells.length !== 18) {
    throw new TypeError("Quality sweep must contain 18 budget cells.");
  }
  for (const raw of cells) {
    const cell = object(raw, "cell");
    const arm = cell.arm;
    const budget = positiveInteger(cell.budget, "cell.budget");
    if (arm !== "pi" && arm !== "pss") {
      throw new TypeError("Quality sweep cell arm is invalid.");
    }
    const matching = observations.filter(
      (item) => item.arm === arm && item.budget === budget
    );
    const valid = matching.filter((item) => item.valid);
    const correct = sum(valid.map((item) => item.correct));
    const total = sum(valid.map((item) => item.total));
    const controlsPassed =
      valid.length > 0 && valid.every((item) => item.controlPassed);
    let expectedBudgetStatus:
      | "budget-clamped"
      | "budget-exact"
      | "budget-unknown"
      | "budget-within-cap" = "budget-unknown";
    if (
      valid.length > 0 &&
      valid.every((item) =>
        item.sentOutputTokens.every((sent) => sent === item.budget)
      )
    ) {
      expectedBudgetStatus = "budget-exact";
    } else if (
      valid.length > 0 &&
      valid.every((item) =>
        item.sentOutputTokens.every((sent) => sent <= item.budget)
      )
    ) {
      expectedBudgetStatus = "budget-within-cap";
    } else if (valid.length > 0) {
      expectedBudgetStatus = "budget-clamped";
    }
    const consistent =
      nonnegativeInteger(cell.valid, "cell.valid") === valid.length &&
      nonnegativeInteger(cell.invalid, "cell.invalid") ===
        matching.length - valid.length &&
      nonnegativeInteger(cell.correct, "cell.correct") === correct &&
      nonnegativeInteger(cell.total, "cell.total") === total &&
      nonnegativeInteger(cell.controlCorrect, "cell.controlCorrect") ===
        sum(valid.map((item) => item.controlCorrect)) &&
      nonnegativeInteger(cell.controlTotal, "cell.controlTotal") ===
        sum(valid.map((item) => item.controlTotal)) &&
      nonnegativeInteger(cell.summaryTokens, "cell.summaryTokens") ===
        sum(valid.map((item) => item.summaryTokens)) &&
      nonnegativeInteger(
        cell.summarizerInputTokens,
        "cell.summarizerInputTokens"
      ) === sum(valid.map((item) => item.summarizerInputTokens)) &&
      boolean(cell.controlsPassed, "cell.controlsPassed") === controlsPassed &&
      cell.budgetStatus === expectedBudgetStatus &&
      closeInterval(cell.wilson95, wilson95(correct, total)) &&
      closeNullable(
        cell.compressionRatioMean,
        meanOrNull(
          valid.flatMap((item) =>
            item.compressionRatio === null ? [] : [item.compressionRatio]
          )
        )
      ) &&
      closeNullable(
        cell.latencyMeanMs,
        meanOrNull(
          valid.flatMap((item) =>
            item.latencyMs === null ? [] : [item.latencyMs]
          )
        )
      ) &&
      cell.costUsd === null;
    if (!consistent) {
      throw new TypeError("Quality sweep cell accounting is inconsistent.");
    }
    nullableFinite(cell.compressionRatioMean, "cell.compressionRatioMean");
    nullableFinite(cell.latencyMeanMs, "cell.latencyMeanMs");
    nullableFinite(cell.costUsd, "cell.costUsd");
    if (array(cell.wilson95, "cell.wilson95").length !== 2) {
      throw new TypeError("Quality sweep cell Wilson interval is invalid.");
    }
  }
}

function wilson95(correct: number, total: number): readonly [number, number] {
  if (total === 0) {
    return [0, 0];
  }
  const z = 1.96;
  const p = correct / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function closeInterval(
  value: unknown,
  expected: readonly [number, number]
): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    close(value[0], expected[0]) &&
    close(value[1], expected[1])
  );
}

function closeNullable(value: unknown, expected: number | null): boolean {
  return value === null && expected === null
    ? true
    : typeof value === "number" && expected !== null && close(value, expected);
}

function close(value: unknown, expected: number): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value - expected) <= 1e-9
  );
}

function meanOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
