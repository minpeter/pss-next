export type RecoveryModelCall =
  | { readonly content: string; readonly role: "user" }
  | {
      readonly content: string;
      readonly role: "assistant";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly output: string;
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
    };

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
    initial: string,
    path?: string
  ) => {
    readonly error?: string;
    readonly text?: string;
    readonly toolOutput?: string;
  };
  readonly callModel: RecoveryModelCaller;
  readonly expected: string;
  readonly initial: string;
  readonly maxAttempts: number;
  readonly path: string;
  /**
   * Renders the current file state the way the real read_file tool would
   * (anchored lines + file hash). Appended to the tool result after an edit
   * that applied but missed, so the model can verify the actual result — the
   * verification channel a real agent has after edit_file.
   */
  readonly renderFile: (path: string, content: string) => string;
  readonly toolName: string;
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

export const runWithRecovery = async ({
  apply,
  callModel,
  expected,
  initial,
  maxAttempts,
  path,
  renderFile,
  toolName,
  userPrompt,
}: RunWithRecoveryOptions): Promise<RecoveryOutcome> => {
  const messages: RecoveryModelCall[] = [{ content: userPrompt, role: "user" }];
  const errorSequence: string[] = [];
  // A real agent's edits accumulate: each retry applies against the file as it
  // stands after the previous attempts, and the anchors/hash shown by
  // renderFile are those of that accumulated state. Applying every retry to
  // the original file instead would reject the model's corrected edits as
  // stale anchors even when they are right.
  let current = initial;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await callModel(messages);
    const outcome = apply(result.text, current, path);
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
    const toolCallId = `edit-${attempt + 1}`;
    messages.push({
      content: result.text,
      role: "assistant",
      toolCallId,
      toolName,
    });
    if (outcome.error === undefined && outcome.text !== undefined) {
      current = outcome.text;
    }
    const currentFile =
      outcome.error === undefined && outcome.text !== undefined
        ? `\n\n${renderFile(path, outcome.text)}`
        : "";
    messages.push({
      output: `${outcome.error ?? outcome.toolOutput ?? ""}${currentFile}`,
      role: "tool",
      toolCallId,
      toolName,
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
