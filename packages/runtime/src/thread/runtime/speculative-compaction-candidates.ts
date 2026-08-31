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
import type {
  AgentCompactionContext,
  AutoCompactionRange,
  ThreadTokenEstimator,
} from "./auto-compaction-types";
import { SpeculativeCandidateCache } from "./speculative-candidate-cache";
import {
  type DetachedSummaryInstallation,
  type DetachedSummaryJob,
  DetachedSummaryJobs,
} from "./speculative-compaction-detached";

export interface SpeculativeCandidate {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly hydratedPrefix: readonly ModelMessage[];
  readonly input: ThreadCompactionInput;
  readonly prefix: readonly ModelMessage[];
  readonly replacementConsumed: boolean;
}

interface CandidateStoreOptions {
  readonly estimate: ThreadTokenEstimator;
  readonly max: number;
  readonly retain: number;
}

/**
 * Candidates are installed by detached summary jobs, never synchronously by an
 * episode, so a deadline that bounds the caller's wait cannot destroy finished
 * provider work. Freshness is enforced at consumption by #getFresh and #fits;
 * there is deliberately no abort-rollback listener because detached installs
 * happen after the originating episode settled.
 */
export class SpeculativeCompactionCandidates {
  readonly #candidates = new SpeculativeCandidateCache<SpeculativeCandidate>();
  readonly #estimate: ThreadTokenEstimator;
  readonly #jobs = new DetachedSummaryJobs();
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
    const expectedInstallation = this.#getFresh(context);
    if (expectedInstallation?.replacementConsumed) {
      return;
    }
    const range = this.#selectRange(context);
    if (
      range === undefined ||
      (expectedInstallation !== undefined &&
        !isCompatibleExpansion(expectedInstallation, range))
    ) {
      return;
    }
    await this.#jobs.startOrJoin(
      context,
      range,
      this.#installDetached(context, range, expectedInstallation !== undefined)
    ).promise;
    context.signal.throwIfAborted();
  }

  async promote(
    context: AgentCompactionContext
  ): Promise<ThreadCompactionInput | undefined> {
    const candidate = this.#getFresh(context);
    const range = this.#selectRange(context);
    if (candidate !== undefined && this.#fits(candidate, context)) {
      context.signal.throwIfAborted();
      return { ...candidate.input };
    }
    if (range === undefined) {
      return;
    }
    const job = this.#jobs.startOrJoin(
      context,
      range,
      this.#installDetached(context, range)
    );
    const summary = await job.promise;
    context.signal.throwIfAborted();
    if (!summary.trim()) {
      return;
    }
    if (this.#jobMatchesContext(job, context, range)) {
      return { ...range, summary };
    }
    const installed = this.#getFresh(context);
    if (installed !== undefined && this.#fits(installed, context)) {
      return { ...installed.input };
    }
    return;
  }

  /**
   * A joined job is only returned directly when its range matches; snapshot
   * freshness was already enforced when the join happened, and installed
   * results are re-validated fail-closed by #getFresh/#fits at use.
   */
  #jobMatchesContext(
    job: DetachedSummaryJob,
    context: AgentCompactionContext,
    range: AutoCompactionRange
  ): boolean {
    return (
      job.range.startSeq === range.startSeq &&
      job.range.endSeqExclusive === range.endSeqExclusive &&
      equalSnapshot(job.compactions, context.compactions) &&
      equalSnapshot(
        job.prefix,
        context.history.slice(0, range.endSeqExclusive)
      ) &&
      equalSnapshot(
        job.hydratedPrefix,
        context.estimatedHistory.slice(0, range.endSeqExclusive)
      )
    );
  }

  #installDetached(
    context: AgentCompactionContext,
    range: AutoCompactionRange,
    replacedFresh = false
  ): () => DetachedSummaryInstallation {
    return () => {
      const reservation = this.#candidates.reserve(context.threadIdentity);
      const compactions = structuredClone(context.compactions);
      const hydratedPrefix = structuredClone(
        context.estimatedHistory.slice(0, range.endSeqExclusive)
      );
      const prefix = structuredClone(
        context.history.slice(0, range.endSeqExclusive)
      );
      return {
        install: (summary) => {
          this.#candidates.install(reservation, {
            compactions,
            hydratedPrefix,
            input: { ...range, summary },
            prefix,
            replacementConsumed:
              replacedFresh || reservation.expectedCandidate !== undefined,
          });
        },
        release: () => this.#candidates.release(reservation),
      };
    };
  }

  #fits(
    candidate: SpeculativeCandidate,
    context: AgentCompactionContext
  ): boolean {
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

  #getFresh(context: AgentCompactionContext): SpeculativeCandidate | undefined {
    const candidate = this.#candidates.get(context.threadIdentity);
    if (
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
      return candidate;
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
  candidate: SpeculativeCandidate,
  range: AutoCompactionRange
): boolean {
  return (
    range.startSeq === candidate.input.startSeq &&
    range.endSeqExclusive > candidate.input.endSeqExclusive
  );
}
