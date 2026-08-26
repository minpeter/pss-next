export interface BootstrapMeanOptions {
  readonly iterations: number;
  readonly random: () => number;
}

export function finiteMean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot compute a mean from an empty sample.");
  }

  let scale = 0;
  let total = 0;
  let overflowed = false;
  for (const value of values) {
    requireFinite(value, "Statistic input");
    scale = Math.max(scale, Math.abs(value));
    total += value;
    overflowed ||= !Number.isFinite(total);
  }
  if (!overflowed) {
    return requireFinite(total / values.length, "Statistic mean");
  }

  let scaledTotal = 0;
  for (const value of values) {
    scaledTotal += value / scale;
  }
  return requireFinite((scaledTotal / values.length) * scale, "Statistic mean");
}

export function finiteSum(values: readonly number[]): number {
  let scale = 0;
  let total = 0;
  let overflowed = false;
  for (const value of values) {
    requireFinite(value, "Statistic input");
    scale = Math.max(scale, Math.abs(value));
    total += value;
    overflowed ||= !Number.isFinite(total);
  }
  if (!overflowed) {
    return total;
  }

  let scaledTotal = 0;
  for (const value of values) {
    scaledTotal += value / scale;
  }
  return requireFinite(scaledTotal * scale, "Statistic sum");
}

export function sortedFiniteValues(
  values: readonly number[]
): readonly number[] {
  for (const value of values) {
    requireFinite(value, "Statistic input");
  }
  return [...values].sort((left, right) => left - right);
}

export function finiteQuantile(
  sortedValues: readonly number[],
  probability: number
): number {
  if (!(Number.isFinite(probability) && probability >= 0 && probability <= 1)) {
    throw new RangeError("Quantile probability must be from zero through one.");
  }
  if (sortedValues.length === 0) {
    throw new RangeError("Cannot compute a quantile from an empty sample.");
  }

  let previous = Number.NEGATIVE_INFINITY;
  for (const value of sortedValues) {
    requireFinite(value, "Quantile input");
    if (value < previous) {
      throw new RangeError("Quantile input must be sorted.");
    }
    previous = value;
  }

  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new RangeError("Quantile indexes must refer to defined values.");
  }
  const weight = position - lowerIndex;
  const difference = upper - lower;
  const value = Number.isFinite(difference)
    ? lower + difference * weight
    : lower * (1 - weight) + upper * weight;
  return requireFinite(value, "Statistic quantile");
}

export function bootstrapMeanCi95(
  values: readonly number[],
  options: BootstrapMeanOptions
): readonly [number, number] {
  if (!(Number.isSafeInteger(options.iterations) && options.iterations > 0)) {
    throw new RangeError(
      "Bootstrap iterations must be a positive safe integer."
    );
  }
  const pointEstimate = finiteMean(values);
  const first = values[0];
  if (first === undefined) {
    throw new RangeError("Cannot bootstrap an empty sample.");
  }
  if (values.every((value) => Object.is(value, first))) {
    return [pointEstimate, pointEstimate];
  }

  const draws: number[] = [];
  for (let draw = 0; draw < options.iterations; draw += 1) {
    const sample: number[] = [];
    for (const _value of values) {
      const sampled = values[Math.floor(options.random() * values.length)];
      if (sampled === undefined) {
        throw new RangeError("Bootstrap index must refer to a defined value.");
      }
      sample.push(sampled);
    }
    draws.push(finiteMean(sample));
  }
  const sortedDraws = sortedFiniteValues(draws);
  return [
    finiteQuantile(sortedDraws, 0.025),
    finiteQuantile(sortedDraws, 0.975),
  ];
}

export function finiteWilson95(
  correct: number,
  total: number
): readonly [number, number] {
  if (!(Number.isSafeInteger(total) && total > 0)) {
    throw new RangeError("Wilson total must be a positive safe integer.");
  }
  if (!(Number.isSafeInteger(correct) && correct >= 0 && correct <= total)) {
    throw new RangeError(
      "Wilson correct count must be a safe integer from zero through total."
    );
  }

  const z = 1.96;
  const probability = correct / total;
  const denominator = 1 + (z * z) / total;
  const center = probability + (z * z) / (2 * total);
  const margin =
    z *
    Math.sqrt(
      (probability * (1 - probability)) / total + (z * z) / (4 * total * total)
    );
  const low = Math.max(0, (center - margin) / denominator);
  const high = Math.min(1, (center + margin) / denominator);
  return [
    requireFinite(low, "Wilson lower bound"),
    requireFinite(high, "Wilson upper bound"),
  ];
}

export function finiteRatio(numerator: number, denominator: number): number {
  requireFinite(numerator, "Statistic numerator");
  requireFinite(denominator, "Statistic denominator");
  return requireFinite(numerator / denominator, "Statistic ratio");
}

export function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite.`);
  }
  return value;
}
