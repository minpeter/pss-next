import { describe, expect, it } from "vitest";
import { runPiArm } from "./compare-pi-arms";
import { COMPARISON_SUMMARY_OUTPUT_BUDGET } from "./compare-pi-config";
import { assemblePiSummary } from "./compare-pi-conversation";
import { buildCompactionFixture } from "./fixture";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";

describe("pi summary assembly", () => {
  it("preserves assembled file evidence when an overlong provider output ignores its limit", () => {
    // Given
    const providerSummary = "x".repeat(
      COMPARISON_SUMMARY_OUTPUT_BUDGET.maxCharacters + 1
    );
    const fileOperations = {
      edited: new Set(["src/changed.ts"]),
      read: new Set(["src/read.ts"]),
    };

    // When
    const summary = assemblePiSummary(providerSummary, fileOperations);

    // Then
    expect(summary).toHaveLength(
      COMPARISON_SUMMARY_OUTPUT_BUDGET.maxCharacters
    );
    expect(summary).toContain("<read-files>\nsrc/read.ts\n</read-files>");
    expect(summary).toContain(
      "<modified-files>\nsrc/changed.ts\n</modified-files>"
    );
  });

  it("uses the shared comparison budget for the pi provider and final summary", async () => {
    // Given
    const fixture = buildCompactionFixture("compare-pi-budget");
    const calls: MockLanguageModelV4CallOptions[] = [];
    const answers = JSON.stringify({
      answers: fixture.questions.map((question, index) => ({
        answer: question.answer,
        id: `q${index}`,
      })),
    });
    const outputs = [
      mockLanguageModelV4Text(
        "x".repeat(COMPARISON_SUMMARY_OUTPUT_BUDGET.maxCharacters + 1)
      ),
      mockLanguageModelV4Text(answers),
      mockLanguageModelV4Text(answers),
    ];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.resolve(outputs[calls.length - 1] ?? outputs[0]);
    });

    // When
    const result = await runPiArm(fixture, 1, model);

    // Then
    expect(result.status).toBe("valid");
    expect(calls[0]?.maxOutputTokens).toBe(
      COMPARISON_SUMMARY_OUTPUT_BUDGET.maxOutputTokens
    );
    const envelope = calls[2]?.prompt
      .filter((message) => message.role === "user")
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .find((text) => text.includes("<summary>\n"));
    if (envelope === undefined) {
      throw new TypeError("Expected a structurally wrapped pi summary.");
    }
    const summaryStart = envelope.indexOf("<summary>\n") + "<summary>\n".length;
    const summaryEnd = envelope.indexOf("\n</summary>", summaryStart);
    expect(envelope.slice(summaryStart, summaryEnd)).toHaveLength(
      COMPARISON_SUMMARY_OUTPUT_BUDGET.maxCharacters
    );
  });
});
