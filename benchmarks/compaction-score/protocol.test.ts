import { describe, expect, it } from "vitest";
import type { FixtureQuestion } from "./fixture";
import {
  BatchedAnswerProtocolError,
  buildBatchedQuestionPrompt,
  parseBatchedAnswers,
} from "./protocol";

const questions: FixtureQuestion[] = [
  {
    answer: "alpha",
    category: "exact-recall",
    question: "First value?",
  },
  {
    answer: "beta",
    category: "tool-history",
    question: "Second value?",
  },
];

describe("batched answer protocol", () => {
  it("builds one indexed prompt for every hidden question", () => {
    expect(buildBatchedQuestionPrompt(questions)).toContain(
      '"id": "q0", "question": "First value?"'
    );
    expect(buildBatchedQuestionPrompt(questions)).toContain(
      '"id": "q1", "question": "Second value?"'
    );
  });

  it("requires canonical values without task labels or elaboration", () => {
    expect(buildBatchedQuestionPrompt(questions)).toContain(
      "For labeled task state, Blocker, or Next action, return only the exact value after the label; omit the label, punctuation, and added context."
    );
  });

  it("parses fenced JSON into question-keyed answers", () => {
    const answers = parseBatchedAnswers(
      '```json\n{"answers":[{"id":"q0","answer":"alpha"},{"id":"q1","answer":"beta"}]}\n```',
      questions
    );

    expect(answers.get(questions[0])).toBe("alpha");
    expect(answers.get(questions[1])).toBe("beta");
  });

  it.each([
    '{"answers":[{"id":"q0","answer":"alpha"}]}',
    '{"answers":[{"id":"q0","answer":"alpha"},{"id":"q0","answer":"again"},{"id":"q1","answer":"beta"}]}',
    '{"answers":[{"id":"q0","answer":"alpha"},{"id":"q9","answer":"beta"}]}',
    "not json",
  ])("rejects malformed or incomplete protocol output: %s", (output) => {
    expect(() => parseBatchedAnswers(output, questions)).toThrow(
      BatchedAnswerProtocolError
    );
  });
});
