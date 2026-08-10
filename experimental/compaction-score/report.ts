import { createHash } from "node:crypto";
import type { BenchmarkScenario } from "./fixture";
import type { CompactionScore, ScoreCount, ScoreDisagreement } from "./scorer";

export type InvalidTrialStatus =
  | "compaction-prompt-failure"
  | "evaluation-provider-failure"
  | "invalid-full-control"
  | "non-compressing-summary"
  | "protocol-failure"
  | "summary-provider-failure";

export interface PromptProfileIdentity {
  readonly hash: string;
  readonly id: string;
}

interface TrialIdentity {
  readonly fixtureSeed: string;
  readonly id: string;
  readonly profile?: PromptProfileIdentity;
  readonly repetition: number;
  readonly scenario: BenchmarkScenario;
}

export interface CompactionHopRecord {
  readonly compactionMs?: number;
  readonly endSeqExclusive: number;
  readonly prefixTokens: number;
  readonly summarizerInputTokens?: number;
  readonly summaryTokens: number;
}

export interface ValidTrialRecord extends TrialIdentity {
  readonly hops: readonly CompactionHopRecord[];
  readonly prefixTokens: number;
  readonly score: CompactionScore;
  readonly status: "valid";
  readonly summaryTokens: number;
}

export interface InvalidTrialRecord extends TrialIdentity {
  readonly error: string;
  readonly status: InvalidTrialStatus;
}

export type TrialRecord = InvalidTrialRecord | ValidTrialRecord;

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

interface WilsonInterval {
  readonly high: number;
  readonly low: number;
}

export interface DisagreementFingerprint {
  readonly arm: ScoreDisagreement["arm"];
  readonly category: ScoreDisagreement["category"];
  readonly count: number;
  readonly fingerprint: string;
  readonly scenario: BenchmarkScenario;
}

export interface RetentionReport {
  readonly aggregate: ScoreCount & {
    readonly accuracy: number;
    readonly wilson95: WilsonInterval;
  };
  readonly byCategory: readonly {
    readonly accuracy: number;
    readonly category: string;
    readonly correct: number;
    readonly total: number;
    readonly wilson95: WilsonInterval;
  }[];
  readonly byScenario: readonly {
    readonly accuracy: number;
    readonly correct: number;
    readonly scenario: BenchmarkScenario;
    readonly total: number;
    readonly wilson95: WilsonInterval;
  }[];
  readonly disagreements: readonly DisagreementFingerprint[];
  readonly trialAccuracy: Distribution;
}

export interface CompressionReport {
  readonly byHop: readonly {
    readonly hop: number;
    readonly ratio: Distribution;
  }[];
  readonly byScenario: readonly {
    readonly ratio: Distribution;
    readonly scenario: BenchmarkScenario;
  }[];
  readonly ratio: Distribution;
  readonly savings: Distribution;
}

export interface TrialSummary {
  readonly compression: CompressionReport | null;
  readonly retention: RetentionReport | null;
  readonly trials: {
    readonly attempted: number;
    readonly invalidByStatus: Partial<Record<InvalidTrialStatus, number>>;
    readonly valid: number;
  };
}

export function summarizeTrials(records: readonly TrialRecord[]): TrialSummary {
  const valid = records.filter(
    (record): record is ValidTrialRecord => record.status === "valid"
  );
  const invalidByStatus: Partial<Record<InvalidTrialStatus, number>> = {};
  for (const record of records) {
    if (record.status !== "valid") {
      invalidByStatus[record.status] =
        (invalidByStatus[record.status] ?? 0) + 1;
    }
  }

  const trials = {
    attempted: records.length,
    invalidByStatus,
    valid: valid.length,
  };
  if (valid.length === 0) {
    return { compression: null, retention: null, trials };
  }

  const trialAccuracies = valid.map(
    (record) => record.score.headline.correct / record.score.headline.total
  );
  const aggregate = valid.reduce(
    (total, record) => ({
      correct: total.correct + record.score.headline.correct,
      total: total.total + record.score.headline.total,
    }),
    { correct: 0, total: 0 }
  );
  const categoryCounts = new Map<string, ScoreCount>();
  const disagreementCounts = new Map<
    string,
    Omit<DisagreementFingerprint, "count"> & { count: number }
  >();
  const scenarioCounts = new Map<BenchmarkScenario, ScoreCount>();
  const scenarioRatios = new Map<BenchmarkScenario, number[]>();
  for (const record of valid) {
    const previousScenario = scenarioCounts.get(record.scenario) ?? {
      correct: 0,
      total: 0,
    };
    scenarioCounts.set(record.scenario, {
      correct: previousScenario.correct + record.score.headline.correct,
      total: previousScenario.total + record.score.headline.total,
    });
    const ratio = record.summaryTokens / record.prefixTokens;
    scenarioRatios.set(record.scenario, [
      ...(scenarioRatios.get(record.scenario) ?? []),
      ratio,
    ]);
    for (const disagreement of record.score.disagreements) {
      const fingerprint = fingerprintDisagreement(
        record.scenario,
        disagreement
      );
      const previous = disagreementCounts.get(fingerprint);
      disagreementCounts.set(fingerprint, {
        arm: disagreement.arm,
        category: disagreement.category,
        count: (previous?.count ?? 0) + 1,
        fingerprint,
        scenario: record.scenario,
      });
    }
    for (const category of record.score.arms.compacted.perCategory) {
      const previous = categoryCounts.get(category.category) ?? {
        correct: 0,
        total: 0,
      };
      categoryCounts.set(category.category, {
        correct: previous.correct + category.correct,
        total: previous.total + category.total,
      });
    }
  }

  const summaryRatios = valid.map(
    (record) => record.summaryTokens / record.prefixTokens
  );
  const maxHops = Math.max(...valid.map((record) => record.hops.length));

  return {
    compression: {
      byHop: Array.from({ length: maxHops }, (_, index) => ({
        hop: index + 1,
        ratio: distribution(
          valid.flatMap((record) => {
            const hop = record.hops[index];
            return hop ? [hop.summaryTokens / hop.prefixTokens] : [];
          })
        ),
      })),
      byScenario: [...scenarioRatios.entries()].map(([scenario, ratios]) => ({
        ratio: distribution(ratios),
        scenario,
      })),
      ratio: distribution(summaryRatios),
      savings: distribution(summaryRatios.map((ratio) => 1 - ratio)),
    },
    retention: {
      aggregate: {
        ...aggregate,
        accuracy: aggregate.correct / aggregate.total,
        wilson95: wilson95(aggregate.correct, aggregate.total),
      },
      byCategory: [...categoryCounts.entries()].map(([category, score]) => ({
        accuracy: score.correct / score.total,
        category,
        ...score,
        wilson95: wilson95(score.correct, score.total),
      })),
      byScenario: [...scenarioCounts.entries()].map(([scenario, score]) => ({
        accuracy: score.correct / score.total,
        scenario,
        ...score,
        wilson95: wilson95(score.correct, score.total),
      })),
      disagreements: [...disagreementCounts.values()].sort((left, right) =>
        left.fingerprint.localeCompare(right.fingerprint)
      ),
      trialAccuracy: distribution(trialAccuracies),
    },
    trials,
  };
}

function distribution(values: readonly number[]): Distribution {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return {
    max: Math.max(...values),
    mean,
    min: Math.min(...values),
    quantiles: {
      p50: quantile(values, 0.5),
      p95: quantile(values, 0.95),
    },
    standardDeviation: Math.sqrt(variance),
  };
}

function fingerprintDisagreement(
  scenario: BenchmarkScenario,
  disagreement: ScoreDisagreement
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scenario,
        disagreement.arm,
        disagreement.category,
        disagreement.question,
        disagreement.expected,
        disagreement.actual,
      ])
    )
    .digest("hex");
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
