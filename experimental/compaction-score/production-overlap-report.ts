import {
  aggregateProductionOverlap,
  productionOverlapMethodology,
} from "./production-overlap-analysis";
import type {
  ProductionOverlapAttempt,
  ProductionOverlapPair,
  ProductionOverlapReport,
} from "./production-overlap-types";

export function createProductionOverlapReport({
  attempts,
  attemptTimeoutMs,
  mode,
  model,
  pairs,
  repetitions,
}: {
  readonly attempts: readonly ProductionOverlapAttempt[];
  readonly attemptTimeoutMs: number;
  readonly mode: ProductionOverlapReport["mode"];
  readonly model: string;
  readonly pairs: readonly ProductionOverlapPair[];
  readonly repetitions: number;
}): ProductionOverlapReport {
  const scenarios = [...new Set(pairs.map((pair) => pair.scenario))];
  return {
    aggregates: scenarios.map((scenario) =>
      aggregateProductionOverlap(scenario, pairs)
    ),
    attempts,
    attemptTimeoutMs,
    createdAt: new Date().toISOString(),
    methodology: productionOverlapMethodology,
    mode,
    model,
    pairs,
    repetitions,
    schemaVersion: "production-overlap-v1",
  };
}

export function renderProductionOverlapReport(
  report: ProductionOverlapReport
): string {
  return [
    "# Production speculative overlap",
    "",
    `- Mode: \`${report.mode}\``,
    `- Model: \`${report.model}\``,
    `- Valid pairs: ${report.pairs.length}`,
    `- Attempt errors: ${report.attempts.filter((attempt) => attempt.status === "error").length}`,
    "",
    "| Scenario | Dispatch block | Actual user block | Decision delta | Completion delta | Candidate | Overlap |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.aggregates.map(
      (row) =>
        `| ${row.scenario} | ${milliseconds(row.dispatchBlockMs.mean)} | ${milliseconds(row.actualUserBlockMs.mean)} | ${signedMilliseconds(row.decisionDeltaMs.mean)} | ${signedMilliseconds(row.completionDeltaMs.mean)} | ${percentage(row.candidateApplied.rate)} | ${percentage(row.overlap.rate)} |`
    ),
    "",
    "Actual user block is max(0, paired treatment-control time-to-first-visible delta).",
    "Dispatch block is reported separately and is not labeled user-visible blocking.",
    "",
  ].join("\n");
}

function milliseconds(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedMilliseconds(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}ms`;
}
