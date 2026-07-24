import { createHash } from "node:crypto";
import { estimateModelMessagesTokens } from "@minpeter/pss-runtime";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  type BenchmarkScenario,
  type CompactionFixture,
  validateCompactionFixture,
} from "./fixture";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { buildScenarioFixture } from "./scenario-fixtures";
import { scoreAnswers } from "./scorer";
import { runCompactionTrial } from "./trial-runner";

const SCENARIO = "long-session" as BenchmarkScenario;
const SEED = "goal5-long-session";
const EXPECTED_FIXTURE_SHA256 =
  "11bbed89257858e178dc0d868a0be8f6459009bac2fe091b6be01374956e8f51";
const EXPECTED_PREFIX_TOKENS = 69_297;
const EXPECTED_CATEGORIES = [
  "exact-recall",
  "file-state",
  "constraint-retention",
  "temporal-resolution",
  "negative-knowledge",
  "hallucination-resistance",
  "tool-history",
  "task-continuation",
] as const;

describe("long-session retention fixture", () => {
  it("uses protocol-short task-state answers without redundant labels", () => {
    const answers = buildScenarioFixture(
      SCENARIO,
      "long-session-short-answers"
    ).questions.map(({ answer }) => answer);

    expect(answers).toEqual(
      expect.arrayContaining(["completed", "in-progress", "blocked"])
    );
  });

  it("has deterministic bytes, token estimate, counts, and one boundary", () => {
    const fixture = buildScenarioFixture(SCENARIO, SEED);
    const repeat = buildScenarioFixture(SCENARIO, SEED);
    const otherSeed = buildScenarioFixture(SCENARIO, `${SEED}-other`);
    const prefix = fixture.messages.slice(0, fixture.compactionEnds[0]);

    expect(fixture.scenario).toBe("long-session");
    expect(fixture.messages).toHaveLength(140);
    expect(fixture.questions).toHaveLength(18);
    expect(fixture.compactionEnds).toEqual([134]);
    expect(digest(fixture)).toBe(EXPECTED_FIXTURE_SHA256);
    expect(digest(fixture)).toBe(digest(repeat));
    expect(digest(fixture)).not.toBe(digest(otherSeed));
    expect(estimateModelMessagesTokens(prefix)).toBe(EXPECTED_PREFIX_TOKENS);
    expect(estimateModelMessagesTokens(prefix)).toBe(
      estimateModelMessagesTokens(
        repeat.messages.slice(0, repeat.compactionEnds[0])
      )
    );
    expect(estimateModelMessagesTokens(prefix)).toBeGreaterThan(32_000);
  });

  it("uses unique filler that contains none of the answer facts", () => {
    const fixture = buildScenarioFixture(SCENARIO, SEED);
    const fillerLines = fixture.messages
      .flatMap(textLines)
      .filter((line) => line.startsWith("DISTRACTOR "));

    expect(fillerLines).toHaveLength(864);
    expect(new Set(fillerLines)).toHaveLength(fillerLines.length);
    for (const { answer, question } of fixture.questions) {
      expect(
        fillerLines.some((line) => line.includes(answer)),
        `filler repeated the answer for: ${question}`
      ).toBe(false);
    }
  });

  it("sources every categorized answer once and gives full control 100%", () => {
    const fixture = buildScenarioFixture(SCENARIO, SEED);
    const sourceIndexes = new Set<number>();
    const sourcedAnswers = new Map(
      fixture.questions.map((question) => {
        const indexes = messageIndexesContaining(fixture, question.answer);
        expect(indexes, question.question).toHaveLength(1);
        sourceIndexes.add(indexes[0] ?? -1);
        return [question, indexes.length === 1 ? question.answer : "unknown"];
      })
    );

    expect(sourceIndexes).toHaveLength(fixture.questions.length);
    expect([
      ...new Set(fixture.questions.map(({ category }) => category)),
    ]).toEqual(EXPECTED_CATEGORIES);
    expect(
      scoreAnswers(fixture.questions, sourcedAnswers, sourcedAnswers)
    ).toMatchObject({
      arms: {
        compacted: { overall: { correct: 18, total: 18 } },
        full: { overall: { correct: 18, total: 18 } },
      },
      headline: { correct: 18, total: 18 },
    });
  });

  it("keeps actual tool evidence whole before an assistant-text to user boundary", () => {
    const fixture = buildScenarioFixture(SCENARIO, SEED);
    const end = fixture.compactionEnds[0] ?? 0;
    const toolCallIndex = fixture.messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "tool-call")
    );
    const call = fixture.messages[toolCallIndex];
    const result = fixture.messages[toolCallIndex + 1];
    const toolAnswers = fixture.questions
      .filter(({ category }) => category === "tool-history")
      .map(({ answer }) => answer);

    expect(toolCallIndex).toBeGreaterThan(0);
    expect(toolCallIndex + 1).toBeLessThan(end);
    expect([call?.role, result?.role]).toEqual(["assistant", "tool"]);
    expect(JSON.stringify([call, result])).toContain(toolAnswers[0]);
    expect(JSON.stringify([call, result])).toContain(toolAnswers[1]);
    expect(fixture.messages[end - 1]).toMatchObject({ role: "assistant" });
    expect(typeof fixture.messages[end - 1]?.content).toBe("string");
    expect(fixture.messages[end]).toMatchObject({ role: "user" });
  });

  it("runs one valid full-control mock evaluator trial", async () => {
    const fixture = buildScenarioFixture(SCENARIO, SEED);
    const answers = JSON.stringify({
      answers: fixture.questions.map(({ answer }, index) => ({
        answer,
        id: `q${index}`,
      })),
    });
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("Concise durable handoff."),
      mockLanguageModelV4Text(answers),
      mockLanguageModelV4Text(answers),
    ]);

    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: SEED,
      id: "long-session-mock-trial",
      model,
      repetition: 1,
      seed: 5005,
      summaryMaxOutputTokens: 1024,
    });

    expect(record).toMatchObject({
      hops: [{ endSeqExclusive: 134 }],
      score: {
        arms: { full: { overall: { correct: 18, total: 18 } } },
        headline: { correct: 18, total: 18 },
      },
      status: "valid",
    });
  });

  it("rejects a malformed boundary that splits the tool pair", () => {
    const fixture = buildScenarioFixture(SCENARIO, SEED);
    const toolCallIndex = fixture.messages.findIndex(
      (message) =>
        message.role === "assistant" && Array.isArray(message.content)
    );
    const malformed = {
      ...fixture,
      compactionEnds: [toolCallIndex + 1],
    };

    expect(() => validateCompactionFixture(malformed)).toThrow(
      "tool-safe assistant-text to user transition"
    );
  });

  it("keeps the late exact Next action directly answerable", () => {
    const fixture = buildScenarioFixture(SCENARIO, SEED);
    const nextAction = fixture.questions.find(({ question }) =>
      question.includes("exact Next action")
    );

    expect(nextAction).toBeDefined();
    expect(
      messageIndexesContaining(fixture, nextAction?.answer ?? "missing"),
      nextAction?.question
    ).toHaveLength(1);
  });
});

function digest(fixture: CompactionFixture): string {
  return createHash("sha256").update(JSON.stringify(fixture)).digest("hex");
}

function messageIndexesContaining(
  fixture: CompactionFixture,
  answer: string
): number[] {
  return fixture.messages.flatMap((message, index) =>
    JSON.stringify(message).includes(answer) ? [index] : []
  );
}

function textLines(message: ModelMessage): string[] {
  return typeof message.content === "string" ? message.content.split("\n") : [];
}
