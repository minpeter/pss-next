const METHODS = [
  { artifactKey: "pss", label: "PSS" },
  { artifactKey: "pi", label: "pi-coding-agent" },
] as const;

interface ArmAggregate {
  readonly compressionMean: number | null;
  readonly invalid: number;
  readonly retained: number;
  readonly semanticRetained: number;
  readonly total: number;
  readonly valid: number;
}

interface ComparisonArtifact {
  readonly arms: Readonly<Record<(typeof METHODS)[number]["artifactKey"], ArmAggregate>>;
  readonly failures: Readonly<
    Record<
      (typeof METHODS)[number]["artifactKey"],
      ReadonlyMap<string, number>
    >
  >;
  readonly model: string;
}

export class ComparisonArtifactError extends Error {
  readonly name = "ComparisonArtifactError";
}

export function renderComparisonMarkdown(value: unknown): string {
  const artifact = parseComparisonArtifact(value);
  const lines = [
    "# Compaction comparison",
    "",
    `Model: \`${artifact.model}\``,
    "",
    "| Method | Valid | Invalid | Exact retention | Semantic retention | Summary ratio | Savings | Compaction latency |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...METHODS.map(({ artifactKey, label }) =>
      renderArm(label, artifact.arms[artifactKey])
    ),
    "",
    "_Comparator-specific compaction latency is not present in comparison.json._",
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

function parseComparisonArtifact(value: unknown): ComparisonArtifact {
  const root = record(value, "comparison artifact");
  const aggregate = record(root.aggregate, "aggregate");
  const overall = record(aggregate.overall, "aggregate.overall");
  const failures = {
    pi: new Map<string, number>(),
    pss: new Map<string, number>(),
  };
  for (const rowValue of array(root.rows, "rows")) {
    const row = record(rowValue, "row");
    for (const { artifactKey } of METHODS) {
      const arm = record(row[artifactKey], `row.${artifactKey}`);
      const status = string(arm.status, `row.${artifactKey}.status`);
      if (status !== "valid") {
        const counts = failures[artifactKey];
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
    }
  }
  return {
    arms: {
      pi: parseArm(overall.pi, "aggregate.overall.pi"),
      pss: parseArm(overall.pss, "aggregate.overall.pss"),
    },
    failures,
    model: string(root.model, "model"),
  };
}

function parseArm(value: unknown, path: string): ArmAggregate {
  const arm = record(value, path);
  return {
    compressionMean: nullableNumber(
      arm.compressionMean,
      `${path}.compressionMean`
    ),
    invalid: nonnegativeInteger(arm.invalid, `${path}.invalid`),
    retained: nonnegativeInteger(arm.retained, `${path}.retained`),
    semanticRetained: nonnegativeInteger(
      arm.semanticRetained,
      `${path}.semanticRetained`
    ),
    total: nonnegativeInteger(arm.total, `${path}.total`),
    valid: nonnegativeInteger(arm.valid, `${path}.valid`),
  };
}

function renderArm(label: string, arm: ArmAggregate): string {
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
    "unavailable |",
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

function record(
  value: unknown,
  path: string
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new ComparisonArtifactError(`${path} must be an object.`);
  }
  return value;
}

function isRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ComparisonArtifactError(`${path} must be an array.`);
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ComparisonArtifactError(`${path} must be a non-empty string.`);
  }
  return value;
}

function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  return finiteNumber(value, path);
}

function nonnegativeInteger(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (!(Number.isInteger(parsed) && parsed >= 0)) {
    throw new ComparisonArtifactError(
      `${path} must be a non-negative integer.`
    );
  }
  return parsed;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ComparisonArtifactError(`${path} must be a finite number.`);
  }
  return value;
}
