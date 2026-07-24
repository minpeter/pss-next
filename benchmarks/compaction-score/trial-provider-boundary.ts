import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { FixtureQuestion } from "./fixture";
import { buildBatchedQuestionPrompt } from "./protocol";
import type { TrialRecord } from "./report";

interface EvaluationInput {
  readonly context: ModelMessage[];
  readonly model: LanguageModel;
  readonly questions: readonly FixtureQuestion[];
  readonly seed?: number;
}

export async function evaluateArm({
  context,
  model,
  questions,
  seed,
}: EvaluationInput): Promise<string> {
  const { text } = await generateText({
    maxOutputTokens: 4096,
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
  cause: unknown
): string {
  if (
    status === "evaluation-provider-failure" ||
    status === "summary-provider-failure"
  ) {
    return status;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
