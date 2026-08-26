import type { ModelMessage } from "ai";
import {
  compactionContextForModel,
  compactionContextMessage,
} from "../state/context";
import type { ThreadCompactionRecord } from "../state/snapshot";
import { equalSnapshot } from "../state/snapshot-equal";
import type { ThreadCompactionInput } from "../state/thread-state";
import {
  latestPrefixCompaction,
  selectAutoCompactionRange,
} from "./auto-compaction-range";
import { NORMAL_COMPACTION_SETTLEMENT } from "./auto-compaction-settlement";
import type {
  AgentCompactionContext,
  AutoCompactionRange,
  ThreadTokenEstimator,
} from "./auto-compaction-types";

interface Candidate {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly hydratedPrefix: readonly ModelMessage[];
  readonly input: ThreadCompactionInput;
  readonly prefix: readonly ModelMessage[];
  readonly replacementConsumed: boolean;
}

type CandidateLifecycle =
  | { readonly tag: "aborted" }
  | { readonly tag: "live" };

interface CandidateInstallation {
  readonly candidate: Candidate;
  lifecycle: CandidateLifecycle;
  readonly previous: CandidateInstallation | undefined;
}

interface CandidateStoreOptions {
  readonly estimate: ThreadTokenEstimator;
  readonly max: number;
  readonly retain: number;
}

export class SpeculativeCompactionCandidates {
  readonly #candidates = new WeakMap<object, CandidateInstallation>();
  readonly #estimate: ThreadTokenEstimator;
  readonly #max: number;
  readonly #retain: number;

  constructor(options: CandidateStoreOptions) {
    this.#estimate = options.estimate;
    this.#max = options.max;
    this.#retain = options.retain;
  }

  async prepare(context: AgentCompactionContext): Promise<void> {
    if (context.modelContextProvenance !== "standard") {
      return;
    }
    const expectedCurrent = this.#candidates.get(context.threadIdentity);
    const expectedInstallation = this.#getFresh(context);
    if (expectedInstallation?.candidate.replacementConsumed) {
      return;
    }
    const range = this.#selectRange(context);
    if (
      range === undefined ||
      (expectedInstallation !== undefined &&
        !isCompatibleExpansion(expectedInstallation.candidate, range))
    ) {
      return;
    }

    const summary = await context.summarize(range);
    context.signal.throwIfAborted();
    if (!summary.trim()) {
      return;
    }
    if (this.#candidates.get(context.threadIdentity) !== expectedCurrent) {
      return;
    }
    const next = {
      compactions: structuredClone(context.compactions),
      hydratedPrefix: structuredClone(
        context.estimatedHistory.slice(0, range.endSeqExclusive)
      ),
      input: { ...range, summary },
      prefix: structuredClone(context.history.slice(0, range.endSeqExclusive)),
      replacementConsumed: expectedInstallation !== undefined,
    };
    this.#installCandidate(
      context,
      expectedCurrent,
      expectedInstallation,
      next
    );
  }

  async promote(
    context: AgentCompactionContext
  ): Promise<ThreadCompactionInput | undefined> {
    const candidate = this.#getFresh(context)?.candidate;
    const range = this.#selectRange(context);
    if (candidate !== undefined && this.#fits(candidate, context)) {
      context.signal.throwIfAborted();
      return { ...candidate.input };
    }
    if (range === undefined) {
      return;
    }
    const summary = await context.summarize(range);
    context.signal.throwIfAborted();
    if (!summary.trim()) {
      return;
    }
    return { ...range, summary };
  }

  #installCandidate(
    context: AgentCompactionContext,
    expectedCurrent: CandidateInstallation | undefined,
    previous: CandidateInstallation | undefined,
    next: Candidate
  ): void {
    const installation: CandidateInstallation = {
      candidate: next,
      lifecycle: { tag: "live" },
      previous,
    };
    const restore = (): void => {
      if (context.signal.reason === NORMAL_COMPACTION_SETTLEMENT) {
        return;
      }
      installation.lifecycle = { tag: "aborted" };
      if (this.#candidates.get(context.threadIdentity) !== installation) {
        return;
      }
      let restored = installation.previous;
      while (restored?.lifecycle.tag === "aborted") {
        restored = restored.previous;
      }
      if (restored) {
        this.#candidates.set(context.threadIdentity, restored);
        return;
      }
      this.#candidates.delete(context.threadIdentity);
    };
    context.signal.addEventListener("abort", restore, { once: true });
    try {
      context.signal.throwIfAborted();
      if (this.#candidates.get(context.threadIdentity) !== expectedCurrent) {
        context.signal.removeEventListener("abort", restore);
        return;
      }
      this.#candidates.set(context.threadIdentity, installation);
    } catch (error) {
      context.signal.removeEventListener("abort", restore);
      throw error;
    }
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

  #getFresh(
    context: AgentCompactionContext
  ): CandidateInstallation | undefined {
    const installation = this.#candidates.get(context.threadIdentity);
    const candidate = installation?.candidate;
    if (
      installation?.lifecycle.tag === "live" &&
      candidate !== undefined &&
      equalSnapshot(
        candidate.prefix,
        context.history.slice(0, candidate.input.endSeqExclusive)
      ) &&
      equalSnapshot(
        candidate.hydratedPrefix,
        context.estimatedHistory.slice(0, candidate.input.endSeqExclusive)
      ) &&
      equalSnapshot(candidate.compactions, context.compactions)
    ) {
      return installation;
    }
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
