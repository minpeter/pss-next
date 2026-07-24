import { describe, expect, it } from "vitest";
import type { BenchmarkScenario } from "./fixture";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { BENCHMARK_SCENARIOS, buildScenarioFixture } from "./scenario-fixtures";
import { runCompactionTrial } from "./trial-runner";

const SCENARIO = "tool-state-cjk" as BenchmarkScenario;

describe("tool-state CJK fixture", () => {
  it("registers a UTF-8 tool-history scenario", () => {
    const fixture = buildScenarioFixture(SCENARIO, "cjk-red");

    expect(BENCHMARK_SCENARIOS).toContain(SCENARIO);
    expect(fixture.scenario).toBe(SCENARIO);
    expect(fixture.messages.some(({ role }) => role === "tool")).toBe(true);
  });

  it("preserves actual Unicode values and a complete tool history", () => {
    const fixture = buildScenarioFixture(SCENARIO, "cjk-unicode");
    const source = JSON.stringify(fixture.messages);
    const end = fixture.compactionEnds[0] ?? 0;

    for (const value of [
      "src/한글/設定/漢字.ts",
      "프로필＿更新・状態",
      "全角文字は80桁で切り詰めない",
      "명령 실패: 권한 거부 (EACCES)",
      "재시도 성공: 캐시를 초기화했습니다",
      "실패: 2개; 型エラー at 漢字.ts:42",
      "통과: 18개; 東京✓",
    ]) {
      expect(source).toContain(value);
    }
    expect(fixture.messages.filter(({ role }) => role === "tool")).toHaveLength(
      4
    );
    expect(fixture.messages[end - 1]).toMatchObject({ role: "assistant" });
    expect(fixture.messages[end]).toMatchObject({ role: "user" });
  });

  it("scores every tool and Unicode fact in both mock arms", async () => {
    const fixture = buildScenarioFixture(SCENARIO, "cjk-trial");
    const answerJson = JSON.stringify({
      answers: fixture.questions.map(({ answer }, index) => ({
        answer,
        id: `q${index}`,
      })),
    });
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("CJK handoff"),
      mockLanguageModelV4Text(answerJson),
      mockLanguageModelV4Text(answerJson),
    ]);
    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: "cjk-trial",
      id: "cjk-trial",
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
  });
});
