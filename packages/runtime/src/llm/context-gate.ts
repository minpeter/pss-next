import type { ModelMessage } from "ai";

export interface ModelContextTokenEstimateInput {
  readonly instructions?: string;
  readonly messages: readonly ModelMessage[];
}

export interface ModelContextGateOptions {
  readonly bufferTokens?: number;
  readonly estimateTokens?: (input: ModelContextTokenEstimateInput) => number;
  readonly maxInputTokens: number;
  readonly onOverflow?: "compact" | "error";
}

export class ContextBudgetExceededError extends Error {
  readonly bufferTokens: number;
  readonly estimatedTokens: number;
  readonly maxInputTokens: number;
  readonly name = "ContextBudgetExceededError";
  readonly onOverflow: "compact" | "error";

  constructor({
    bufferTokens,
    estimatedTokens,
    maxInputTokens,
    onOverflow,
  }: {
    readonly bufferTokens: number;
    readonly estimatedTokens: number;
    readonly maxInputTokens: number;
    readonly onOverflow: "compact" | "error";
  }) {
    super(
      `context gate rejected prompt: estimated ${estimatedTokens} input tokens plus ${bufferTokens} reserved tokens exceeds maxInputTokens ${maxInputTokens}.`
    );
    this.bufferTokens = bufferTokens;
    this.estimatedTokens = estimatedTokens;
    this.maxInputTokens = maxInputTokens;
    this.onOverflow = onOverflow;
  }
}

export function enforceContextGate({
  contextGate,
  instructions,
  messages,
}: {
  readonly contextGate?: false | ModelContextGateOptions;
  readonly instructions?: string;
  readonly messages: readonly ModelMessage[];
}): void {
  if (!contextGate) {
    return;
  }

  const bufferTokens = contextGate.bufferTokens ?? 0;
  const estimatedTokens = estimatePromptTokens(
    { instructions, messages },
    contextGate.estimateTokens
  );
  if (estimatedTokens + bufferTokens <= contextGate.maxInputTokens) {
    return;
  }

  throw new ContextBudgetExceededError({
    bufferTokens,
    estimatedTokens,
    maxInputTokens: contextGate.maxInputTokens,
    onOverflow: contextGate.onOverflow ?? "compact",
  });
}

function estimatePromptTokens(
  input: ModelContextTokenEstimateInput,
  estimator: ModelContextGateOptions["estimateTokens"]
): number {
  if (estimator) {
    return estimator(input);
  }

  const serialized = JSON.stringify(
    {
      instructions: input.instructions,
      messages: input.messages,
    },
    promptTokenEstimateReplacer
  );
  return Math.ceil(serialized.length / 4);
}

export function estimateModelMessagesTokens(
  messages: readonly ModelMessage[]
): number {
  return Math.ceil(
    JSON.stringify(messages, promptTokenEstimateReplacer).length / 4
  );
}

function promptTokenEstimateReplacer(_key: string, value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return binaryPromptTokenEstimate(value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return binaryPromptTokenEstimate(value.byteLength);
  }
  return value;
}

function binaryPromptTokenEstimate(byteLength: number): {
  readonly byteLength: number;
  readonly type: "binary";
} {
  return { byteLength, type: "binary" };
}
