import {
  estimateModelMessagesTokens,
  type ModelContextTokenEstimateInput,
} from "../../llm/context-gate";
import {
  compactionContextForModel,
  compactionContextMessage,
} from "../state/context";
import type { ThreadCompactionInput } from "../state/thread-state";
import {
  latestPrefixCompaction,
  selectAutoCompactionRange,
} from "./auto-compaction-range";
import {
  type AgentCompaction,
  type AgentCompactionContext,
  DEFAULT_COMPACTION_DEADLINE_MS,
  type ThreadTokenEstimator,
} from "./auto-compaction-types";
import { equalSnapshot } from "./snapshot-equal";

export interface SpeculativeCompactionOptions {
  readonly deadlineMs?: number;
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
  replacementAttempted: boolean;
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
  if (!(Number.isSafeInteger(deadlineMs) && deadlineMs > 0)) {
    throw new TypeError(
      "speculativeCompaction: deadlineMs must be a positive integer."
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
  const compact = async (
    context: AgentCompactionContext
  ): Promise<ThreadCompactionInput | undefined> => {
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
    if (tokens < Math.floor(max * prepare)) {
      return;
    }
    if (candidate) {
      if (candidate.replacementAttempted) {
        return;
      }
      candidate.replacementAttempted = true;
      await prepareCandidate({
        candidates,
        context,
        estimate,
        expectedCandidate: candidate,
        max,
        replacementAttempted: true,
        retain,
      });
      return;
    }
    await prepareCandidate({
      candidates,
      context,
      estimate,
      max,
      replacementAttempted: false,
      retain,
    });
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

async function prepareCandidate({
  candidates,
  context,
  estimate,
  expectedCandidate,
  max,
  replacementAttempted,
  retain,
}: {
  readonly candidates: WeakMap<object, Candidate>;
  readonly context: AgentCompactionContext;
  readonly estimate: ThreadTokenEstimator;
  readonly expectedCandidate?: Candidate;
  readonly max: number;
  readonly replacementAttempted: boolean;
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
  if (
    expectedCandidate &&
    candidates.get(context.threadIdentity) !== expectedCandidate
  ) {
    return;
  }
  candidates.set(context.threadIdentity, {
    compactions: structuredClone(context.compactions),
    input,
    prefix: structuredClone(context.history.slice(0, range.endSeqExclusive)),
    replacementAttempted,
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
  const fit =
    candidate !== undefined &&
    candidateFits({ candidate, context, estimate, max });
  const needsBroaderOverflowSummary =
    context.reason === "overflow" &&
    candidate !== undefined &&
    currentRange !== undefined &&
    currentRange.endSeqExclusive > candidate.input.endSeqExclusive &&
    !fit;
  if (candidate && fit && !needsBroaderOverflowSummary) {
    return candidate.input;
  }
  const range = currentRange;
  if (!range) {
    return;
  }
  const summary = await context.summarize(range);
  return summary.trim() ? { ...range, summary } : undefined;
}

function candidateFits({
  candidate,
  context,
  estimate,
  max,
}: {
  readonly candidate: Candidate;
  readonly context: AgentCompactionContext;
  readonly estimate: ThreadTokenEstimator;
  readonly max: number;
}): boolean {
  if (candidate.input.startSeq !== 0) {
    return false;
  }
  const prefix = latestPrefixCompaction(context.compactions);
  if (
    prefix !== undefined &&
    candidate.input.endSeqExclusive < prefix.endSeqExclusive
  ) {
    return false;
  }
  const projected =
    prefix === undefined
      ? context.history
      : [
          compactionContextForModel(compactionContextMessage(prefix)),
          ...context.history.slice(prefix.endSeqExclusive),
        ];
  if (!equalSnapshot(context.modelContext, projected)) {
    return false;
  }
  const wrapper = compactionContextForModel({
    endSeqExclusive: candidate.input.endSeqExclusive,
    role: "compaction",
    startSeq: candidate.input.startSeq,
    summary: candidate.input.summary,
  });
  const tail = context.estimatedHistory.slice(candidate.input.endSeqExclusive);
  const tokensFor = context.estimateTokens ?? estimate;
  const historyTokens = context.estimatedHistoryMessageTokens
    ? tokensFor([wrapper]) +
      context.estimatedHistoryMessageTokens
        .slice(candidate.input.endSeqExclusive)
        .reduce((total, tokens) => total + tokens, 0)
    : tokensFor([wrapper, ...tail]);
  return context.instructionsTokens + historyTokens <= max;
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
