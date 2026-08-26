import { describe, expect, it } from "vitest";
import { buildCompactionFixture } from "./fixture";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { runCompactionTrial } from "./trial-runner";

const SUMMARY_MAX_OUTPUT_TOKENS = 2048;
const SUMMARY_MAX_CHARACTERS = 4 * SUMMARY_MAX_OUTPUT_TOKENS;
const SUMMARY_START = "<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

describe("runCompactionTrial summary budget", () => {
  it("caps final PSS summary after deterministic evidence when provider ignores its limit", async () => {
    // Given
    const fixture = buildCompactionFixture("trial-runner-summary-cap");
    const calls: MockLanguageModelV4CallOptions[] = [];
    const answers = JSON.stringify({
      answers: fixture.questions.map((question, index) => ({
        answer: question.answer,
        id: `q${index}`,
      })),
    });
    const outputs = [
      mockLanguageModelV4Text("x".repeat(SUMMARY_MAX_CHARACTERS)),
      mockLanguageModelV4Text(answers),
      mockLanguageModelV4Text(answers),
    ];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.resolve(outputs[calls.length - 1] ?? outputs[0]);
    });

    // When
    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: "trial-runner-summary-cap",
      id: "trial-summary-cap",
      model,
      repetition: 1,
      summaryMaxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    });

    // Then
    expect(record.status).toBe("valid");
    expect(calls[0]?.maxOutputTokens).toBe(SUMMARY_MAX_OUTPUT_TOKENS);
    const envelope = calls[2]?.prompt
      .filter((message) => message.role === "user")
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .find(
        (text) => text.includes(SUMMARY_START) && text.endsWith(SUMMARY_SUFFIX)
      );
    if (envelope === undefined) {
      throw new TypeError("Expected a structurally wrapped summary.");
    }
    const summary = envelope.slice(
      envelope.indexOf(SUMMARY_START) + SUMMARY_START.length,
      -SUMMARY_SUFFIX.length
    );
    expect(summary).toHaveLength(SUMMARY_MAX_CHARACTERS);
  });
});
