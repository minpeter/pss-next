export interface ComparisonStatistics {
  readonly compressionRatioStandardDeviation: number;
  readonly exactWilson95: WilsonInterval | null;
  readonly invalid: number;
  readonly latencyStandardDeviation: number | null;
  readonly semanticWilson95: WilsonInterval | null;
  readonly valid: number;
}

interface StatisticsInput {
  readonly compressionRatios: readonly number[];
  readonly durations: readonly number[];
  readonly invalid: number;
  readonly retained: number;
  readonly semanticRetained: number;
  readonly total: number;
  readonly valid: number;
}

interface WilsonInterval {
  readonly high: number;
  readonly low: number;
}

export function summarizeComparisonStatistics({
  compressionRatios,
  durations,
  invalid,
  retained,
  semanticRetained,
  total,
  valid,
}: StatisticsInput): ComparisonStatistics {
  return {
    compressionRatioStandardDeviation: standardDeviation(compressionRatios),
    exactWilson95: total === 0 ? null : wilson95(retained, total),
    invalid,
    latencyStandardDeviation:
      durations.length === 0 ? null : standardDeviation(durations),
    semanticWilson95: total === 0 ? null : wilson95(semanticRetained, total),
    valid,
  };
}

export function renderComparisonStatistics(
  details: readonly {
    readonly label: string;
    readonly statistics: ComparisonStatistics | null;
  }[]
): readonly string[] {
  return [
    "",
    "## Statistical diagnostics",
    "",
    "| Method | Exact Wilson 95% CI | Semantic Wilson 95% CI | Compression ratio SD | Latency SD | Invalid rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...details.map(renderStatisticsRow),
  ];
}

function renderStatisticsRow({
  label,
  statistics,
}: {
  readonly label: string;
  readonly statistics: ComparisonStatistics | null;
}): string {
  if (!statistics) {
    return `| ${label} | unavailable | unavailable | unavailable | unavailable | unavailable |`;
  }
  const attempted = statistics.valid + statistics.invalid;
  return [
    `| ${label}`,
    interval(statistics.exactWilson95),
    interval(statistics.semanticWilson95),
    percentage(statistics.compressionRatioStandardDeviation),
    statistics.latencyStandardDeviation === null
      ? "unavailable"
      : formatMilliseconds(statistics.latencyStandardDeviation),
    `${
      attempted === 0
        ? "unavailable"
        : `${statistics.invalid}/${attempted} (${percentage(
            statistics.invalid / attempted
          )})`
    } |`,
  ].join(" | ");
}

function standardDeviation(values: readonly number[]): number {
  const mean = sum(values) / values.length;
  return Math.sqrt(
    sum(values.map((value) => (value - mean) ** 2)) / values.length
  );
}

function wilson95(correct: number, total: number): WilsonInterval {
  const z = 1.96;
  const probability = correct / total;
  const denominator = 1 + z ** 2 / total;
  const center = (probability + z ** 2 / (2 * total)) / denominator;
  const margin =
    (z *
      Math.sqrt(
        (probability * (1 - probability) + z ** 2 / (4 * total)) / total
      )) /
    denominator;
  return {
    high: Math.min(1, center + margin),
    low: Math.max(0, center - margin),
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function interval(value: WilsonInterval | null): string {
  return value === null
    ? "unavailable"
    : `${percentage(value.low)}-${percentage(value.high)}`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}
