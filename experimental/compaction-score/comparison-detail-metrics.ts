import {
  type ComparisonStatistics,
  renderComparisonStatistics,
  summarizeComparisonStatistics,
} from "./comparison-statistics";

export interface ComparisonHopMetric {
  readonly compactionMs?: number;
  readonly prefixTokens: number;
  readonly summarizerInputTokens?: number;
  readonly summaryTokens: number;
}

export interface ComparisonDetailMetrics {
  readonly compactions: number;
  readonly exactFactsPerThousandSummaryTokens: number;
  readonly latency: {
    readonly maxMs: number;
    readonly meanMs: number;
    readonly measured: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly inputTokensPerSecond: number | null;
    readonly totalMs: number;
  } | null;
  readonly meanSummaryTokens: number;
  readonly prefixTokens: number;
  readonly removedTokens: number;
  readonly semanticFactsPerThousandSummaryTokens: number;
  readonly statistics: ComparisonStatistics;
  readonly summarizerInputTokens: number | null;
  readonly summaryTokens: number;
}

interface ComparisonDetailInput {
  readonly hops: readonly ComparisonHopMetric[];
  readonly invalid: number;
  readonly retained: number;
  readonly semanticRetained: number;
  readonly total: number;
  readonly valid: number;
}

interface LabeledDetail {
  readonly label: string;
  readonly metrics: ComparisonDetailMetrics | null;
}

export function summarizeComparisonDetails({
  hops,
  invalid,
  retained,
  semanticRetained,
  total,
  valid,
}: ComparisonDetailInput): ComparisonDetailMetrics | null {
  if (hops.length === 0) {
    return null;
  }
  const prefixTokens = checkedSum(hops.map((hop) => hop.prefixTokens));
  const summaryTokens = checkedSum(hops.map((hop) => hop.summaryTokens));
  const timed = hops.filter(
    (
      hop
    ): hop is ComparisonHopMetric & {
      readonly compactionMs: number;
    } => hop.compactionMs !== undefined
  );
  const durations = timed.map((hop) => hop.compactionMs);
  const compressionRatios = hops.map(
    (hop) => hop.summaryTokens / hop.prefixTokens
  );
  const totalMs = checkedSum(durations);
  const timedInputTokens = timed.every(
    (hop) => hop.summarizerInputTokens !== undefined
  )
    ? checkedSum(timed.map((hop) => hop.summarizerInputTokens ?? 0))
    : null;
  const summarizerInputTokens = hops.every(
    (hop) => hop.summarizerInputTokens !== undefined
  )
    ? checkedSum(hops.map((hop) => hop.summarizerInputTokens ?? 0))
    : null;
  const densityScale = summaryTokens === 0 ? 0 : 1000 / summaryTokens;
  let inputTokensPerSecond: number | null = null;
  if (timedInputTokens !== null) {
    inputTokensPerSecond =
      totalMs === 0 ? 0 : (timedInputTokens * 1000) / totalMs;
  }
  const metrics: ComparisonDetailMetrics = {
    compactions: hops.length,
    exactFactsPerThousandSummaryTokens: retained * densityScale,
    latency:
      durations.length === 0
        ? null
        : {
            maxMs: durations.reduce(
              (maximum, duration) => Math.max(maximum, duration),
              0
            ),
            meanMs: totalMs / durations.length,
            measured: durations.length,
            p50Ms: quantile(durations, 0.5),
            p95Ms: quantile(durations, 0.95),
            inputTokensPerSecond,
            totalMs,
          },
    meanSummaryTokens: summaryTokens / hops.length,
    prefixTokens,
    removedTokens: prefixTokens - summaryTokens,
    semanticFactsPerThousandSummaryTokens: semanticRetained * densityScale,
    statistics: summarizeComparisonStatistics({
      compressionRatios,
      durations,
      invalid,
      retained,
      semanticRetained,
      total,
      valid,
    }),
    summarizerInputTokens,
    summaryTokens,
  };
  assertFiniteMetrics(metrics);
  return metrics;
}

export function renderComparisonDetails(
  details: readonly LabeledDetail[]
): readonly string[] {
  if (details.every(({ metrics }) => metrics === null)) {
    return [];
  }
  return [
    "",
    "## Token footprint",
    "",
    "| Method | Compactions | Source tokens | Summarizer input | Summary tokens | Removed tokens | Mean summary/hop | Exact facts/1k summary tokens | Semantic facts/1k summary tokens |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...details.map(renderTokenRow),
    "",
    "_Token counts are deterministic context estimates, not provider billing usage._",
    "",
    "## Synchronous compaction critical path",
    "",
    "| Method | Measured | Total compaction time | Mean | P50 | P95 | Max | Input throughput |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...details.map(renderLatencyRow),
    "",
    "_This benchmark measures direct compaction critical-path time. It is an upper bound, not production user-visible block time; speculative gate overlap requires a separate runtime benchmark._",
    ...renderComparisonStatistics(
      details.map(({ label, metrics }) => ({
        label,
        statistics: metrics?.statistics ?? null,
      }))
    ),
  ];
}

export function formatMilliseconds(value: number): string {
  return `${decimal(value)} ms`;
}

function renderTokenRow({ label, metrics }: LabeledDetail): string {
  if (metrics === null) {
    return `| ${label} | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |`;
  }
  return [
    `| ${label}`,
    metrics.compactions,
    integer(metrics.prefixTokens),
    metrics.summarizerInputTokens === null
      ? "unavailable"
      : integer(metrics.summarizerInputTokens),
    integer(metrics.summaryTokens),
    integer(metrics.removedTokens),
    decimal(metrics.meanSummaryTokens),
    decimal(metrics.exactFactsPerThousandSummaryTokens),
    `${decimal(metrics.semanticFactsPerThousandSummaryTokens)} |`,
  ].join(" | ");
}

function renderLatencyRow({ label, metrics }: LabeledDetail): string {
  const latency = metrics?.latency;
  if (!(metrics && latency)) {
    return `| ${label} | 0/${metrics?.compactions ?? 0} | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |`;
  }
  return [
    `| ${label}`,
    `${latency.measured}/${metrics.compactions}`,
    formatMilliseconds(latency.totalMs),
    formatMilliseconds(latency.meanMs),
    formatMilliseconds(latency.p50Ms),
    formatMilliseconds(latency.p95Ms),
    formatMilliseconds(latency.maxMs),
    `${
      latency.inputTokensPerSecond === null
        ? "unavailable"
        : `${decimal(latency.inputTokensPerSecond)} tok/s`
    } |`,
  ].join(" | ");
}

function checkedSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Metric total exceeds the supported numeric range.");
    }
  }
  return total;
}

function assertFiniteMetrics(metrics: ComparisonDetailMetrics): void {
  const values = [
    metrics.exactFactsPerThousandSummaryTokens,
    metrics.meanSummaryTokens,
    metrics.removedTokens,
    metrics.semanticFactsPerThousandSummaryTokens,
    metrics.statistics.compressionRatioStandardDeviation,
    ...(metrics.statistics.latencyStandardDeviation === null
      ? []
      : [metrics.statistics.latencyStandardDeviation]),
    ...(metrics.latency === null
      ? []
      : Object.values(metrics.latency).filter((value) => value !== null)),
  ];
  if (!values.every(Number.isFinite)) {
    throw new RangeError("Derived comparison metrics must be finite.");
  }
}

function quantile(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new TypeError("Cannot compute a quantile for an empty distribution.");
  }
  return lower + (upper - lower) * (index - lowerIndex);
}

function decimal(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    useGrouping: true,
  });
}

function integer(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 0,
    useGrouping: true,
  });
}
