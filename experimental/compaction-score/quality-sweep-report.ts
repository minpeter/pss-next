import type { QualitySweepReport } from "./quality-sweep-types";

export function renderQualitySweepReport(report: QualitySweepReport): string {
  return [
    "# Matched-quality output-budget sweep",
    "",
    `- Mode: \`${report.mode}\``,
    `- Model: \`${report.model}\``,
    `- Repetitions: ${report.repetitions}`,
    `- Budgets: ${report.budgets.join(", ")}`,
    `- Output budget enforcement: \`${report.methodology.outputBudgetEnforcement}\``,
    "- Scope: final assembled summary, including deterministic PSS tool evidence and pi file-operation state, before compression validation and scoring.",
    "",
    "## Matched quality",
    "",
    "| Quality | PSS budget | pi budget | pi/PSS | Bootstrap draws |",
    "|---:|---:|---:|---:|---:|",
    ...report.matchedQuality.map(
      (point) =>
        `| ${percentage(point.quality)} | ${number(point.pssBudget)} | ${number(point.piBudget)} | ${point.ratio.toFixed(3)} | ${point.bootstrapValidDraws} |`
    ),
    "",
    "## Budget cells",
    "",
    "| Arm | Budget | Status | Control | Retention | Valid | Invalid | Compression | Latency | Summary tokens | Cost |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.cells.map(
      (cell) =>
        `| ${cell.arm} | ${cell.budget} | ${cell.budgetStatus} | ${cell.controlTotal === 0 ? "n/a" : `${cell.controlCorrect}/${cell.controlTotal}`} | ${cell.total === 0 ? "n/a" : percentage(cell.correct / cell.total)} | ${cell.valid} | ${cell.invalid} | ${nullable(cell.compressionRatioMean)} | ${nullable(cell.latencyMeanMs, "ms")} | ${cell.summaryTokens} | ${cell.costUsd === null ? "n/a" : `$${cell.costUsd.toFixed(4)}`} |`
    ),
    "",
    "Cost is reported as unavailable unless the campaign manifest supplies explicit provider rates.",
    "",
  ].join("\n");
}

function number(value: number): string {
  return value.toFixed(1);
}

function nullable(value: number | null, suffix = ""): string {
  return value === null ? "n/a" : `${value.toFixed(3)}${suffix}`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
