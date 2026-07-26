import { describe, expect, it } from "vitest";
import {
  BENCHMARK_SCENARIOS,
  buildScenarioFixture,
  scenarioForFixtureIndex,
} from "./scenario-fixtures";

describe("twelve-scenario matrix", () => {
  it("keeps the original default trio and exposes twelve direct scenarios", () => {
    expect(BENCHMARK_SCENARIOS).toHaveLength(12);
    expect(BENCHMARK_SCENARIOS.slice(0, 3)).toEqual([
      "baseline",
      "lifecycle",
      "boundary-noise",
    ]);
    expect([0, 1, 2].map(scenarioForFixtureIndex)).toEqual([
      "baseline",
      "lifecycle",
      "boundary-noise",
    ]);
    for (const scenario of BENCHMARK_SCENARIOS) {
      expect(
        buildScenarioFixture(scenario, `matrix-${scenario}`).scenario
      ).toBe(scenario);
    }
  });

  it("keeps tool-state and CJK projections independently answerable", () => {
    const toolState = buildScenarioFixture("evolving-tool-state", "matrix");
    const cjk = buildScenarioFixture("actual-cjk", "matrix");

    expect(toolState.questions).toHaveLength(4);
    expect(cjk.questions).toHaveLength(3);
  });
});
