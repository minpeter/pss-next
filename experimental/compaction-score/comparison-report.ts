import {
  type ArmAggregate,
  parseComparisonArtifact,
} from "./comparison-artifact";
import {
  type ComparisonDetailMetrics,
  formatMilliseconds,
  renderComparisonDetails,
} from "./comparison-detail-metrics";

const METHODS = [
  { artifactKey: "pss", label: "PSS" },
  { artifactKey: "pi", label: "pi-coding-agent" },
] as const;

export function renderComparisonMarkdown(value: unknown): string {
  const artifact = parseComparisonArtifact(value);
  const backtickRuns = artifact.model.match(/`+/g) ?? [];
  const modelFence = "`".repeat(
    backtickRuns.reduce((longest, run) => Math.max(longest, run.length + 1), 1)
  );
  const renderedModel =
    backtickRuns.length === 0
      ? `${modelFence}${artifact.model}${modelFence}`
      : `${modelFence} ${artifact.model} ${modelFence}`;
  const lines = [
    "# Compaction comparison",
    "",
    `Model: ${renderedModel}`,
    "",
    "| Method | Valid | Invalid | Exact retention | Semantic retention | Summary ratio | Savings | Compaction latency |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...METHODS.map(({ artifactKey, label }) =>
      renderArm(
        label,
        artifact.arms[artifactKey],
        artifact.details[artifactKey]
      )
    ),
    ...(METHODS.every(({ artifactKey }) => {
      const details = artifact.details[artifactKey];
      return details === null || details.latency === null;
    })
      ? [
          "",
          "_Comparator-specific compaction latency is not present in comparison.json._",
        ]
      : []),
    ...renderComparisonDetails(
      METHODS.map(({ artifactKey, label }) => ({
        label,
        metrics: artifact.details[artifactKey],
      }))
    ),
  ];
  if (
    METHODS.some(({ artifactKey }) => artifact.failures[artifactKey].size > 0)
  ) {
    lines.push(
      "",
      "## Invalid attempts",
      "",
      "| Method | Status | Count |",
      "| --- | --- | ---: |"
    );
    for (const { artifactKey, label } of METHODS) {
      const failures = [...artifact.failures[artifactKey].entries()].sort(
        ([left], [right]) => left.localeCompare(right)
      );
      for (const [status, count] of failures) {
        lines.push(`| ${label} | ${escapeTableCell(status)} | ${count} |`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderArm(
  label: string,
  arm: ArmAggregate,
  details: ComparisonDetailMetrics | null
): string {
  const ratio =
    arm.compressionMean === null
      ? "unavailable"
      : percentage(arm.compressionMean);
  const savings =
    arm.compressionMean === null
      ? "unavailable"
      : percentage(1 - arm.compressionMean);
  return [
    `| ${label}`,
    arm.valid,
    arm.invalid,
    score(arm.retained, arm.total),
    score(arm.semanticRetained, arm.total),
    ratio,
    savings,
    `${
      details?.latency
        ? formatMilliseconds(details.latency.meanMs)
        : "unavailable"
    } |`,
  ].join(" | ");
}

function escapeTableCell(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|");
}

function score(correct: number, total: number): string {
  return total === 0
    ? "unavailable"
    : `${correct}/${total} (${percentage(correct / total)})`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
