import {
  finiteMean,
  finiteQuantile,
  finiteRatio,
  finiteSum,
  finiteWilson95,
  requireFinite,
  sortedFiniteValues,
} from "./finite-statistics";
import {
  type MatchedQualityPoint,
  matchQualityCurves,
  type QualityCell,
} from "./quality-sweep-curve";
import type {
  MatchedQualityEstimate,
  QualitySweepCell,
  QualitySweepObservation,
} from "./quality-sweep-types";

const BOOTSTRAP_ITERATIONS = 10_000;
const BOOTSTRAP_SEED = 0xb4_d6_e7;

export function aggregateQualityCells(
  observations: readonly QualitySweepObservation[]
): readonly QualitySweepCell[] {
  const keys = [
    ...new Set(
      observations.map(({ arm, budget }) => `${arm}:${budget}` as const)
    ),
  ].sort();
  return keys.map((key) => {
    const [arm, budgetText] = key.split(":");
    if ((arm !== "pi" && arm !== "pss") || budgetText === undefined) {
      throw new TypeError("Invalid quality sweep cell key.");
    }
    const budget = Number(budgetText);
    const matching = observations.filter(
      (item) => item.arm === arm && item.budget === budget
    );
    const valid = matching.filter((item) => item.valid);
    const correct = finiteSum(valid.map((item) => item.correct));
    const total = finiteSum(valid.map((item) => item.total));
    const controlCorrect = finiteSum(valid.map((item) => item.controlCorrect));
    const controlTotal = finiteSum(valid.map((item) => item.controlTotal));
    const compression = valid.flatMap((item) =>
      item.compressionRatio === null ? [] : [item.compressionRatio]
    );
    const latencies = valid.flatMap((item) =>
      item.latencyMs === null ? [] : [item.latencyMs]
    );
    let budgetStatus: QualitySweepCell["budgetStatus"] = "budget-unknown";
    if (
      valid.length > 0 &&
      valid.every((item) =>
        item.sentOutputTokens.every((sent) => sent === item.budget)
      )
    ) {
      budgetStatus = "budget-exact";
    } else if (
      valid.length > 0 &&
      valid.every((item) =>
        item.sentOutputTokens.every((sent) => sent <= item.budget)
      )
    ) {
      budgetStatus = "budget-within-cap";
    } else if (valid.length > 0) {
      budgetStatus = "budget-clamped";
    }

    return {
      arm,
      budget,
      budgetStatus,
      compressionRatioMean: meanOrNull(compression),
      controlCorrect,
      controlsPassed:
        valid.length > 0 &&
        valid.every((observation) => observation.controlPassed),
      controlTotal,
      correct,
      costUsd: null,
      invalid: matching.length - valid.length,
      latencyMeanMs: meanOrNull(latencies),
      summarizerInputTokens: finiteSum(
        valid.map((item) => item.summarizerInputTokens)
      ),
      summaryTokens: finiteSum(valid.map((item) => item.summaryTokens)),
      total,
      valid: valid.length,
      wilson95: wilson95(correct, total),
    };
  });
}

export function matchedQualityEstimates(
  observations: readonly QualitySweepObservation[],
  targets: readonly number[]
): readonly MatchedQualityEstimate[] {
  const pointEstimate = matchFromObservations(observations, targets);
  const byTarget = new Map<
    number,
    { pi: number[]; pss: number[]; ratio: number[] }
  >(targets.map((quality) => [quality, { pi: [], pss: [], ratio: [] }]));
  const random = mulberry32(BOOTSTRAP_SEED);

  for (let draw = 0; draw < BOOTSTRAP_ITERATIONS; draw += 1) {
    const sample = bootstrapWithinCells(observations, random);
    for (const point of matchFromObservations(sample, targets)) {
      const values = byTarget.get(point.quality);
      if (values === undefined) {
        throw new TypeError("Missing matched-quality bootstrap target.");
      }
      values.pi.push(requireFinite(point.piBudget, "PI bootstrap budget"));
      values.pss.push(requireFinite(point.pssBudget, "PSS bootstrap budget"));
      values.ratio.push(finiteRatio(point.piBudget, point.pssBudget));
    }
  }

  return pointEstimate.map((point) => {
    const values = byTarget.get(point.quality);
    if (values === undefined) {
      throw new TypeError("Missing matched-quality bootstrap target.");
    }
    const enoughDraws = values.ratio.length >= BOOTSTRAP_ITERATIONS * 0.95;
    return {
      bootstrapValidDraws: values.ratio.length,
      piBudget: requireFinite(point.piBudget, "Matched PI budget"),
      piBudgetCi95: enoughDraws ? percentile95(values.pi) : null,
      pssBudget: requireFinite(point.pssBudget, "Matched PSS budget"),
      pssBudgetCi95: enoughDraws ? percentile95(values.pss) : null,
      quality: requireFinite(point.quality, "Matched quality"),
      ratio: finiteRatio(point.piBudget, point.pssBudget),
      ratioCi95: enoughDraws ? percentile95(values.ratio) : null,
    };
  });
}

export const qualitySweepMethodology = {
  bootstrapIterations: BOOTSTRAP_ITERATIONS,
  bootstrapSeed: BOOTSTRAP_SEED,
  calibrationSampling: "prefer-4096-fallback-nearest-captured-budget",
  interpolation: "pav-isotonic-inverse-linear",
  invalidPolicy: "excluded-with-explicit-count",
  outputBudgetEnforcement: "local-four-characters-per-token-hard-cap",
} as const;

function matchFromObservations(
  observations: readonly QualitySweepObservation[],
  targets: readonly number[]
): readonly MatchedQualityPoint[] {
  const cells = aggregateQualityCells(observations).filter(
    (cell) =>
      (cell.budgetStatus === "budget-exact" ||
        cell.budgetStatus === "budget-within-cap") &&
      cell.valid > 0 &&
      cell.total > 0
  );
  return matchQualityCurves(
    curveCells(cells, "pss"),
    curveCells(cells, "pi"),
    targets
  );
}

function curveCells(
  cells: readonly QualitySweepCell[],
  arm: "pi" | "pss"
): readonly QualityCell[] {
  return cells
    .filter((cell) => cell.arm === arm)
    .map(({ budget, correct, total }) => ({ budget, correct, total }));
}

function bootstrapWithinCells(
  observations: readonly QualitySweepObservation[],
  random: () => number
): readonly QualitySweepObservation[] {
  const groups = new Map<string, QualitySweepObservation[]>();
  for (const observation of observations.filter((item) => item.valid)) {
    const key = `${observation.arm}:${observation.budget}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) =>
    group.map(() => {
      const sampled = group[Math.floor(random() * group.length)];
      if (sampled === undefined) {
        throw new TypeError("Cannot bootstrap an empty quality sweep cell.");
      }
      return sampled;
    })
  );
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function percentile95(values: readonly number[]): readonly [number, number] {
  const sorted = sortedFiniteValues(values);
  return [finiteQuantile(sorted, 0.025), finiteQuantile(sorted, 0.975)];
}

function wilson95(correct: number, total: number): readonly [number, number] {
  return total === 0 ? [0, 0] : finiteWilson95(correct, total);
}

function meanOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : finiteMean(values);
}
