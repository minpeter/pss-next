import type { FixtureQuestion } from "./fixture";

const CODE_FENCE_START = /^```(?:json)?\s*/i;
const CODE_FENCE_END = /\s*```$/;

export const BATCHED_ANSWER_RULES = {
  labeledStateMode: "value-only",
  toolResultMode: "complete",
} as const;

export class BatchedAnswerProtocolError extends Error {
  readonly name = "BatchedAnswerProtocolError";
}

export function buildBatchedQuestionPrompt(
  questions: readonly FixtureQuestion[]
): string {
  const lines = questions.map(
    (question, index) =>
      `{"id": "q${index}", "question": ${JSON.stringify(question.question)}}`
  );

  return [
    "Answer every question using only the preceding conversation.",
    'Return JSON only in this shape: {"answers":[{"id":"q0","answer":"exact value"}]}.',
    "Include every id exactly once. Use the shortest exact value, with no explanation.",
    `For labeled task state, Blocker, or Next action, use ${BATCHED_ANSWER_RULES.labeledStateMode} mode: return only the exact value after the label; omit the label, punctuation, and added context.`,
    `For a tool result, use ${BATCHED_ANSWER_RULES.toolResultMode} mode: return the complete exact result, including leading status counts and error text.`,
    'If the conversation does not contain an answer, use "unknown".',
    "",
    ...lines,
  ].join("\n");
}

export function parseBatchedAnswers(
  output: string,
  questions: readonly FixtureQuestion[]
): Map<FixtureQuestion, string> {
  const parsed = parseJson(output);
  if (!(isRecord(parsed) && Array.isArray(parsed.answers))) {
    throw new BatchedAnswerProtocolError(
      'Expected an object with an "answers" array.'
    );
  }

  const expectedIds = new Set(questions.map((_, index) => questionId(index)));
  const byId = new Map<string, string>();

  for (const item of parsed.answers) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.answer !== "string"
    ) {
      throw new BatchedAnswerProtocolError(
        "Each answer must contain string id and answer fields."
      );
    }
    if (!expectedIds.has(item.id)) {
      throw new BatchedAnswerProtocolError(`Unexpected answer id: ${item.id}`);
    }
    if (byId.has(item.id)) {
      throw new BatchedAnswerProtocolError(`Duplicate answer id: ${item.id}`);
    }
    byId.set(item.id, item.answer);
  }

  if (byId.size !== questions.length) {
    throw new BatchedAnswerProtocolError(
      `Expected ${questions.length} answers, received ${byId.size}.`
    );
  }

  return new Map(
    questions.map((question, index) => [
      question,
      byId.get(questionId(index)) as string,
    ])
  );
}

function parseJson(output: string): unknown {
  const trimmed = output.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(CODE_FENCE_START, "").replace(CODE_FENCE_END, "")
    : trimmed;

  try {
    return JSON.parse(unfenced);
  } catch (cause) {
    throw new BatchedAnswerProtocolError(
      `Answer output was not valid JSON: ${String(cause)}`
    );
  }
}

function questionId(index: number): string {
  return `q${index}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
