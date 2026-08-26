import {
  finiteMean,
  finiteQuantile,
  finiteWilson95,
  requireFinite,
  sortedFiniteValues,
} from "./finite-statistics";

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
  if (values.length === 0) {
    throw new RangeError("Cannot summarize an empty distribution.");
  }
  const sorted = sortedFiniteValues(values);
  const minimum = sorted[0];
  const maximum = sorted.at(-1);
  if (minimum === undefined || maximum === undefined) {
    throw new RangeError("Distribution indexes must refer to defined values.");
  }
  const mean = finiteMean(values);
  return {
    max: maximum,
    mean,
    min: minimum,
    quantiles: {
      p50: finiteQuantile(sorted, 0.5),
      p95: finiteQuantile(sorted, 0.95),
    },
    standardDeviation: standardDeviation(values, mean),
  };
}

export function wilson95(correct: number, total: number): WilsonInterval {
  const [low, high] = finiteWilson95(correct, total);
  return { high, low };
}

function standardDeviation(values: readonly number[], mean: number): number {
  let squaredDifferenceSum = 0;
  for (const value of values) {
    squaredDifferenceSum += (value - mean) ** 2;
  }
  if (Number.isFinite(squaredDifferenceSum)) {
    return requireFinite(
      Math.sqrt(squaredDifferenceSum / values.length),
      "Distribution standard deviation"
    );
  }

  let scale = 0;
  for (const value of values) {
    scale = Math.max(scale, Math.abs(value));
  }
  if (scale === 0) {
    return 0;
  }
  const scaledMean = mean / scale;
  let scaledSquaredDifferenceSum = 0;
  for (const value of values) {
    const difference = value / scale - scaledMean;
    scaledSquaredDifferenceSum += difference ** 2;
  }
  const scaledDeviation = Math.min(
    1,
    Math.sqrt(scaledSquaredDifferenceSum / values.length)
  );
  return requireFinite(
    scaledDeviation * scale,
    "Distribution standard deviation"
  );
}
