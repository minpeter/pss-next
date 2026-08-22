import type { ModelMessage } from "ai";
import {
  compactionContextForModel,
  compactionContextMessage,
} from "../state/context";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type { ThreadCompactionInput } from "../state/thread-state";
import {
  latestPrefixCompaction,
  selectAutoCompactionRange,
} from "./auto-compaction-range";
import type {
  AgentCompactionContext,
  AutoCompactionRange,
  ThreadTokenEstimator,
} from "./auto-compaction-types";
import { equalSnapshot } from "./snapshot-equal";

interface Candidate {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly input: ThreadCompactionInput;
  readonly prefix: readonly ModelMessage[];
  readonly replacementConsumed: boolean;
}

interface CandidateStoreOptions {
  readonly estimate: ThreadTokenEstimator;
  readonly max: number;
  readonly retain: number;
}

export class SpeculativeCompactionCandidates {
  readonly #candidates = new WeakMap<object, Candidate>();
  readonly #estimate: ThreadTokenEstimator;
  readonly #max: number;
  readonly #retain: number;

  constructor(options: CandidateStoreOptions) {
    this.#estimate = options.estimate;
    this.#max = options.max;
    this.#retain = options.retain;
  }

  async prepare(context: AgentCompactionContext): Promise<void> {
    const expectedCandidate = this.#getFresh(context);
    if (expectedCandidate?.replacementConsumed) {
      return;
    }
    const range = this.#selectRange(context);
    if (
      range === undefined ||
      (expectedCandidate !== undefined &&
        !isCompatibleExpansion(expectedCandidate, range))
    ) {
      return;
    }

    const summary = await context.summarize(range);
    context.signal.throwIfAborted();
    if (!summary.trim()) {
      return;
    }
    if (
      expectedCandidate !== undefined &&
      this.#candidates.get(context.threadIdentity) !== expectedCandidate
    ) {
      return;
    }
    this.#candidates.set(context.threadIdentity, {
      compactions: structuredClone(context.compactions),
      input: { ...range, summary },
      prefix: structuredClone(context.history.slice(0, range.endSeqExclusive)),
      replacementConsumed: expectedCandidate !== undefined,
    });
  }

  async promote(
    context: AgentCompactionContext
  ): Promise<ThreadCompactionInput | undefined> {
    const candidate = this.#getFresh(context);
    const range = this.#selectRange(context);
    if (candidate !== undefined && this.#fits(candidate, context)) {
      this.#candidates.delete(context.threadIdentity);
      return candidate.input;
    }
    if (range === undefined) {
      return;
    }
    const summary = await context.summarize(range);
    context.signal.throwIfAborted();
    if (!summary.trim()) {
      return;
    }
    if (this.#candidates.get(context.threadIdentity) === candidate) {
      this.#candidates.delete(context.threadIdentity);
    }
    return { ...range, summary };
  }

  #fits(candidate: Candidate, context: AgentCompactionContext): boolean {
    if (context.modelContextProvenance !== "standard") {
      return false;
    }
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
        ? context.estimatedHistory
        : [
            compactionContextForModel(compactionContextMessage(prefix)),
            ...context.estimatedHistory.slice(prefix.endSeqExclusive),
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
    const tail = context.estimatedHistory.slice(
      candidate.input.endSeqExclusive
    );
    const tokensFor = context.estimateTokens ?? this.#estimate;
    const historyTokens = context.estimatedHistoryMessageTokens
      ? tokensFor([wrapper]) +
        context.estimatedHistoryMessageTokens
          .slice(candidate.input.endSeqExclusive)
          .reduce((total, tokens) => total + tokens, 0)
      : tokensFor([wrapper, ...tail]);
    return context.instructionsTokens + historyTokens <= this.#max;
  }

  #getFresh(context: AgentCompactionContext): Candidate | undefined {
    const candidate = this.#candidates.get(context.threadIdentity);
    if (
      candidate !== undefined &&
      equalSnapshot(
        candidate.prefix,
        context.history.slice(0, candidate.input.endSeqExclusive)
      ) &&
      equalSnapshot(candidate.compactions, context.compactions)
    ) {
      return candidate;
    }
    this.#candidates.delete(context.threadIdentity);
    return;
  }

  #selectRange(
    context: AgentCompactionContext
  ): AutoCompactionRange | undefined {
    return selectAutoCompactionRange({
      compactions: context.compactions,
      history: context.estimatedHistory,
      instructionsTokens: context.instructionsTokens,
      messageTokenCosts: context.estimatedHistoryMessageTokens,
      policy: {
        estimateTokens: context.estimateTokens ?? this.#estimate,
        retainTokens: Math.floor(this.#max * this.#retain),
        triggerTokens: 1,
      },
    });
  }
}

function isCompatibleExpansion(
  candidate: Candidate,
  range: AutoCompactionRange
): boolean {
  return (
    range.startSeq === candidate.input.startSeq &&
    range.endSeqExclusive > candidate.input.endSeqExclusive
  );
}
