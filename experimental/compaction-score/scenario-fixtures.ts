import { buildCompactionFixture } from "./baseline-fixture";
import { buildBoundaryNoiseFixture } from "./boundary-noise-fixture";
import {
  type BenchmarkScenario,
  type CompactionFixture,
  validateCompactionFixture,
} from "./fixture";
import {
  buildGiantMessageFixture,
  buildPromptInjectionFixture,
} from "./injection-fixtures";
import { buildLifecycleFixture } from "./lifecycle-fixture";
import { buildLongSessionFixture } from "./long-session-fixture";
import { buildProgressiveFiveHopFixture } from "./progressive-five-hop-fixture";
import {
  buildDenseSmallRangeFixture,
  buildSparseFactFixture,
} from "./sparse-dense-fixtures";
import { buildToolStateCjkFixture } from "./tool-state-cjk-fixture";
import {
  buildActualCjkFixture,
  buildEvolvingToolStateFixture,
} from "./tool-state-projections";

export const BENCHMARK_SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
  "long-session",
  "progressive-five-hop",
  "prompt-injection",
  "giant-message",
  "tool-state-cjk",
  "sparse-fact",
  "dense-small-range",
  "evolving-tool-state",
  "actual-cjk",
] as const satisfies readonly BenchmarkScenario[];

export function buildScenarioFixture(
  scenario: BenchmarkScenario,
  seed: string
): CompactionFixture {
  let fixture = buildCompactionFixture(seed);
  if (scenario === "lifecycle") {
    fixture = buildLifecycleFixture(seed);
  } else if (scenario === "boundary-noise") {
    fixture = buildBoundaryNoiseFixture(seed);
  } else if (scenario === "long-session") {
    fixture = buildLongSessionFixture(seed);
  } else if (scenario === "progressive-five-hop") {
    fixture = buildProgressiveFiveHopFixture(seed);
  } else if (scenario === "prompt-injection") {
    fixture = buildPromptInjectionFixture(seed);
  } else if (scenario === "giant-message") {
    fixture = buildGiantMessageFixture(seed);
  } else if (scenario === "tool-state-cjk") {
    fixture = buildToolStateCjkFixture(seed);
  } else if (scenario === "sparse-fact") {
    fixture = buildSparseFactFixture(seed);
  } else if (scenario === "dense-small-range") {
    fixture = buildDenseSmallRangeFixture(seed);
  } else if (scenario === "evolving-tool-state") {
    fixture = buildEvolvingToolStateFixture(seed);
  } else if (scenario === "actual-cjk") {
    fixture = buildActualCjkFixture(seed);
  }
  return validateCompactionFixture(fixture);
}

export function scenarioForFixtureIndex(index: number): BenchmarkScenario {
  return BENCHMARK_SCENARIOS[index % BENCHMARK_SCENARIOS.length] ?? "baseline";
}
