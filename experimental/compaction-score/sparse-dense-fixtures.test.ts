import { estimateModelMessagesTokens } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import type { BenchmarkScenario } from "./fixture";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { BENCHMARK_SCENARIOS, buildScenarioFixture } from "./scenario-fixtures";
import { runCompactionTrial } from "./trial-runner";

const SPARSE = "sparse-fact" as BenchmarkScenario;
const DENSE = "dense-small-range" as BenchmarkScenario;

describe("sparse and dense fixtures", () => {
  it("registers both compression-pressure scenarios", () => {
    expect(BENCHMARK_SCENARIOS).toEqual(
      expect.arrayContaining([SPARSE, DENSE])
    );
    expect(buildScenarioFixture(SPARSE, "sparse-red").scenario).toBe(SPARSE);
    expect(buildScenarioFixture(DENSE, "dense-red").scenario).toBe(DENSE);
  });

  it("has a >5k sparse prefix and a 600-900 token dense prefix", () => {
    const sparse = buildScenarioFixture(SPARSE, "sparse-red");
    const dense = buildScenarioFixture(DENSE, "dense-red");
    const tokens = (fixture: ReturnType<typeof buildScenarioFixture>) =>
      estimateModelMessagesTokens(
        fixture.messages.slice(0, fixture.compactionEnds[0])
      );

    expect(tokens(sparse)).toBeGreaterThan(5000);
    expect(tokens(dense)).toBeGreaterThanOrEqual(600);
    expect(tokens(dense)).toBeLessThanOrEqual(900);
  });

  it("retains sparse facts through a valid compacted mock arm", async () => {
    const fixture = buildScenarioFixture(SPARSE, "sparse-trial");
    const answers = JSON.stringify({
      answers: fixture.questions.map(({ answer }, index) => ({
        answer,
        id: `q${index}`,
      })),
    });
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("sparse handoff"),
      mockLanguageModelV4Text(answers),
      mockLanguageModelV4Text(answers),
    ]);
    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: "sparse-trial",
      id: "sparse-trial",
      model,
      repetition: 1,
      seed: 42,
      summaryMaxOutputTokens: 768,
    });

    expect(record.status).toBe("valid");
    if (record.status !== "valid") {
      return;
    }
    expect(record.score.arms.compacted.overall.correct).toBe(
      fixture.questions.length
    );
  });

  it("fails closed when dense output expands instead of compressing", async () => {
    const fixture = buildScenarioFixture(DENSE, "dense-expansion");
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("expansion ".repeat(10_000)),
    ]);
    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: "dense-expansion",
      id: "dense-expansion",
      model,
      repetition: 1,
      seed: 42,
      summaryMaxOutputTokens: 768,
    });

    expect(record.status).toBe("non-compressing-summary");
  });
});
