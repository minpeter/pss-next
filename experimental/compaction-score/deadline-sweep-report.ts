import type {
  DeadlineHistoricalEvidence,
  DeadlineScenarioAggregate,
  DeadlineSweepReport,
} from "./deadline-sweep-types";

export function renderDeadlineSweepReport(report: DeadlineSweepReport): string {
  return [
    "# Compaction deadline sweep",
    "",
    `- Mode: \`${report.mode}\``,
    `- Model: \`${report.model}\``,
    `- Deadlines: ${report.deadlinesMs.join(", ")} ms`,
    `- Historical uncapped evidence: ${historicalLabel(report.historical)}`,
    "",
    ...Object.entries(report.scenarios).flatMap(([scenario, rows]) => [
      `## ${scenario}`,
      "",
      "| Deadline | Provider start | Timeout | Candidate applied |",
      "|---:|---:|---:|---:|",
      ...report.deadlinesMs.map((deadlineMs) =>
        rateRow(deadlineMs, rows[String(deadlineMs)])
      ),
      "",
      "| Deadline | Decision mean (bootstrap 95% CI) | Reliability | Typed timeout | Path valid | Summary calls |",
      "|---:|---:|---:|---:|---:|---:|",
      ...report.deadlinesMs.map((deadlineMs) =>
        diagnosticsRow(deadlineMs, rows[String(deadlineMs)])
      ),
      "",
      `Full-dimension Pareto deadlines: ${(report.pareto[scenario] ?? [])
        .map((deadline) => `${deadline}ms`)
        .join(", ")}`,
      `Historical-comparable Pareto: ${
        (report.historicalPareto[scenario] ?? []).join(", ") || "unavailable"
      }`,
      "",
    ]),
    "## Paired latency comparisons",
    "",
    "| Scenario | From | To | Pairs | Mean delta (bootstrap 95% CI) | Provider delta | Candidate delta |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.paired.map(
      (row) =>
        `| ${row.scenario} | ${row.fromDeadlineMs}ms | ${row.toDeadlineMs}ms | ${row.pairs} | ${signed(row.latencyDeltaMeanMs)} [${signed(row.latencyDeltaMeanCi95[0])}, ${signed(row.latencyDeltaMeanCi95[1])}] | ${signedPercent(row.providerStartedDelta)} | ${signedPercent(row.candidateAppliedDelta)} |`
    ),
    "",
    "Decision latency, provider availability, policy timeout, candidate application, typed-timeout integrity, reliability, and summary-call cost remain separate Pareto dimensions.",
    "The historical comparison uses only the three common dimensions: decision latency, provider start, and candidate application.",
    "",
  ].join("\n");
}

function rateRow(
  deadlineMs: number,
  row: DeadlineScenarioAggregate | undefined
): string {
  if (row === undefined) {
    return `| ${deadlineMs}ms | unavailable | unavailable | unavailable |`;
  }
  return `| ${deadlineMs}ms | ${rate(row.providerStarted)} | ${rate(row.timeout)} | ${rate(row.candidateApplied)} |`;
}

function diagnosticsRow(
  deadlineMs: number,
  row: DeadlineScenarioAggregate | undefined
): string {
  if (row === undefined) {
    return `| ${deadlineMs}ms | unavailable | unavailable | unavailable | unavailable | unavailable |`;
  }
  const latency = row.decisionLatencyMs;
  return `| ${deadlineMs}ms | ${milliseconds(latency.mean)} [${milliseconds(latency.meanCi95[0])}, ${milliseconds(latency.meanCi95[1])}] | ${rate(row.reliability)} | ${row.typedTimeoutIntegrity === null ? "n/a" : rate(row.typedTimeoutIntegrity)} | ${rate(row.pathValid)} | ${row.summaryCallsMean.toFixed(2)} |`;
}

function historicalLabel(
  historical: DeadlineHistoricalEvidence | null
): string {
  return historical === null
    ? "not supplied (deterministic QA only)"
    : `\`${historical.source}\` (SHA-256 \`${historical.sha256}\`)`;
}

function rate(value: {
  readonly rate: number;
  readonly wilson95: readonly [number, number];
}): string {
  return `${percentage(value.rate)} [${percentage(value.wilson95[0])}, ${percentage(value.wilson95[1])}]`;
}

function milliseconds(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${milliseconds(value)}`;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${percentage(value)}`;
}
