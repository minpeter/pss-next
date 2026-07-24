import { buildCompactionFixture } from "./baseline-fixture";
import { buildBoundaryNoiseFixture } from "./boundary-noise-fixture";
import type { BenchmarkScenario, CompactionFixture } from "./fixture";
import { buildLifecycleFixture } from "./lifecycle-fixture";

export const BENCHMARK_SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
] as const satisfies readonly BenchmarkScenario[];

export function buildScenarioFixture(
  scenario: BenchmarkScenario,
  seed: string
): CompactionFixture {
  if (scenario === "lifecycle") {
    return buildLifecycleFixture(seed);
  }
  if (scenario === "boundary-noise") {
    return buildBoundaryNoiseFixture(seed);
  }
  return buildCompactionFixture(seed);
}

export function scenarioForFixtureIndex(index: number): BenchmarkScenario {
  return BENCHMARK_SCENARIOS[index % BENCHMARK_SCENARIOS.length] ?? "baseline";
}
