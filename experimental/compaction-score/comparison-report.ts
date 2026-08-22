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
  const normalizedModel = artifact.model.replace(/[\r\n]+/g, " ");
  const backtickRuns = normalizedModel.match(/`+/g) ?? [];
  const modelFence = "`".repeat(
    Math.max(1, ...backtickRuns.map((run) => run.length + 1))
  );
  const renderedModel =
    backtickRuns.length === 0
      ? `${modelFence}${normalizedModel}${modelFence}`
      : `${modelFence} ${normalizedModel} ${modelFence}`;
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
  const failures = METHODS.flatMap(({ artifactKey, label }) =>
    [...artifact.failures[artifactKey].entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `| ${label} | ${status} | ${count} |`)
  );
  if (failures.length > 0) {
    lines.push(
      "",
      "## Invalid attempts",
      "",
      "| Method | Status | Count |",
      "| --- | --- | ---: |",
      ...failures
    );
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

function score(correct: number, total: number): string {
  return total === 0
    ? "unavailable"
    : `${correct}/${total} (${percentage(correct / total)})`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
