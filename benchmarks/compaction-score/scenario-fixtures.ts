import { buildCompactionFixture } from "./baseline-fixture";
import { buildBoundaryNoiseFixture } from "./boundary-noise-fixture";
import {
  type BenchmarkScenario,
  type CompactionFixture,
  validateCompactionFixture,
} from "./fixture";
import { buildLifecycleFixture } from "./lifecycle-fixture";
import { buildLongSessionFixture } from "./long-session-fixture";
import { buildProgressiveFiveHopFixture } from "./progressive-five-hop-fixture";

export const BENCHMARK_SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
  "long-session",
  "progressive-five-hop",
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
  }
  return validateCompactionFixture(fixture);
}

export function scenarioForFixtureIndex(index: number): BenchmarkScenario {
  return BENCHMARK_SCENARIOS[index % BENCHMARK_SCENARIOS.length] ?? "baseline";
}
