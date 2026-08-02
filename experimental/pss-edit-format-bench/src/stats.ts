/**
 * Uncertainty statistics for the bench report, following the harness practice
 * verified from OpenAI evals (bootstrap std), lm-eval-harness (bootstrap
 * stderr), and HELM (paired bootstrap for method-vs-method comparisons).
 * All estimators are seeded so a report is reproducible from its attempts.
 */
export interface CellStats {
  readonly attempts: number;
  readonly passed: number;
  readonly rate: number;
  readonly se: number;
  readonly ciLow: number;
  readonly ciHigh: number;
}

export interface DeltaStats {
  readonly pairs: number;
  readonly delta: number;
  readonly se: number;
  readonly ciLow: number;
  readonly ciHigh: number;
}

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const extractFingerprint = (body: unknown): string | null => {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const value = (body as Record<string, unknown>).system_fingerprint;
  return typeof value === "string" && value.length > 0 ? value : null;
};

const percentile = (sorted: readonly number[], q: number): number => {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(q * (sorted.length - 1)))
  );
  return sorted[index] as number;
};

const bootstrapMeans = (
  values: readonly number[],
  iterations: number,
  seed: number
): readonly number[] => {
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)] as number;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return means;
};

const spreadOf = (means: readonly number[]): number => {
  const mean = means.reduce((sum, value) => sum + value, 0) / means.length;
  const variance =
    means.reduce((sum, value) => sum + (value - mean) ** 2, 0) / means.length;
  return Math.sqrt(variance);
};

export const bootstrapCell = (
  passes: readonly boolean[],
  iterations = 10_000,
  seed = 42
): CellStats => {
  const attempts = passes.length;
  const passed = passes.filter(Boolean).length;
  const rate = attempts === 0 ? 0 : passed / attempts;
  if (attempts === 0) {
    return { attempts, ciHigh: 0, ciLow: 0, passed, rate, se: 0 };
  }
  const means = bootstrapMeans(passes.map(Number), iterations, seed);
  return {
    attempts,
    ciHigh: percentile(means, 0.975),
    ciLow: percentile(means, 0.025),
    passed,
    rate,
    se: spreadOf(means),
  };
};

export const pairedDelta = (
  a: readonly (boolean | null)[],
  b: readonly (boolean | null)[],
  iterations = 10_000,
  seed = 42
): DeltaStats => {
  const diffs: number[] = [];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left !== null && left !== undefined && right !== null && right !== undefined) {
      diffs.push(Number(left) - Number(right));
    }
  }
  const pairs = diffs.length;
  if (pairs === 0) {
    return { ciHigh: 0, ciLow: 0, delta: 0, pairs, se: 0 };
  }
  const delta = diffs.reduce((sum, value) => sum + value, 0) / pairs;
  const means = bootstrapMeans(diffs, iterations, seed);
  return {
    ciHigh: percentile(means, 0.975),
    ciLow: percentile(means, 0.025),
    delta,
    pairs,
    se: spreadOf(means),
  };
};
