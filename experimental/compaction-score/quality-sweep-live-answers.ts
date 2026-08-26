import type { QualityEvaluationAnswers } from "./quality-sweep-types";

export function parseCompareAnswers(
  value: unknown
): QualityEvaluationAnswers | undefined {
  if (!isRecord(value)) {
    return;
  }
  const compacted = value.compacted;
  const full = value.full;
  if (
    !(
      Array.isArray(compacted) &&
      Array.isArray(full) &&
      compacted.every((answer) => typeof answer === "string") &&
      full.every((answer) => typeof answer === "string")
    )
  ) {
    throw new TypeError("Invalid compare-pi evaluation answers.");
  }
  return { compacted, full };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
