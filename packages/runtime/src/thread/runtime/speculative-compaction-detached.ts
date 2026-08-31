import type { ModelMessage } from "ai";
import type { ThreadCompactionRecord } from "../state/snapshot";
import { equalSnapshot } from "../state/snapshot-equal";
import type {
  AgentCompactionContext,
  AutoCompactionRange,
} from "./auto-compaction-types";
import { compactionThreadIdentityParts } from "./compaction-thread-identity";

export interface DetachedSummaryJob {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly hydratedPrefix: readonly ModelMessage[];
  readonly prefix: readonly ModelMessage[];
  readonly promise: Promise<string>;
  readonly range: AutoCompactionRange;
  readonly token: Readonly<object>;
}

export interface DetachedSummaryInstallation {
  readonly install: (summary: string) => void;
  readonly release: () => void;
}

/**
 * Process-local, single-flight registry for summary provider calls that
 * outlive their originating compaction episode. The episode deadline bounds
 * the caller's wait, never the detached work; a second episode joins the
 * in-flight call instead of starting another.
 */
export class DetachedSummaryJobs {
  readonly #jobs = new WeakMap<
    Readonly<object>,
    Map<string, DetachedSummaryJob>
  >();

  startOrJoin(
    context: AgentCompactionContext,
    range: AutoCompactionRange,
    installationFactory: () => DetachedSummaryInstallation
  ): DetachedSummaryJob {
    const { owner, threadKey } = compactionThreadIdentityParts(
      context.threadIdentity
    );
    let ownerJobs = this.#jobs.get(owner);
    const existing = ownerJobs?.get(threadKey);
    if (existing !== undefined && matchesContext(existing, context)) {
      return existing;
    }

    const installation = installationFactory();
    const token = Object.freeze({});
    let pending: Promise<string>;
    try {
      pending = context.summarize(range, { lifetime: "detached" });
    } catch (error) {
      installation.release();
      throw error;
    }
    let job: DetachedSummaryJob;
    const promise = pending
      .then((summary) => {
        const current = this.#jobs.get(owner)?.get(threadKey);
        if (summary.trim() && current?.token === token) {
          installation.install(summary);
        }
        return summary;
      })
      .finally(() => {
        installation.release();
        const currentJobs = this.#jobs.get(owner);
        if (currentJobs?.get(threadKey) === job) {
          currentJobs.delete(threadKey);
          if (currentJobs.size === 0) {
            this.#jobs.delete(owner);
          }
        }
      });
    job = {
      compactions: context.compactions,
      hydratedPrefix: context.estimatedHistory.slice(0, range.endSeqExclusive),
      prefix: context.history.slice(0, range.endSeqExclusive),
      promise,
      range,
      token,
    };
    if (ownerJobs === undefined) {
      ownerJobs = new Map();
      this.#jobs.set(owner, ownerJobs);
    }
    ownerJobs.set(threadKey, job);
    return job;
  }
}

/**
 * Single-flight means one in-flight call per context snapshot. A job captured
 * before the thread drifted is not a duplicate of the work this context needs,
 * so it neither joins nor blocks a fresh call.
 */
function matchesContext(
  job: DetachedSummaryJob,
  context: AgentCompactionContext
): boolean {
  return (
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
