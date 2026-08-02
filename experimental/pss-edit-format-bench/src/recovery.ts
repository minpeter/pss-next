export interface RecoveryModelCall {
  readonly content: string;
  readonly role: "user" | "assistant";
}

export type RecoveryModelCaller = (
  messages: readonly RecoveryModelCall[]
) => Promise<{ text: string }>;

export interface RecoveryOutcome {
  readonly attemptsUsed: number;
  readonly errorSequence: readonly string[];
  readonly firstAttemptFailed: boolean;
  readonly recovered: boolean;
  readonly repeatedFailure: boolean;
}

export interface RunWithRecoveryOptions {
  readonly apply: (
    reply: string,
    initial: string
  ) => { readonly error?: string; readonly text?: string };
  readonly callModel: RecoveryModelCaller;
  readonly expected: string;
  readonly initial: string;
  readonly maxAttempts: number;
  readonly userPrompt: string;
}

const failureClass = (
  error: string | undefined,
  produced: string | undefined,
  expected: string
): string => {
  if (error !== undefined) {
    return "unparsable";
  }
  if (
    produced !== undefined &&
    produced.replaceAll(/\s+/gu, "") === expected.replaceAll(/\s+/gu, "")
  ) {
    return "indentation";
  }
  return "wrong-content";
};

const feedbackFor = (
  error: string | undefined,
  produced: string | undefined
): string => {
  if (error !== undefined) {
    return `The edit was rejected: ${error}. Re-read the file and retry with a corrected edit. Output only the edit, nothing else.`;
  }
  return `The edit applied but the result does not match the intended change. Current file content:\n\`\`\`\n${produced}\`\`\`\nRe-read and retry with a corrected edit. Output only the edit, nothing else.`;
};

export const runWithRecovery = async ({
  apply,
  callModel,
  expected,
  initial,
  maxAttempts,
  userPrompt,
}: RunWithRecoveryOptions): Promise<RecoveryOutcome> => {
  const messages: RecoveryModelCall[] = [{ content: userPrompt, role: "user" }];
  const errorSequence: string[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await callModel(messages);
    const outcome = apply(result.text, initial);
    if (outcome.text === expected) {
      return {
        attemptsUsed: attempt + 1,
        errorSequence,
        firstAttemptFailed: attempt > 0,
        recovered: true,
        repeatedFailure: false,
      };
    }
    errorSequence.push(failureClass(outcome.error, outcome.text, expected));
    messages.push({ content: result.text, role: "assistant" });
    messages.push({
      content: feedbackFor(outcome.error, outcome.text),
      role: "user",
    });
  }
  return {
    attemptsUsed: maxAttempts,
    errorSequence,
    firstAttemptFailed: true,
    recovered: false,
    repeatedFailure: new Set(errorSequence).size === 1,
  };
};
