import type { ModelMessage } from "ai";
import { isRecord as isObjectRecord } from "../../internal/guards";
import { estimateModelMessagesTokens } from "../../llm/context-gate";
import {
  compactionContextForModel,
  compactionContextMessage,
} from "../state/context";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type {
  AutoCompactionRange,
  ThreadTokenEstimator,
} from "./auto-compaction-types";

export interface CompactionRangePolicy {
  readonly estimateTokens?: ThreadTokenEstimator;
  readonly retainTokens: number;
  readonly triggerTokens: number;
}

/**
 * A compaction summary always pays the model-facing wrapper overhead, so a
 * source range smaller than one empty wrapper can never compress and is
 * skipped before spending a summary model call.
 */
export const MIN_SOURCE_WRAPPER_MULTIPLE = 1;

export function selectAutoCompactionRange({
  compactions,
  history,
  instructionsTokens = 0,
  messageTokenCosts,
  policy,
}: {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly history: readonly ModelMessage[];
  readonly instructionsTokens?: number;
  /** Precomputed marginal costs aligned by index with history. */
  readonly messageTokenCosts?: readonly number[];
  readonly policy: CompactionRangePolicy;
}): AutoCompactionRange | undefined {
  const estimate = policy.estimateTokens ?? estimateModelMessagesTokens;
  if (messageTokenCosts && messageTokenCosts.length !== history.length) {
    throw new TypeError("messageTokenCosts must align with history.");
  }
  const covered = latestPrefixCompaction(compactions);
  const coveredEnd = covered?.endSeqExclusive ?? 0;
  const summaryTokens = covered
    ? estimate([compactionContextForModel(compactionContextMessage(covered))])
    : 0;
  const suffix = history.slice(coveredEnd);
  const suffixTokens = messageTokenCosts
    ? messageTokenCosts.slice(coveredEnd)
    : suffix.map((message) => estimate([message]));
  const totalTokens =
    instructionsTokens +
    summaryTokens +
    suffixTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (totalTokens < policy.triggerTokens) {
    return;
  }

  const tailBudget = Math.max(0, policy.retainTokens - instructionsTokens);
  let retainedTokens = 0;
  let tailStart = suffix.length;
  while (tailStart > 0) {
    const nextTokens = suffixTokens[tailStart - 1] ?? 0;
    if (tailStart < suffix.length && retainedTokens + nextTokens > tailBudget) {
      break;
    }
    retainedTokens += nextTokens;
    tailStart -= 1;
  }

  const targetEndSeqExclusive = coveredEnd + tailStart;
  if (targetEndSeqExclusive <= coveredEnd) {
    return;
  }

  const endSeqExclusive = selectSafeCompactionBoundary(
    history,
    coveredEnd,
    targetEndSeqExclusive
  );
  if (endSeqExclusive === undefined) {
    return;
  }

  const sourceTokens =
    summaryTokens +
    suffixTokens
      .slice(0, endSeqExclusive - coveredEnd)
      .reduce((sum, tokens) => sum + tokens, 0);
  const wrapperFloorTokens = estimate([
    compactionContextForModel({
      endSeqExclusive,
      role: "compaction",
      startSeq: 0,
      summary: "",
    }),
  ]);
  if (sourceTokens < wrapperFloorTokens * MIN_SOURCE_WRAPPER_MULTIPLE) {
    return;
  }

  return { endSeqExclusive, startSeq: 0 };
}

export function latestPrefixCompaction(
  compactions: readonly ThreadCompactionRecord[]
): ThreadCompactionRecord | undefined {
  // Newest-first matches ModelMessageHistory nonOverlappedCompactions: a later
  // overlapping prefix wins even when it covers less history.
  for (let index = compactions.length - 1; index >= 0; index -= 1) {
    const record = compactions[index];
    if (record?.startSeq === 0) {
      return record;
    }
  }
  return;
}

function selectSafeCompactionBoundary(
  history: readonly ModelMessage[],
  coveredEnd: number,
  targetEnd: number
): number | undefined {
  let end = targetEnd;
  while (end > coveredEnd && !isSafeCompactionBoundary(history, end)) {
    end -= 1;
  }
  if (end > coveredEnd) {
    return end;
  }
  if (coveredEnd === 0) {
    return;
  }
  for (end = targetEnd + 1; end <= history.length; end += 1) {
    if (isSafeCompactionBoundary(history, end)) {
      return end;
    }
  }
  return;
}

function isSafeCompactionBoundary(
  history: readonly ModelMessage[],
  endSeqExclusive: number
): boolean {
  const previous = history[endSeqExclusive - 1];
  const next = history[endSeqExclusive];
  if (next?.role === "tool") {
    return false;
  }
  return previous?.role === "assistant" && !messageHasToolCall(previous);
}

function messageHasToolCall(message: ModelMessage | undefined): boolean {
  if (message?.role !== "assistant") {
    return false;
  }

  const content: unknown = message.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some(
    (part) => isObjectRecord(part) && part.type === "tool-call"
  );
}
