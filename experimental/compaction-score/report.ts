import { createHash } from "node:crypto";
import type { BenchmarkScenario } from "./fixture";
import {
  type Distribution,
  distribution,
  type WilsonInterval,
  wilson95,
} from "./report-statistics";
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

export type { Distribution } from "./report-statistics";

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
  const invalidByStatus: Partial<Record<InvalidTrialStatus, number>> = {};
  const categoryCounts = new Map<string, ScoreCount>();
  const disagreementCounts = new Map<
    string,
    Omit<DisagreementFingerprint, "count"> & { count: number }
  >();
  const hopRatios: number[][] = [];
  const scenarioCounts = new Map<BenchmarkScenario, ScoreCount>();
  const scenarioRatios = new Map<BenchmarkScenario, number[]>();
  const summaryRatios: number[] = [];
  const trialAccuracies: number[] = [];
  let aggregateCorrect = 0;
  let aggregateTotal = 0;
  let validCount = 0;

  for (const record of records) {
    switch (record.status) {
      case "compaction-prompt-failure":
      case "evaluation-provider-failure":
      case "invalid-full-control":
      case "non-compressing-summary":
      case "protocol-failure":
      case "summary-provider-failure":
        invalidByStatus[record.status] =
          (invalidByStatus[record.status] ?? 0) + 1;
        continue;
      case "valid":
        break;
      default:
        assertNever(record);
    }

    validCount += 1;
    aggregateCorrect += record.score.headline.correct;
    aggregateTotal += record.score.headline.total;
    trialAccuracies.push(
      record.score.headline.correct / record.score.headline.total
    );
    const ratio = record.summaryTokens / record.prefixTokens;
    summaryRatios.push(ratio);
    const ratiosForScenario = scenarioRatios.get(record.scenario);
    if (ratiosForScenario === undefined) {
      scenarioRatios.set(record.scenario, [ratio]);
    } else {
      ratiosForScenario.push(ratio);
    }
    for (const [index, hop] of record.hops.entries()) {
      const ratiosForHop = hopRatios[index];
      const hopRatio = hop.summaryTokens / hop.prefixTokens;
      if (ratiosForHop === undefined) {
        hopRatios.push([hopRatio]);
      } else {
        ratiosForHop.push(hopRatio);
      }
    }

    addScore(scenarioCounts, record.scenario, record.score.headline);
    for (const category of record.score.arms.compacted.perCategory) {
      addScore(categoryCounts, category.category, category);
    }
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
  }

  const trials = {
    attempted: records.length,
    invalidByStatus,
    valid: validCount,
  };
  if (validCount === 0) {
    return { compression: null, retention: null, trials };
  }

  return {
    compression: {
      byHop: hopRatios.map((ratios, index) => ({
        hop: index + 1,
        ratio: distribution(ratios),
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
        accuracy: aggregateCorrect / aggregateTotal,
        correct: aggregateCorrect,
        total: aggregateTotal,
        wilson95: wilson95(aggregateCorrect, aggregateTotal),
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

function assertNever(value: never): never {
  throw new TypeError(`Unexpected trial record: ${String(value)}`);
}

function addScore<Key>(
  counts: Map<Key, ScoreCount>,
  key: Key,
  score: ScoreCount
): void {
  const previous = counts.get(key);
  counts.set(key, {
    correct: (previous?.correct ?? 0) + score.correct,
    total: (previous?.total ?? 0) + score.total,
  });
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
