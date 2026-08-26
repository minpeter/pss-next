import type { QualityEvaluationAnswers } from "./quality-sweep-types";
import type { CompactionScore } from "./scorer";

export interface ComparePiIdentity {
  readonly model: string;
  readonly repetitions: number;
  readonly summaryMaxOutputTokens: number;
}

export interface ArmResult {
  readonly answers?: QualityEvaluationAnswers;
  readonly error?: string;
  readonly hops?: readonly ComparePiHop[];
  readonly score?: CompactionScore;
  readonly semanticCorrect?: number;
  readonly status: string;
}

export interface ComparePiHop {
  readonly compactionMs?: number;
  readonly prefixTokens: number;
  readonly sentOutputTokens: number;
  readonly summarizerInputTokens?: number;
  readonly summaryTokens: number;
}

export interface ComparisonRow {
  readonly pi: ArmResult;
  readonly pss: ArmResult;
  readonly repetition: number;
  readonly scenario: string;
}

export interface ComparePiReport extends ComparePiIdentity {
  readonly rows: readonly ComparisonRow[];
  readonly schemaVersion: "compare-pi-v3";
}
