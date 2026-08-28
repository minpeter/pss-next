export interface LatencySummary {
  readonly count: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export class InvalidStatisticError extends Error {
  readonly name = "InvalidStatisticError";
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid statistic input: ${reason}`);
    this.reason = reason;
  }
}

export function linearQuantile(
  samples: readonly number[],
  quantile: number
): number {
  if (samples.length === 0) {
    throw new InvalidStatisticError("samples must not be empty");
  }
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new InvalidStatisticError(
      "quantile must be finite and within [0, 1]"
    );
  }
  if (!samples.every(Number.isFinite)) {
    throw new InvalidStatisticError("samples must be finite");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return quantileFromSorted(sorted, quantile);
}

export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  if (samples.length === 0 || !samples.every(Number.isFinite)) {
    throw new InvalidStatisticError("latencies must be non-empty and finite");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const minimum = sorted[0];
  const maximum = sorted.at(-1);
  if (minimum === undefined || maximum === undefined) {
    throw new InvalidStatisticError("latencies must not be empty");
  }
  return {
    count: sorted.length,
    maxMs: maximum,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    minMs: minimum,
    p50Ms: quantileFromSorted(sorted, 0.5),
    p95Ms: quantileFromSorted(sorted, 0.95),
    p99Ms: quantileFromSorted(sorted, 0.99),
  };
}

function quantileFromSorted(
  sorted: readonly number[],
  quantile: number
): number {
  const position = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new InvalidStatisticError("quantile position is outside samples");
  }
  return lower + (upper - lower) * (position - lowerIndex);
}
