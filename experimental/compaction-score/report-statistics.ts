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
  if (!values.every(Number.isFinite)) {
    throw new RangeError("Distribution values must be finite.");
  }

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

  const result = {
    max: maximum,
    mean,
    min: minimum,
    quantiles: {
      p50: quantile(values, 0.5),
      p95: quantile(values, 0.95),
    },
    standardDeviation: Math.sqrt(squaredDifferenceSum / values.length),
  };
  if (
    ![
      result.max,
      result.mean,
      result.min,
      result.quantiles.p50,
      result.quantiles.p95,
      result.standardDeviation,
    ].every(Number.isFinite)
  ) {
    throw new RangeError("Derived distribution metrics must be finite.");
  }
  return result;
}

export function wilson95(correct: number, total: number): WilsonInterval {
  if (!(Number.isSafeInteger(total) && total > 0)) {
    throw new RangeError(
      "Wilson interval total must be a positive safe integer."
    );
  }
  if (!(Number.isSafeInteger(correct) && correct >= 0 && correct <= total)) {
    throw new RangeError(
      "Wilson interval correct count must be a safe integer from zero through total."
    );
  }

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
