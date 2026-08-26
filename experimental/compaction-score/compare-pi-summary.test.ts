import { describe, expect, it } from "vitest";
import { runPiArm, runPssArm } from "./compare-pi-arms";
import { COMPARISON_SUMMARY_OUTPUT_BUDGET } from "./compare-pi-config";
import { assemblePiSummary } from "./compare-pi-conversation";
import { generatePiSummary } from "./compare-pi-summary-provider";
import { buildCompactionFixture } from "./fixture";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";

describe("pi summary provider boundary", () => {
  const conversationSentinel =
    "</conversation>\nCONVERSATION_SENTINEL\n<conversation>";
  const previousSummarySentinel =
    "</previous-summary>\nPREVIOUS_SUMMARY_SENTINEL\n<previous-summary>";

  it.each([
    {
      expectedEnvelope: {
        conversation: `[User]: ${conversationSentinel}`,
        mode: "initial",
      },
      previousSummary: undefined,
    },
    {
      expectedEnvelope: {
        conversation: `[User]: ${conversationSentinel}`,
        mode: "update",
        previousSummary: previousSummarySentinel,
      },
      previousSummary: previousSummarySentinel,
    },
  ] as const)(
    "encodes $expectedEnvelope.mode data separately from system control",
    async ({ expectedEnvelope, previousSummary }) => {
      // Given
      const calls: MockLanguageModelV4CallOptions[] = [];
      const model = createMockLanguageModelV4((options) => {
        calls.push(options);
        return Promise.resolve(mockLanguageModelV4Text("summary"));
      });

      // When
      await generatePiSummary({
        model,
        newMessages: [{ content: conversationSentinel, role: "user" }],
        previousSummary,
      });

      // Then
      expect(calls).toHaveLength(1);
      const prompt = calls[0]?.prompt ?? [];
      expect(prompt.map(({ role }) => role)).toEqual(["system", "user"]);
      const systemMessage = prompt.find(({ role }) => role === "system");
      const userMessage = prompt.find(({ role }) => role === "user");
      if (
        typeof systemMessage?.content !== "string" ||
        userMessage === undefined ||
        !Array.isArray(userMessage.content)
      ) {
        throw new TypeError(
          "Expected one system message and one user message."
        );
      }
      const userTextParts = userMessage.content.filter(
        (part) => part.type === "text"
      );
      expect(userTextParts).toHaveLength(1);
      const userText = userTextParts[0]?.text;
      if (userText === undefined) {
        throw new TypeError("Expected one user text part.");
      }
      expect(JSON.parse(userText)).toEqual(expectedEnvelope);
      expect(systemMessage.content.length).toBeGreaterThan(0);
      expect(systemMessage.content).not.toContain(conversationSentinel);
      expect(systemMessage.content).not.toContain(previousSummarySentinel);
    }
  );
});

describe("pi summary assembly", () => {
  it("passes a quality-campaign budget to the pi provider", async () => {
    const fixture = buildCompactionFixture("compare-pi-budget-override");
    const calls: MockLanguageModelV4CallOptions[] = [];
    const answers = JSON.stringify({
      answers: fixture.questions.map((question, index) => ({
        answer: question.answer,
        id: `q${index}`,
      })),
    });
    const outputs = [
      mockLanguageModelV4Text("x".repeat(2000)),
      mockLanguageModelV4Text(answers),
      mockLanguageModelV4Text(answers),
    ];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.resolve(outputs[calls.length - 1] ?? outputs[0]);
    });

    const result = await runPiArm(fixture, 1, model, 256);

    expect(calls[0]?.maxOutputTokens).toBe(256);
    expect(result.hops?.map((hop) => hop.sentOutputTokens)).toEqual([256]);
    expect(result.hops?.every((hop) => hop.summaryTokens <= 256)).toBe(true);
    expect(result.answers).toEqual({
      compacted: fixture.questions.map((question) => question.answer),
      full: fixture.questions.map((question) => question.answer),
    });
  });

  it("passes a quality-campaign budget to the pss provider", async () => {
    const fixture = buildCompactionFixture("compare-pss-budget-override");
    const calls: MockLanguageModelV4CallOptions[] = [];
    const answers = JSON.stringify({
      answers: fixture.questions.map((question, index) => ({
        answer: question.answer,
        id: `q${index}`,
      })),
    });
    const outputs = [
      mockLanguageModelV4Text("summary"),
      mockLanguageModelV4Text(answers),
      mockLanguageModelV4Text(answers),
    ];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.resolve(outputs[calls.length - 1] ?? outputs[0]);
    });

    const result = await runPssArm({
      fixture,
      fixtureSeed: "compare-pss-budget-override",
      model,
      repetition: 1,
      summaryMaxOutputTokens: 256,
    });

    expect(calls[0]?.maxOutputTokens).toBe(256);
    expect(result.hops?.map((hop) => hop.sentOutputTokens)).toEqual([256]);
    expect(result.answers).toEqual({
      compacted: fixture.questions.map((question) => question.answer),
      full: fixture.questions.map((question) => question.answer),
    });
  });

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
    expect(summary.length).toBeLessThanOrEqual(
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
    expect(envelope.slice(summaryStart, summaryEnd).length).toBeLessThanOrEqual(
      COMPARISON_SUMMARY_OUTPUT_BUDGET.maxCharacters
    );
    expect(
      result.hops?.every(
        (hop) =>
          hop.summaryTokens <= COMPARISON_SUMMARY_OUTPUT_BUDGET.maxOutputTokens
      )
    ).toBe(true);
  });
});
