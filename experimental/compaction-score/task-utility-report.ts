import {
  bootstrapMeanCi95,
  finiteMean,
  finiteQuantile,
  finiteRatio,
  finiteWilson95,
  sortedFiniteValues,
} from "./finite-statistics";
import type {
  TaskLatencyMetric,
  TaskRateMetric,
  TaskUtilityArm,
  TaskUtilityPair,
  TaskUtilityReport,
} from "./task-utility-types";

export function createTaskUtilityReport({
  attemptTimeoutMs = 10 * 60 * 1000,
  mode,
  model,
  pairs,
  repetitions,
}: Pick<TaskUtilityReport, "mode" | "model" | "repetitions"> & {
  readonly attemptTimeoutMs?: number;
  readonly pairs: readonly TaskUtilityPair[];
}): TaskUtilityReport {
  const fullSuccesses = pairs.filter((pair) => pair.fullPassed);
  const compactSuccesses = fullSuccesses.filter((pair) => pair.compactPassed);
  return {
    attemptTimeoutMs,
    createdAt: new Date().toISOString(),
    fixtures: [...new Set(pairs.map((pair) => pair.fixture))],
    methodology: {
      compactSuccessCondition: "conditioned-on-full-success",
      costPolicy: "null-without-explicit-rates",
      interval: "wilson-95",
    },
    mode,
    model,
    pairs,
    repetitions,
    schemaVersion: "task-utility-v1",
    summary: {
      compactConditionalSuccess: rateSummary(
        compactSuccesses.length,
        fullSuccesses.length
      ),
      compactCostUsd: null,
      compactLatencyMs: latencySummary(pairs, "compact"),
      compactQuality: qualitySummary(pairs, "compact"),
      contextLossFailures: pairs.filter(
        (pair) => pair.classification === "context-loss-failure"
      ).length,
      fullControlSuccess: rateSummary(fullSuccesses.length, pairs.length),
      fullCostUsd: null,
      fullLatencyMs: latencySummary(pairs, "full"),
      fullQuality: qualitySummary(pairs, "full"),
      invalidFullControls: pairs.length - fullSuccesses.length,
      retainedSuccesses: pairs.filter(
        (pair) => pair.classification === "retained-success"
      ).length,
    },
  };
}

export function renderTaskUtilityReport(report: TaskUtilityReport): string {
  return [
    "# Downstream coding-agent task utility",
    "",
    `- Mode: \`${report.mode}\``,
    `- Repetitions: ${report.repetitions}`,
    `- Model: \`${report.model}\``,
    `- Full-control success: ${percentage(report.summary.fullControlSuccess.rate)}`,
    `- Compact conditional success: ${percentage(report.summary.compactConditionalSuccess.rate)}`,
    "",
    "| Fixture | Full success | Compact success | Classification | Full latency | Compact latency |",
    "|---|---:|---:|---|---:|---:|",
    ...report.pairs.map((pair) => {
      const full = pair.arms.find((arm) => arm.arm === "full");
      const compact = pair.arms.find((arm) => arm.arm === "compact");
      return `| ${pair.fixture} | ${yesNo(pair.fullPassed)} | ${yesNo(pair.compactPassed)} | ${pair.classification} | ${milliseconds(full?.durationMs)} | ${milliseconds(compact?.durationMs)} |`;
    }),
    "",
    "Cost is null unless explicit provider pricing metadata is supplied.",
    "",
  ].join("\n");
}

function rateSummary(numerator: number, denominator: number): TaskRateMetric {
  return {
    denominator,
    rate: denominator === 0 ? 0 : finiteRatio(numerator, denominator),
    wilson95:
      denominator === 0 ? [0, 0] : finiteWilson95(numerator, denominator),
  };
}

function qualitySummary(
  pairs: readonly TaskUtilityPair[],
  arm: TaskUtilityArm
): TaskRateMetric {
  const results = pairs.flatMap((pair) =>
    pair.arms.filter((result) => result.arm === arm)
  );
  const checks = results.flatMap((result) => result.validation.checks);
  return rateSummary(
    checks.filter((check) => check.passed).length,
    checks.length
  );
}

function latencySummary(
  pairs: readonly TaskUtilityPair[],
  arm: TaskUtilityArm
): TaskLatencyMetric {
  const values = pairs.flatMap((pair) =>
    pair.arms
      .filter((result) => result.arm === arm)
      .map((result) => result.durationMs)
  );
  if (values.length === 0) {
    return { max: 0, mean: 0, meanCi95: [0, 0], p95: 0 };
  }
  const sorted = sortedFiniteValues(values);
  const maximum = sorted.at(-1);
  if (maximum === undefined) {
    throw new RangeError("Task latency indexes must refer to defined values.");
  }
  return {
    max: maximum,
    mean: finiteMean(values),
    meanCi95: bootstrapMeanCi95(values, {
      iterations: 10_000,
      random: seededRandom(`2718:${arm}`),
    }),
    p95: finiteQuantile(sorted, 0.95),
  };
}

function seededRandom(seed: string): () => number {
  let state = [...seed].reduce(
    (total, character) => total + character.charCodeAt(0),
    0
  );
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function milliseconds(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value.toFixed(1)}ms`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
