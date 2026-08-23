import type { ModelMessage } from "ai";
import {
  defaultModelPromptMeasurementProfile,
  estimateModelMessagesTokens,
} from "../../llm/context-gate";
import type { ContextTokenView } from "../../llm/context-tokens";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { ThreadTokenEstimator } from "./auto-compaction-types";

export interface CompactionTokenAccountingInput {
  readonly estimatedHistory: readonly ModelMessage[];
  readonly hydratedModelContext: readonly ModelMessage[];
  readonly legacyEstimate?: ThreadTokenEstimator;
  readonly meterView?: ContextTokenView;
  readonly model: ModelGenerationOptions;
  readonly observedInput: readonly ModelMessage[];
  readonly observedOutput: readonly ModelMessage[];
}

export interface CompactionTokenAccounting {
  readonly estimate: ThreadTokenEstimator;
  readonly estimatedContextTokens: number;
  readonly estimatedHistoryMessageTokens?: readonly number[];
  readonly fixedTokens: number;
}

export function compactionTokenAccounting({
  estimatedHistory,
  hydratedModelContext,
  legacyEstimate,
  meterView,
  model,
  observedInput,
  observedOutput,
}: CompactionTokenAccountingInput): CompactionTokenAccounting {
  const measurementProfile =
    model.contextTokens?.measurementProfile ??
    defaultModelPromptMeasurementProfile;
  const estimate: ThreadTokenEstimator = meterView
    ? (messages) =>
        meterView
          .estimateMessageUnits(measurementProfile.measureMessages(messages))
          .reduce((sum, tokens) => sum + tokens, 0)
    : (legacyEstimate ?? estimateModelMessagesTokens);
  const transformOverhead = Math.max(
    0,
    estimate(observedOutput) - estimate(observedInput)
  );
  const meterProfile = meterView?.profile({
    contextMessageUnits:
      measurementProfile.measureMessages(hydratedModelContext),
    historyMessageUnits: measurementProfile.measureMessages(estimatedHistory),
  });
  const instructionsTokens =
    meterProfile?.fixedPrompt || !model.instructions
      ? 0
      : estimate([{ content: model.instructions, role: "system" }]);
  const estimatedHistoryMessageTokens =
    meterProfile?.historyMarginal ??
    (legacyEstimate
      ? estimatedHistory.map((message) => estimate([message]))
      : undefined);
  const fixedTokens =
    (meterProfile?.fixedPrompt ?? 0) + instructionsTokens + transformOverhead;
  return {
    estimate,
    estimatedContextTokens: meterProfile
      ? meterProfile.fullInput + transformOverhead + instructionsTokens
      : estimate(hydratedModelContext) + fixedTokens,
    ...(estimatedHistoryMessageTokens ? { estimatedHistoryMessageTokens } : {}),
    fixedTokens,
  };
}

/** Bound summary output using both the retained-context target and source size. */
export function selectSummaryOutputTokenLimit({
  inputTokens,
  retainTokens,
}: {
  readonly inputTokens: number;
  readonly retainTokens: number;
}): number {
  const policyCeiling = Math.min(
    16_384,
    Math.max(512, Math.floor(retainTokens / 2))
  );
  const inputCeiling = Math.max(256, Math.floor(inputTokens / 2));
  return Math.min(policyCeiling, inputCeiling);
}
