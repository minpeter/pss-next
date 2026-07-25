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
  ThreadAutoCompactionOptions,
} from "./auto-compaction-types";

export function selectAutoCompactionRange({
  compactions,
  history,
  instructionsTokens = 0,
  policy,
}: {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly history: readonly ModelMessage[];
  readonly instructionsTokens?: number;
  readonly policy: ThreadAutoCompactionOptions;
}): AutoCompactionRange | undefined {
  const estimate = policy.estimateTokens ?? estimateModelMessagesTokens;
  const covered = latestPrefixCompaction(compactions);
  const coveredEnd = covered?.endSeqExclusive ?? 0;
  const summaryTokens = covered
    ? estimate([compactionContextForModel(compactionContextMessage(covered))])
    : 0;
  const suffix = history.slice(coveredEnd);
  const suffixTokens = suffix.map((message) => estimate([message]));
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

  let endSeqExclusive = coveredEnd + tailStart;
  while (
    endSeqExclusive > coveredEnd &&
    !isSafeCompactionBoundary(history, endSeqExclusive)
  ) {
    endSeqExclusive -= 1;
  }

  if (endSeqExclusive <= coveredEnd) {
    return;
  }

  return { endSeqExclusive, startSeq: 0 };
}

function latestPrefixCompaction(
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
