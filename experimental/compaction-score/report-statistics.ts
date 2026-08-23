export interface Distribution {
  readonly max: number;
  readonly mean: number;
  readonly min: number;
  readonly quantiles: {
    readonly p50: number;
    readonly p95: number;
  };
  readonly standardDeviation: number;
}

export interface WilsonInterval {
  readonly high: number;
  readonly low: number;
}

export function distribution(values: readonly number[]): Distribution {
  let maximum = Number.NEGATIVE_INFINITY;
  let minimum = Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const value of values) {
    maximum = Math.max(maximum, value);
    minimum = Math.min(minimum, value);
    sum += value;
  }
  const mean = sum / values.length;
  let squaredDifferenceSum = 0;
  for (const value of values) {
    squaredDifferenceSum += (value - mean) ** 2;
  }

  return {
    max: maximum,
    mean,
    min: minimum,
    quantiles: {
      p50: quantile(values, 0.5),
      p95: quantile(values, 0.95),
    },
    standardDeviation: Math.sqrt(squaredDifferenceSum / values.length),
  };
}

export function wilson95(correct: number, total: number): WilsonInterval {
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
