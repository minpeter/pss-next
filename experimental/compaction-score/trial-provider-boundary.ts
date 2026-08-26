import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { FixtureQuestion } from "./fixture";
import { buildBatchedQuestionPrompt } from "./protocol";
import type { TrialRecord } from "./report";

interface EvaluationInput {
  readonly context: ModelMessage[];
  readonly model: LanguageModel;
  readonly questions: readonly FixtureQuestion[];
  readonly seed?: number;
  readonly signal: AbortSignal;
}

export async function evaluateArm({
  context,
  model,
  questions,
  seed,
  signal,
}: EvaluationInput): Promise<string> {
  const { text } = await generateText({
    abortSignal: signal,
    messages: [
      ...context,
      {
        content: buildBatchedQuestionPrompt(questions),
        role: "user",
      },
    ],
    model,
    ...(seed === undefined ? {} : { seed }),
    temperature: 0,
  });
  return text;
}

export function stableTrialError(
  status: Exclude<TrialRecord["status"], "valid">,
  _cause: unknown
): string {
  return status;
}
