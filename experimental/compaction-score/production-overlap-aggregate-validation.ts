import { aggregateProductionOverlap } from "./production-overlap-analysis";
import { array, object } from "./production-overlap-parse";
import type { ProductionOverlapPair } from "./production-overlap-types";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";

const SCENARIOS: readonly RuntimeBlockScenario[] = [
  "overlap-nonblocking",
  "prepared-hit",
  "candidate-fit-late-hit",
  "candidate-too-broad-fallback",
  "summary-failure-retry-hit",
  "repeated-failure-overflow-recovery",
];

export function validateProductionOverlapAggregates(
  raw: unknown,
  pairs: readonly ProductionOverlapPair[]
): void {
  const aggregates = array(raw, "aggregates");
  if (aggregates.length !== SCENARIOS.length) {
    throw new TypeError("Production overlap aggregate grid is incomplete.");
  }
  for (const scenario of SCENARIOS) {
    const rawAggregate = aggregates.find(
      (value) => object(value, "aggregate").scenario === scenario
    );
    if (rawAggregate === undefined) {
      throw new TypeError("Production overlap aggregate scenario is missing.");
    }
    const expected = aggregateProductionOverlap(scenario, pairs);
    if (JSON.stringify(rawAggregate) !== JSON.stringify(expected)) {
      throw new TypeError("Production overlap aggregate is inconsistent.");
    }
  }
}
