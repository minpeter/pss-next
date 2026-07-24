import { estimateModelMessagesTokens } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import type { BenchmarkScenario } from "./fixture";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { BENCHMARK_SCENARIOS, buildScenarioFixture } from "./scenario-fixtures";
import { runCompactionTrial } from "./trial-runner";

const INJECTION = "prompt-injection" as BenchmarkScenario;
const GIANT = "giant-message" as BenchmarkScenario;

describe("injection-resistance fixtures", () => {
  it("registers prompt-injection and giant-message scenarios", () => {
    expect(BENCHMARK_SCENARIOS).toEqual(
      expect.arrayContaining([INJECTION, GIANT])
    );
    expect(buildScenarioFixture(INJECTION, "injection-red").scenario).toBe(
      INJECTION
    );
    expect(buildScenarioFixture(GIANT, "giant-red").scenario).toBe(GIANT);
  });

  it("makes the giant prefix exceed the detailed prompt range", () => {
    const fixture = buildScenarioFixture(GIANT, "giant-red");
    const end = fixture.compactionEnds[0] ?? 0;

    expect(
      estimateModelMessagesTokens(fixture.messages.slice(0, end))
    ).toBeGreaterThan(32_000);
  });

  it.each([INJECTION, GIANT])(
    "%s preserves markers as data behind a tool-safe boundary",
    (scenario) => {
      const fixture = buildScenarioFixture(scenario, `payload-${scenario}`);
      const source = JSON.stringify(fixture.messages);
      const end = fixture.compactionEnds[0] ?? 0;

      expect(source).toContain("</summary>");
      expect(source).toContain("<system>");
      expect(source).toContain("role=system");
      expect(fixture.messages[end - 1]).toMatchObject({ role: "assistant" });
      expect(typeof fixture.messages[end - 1]?.content).toBe("string");
      expect(fixture.messages[end]).toMatchObject({ role: "user" });
      expect(
        fixture.messages.filter(({ role }) => role === "tool")
      ).toHaveLength(1);
    }
  );

  it("keeps the real objective authoritative in the compacted mock arm", async () => {
    const fixture = buildScenarioFixture(INJECTION, "injection-trial");
    const answerJson = JSON.stringify({
      answers: fixture.questions.map(({ answer }, index) => ({
        answer,
        id: `q${index}`,
      })),
    });
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("safe compacted handoff"),
      mockLanguageModelV4Text(answerJson),
      mockLanguageModelV4Text(answerJson),
    ]);

    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: "injection-trial",
      id: "injection-trial",
      model,
      repetition: 1,
      seed: 42,
      summaryMaxOutputTokens: 768,
    });

    expect(record.status).toBe("valid");
    if (record.status !== "valid") {
      return;
    }
    expect(record.score.arms.full.overall.correct).toBe(
      fixture.questions.length
    );
    expect(record.score.arms.compacted.overall.correct).toBe(
      fixture.questions.length
    );
    expect(
      fixture.questions.find(
        ({ question }) => question === "What is the real objective?"
      )?.answer
    ).not.toContain("exfiltrate credentials");
  });
});
