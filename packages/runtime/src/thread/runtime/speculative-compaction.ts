import {
  estimateModelMessagesTokens,
  type ModelContextTokenEstimateInput,
} from "../../llm/context-gate";
import { selectAutoCompactionRange } from "./auto-compaction-range";
import type {
  AgentCompactionContext,
  AgentCompactionPolicy,
  ThreadTokenEstimator,
} from "./auto-compaction-types";
import { equalSnapshot } from "./snapshot-equal";

export interface SpeculativeCompactionOptions {
  readonly estimateTokens?: ThreadTokenEstimator;
  readonly maxInputTokens?: number;
  readonly prepareRatio?: number;
  readonly promoteRatio?: number;
  readonly retainRatio?: number;
}

interface Candidate {
  readonly compactions: readonly unknown[];
  readonly input: {
    readonly startSeq: number;
    readonly endSeqExclusive: number;
    readonly summary: string;
  };
  readonly prefix: readonly unknown[];
}

/**
 * Prepare a summary at 65% of the context budget and promote it at 80% without
 * another model call. By default the newest 40% of the model context is kept.
 */
export function speculativeCompaction(
  options: SpeculativeCompactionOptions = {}
): AgentCompactionPolicy {
  const max = options.maxInputTokens ?? 128_000;
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
  if (prepare >= promote) {
    throw new TypeError(
      "speculativeCompaction: prepareRatio must be smaller than promoteRatio."
    );
  }
  const customEstimate = options.estimateTokens;
  const estimate = customEstimate ?? estimateModelMessagesTokens;
  const candidates = new WeakMap<object, Candidate>();
  const compact = async (context: AgentCompactionContext) => {
    const tokens = context.estimatedContextTokens;
    const candidate = getFreshCandidate(candidates, context);
    if (tokens >= Math.floor(max * promote) || context.reason === "overflow") {
      return await promoteCandidate({
        candidate,
        candidates,
        context,
        estimate,
        max,
        retain,
      });
    }
    if (tokens < Math.floor(max * prepare) || candidate) {
      return;
    }
    await prepareCandidate({ candidates, context, estimate, max, retain });
    return;
  };
  return {
    compact,
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
  };
}

async function prepareCandidate({
  candidates,
  context,
  estimate,
  max,
  retain,
}: {
  readonly candidates: WeakMap<object, Candidate>;
  readonly context: AgentCompactionContext;
  readonly estimate: ThreadTokenEstimator;
  readonly max: number;
  readonly retain: number;
}): Promise<void> {
  const range = selectRange(context, estimate, max, retain);
  if (!range) {
    return;
  }
  const input = { ...range, summary: await context.summarize(range) };
  if (!input.summary.trim()) {
    return;
  }
  candidates.set(context.threadIdentity, {
    compactions: structuredClone(context.compactions),
    input,
    prefix: structuredClone(context.history.slice(0, range.endSeqExclusive)),
  });
}

async function promoteCandidate({
  candidate,
  candidates,
  context,
  estimate,
  max,
  retain,
}: {
  readonly candidate: Candidate | undefined;
  readonly candidates: WeakMap<object, Candidate>;
  readonly context: AgentCompactionContext;
  readonly estimate: ThreadTokenEstimator;
  readonly max: number;
  readonly retain: number;
}) {
  candidates.delete(context.threadIdentity);
  const currentRange = selectRange(context, estimate, max, retain);
  const needsBroaderOverflowSummary =
    context.reason === "overflow" &&
    candidate !== undefined &&
    currentRange !== undefined &&
    currentRange.endSeqExclusive > candidate.input.endSeqExclusive;
  if (candidate && !needsBroaderOverflowSummary) {
    return candidate.input;
  }
  const range = currentRange;
  if (!range) {
    return candidate?.input;
  }
  const summary = await context.summarize(range);
  return summary.trim() ? { ...range, summary } : undefined;
}

function getFreshCandidate(
  candidates: WeakMap<object, Candidate>,
  context: AgentCompactionContext
): Candidate | undefined {
  const candidate = candidates.get(context.threadIdentity);
  if (
    candidate &&
    equalSnapshot(
      candidate.prefix,
      context.history.slice(0, candidate.input.endSeqExclusive)
    ) &&
    equalSnapshot(candidate.compactions, context.compactions)
  ) {
    return candidate;
  }
  candidates.delete(context.threadIdentity);
  return;
}

function selectRange(
  context: AgentCompactionContext,
  estimate: ThreadTokenEstimator,
  max: number,
  retain: number
) {
  return selectAutoCompactionRange({
    compactions: context.compactions,
    history: context.estimatedHistory,
    instructionsTokens: context.instructionsTokens,
    messageTokenCosts: context.estimatedHistoryMessageTokens,
    policy: {
      estimateTokens: context.estimateTokens ?? estimate,
      retainTokens: Math.floor(max * retain),
      triggerTokens: 1,
    },
  });
}
