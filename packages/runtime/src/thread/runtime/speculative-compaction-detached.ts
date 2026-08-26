import type { ModelMessage } from "ai";
import type { ThreadCompactionRecord } from "../state/snapshot";
import { equalSnapshot } from "../state/snapshot-equal";
import type {
  AgentCompactionContext,
  AutoCompactionRange,
} from "./auto-compaction-types";

export interface DetachedSummaryJob {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly hydratedPrefix: readonly ModelMessage[];
  readonly prefix: readonly ModelMessage[];
  readonly promise: Promise<string>;
  readonly range: AutoCompactionRange;
  readonly token: Readonly<object>;
}

/**
 * Process-local, single-flight registry for summary provider calls that
 * outlive their originating compaction episode. The episode deadline bounds
 * the caller's wait, never the detached work; a second episode joins the
 * in-flight call instead of starting another.
 */
export class DetachedSummaryJobs {
  readonly #jobs = new WeakMap<object, DetachedSummaryJob>();

  startOrJoin(
    context: AgentCompactionContext,
    range: AutoCompactionRange,
    install: (summary: string) => void
  ): DetachedSummaryJob {
    const existing = this.#jobs.get(context.threadIdentity);
    if (existing !== undefined && matchesContext(existing, context)) {
      return existing;
    }
    const token = Object.freeze({});
    const promise = context
      .summarize(range, { lifetime: "detached" })
      .then((summary) => {
        const current = this.#jobs.get(context.threadIdentity);
        if (summary.trim() && current?.token === token) {
          install(summary);
        }
        return summary;
      });
    const job: DetachedSummaryJob = {
      compactions: context.compactions,
      hydratedPrefix: context.estimatedHistory.slice(0, range.endSeqExclusive),
      prefix: context.history.slice(0, range.endSeqExclusive),
      promise,
      range,
      token,
    };
    this.#jobs.set(context.threadIdentity, job);
    const release = (): void => {
      if (this.#jobs.get(context.threadIdentity) === job) {
        this.#jobs.delete(context.threadIdentity);
      }
    };
    promise.then(release, release);
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
