import { deferred } from "../../internal/deferred";
import type { ThreadCompactionInput } from "../state/thread-state";
import {
  automaticCompactionDeadline,
  type CompactionDeadline,
  earliestCompactionDeadline,
  strictCompactionDeadline,
} from "./auto-compaction-deadline";
import {
  CompactionDeadlineExceededError,
  runCompactionEpisode,
} from "./auto-compaction-episode";
import {
  type ActiveCompaction,
  type CompactionCoordinator,
  type CompactionRequestOptions,
  coordinatorFor,
  enqueuePending,
  type RunnableCompactionRequest,
  restorePendingAfterFailedRetry,
  type ScheduledCompactionRequest,
  takePendingForActivation,
  takePendingForRetry,
  waitForActiveCompaction,
} from "./auto-compaction-scheduler";
import type {
  AgentCompaction,
  AgentCompactionReason,
  CompactionSummaryOptions,
} from "./auto-compaction-types";
import { compactionQueueDeadline } from "./compaction-queue-deadline";

export function scheduleThreadCompaction(
  options: CompactionRequestOptions
): Promise<void> {
  if (!options.compaction) {
    return Promise.resolve();
  }
  const request: ScheduledCompactionRequest = {
    deadline: automaticCompactionDeadline({
      compaction: options.compaction,
      diagnostics: options.model.diagnostics,
    }),
    options: { ...options, compaction: options.compaction },
  };
  const coordinator = coordinatorFor(options.state);
  if (coordinator.active || coordinator.blockingWaiters > 0) {
    return enqueuePending(coordinator, request);
  }
  return startCompletedTurn(coordinator, request);
}

export async function compactThreadBlocking(
  options: CompactionRequestOptions
): Promise<boolean> {
  if (!options.compaction) {
    return false;
  }
  return await runBlocking({
    deadline: automaticCompactionDeadline({
      compaction: options.compaction,
      diagnostics: options.model.diagnostics,
    }),
    options: { ...options, compaction: options.compaction },
    reason: "overflow",
  });
}

/** Force a compaction through the automatic snapshot and freshness pipeline. */
export async function compactThreadManually(
  options: Omit<CompactionRequestOptions, "compaction"> & {
    readonly deadline?: CompactionDeadline;
    readonly deadlineMs?: () => number;
    readonly explicitInput?: ThreadCompactionInput;
    readonly summaryOptions?: CompactionSummaryOptions;
  }
): Promise<boolean> {
  const compaction: AgentCompaction = options.explicitInput
    ? () => options.explicitInput
    : async (context) => {
        if (context.history.length === 0) {
          return;
        }
        const range = { endSeqExclusive: context.history.length, startSeq: 0 };
        return {
          ...range,
          summary: await context.summarize(range, options.summaryOptions),
        };
      };
  return await runBlocking({
    deadline: options.deadline ?? strictCompactionDeadline(options.deadlineMs),
    options: { ...options, compaction },
    reason: "manual",
  });
}

function startCompletedTurn(
  coordinator: CompactionCoordinator,
  request: ScheduledCompactionRequest
): Promise<void> {
  const { deadline, options } = request;
  const running = activate(coordinator, "completed-turn", async () => {
    const episode = {
      ...options,
      ...deadline,
      compactionId: crypto.randomUUID(),
      reason: "completed-turn" as const,
    };
    try {
      return await runCompactionEpisode({ ...episode, runnerAttempt: 1 });
    } catch (error) {
      if (
        error instanceof CompactionDeadlineExceededError ||
        coordinator.blockingWaiters > 0
      ) {
        return false;
      }
      const coveredPending = takePendingForRetry(coordinator);
      const retryOptions = coveredPending?.options ?? options;
      const retryDeadline = coveredPending
        ? earliestCompactionDeadline(deadline, coveredPending.deadline)
        : deadline;
      try {
        const result = await runCompactionEpisode({
          ...retryOptions,
          ...retryDeadline,
          compactionId: episode.compactionId,
          reason: "completed-turn",
          runnerAttempt: 2,
        });
        coveredPending?.deferred.resolve(undefined);
        return result;
      } catch {
        restorePendingAfterFailedRetry(coordinator, coveredPending);
        return false;
      }
    }
  });
  return running.then(() => undefined);
}

async function runBlocking({
  deadline,
  options,
  reason,
}: {
  readonly deadline: CompactionDeadline;
  readonly options: RunnableCompactionRequest;
  readonly reason: "manual" | "overflow";
}): Promise<boolean> {
  const queueDeadline = compactionQueueDeadline({
    deadline,
    reason,
    signal: options.signal,
  });
  const coordinator = coordinatorFor(options.state);
  coordinator.blockingWaiters += 1;
  try {
    while (coordinator.active) {
      const active = coordinator.active;
      const compacted = await waitForActiveCompaction(
        active.promise,
        queueDeadline.signal
      );
      options.signal?.throwIfAborted();
      if (Date.now() >= deadline.deadlineAt) {
        throw new CompactionDeadlineExceededError({ ...deadline, reason });
      }
      queueDeadline.signal.throwIfAborted();
      if (active.reason !== "completed-turn") {
        return compacted;
      }
      if (reason === "overflow" && compacted) {
        return true;
      }
    }
    queueDeadline.dispose();
    return await activate(coordinator, reason, () =>
      runCompactionEpisode({
        ...options,
        ...deadline,
        compactionId: crypto.randomUUID(),
        reason,
        runnerAttempt: 1,
      })
    );
  } finally {
    queueDeadline.dispose();
    coordinator.blockingWaiters -= 1;
    startPendingIfReady(coordinator);
  }
}

function activate(
  coordinator: CompactionCoordinator,
  reason: AgentCompactionReason,
  work: () => Promise<boolean>
): Promise<boolean> {
  const settled = deferred<boolean>();
  const active = { promise: settled.promise, reason };
  coordinator.active = active;
  Promise.resolve()
    .then(work)
    .then(
      (result) => {
        finishActive(coordinator, active);
        settled.resolve(result);
      },
      (error: unknown) => {
        finishActive(coordinator, active);
        settled.reject(error);
      }
    );
  return settled.promise;
}

function finishActive(
  coordinator: CompactionCoordinator,
  active: ActiveCompaction
): void {
  if (coordinator.active === active) {
    coordinator.active = undefined;
  }
  startPendingIfReady(coordinator);
}

function startPendingIfReady(coordinator: CompactionCoordinator): void {
  if (
    coordinator.active ||
    coordinator.blockingWaiters > 0 ||
    !coordinator.pending
  ) {
    return;
  }
  const pending = takePendingForActivation(coordinator);
  if (pending) {
    startCompletedTurn(coordinator, pending).then(
      pending.deferred.resolve,
      pending.deferred.reject
    );
  }
}
