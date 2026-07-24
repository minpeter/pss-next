import type { ModelMessage } from "ai";
import { buildCompactionFixture as buildBaselineFixture } from "./baseline-fixture";

export function buildCompactionFixture(seed: string): CompactionFixture {
  return buildBaselineFixture(seed);
}

export interface FixtureQuestion {
  readonly answer: string;
  readonly category:
    | "boundary-recall"
    | "constraint-retention"
    | "distractor-resolution"
    | "exact-recall"
    | "file-state"
    | "hallucination-resistance"
    | "negative-knowledge"
    | "task-continuation"
    | "temporal-resolution"
    | "tool-history";
  readonly question: string;
}

export type BenchmarkScenario = "baseline" | "boundary-noise" | "lifecycle";

export interface CompactionFixture {
  readonly compactionEnds: readonly number[];
  readonly messages: ModelMessage[];
  readonly questions: FixtureQuestion[];
  readonly scenario: BenchmarkScenario;
}
