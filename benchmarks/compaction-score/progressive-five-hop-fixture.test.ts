import { describe, expect, it } from "vitest";
import type { BenchmarkScenario } from "./fixture";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { BENCHMARK_SCENARIOS, buildScenarioFixture } from "./scenario-fixtures";
import { runCompactionTrial } from "./trial-runner";

const SCENARIO = "progressive-five-hop" as BenchmarkScenario;

describe("progressive five-hop fixture", () => {
  it("is registered as an exact five-hop scenario", () => {
    const fixture = buildScenarioFixture(SCENARIO, "five-hop-red");

    expect(BENCHMARK_SCENARIOS).toContain(SCENARIO);
    expect(fixture.scenario).toBe(SCENARIO);
    expect(fixture.compactionEnds).toHaveLength(5);
  });

  it("retains stale chronology while selecting authoritative answers", () => {
    const fixture = buildScenarioFixture(SCENARIO, "five-hop-chronology");
    const source = JSON.stringify(fixture.messages);
    const answers = new Map(
      fixture.questions.map(({ answer, question }) => [question, answer])
    );

    for (const staleValue of [
      "Node 20",
      "Node 22",
      "Node 24",
      "src/cache.ts",
      "src/storage.ts",
      "src/persistence.ts",
      "5 passed, 4 failed",
    ]) {
      expect(source).toContain(staleValue);
    }
    expect(answers.get("What is the final runtime target?")).toBe("Node 26");
    expect(answers.get("What is the current state file?")).toBe("src/state.ts");
    expect(answers.get("What is task-migrate's final status?")).toBe(
      "completed"
    );
    expect(answers.get("What is task-release's final status?")).toBe("blocked");
    expect(answers.get("Who owns deployment?")).toBe("unknown");
  });

  it("keeps every boundary tool-safe and every tool pair intact", () => {
    const fixture = buildScenarioFixture(SCENARIO, "five-hop-boundaries");

    expect(fixture.messages.filter(({ role }) => role === "tool")).toHaveLength(
      5
    );
    for (const end of fixture.compactionEnds) {
      expect(fixture.messages[end - 1]).toMatchObject({ role: "assistant" });
      expect(typeof fixture.messages[end - 1]?.content).toBe("string");
      expect(fixture.messages[end]).toMatchObject({ role: "user" });
    }
  });

  it("records five compaction hops with perfect mock control and recall", async () => {
    const fixture = buildScenarioFixture(SCENARIO, "five-hop-trial");
    const answerJson = JSON.stringify({
      answers: fixture.questions.map(({ answer }, index) => ({
        answer,
        id: `q${index}`,
      })),
    });
    let call = 0;
    const model = createMockLanguageModelV4(() => {
      call += 1;
      return Promise.resolve(
        mockLanguageModelV4Text(call <= 5 ? `hop-${call}` : answerJson)
      );
    });

    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: "five-hop-trial",
      id: "five-hop-trial",
      model,
      repetition: 1,
      seed: 42,
      summaryMaxOutputTokens: 768,
    });

    expect(record.status).toBe("valid");
    if (record.status !== "valid") {
      return;
    }
    expect(record.hops).toHaveLength(5);
    expect(record.score.arms.full.overall.correct).toBe(
      fixture.questions.length
    );
    expect(record.score.arms.compacted.overall.correct).toBe(
      fixture.questions.length
    );
    expect(record.score.headline).toEqual({
      correct: fixture.questions.length,
      total: fixture.questions.length,
    });
  });
});
