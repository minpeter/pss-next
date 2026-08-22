import {
  estimateModelMessagesTokens,
  type ModelContextTokenEstimateInput,
} from "../../llm/context-gate";
import type { ThreadCompactionInput } from "../state/thread-state";
import {
  type AgentCompaction,
  type AgentCompactionContext,
  DEFAULT_COMPACTION_DEADLINE_MS,
  MAX_COMPACTION_DEADLINE_MS,
  type ThreadTokenEstimator,
} from "./auto-compaction-types";
import { SpeculativeCompactionCandidates } from "./speculative-compaction-candidates";

export interface SpeculativeCompactionOptions {
  readonly deadlineMs?: number;
  readonly estimateTokens?: ThreadTokenEstimator;
  readonly maxInputTokens?: number;
  readonly prepareRatio?: number;
  readonly promoteRatio?: number;
  readonly retainRatio?: number;
}

/**
 * Prepare a summary at 65% of the context budget and promote it at 80% without
 * another model call. By default the newest 40% of the model context is kept.
 */
export function speculativeCompaction(
  options: SpeculativeCompactionOptions = {}
): AgentCompaction {
  const max = options.maxInputTokens ?? 128_000;
  const deadlineMs = options.deadlineMs ?? DEFAULT_COMPACTION_DEADLINE_MS;
  const prepare = options.prepareRatio ?? 0.65;
  const promote = options.promoteRatio ?? 0.8;
  const retain = options.retainRatio ?? 0.4;
  for (const [name, value] of [
    ["prepareRatio", prepare],
    ["promoteRatio", promote],
    ["retainRatio", retain],
  ] as const) {
    if (!(value > 0 && value < 1)) {
      throw new TypeError(
        `speculativeCompaction: ${name} must be between 0 and 1.`
      );
    }
  }
  if (!(Number.isSafeInteger(max) && max > 0)) {
    throw new TypeError(
      "speculativeCompaction: maxInputTokens must be a positive integer."
    );
  }
  if (
    !(
      Number.isSafeInteger(deadlineMs) &&
      deadlineMs > 0 &&
      deadlineMs <= MAX_COMPACTION_DEADLINE_MS
    )
  ) {
    throw new TypeError(
      `speculativeCompaction: deadlineMs must be a positive integer no greater than ${MAX_COMPACTION_DEADLINE_MS}.`
    );
  }
  if (prepare >= promote) {
    throw new TypeError(
      "speculativeCompaction: prepareRatio must be smaller than promoteRatio."
    );
  }
  const customEstimate = options.estimateTokens;
  const estimate = customEstimate ?? estimateModelMessagesTokens;
  const candidates = new SpeculativeCompactionCandidates({
    estimate,
    max,
    retain,
  });
  const compact = async (
    context: AgentCompactionContext
  ): Promise<ThreadCompactionInput | undefined> => {
    const tokens = context.estimatedContextTokens;
    if (tokens >= Math.floor(max * promote) || context.reason === "overflow") {
      return await candidates.promote(context);
    }
    if (tokens < Math.floor(max * prepare)) {
      return;
    }
    await candidates.prepare(context);
    return;
  };
  return Object.assign(compact, {
    deadlineMs: () => deadlineMs,
    ...(customEstimate
      ? {
          estimateTokens: ({
            instructions,
            messages,
          }: ModelContextTokenEstimateInput) =>
            customEstimate(
              instructions
                ? [{ content: instructions, role: "system" }, ...messages]
                : messages
            ),
        }
      : {}),
    maxInputTokens: () => max,
    onOverflow: "compact" as const,
  });
}
