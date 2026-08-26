import type {
  RuntimeBlockScenario,
  RuntimeSummarySpan,
} from "./runtime-block-time-metrics";

export interface ProductionTurnTimestamps {
  readonly firstVisibleAtMs: number;
  readonly providerStartedAtMs: number;
  readonly sentAtMs: number;
  readonly stepStartedAtMs: number;
  readonly turnEndedAtMs: number;
  readonly turnStartedAtMs: number;
}

export interface ProductionOverlapPair {
  readonly actualTurnDeltaMs: number;
  readonly actualUserBlockMs: number;
  readonly candidateApplied: boolean;
  readonly completionDeltaMs: number;
  readonly control: ProductionTurnTimestamps;
  readonly decisionDeltaMs: number;
  readonly dispatchBlockMs: number;
  readonly dispatchDeltaMs: number;
  readonly order: "control-treatment" | "treatment-control";
  readonly overlapAtProviderStart: boolean;
  readonly pathValid: boolean;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summarySpans: readonly RuntimeSummarySpan[];
  readonly treatment: ProductionTurnTimestamps;
  readonly zeroBlock: boolean;
}

export interface ProductionOverlapAttempt {
  readonly message?: string;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly status: "completed" | "error";
}

export interface ProductionOverlapAggregate {
  readonly actualUserBlockMs: DistributionWithCi;
  readonly candidateApplied: RateWithInterval;
  readonly completionDeltaMs: DistributionWithCi;
  readonly decisionDeltaMs: DistributionWithCi;
  readonly dispatchBlockMs: DistributionWithCi;
  readonly overlap: RateWithInterval;
  readonly pathValid: RateWithInterval;
  readonly scenario: RuntimeBlockScenario;
  readonly validPairs: number;
  readonly zeroBlock: RateWithInterval;
}

export interface ProductionOverlapReport {
  readonly aggregates: readonly ProductionOverlapAggregate[];
  readonly attempts: readonly ProductionOverlapAttempt[];
  readonly attemptTimeoutMs: number;
  readonly createdAt: string;
  readonly methodology: {
    readonly bootstrapIterations: 10_000;
    readonly bootstrapSeed: 4_242;
    readonly compactionDeadlineMs: 60_000;
    readonly decisionDelta: "treatment-context-gate-vs-control-no-gate";
    readonly pairedModelClient: "shared-sequential";
    readonly pathValidityDenominator: "completed-pairs";
    readonly primaryUserBlock: "paired-first-visible-delta-clamped-at-zero";
    readonly rateInterval: "wilson-95";
  };
  readonly mode: "deterministic" | "live";
  readonly model: string;
  readonly pairs: readonly ProductionOverlapPair[];
  readonly repetitions: number;
  readonly schemaVersion: "production-overlap-v1";
}

interface DistributionWithCi {
  readonly max: number;
  readonly mean: number;
  readonly meanCi95: readonly [number, number];
  readonly p50: number;
  readonly p95: number;
}

interface RateWithInterval {
  readonly rate: number;
  readonly wilson95: readonly [number, number];
}
