import type { ModelMessage } from "ai";
import type { PreparedModelToolChoice } from "./model-step-preparation";
import {
  defaultModelPromptMeasurementProfile,
  type ModelContextTokenEstimateInput,
  type ModelPromptTool,
} from "./prompt-measurement";

export type {
  ModelContextTokenEstimateInput,
  ModelPromptMeasurement,
  ModelPromptMeasurementProfile,
  ModelPromptTool,
} from "./prompt-measurement";
// biome-ignore lint/performance/noBarrelFile: Stable compatibility entrypoint after splitting prompt measurement.
export {
  defaultModelPromptMeasurementProfile,
  estimateModelMessagesTokens,
  materializeModelPromptTools,
  modelPromptTools,
} from "./prompt-measurement";

/**
 * A budget source consulted before every model request. The gate calls
 * `maxInputTokens()` (and `estimateTokens`, when provided) on each call, so
 * hosts may back the budget with live signal such as the active model's
 * context window.
 */
export interface ContextBudgetSource {
  readonly bufferTokens?: number;
  readonly estimateTokens?: (input: ModelContextTokenEstimateInput) => number;
  readonly maxInputTokens: () => number;
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
  promptTools,
  toolChoice,
}: {
  readonly contextGate?: false | ContextBudgetSource;
  readonly instructions?: string;
  readonly messages: readonly ModelMessage[];
  readonly promptTools?: readonly ModelPromptTool[];
  readonly toolChoice?: PreparedModelToolChoice;
}): void {
  if (!contextGate) {
    return;
  }

  const bufferTokens = contextGate.bufferTokens ?? 0;
  const maxInputTokens = contextGate.maxInputTokens();
  const estimatedTokens = estimatePromptTokens(
    {
      ...(instructions === undefined ? {} : { instructions }),
      messages,
      ...(toolChoice === undefined ? {} : { toolChoice }),
      ...(promptTools === undefined ? {} : { tools: promptTools }),
    },
    contextGate.estimateTokens
  );
  if (estimatedTokens + bufferTokens <= maxInputTokens) {
    return;
  }

  throw new ContextBudgetExceededError({
    bufferTokens,
    estimatedTokens,
    maxInputTokens,
    onOverflow: contextGate.onOverflow ?? "compact",
  });
}

function estimatePromptTokens(
  input: ModelContextTokenEstimateInput,
  estimator: ContextBudgetSource["estimateTokens"]
): number {
  if (estimator) {
    return estimator(input);
  }

  return defaultModelPromptMeasurementProfile.measurePrompt(input).totalUnits;
}
