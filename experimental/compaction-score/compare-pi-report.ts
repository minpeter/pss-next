import { HOLDOUT_SCENARIOS, ORIGINAL_SCENARIOS } from "./compare-pi-config";
import type { ArmResult, ComparisonRow } from "./compare-pi-types";

interface ArmAggregate {
  readonly compressionMean: number | null;
  readonly invalid: number;
  readonly retained: number;
  readonly semanticRetained: number;
  readonly total: number;
  readonly valid: number;
}

export function buildComparisonReport(
  rows: readonly ComparisonRow[],
  model: string
): {
  readonly aggregate: {
    readonly holdouts: {
      readonly pi: ArmAggregate;
      readonly pss: ArmAggregate;
    };
    readonly originals: {
      readonly pi: ArmAggregate;
      readonly pss: ArmAggregate;
    };
    readonly overall: { readonly pi: ArmAggregate; readonly pss: ArmAggregate };
  };
  readonly model: string;
  readonly rows: readonly ComparisonRow[];
} {
  const originalScenarios = new Set<string>(ORIGINAL_SCENARIOS);
  const holdoutScenarios = new Set<string>(HOLDOUT_SCENARIOS);
  const originals = rows.filter((row) => originalScenarios.has(row.scenario));
  const holdouts = rows.filter((row) => holdoutScenarios.has(row.scenario));
  return {
    aggregate: {
      holdouts: aggregateRows(holdouts),
      originals: aggregateRows(originals),
      overall: aggregateRows(rows),
    },
    model,
    rows,
  };
}

function aggregateRows(rows: readonly ComparisonRow[]): {
  readonly pi: ArmAggregate;
  readonly pss: ArmAggregate;
} {
  return {
    pi: aggregate(rows.map((row) => row.pi)),
    pss: aggregate(rows.map((row) => row.pss)),
  };
}

function aggregate(results: readonly ArmResult[]): ArmAggregate {
  let retained = 0;
  let semanticRetained = 0;
  let total = 0;
  const ratios: number[] = [];
  let valid = 0;
  for (const result of results) {
    if (result.status !== "valid" || !result.score) {
      continue;
    }
    valid += 1;
    retained += result.score.headline.correct;
    semanticRetained += result.semanticCorrect ?? result.score.headline.correct;
    total += result.score.headline.total;
    for (const hop of result.hops ?? []) {
      ratios.push(hop.summaryTokens / hop.prefixTokens);
    }
  }
  return {
    compressionMean:
      ratios.length === 0
        ? null
        : ratios.reduce((sum, value) => sum + value, 0) / ratios.length,
    invalid: results.length - valid,
    retained,
    semanticRetained,
    total,
    valid,
  };
}

export function describeArm(result: ArmResult): string {
  if (result.status !== "valid" || !result.score) {
    return `invalid status=${result.status} error=${result.error}`;
  }
  const ratio = (result.hops ?? [])
    .map((hop) => (hop.summaryTokens / hop.prefixTokens).toFixed(3))
    .join(",");
  const semantic =
    result.semanticCorrect === undefined ||
    result.semanticCorrect === result.score.headline.correct
      ? ""
      : ` semantic=${result.semanticCorrect}/${result.score.headline.total}`;
  return `valid ${result.score.headline.correct}/${result.score.headline.total}${semantic} ratio=[${ratio}]`;
}
