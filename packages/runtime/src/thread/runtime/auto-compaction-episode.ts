import type {
  AutoCompactionDiagnosticMetadata,
  RuntimeDiagnostic,
} from "../../diagnostics";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { ThreadState } from "../state/thread-state";
import { prepareAutoCompaction } from "./auto-compaction-preparation";
import type {
  AgentCompaction,
  AgentCompactionReason,
  ThreadCompactionHandler,
  ThreadContextTransformObserver,
  ThreadModelContextTransform,
} from "./auto-compaction-types";

export interface AutoCompactionEpisodeOptions {
  readonly compact?: ThreadCompactionHandler;
  readonly compaction: AgentCompaction;
  readonly compactionId: string;
  readonly deadlineAt: number;
  readonly deadlineMs: number;
  readonly latestContextTransform?: ThreadContextTransformObserver;
  readonly model: ModelGenerationOptions;
  readonly reason: AgentCompactionReason;
  readonly runnerAttempt: number;
  readonly signal?: AbortSignal;
  readonly state: ThreadState;
  readonly threadKey: string;
  readonly transformModelContext?: ThreadModelContextTransform;
}

export class CompactionDeadlineExceededError extends Error {
  readonly deadlineAt: number;
  readonly deadlineMs: number;
  readonly name = "CompactionDeadlineExceededError";
  readonly reason: AgentCompactionReason;

  constructor({
    cause,
    deadlineAt,
    deadlineMs,
    reason,
  }: {
    readonly cause?: unknown;
    readonly deadlineAt: number;
    readonly deadlineMs: number;
    readonly reason: AgentCompactionReason;
  }) {
    super(`Compaction exceeded its ${deadlineMs}ms deadline.`, { cause });
    this.deadlineAt = deadlineAt;
    this.deadlineMs = deadlineMs;
    this.reason = reason;
  }
}

/** Mutable counters shared by preparation and the commit boundary. */
interface CompactionCounters {
  commitStarted: boolean;
  summaryCalls: number;
}

export async function runCompactionEpisode(
  options: AutoCompactionEpisodeOptions
): Promise<boolean> {
  const counters: CompactionCounters = {
    commitStarted: false,
    summaryCalls: 0,
  };
  const startedAt = performance.now();
  try {
    const committed = await runBeforeDeadline(options, counters);
    reportCompaction(options, counters, startedAt, {
      outcome: committed ? "committed" : "skipped",
    });
    return committed;
  } catch (error) {
    reportCompaction(options, counters, startedAt, {
      outcome:
        error instanceof CompactionDeadlineExceededError
          ? "timed-out"
          : "failed",
    });
    throw error;
  }
}

async function runBeforeDeadline(
  options: AutoCompactionEpisodeOptions,
  counters: CompactionCounters
): Promise<boolean> {
  const remainingMs = options.deadlineAt - Date.now();
  const timeoutError = new CompactionDeadlineExceededError({
    deadlineAt: options.deadlineAt,
    deadlineMs: options.deadlineMs,
    reason: options.reason,
  });
  if (remainingMs <= 0) {
    throw timeoutError;
  }
  const controller = new AbortController();
  const abortFromCaller = (): void => {
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) {
    abortFromCaller();
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(timeoutError), remainingMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(controller.signal.reason);
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!counters.commitStarted) {
          reject(controller.signal.reason);
        }
      },
      { once: true }
    );
  });
  try {
    return await Promise.race([
      prepareAndCommit({ ...options, signal: controller.signal }, counters),
      aborted,
    ]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function prepareAndCommit(
  options: AutoCompactionEpisodeOptions & { readonly signal: AbortSignal },
  counters: CompactionCounters
): Promise<boolean> {
  const prepared = await prepareAutoCompaction(options, () => {
    counters.summaryCalls += 1;
  });
  options.signal.throwIfAborted();
  if (!prepared) {
    return false;
  }
  const markCommitStarted = (): void => {
    counters.commitStarted = true;
  };
  if (options.compact) {
    return await options.compact(prepared.input, {
      freshnessGuard: prepared.freshnessGuard,
      markCommitStarted,
      signal: options.signal,
    });
  }
  if (!prepared.freshnessGuard(prepared.input)) {
    return false;
  }
  options.signal.throwIfAborted();
  await options.state.compact(prepared.input, {
    markCommitStarted,
    signal: options.signal,
  });
  return true;
}

function reportCompaction(
  options: AutoCompactionEpisodeOptions,
  counters: CompactionCounters,
  startedAt: number,
  result: {
    readonly outcome: AutoCompactionDiagnosticMetadata["outcome"];
  }
): void {
  const diagnostics = options.model.diagnostics;
  if (!diagnostics) {
    return;
  }
  const compaction: AutoCompactionDiagnosticMetadata = {
    compactionId: options.compactionId,
    deadlineAt: options.deadlineAt,
    durationMs: performance.now() - startedAt,
    outcome: result.outcome,
    reason: options.reason,
    runnerAttempt: options.runnerAttempt,
    summaryCalls: counters.summaryCalls,
  };
  const diagnostic: RuntimeDiagnostic = {
    code:
      result.outcome === "committed"
        ? "compaction.completed"
        : `compaction.${result.outcome}`,
    compaction,
    level:
      result.outcome === "failed" || result.outcome === "timed-out"
        ? "error"
        : "info",
    phase: "auto-compaction",
  };
  Promise.resolve()
    .then(() => diagnostics.report(diagnostic))
    .catch(() => undefined);
}
