import type { DeadlineSweepReport } from "./deadline-sweep-types";
import type { HumanCalibrationReport } from "./human-calibration-types";
import type {
  ProductionOverlapAggregate,
  ProductionOverlapReport,
} from "./production-overlap-types";
import type {
  MatchedQualityEstimate,
  QualitySweepCell,
  QualitySweepReport,
} from "./quality-sweep-types";
import type { TaskUtilityReport } from "./task-utility-types";

export type EvidenceStatus = "inferred" | "measured" | "unmeasured";

export interface FiveTrackInputEvidence {
  readonly mode: "deterministic" | "live" | null;
  readonly model: string | null;
  readonly path: string;
  readonly receiptSha256: string | null;
  readonly schemaVersion: string;
  readonly sha256: string;
  readonly status: "measured";
  readonly track:
    | "deadline-sweep"
    | "human-calibration"
    | "production-overlap"
    | "quality-sweep"
    | "task-utility";
}

export interface QualityCurvePoint {
  readonly arm: "pi" | "pss";
  readonly budget: number;
  readonly compressionRatio: number | null;
  readonly costUsd: null;
  readonly latencyMeanMs: number | null;
  readonly retention: number;
  readonly retentionWilson95: readonly [number, number];
  readonly status: "measured";
}

export interface FiveTrackReport {
  readonly createdAt: string;
  readonly curves: {
    readonly rateDistortionLatency: {
      readonly points: readonly QualityCurvePoint[];
      readonly status: "measured";
    };
    readonly utility: {
      readonly status: "measured";
      readonly summary: TaskUtilityReport["summary"];
    };
  };
  readonly fairness: {
    readonly fullProduct: {
      readonly deadlines: DeadlineSweepReport["scenarios"];
      readonly productionOverlap: readonly ProductionOverlapAggregate[];
      readonly status: "measured";
      readonly taskUtility: TaskUtilityReport["summary"];
    };
    readonly matchedOutputBudget: {
      readonly cells: readonly QualitySweepCell[];
      readonly status: "measured";
    };
    readonly matchedQuality: {
      readonly estimates: readonly MatchedQualityEstimate[];
      readonly status: "inferred";
    };
  };
  readonly humanCalibration: HumanCalibrationReport;
  readonly inputs: {
    readonly deadline: FiveTrackInputEvidence;
    readonly human: FiveTrackInputEvidence;
    readonly production: FiveTrackInputEvidence;
    readonly quality: FiveTrackInputEvidence;
    readonly task: FiveTrackInputEvidence;
  };
  readonly measurementStatus: {
    readonly deadlineOutcomes: "measured";
    readonly humanCalibration: "measured";
    readonly matchedQuality: "inferred";
    readonly paretoDominance: "inferred";
    readonly productionBlocking: "measured";
    readonly providerCost: "unmeasured";
    readonly quality: "measured";
    readonly taskUtility: "measured";
  };
  readonly methodology: {
    readonly aggregateScore: "forbidden";
    readonly crossTrackJoin: "none";
    readonly fairnessRegimes: readonly [
      "matched-output-budget",
      "matched-quality",
      "full-product",
    ];
    readonly qualityOutputBudgetEnforcement: QualitySweepReport["methodology"]["outputBudgetEnforcement"];
  };
  readonly pareto: {
    readonly deadline: {
      readonly front: DeadlineSweepReport["pareto"];
      readonly historicalFront: DeadlineSweepReport["historicalPareto"];
      readonly status: "inferred";
    };
    readonly quality: {
      readonly front: readonly string[];
      readonly status: "inferred";
    };
  };
  readonly productionAttempts: ProductionOverlapReport["attempts"];
  readonly schemaVersion: "five-track-report-v1";
}
