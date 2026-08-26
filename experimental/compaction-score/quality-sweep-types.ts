import type { ModelMessage } from "ai";
import type { FixtureQuestion } from "./fixture";

export type QualitySweepArm = "pi" | "pss";
export type QualitySweepMode = "deterministic" | "live";

export interface QualityEvaluationAnswers {
  readonly compacted: readonly string[];
  readonly full: readonly string[];
}

export interface QualitySweepObservation {
  readonly arm: QualitySweepArm;
  readonly budget: number;
  readonly compressionRatio: number | null;
  readonly controlCorrect: number;
  readonly controlPassed: boolean;
  readonly controlTotal: number;
  readonly correct: number;
  readonly costUsd: number | null;
  readonly evaluationAnswers?: QualityEvaluationAnswers;
  readonly fixtureSeed: string;
  readonly invalidReason?: string;
  readonly latencyMs: number | null;
  readonly repetition: number;
  readonly scenario: string;
  readonly sentOutputTokens: readonly number[];
  readonly summarizerInputTokens: number;
  readonly summaryTokens: number;
  readonly total: number;
  readonly valid: boolean;
}

export interface QualitySweepCell {
  readonly arm: QualitySweepArm;
  readonly budget: number;
  readonly budgetStatus:
    | "budget-clamped"
    | "budget-exact"
    | "budget-unknown"
    | "budget-within-cap";
  readonly compressionRatioMean: number | null;
  readonly controlCorrect: number;
  readonly controlsPassed: boolean;
  readonly controlTotal: number;
  readonly correct: number;
  readonly costUsd: number | null;
  readonly invalid: number;
  readonly latencyMeanMs: number | null;
  readonly summarizerInputTokens: number;
  readonly summaryTokens: number;
  readonly total: number;
  readonly valid: number;
  readonly wilson95: readonly [number, number];
}

export interface MatchedQualityEstimate {
  readonly bootstrapValidDraws: number;
  readonly piBudget: number;
  readonly piBudgetCi95: readonly [number, number] | null;
  readonly pssBudget: number;
  readonly pssBudgetCi95: readonly [number, number] | null;
  readonly quality: number;
  readonly ratio: number;
  readonly ratioCi95: readonly [number, number] | null;
}

export interface CalibrationItem {
  readonly compactedAnswer?: string;
  readonly fullAnswer?: string;
  readonly messages: readonly ModelMessage[];
  readonly questions: readonly FixtureQuestion[];
  readonly scenario: string;
  readonly seed: string;
}

export interface QualitySweepReport {
  readonly budgets: readonly number[];
  readonly calibrationItems: readonly CalibrationItem[];
  readonly cells: readonly QualitySweepCell[];
  readonly createdAt: string;
  readonly matchedQuality: readonly MatchedQualityEstimate[];
  readonly methodology: {
    readonly bootstrapIterations: number;
    readonly bootstrapSeed: number;
    readonly calibrationSampling: "prefer-4096-fallback-nearest-captured-budget";
    readonly interpolation: "pav-isotonic-inverse-linear";
    readonly invalidPolicy: "excluded-with-explicit-count";
    readonly outputBudgetEnforcement: "local-four-characters-per-token-hard-cap";
    readonly qualityTargets: readonly number[];
  };
  readonly mode: QualitySweepMode;
  readonly model: string;
  readonly observations: readonly QualitySweepObservation[];
  readonly repetitions: number;
  readonly schemaVersion: "quality-sweep-v2";
}
