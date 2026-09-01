import type { ModelMessage } from "ai";
import type { ThreadCompactionRecord } from "../state/snapshot";
import { equalSnapshot } from "../state/snapshot-equal";
import type {
  AgentCompactionContext,
  AgentCompactionModelContextProvenance,
  AutoCompactionRange,
} from "./auto-compaction-types";
import { DETACHED_SUMMARY_BACKSTOP_MS } from "./auto-compaction-types";
import { compactionThreadIdentityParts } from "./compaction-thread-identity";
import { SPECULATIVE_CANDIDATE_CACHE_MAX } from "./speculative-candidate-cache";

export interface DetachedSummaryJob {
  readonly cancel: () => void;
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly hydratedPrefix: readonly ModelMessage[];
  readonly modelContext: readonly ModelMessage[];
  readonly modelContextProvenance: AgentCompactionModelContextProvenance;
  readonly prefix: readonly ModelMessage[];
  readonly promise: Promise<string>;
  readonly range: AutoCompactionRange;
  readonly refresh: () => void;
  readonly token: Readonly<object>;
}

export interface DetachedSummaryInstallation {
  readonly install: (summary: string) => void;
  readonly release: () => void;
  readonly touch?: () => void;
}

/**
 * Process-local, single-flight registry for summary provider calls that
 * outlive their originating compaction episode. Jobs own their cancellation
 * and cleanup independently of provider settlement.
 */
export class DetachedSummaryJobs {
  readonly #jobs = new WeakMap<
    Readonly<object>,
    Map<string, DetachedSummaryJob>
  >();
  readonly #lru = new Map<DetachedSummaryJob, true>();

  startOrJoin(
    context: AgentCompactionContext,
    range: AutoCompactionRange,
    installationFactory: (onEvict: () => void) => DetachedSummaryInstallation
  ): DetachedSummaryJob {
    const { owner, threadKey } = compactionThreadIdentityParts(
      context.threadIdentity
    );
    const existing = this.#jobs.get(owner)?.get(threadKey);
    if (existing !== undefined && matchesContext(existing, context)) {
      existing.refresh();
      this.#touch(existing);
      return existing;
    }
    existing?.cancel();

    const controller = new AbortController();
    let finalized = false;
    let job: DetachedSummaryJob | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let installation: DetachedSummaryInstallation;
    const finalize = (abort: boolean): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (abort) {
        controller.abort(
          new Error("Detached compaction summary lifecycle ended.")
        );
      }
      installation.release();
      if (job === undefined) {
        return;
      }
      this.#lru.delete(job);
      const currentJobs = this.#jobs.get(owner);
      if (currentJobs?.get(threadKey) === job) {
        currentJobs.delete(threadKey);
        if (currentJobs.size === 0) {
          this.#jobs.delete(owner);
        }
      }
    };

    installation = installationFactory(() => finalize(true));
    let pending: Promise<string>;
    try {
      pending = context.summarize(range, {
        lifetime: "detached",
        signal: controller.signal,
      });
    } catch (error) {
      installation.release();
      throw error;
    }
    const token = Object.freeze({});
    const promise = pending
      .then((summary) => {
        const current = this.#jobs.get(owner)?.get(threadKey);
        if (summary.trim() && current?.token === token) {
          installation.install(summary);
        }
        return summary;
      })
      .finally(() => finalize(false));
    // Preserve rejection for joiners while observing abandoned detached calls.
    promise.catch(() => undefined);
    job = {
      cancel: () => finalize(true),
      compactions: structuredClone(context.compactions),
      hydratedPrefix: structuredClone(
        context.estimatedHistory.slice(0, range.endSeqExclusive)
      ),
      modelContext: structuredClone(context.modelContext),
      modelContextProvenance: context.modelContextProvenance,
      prefix: structuredClone(context.history.slice(0, range.endSeqExclusive)),
      promise,
      range,
      refresh: () => installation.touch?.(),
      token,
    };
    let ownerJobs = this.#jobs.get(owner);
    if (ownerJobs === undefined) {
      ownerJobs = new Map();
      this.#jobs.set(owner, ownerJobs);
    }
    ownerJobs.set(threadKey, job);
    this.#touch(job);
    timer = setTimeout(() => finalize(true), DETACHED_SUMMARY_BACKSTOP_MS);
    timer.unref();
    this.#evict();
    return job;
  }

  #evict(): void {
    while (this.#lru.size > SPECULATIVE_CANDIDATE_CACHE_MAX) {
      const oldest = this.#lru.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      oldest.cancel();
    }
  }

  #touch(job: DetachedSummaryJob): void {
    this.#lru.delete(job);
    this.#lru.set(job, true);
  }
}

/** Jobs join only when every summary-bearing context input is unchanged. */
function matchesContext(
  job: DetachedSummaryJob,
  context: AgentCompactionContext
): boolean {
  return (
    context.modelContextProvenance !== "unknown" &&
    job.modelContextProvenance === context.modelContextProvenance &&
    equalSnapshot(job.modelContext, context.modelContext) &&
    equalSnapshot(job.compactions, context.compactions) &&
    equalSnapshot(
      job.prefix,
      context.history.slice(0, job.range.endSeqExclusive)
    ) &&
    equalSnapshot(
      job.hydratedPrefix,
      context.estimatedHistory.slice(0, job.range.endSeqExclusive)
    )
  );
}
