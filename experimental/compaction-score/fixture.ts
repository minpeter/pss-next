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

export type BenchmarkScenario =
  | "baseline"
  | "boundary-noise"
  | "actual-cjk"
  | "giant-message"
  | "lifecycle"
  | "long-session"
  | "prompt-injection"
  | "progressive-five-hop"
  | "sparse-fact"
  | "dense-small-range"
  | "evolving-tool-state"
  | "tool-state-cjk"
  | "holdout-json"
  | "holdout-cjk"
  | "holdout-log";

export interface CompactionFixture {
  readonly compactionEnds: readonly number[];
  readonly messages: ModelMessage[];
  readonly questions: FixtureQuestion[];
  readonly scenario: BenchmarkScenario;
}

export function validateCompactionFixture(
  fixture: CompactionFixture
): CompactionFixture {
  let previousEnd = 0;
  if (fixture.compactionEnds.length === 0) {
    throw new TypeError("Compaction fixture requires at least one boundary.");
  }
  for (const end of fixture.compactionEnds) {
    const before = fixture.messages[end - 1];
    const after = fixture.messages[end];
    if (
      !Number.isInteger(end) ||
      end <= previousEnd ||
      before?.role !== "assistant" ||
      typeof before.content !== "string" ||
      after?.role !== "user"
    ) {
      throw new TypeError(
        `Compaction boundary ${end} must be an increasing, tool-safe assistant-text to user transition.`
      );
    }
    previousEnd = end;
  }
  return fixture;
}
