import type { CompactionScore } from "./scorer";

export interface ArmResult {
  readonly error?: string;
  readonly hops?: readonly {
    readonly compactionMs?: number;
    readonly prefixTokens: number;
    readonly summarizerInputTokens?: number;
    readonly summaryTokens: number;
  }[];
  readonly score?: CompactionScore;
  readonly semanticCorrect?: number;
  readonly status: string;
}

export interface ComparisonRow {
  readonly pi: ArmResult;
  readonly pss: ArmResult;
  readonly repetition: number;
  readonly scenario: string;
}
