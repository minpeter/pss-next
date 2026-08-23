import { type Deferred, deferred } from "../../internal/deferred";
import type { CompactionDeadline } from "./auto-compaction-deadline";
import type { AutoCompactionEpisodeOptions } from "./auto-compaction-episode";
import type {
  AgentCompaction,
  AgentCompactionReason,
} from "./auto-compaction-types";
import {
  type CompactionQueueDeadline,
  compactionQueueDeadline,
} from "./compaction-queue-deadline";

export type CompactionRequestOptions = Omit<
  AutoCompactionEpisodeOptions,
  | "compaction"
  | "compactionId"
  | "deadlineAt"
  | "deadlineMs"
  | "reason"
  | "runnerAttempt"
> & {
  readonly compaction?: AgentCompaction;
};

export type RunnableCompactionRequest = CompactionRequestOptions & {
  readonly compaction: AgentCompaction;
};

export interface ScheduledCompactionRequest {
  readonly deadline: CompactionDeadline;
  readonly options: RunnableCompactionRequest;
}

export interface ActiveCompaction {
  readonly promise: Promise<boolean>;
  readonly reason: AgentCompactionReason;
}

/** Per-thread scheduling state; mutation is its documented purpose. */
export interface CompactionCoordinator {
  active: ActiveCompaction | undefined;
  blockingWaiters: number;
  pending: PendingCompaction | undefined;
}

/** Coalesced completed-turn request awaiting the blocking lane. */
export interface PendingCompaction extends ScheduledCompactionRequest {
  abortFromQueue: (() => void) | undefined;
  readonly deferred: Deferred;
  options: RunnableCompactionRequest;
  queueDeadline: CompactionQueueDeadline | undefined;
}

const coordinators = new WeakMap<
  AutoCompactionEpisodeOptions["state"],
  CompactionCoordinator
>();

export function coordinatorFor(
  state: AutoCompactionEpisodeOptions["state"]
): CompactionCoordinator {
  const existing = coordinators.get(state);
  if (existing) {
    return existing;
  }
  const coordinator: CompactionCoordinator = {
    active: undefined,
    blockingWaiters: 0,
    pending: undefined,
  };
  coordinators.set(state, coordinator);
  return coordinator;
}

export function enqueuePending(
  coordinator: CompactionCoordinator,
  request: ScheduledCompactionRequest
): Promise<void> {
  const pending = coordinator.pending;
  if (pending) {
    disarmPendingDeadline(pending);
    pending.options = request.options;
    armPendingDeadline(coordinator, pending);
    return pending.deferred.promise;
  }
  const queued: PendingCompaction = {
    ...request,
    abortFromQueue: undefined,
    deferred: deferred(),
    queueDeadline: undefined,
  };
  coordinator.pending = queued;
  armPendingDeadline(coordinator, queued);
  return queued.deferred.promise;
}

export function takePendingForActivation(
  coordinator: CompactionCoordinator
): PendingCompaction | undefined {
  return takePending(coordinator);
}

export function takePendingForRetry(
  coordinator: CompactionCoordinator
): PendingCompaction | undefined {
  return takePending(coordinator);
}

export function restorePendingAfterFailedRetry(
  coordinator: CompactionCoordinator,
  covered: PendingCompaction | undefined
): void {
  if (!covered) {
    return;
  }
  const newer = takePending(coordinator);
  if (newer) {
    covered.options = newer.options;
    covered.deferred.promise.then(
      () => newer.deferred.resolve(undefined),
      newer.deferred.reject
    );
  }
  coordinator.pending = covered;
  armPendingDeadline(coordinator, covered);
}

function takePending(
  coordinator: CompactionCoordinator
): PendingCompaction | undefined {
  const pending = coordinator.pending;
  coordinator.pending = undefined;
  if (pending) {
    disarmPendingDeadline(pending);
  }
  return pending;
}

function armPendingDeadline(
  coordinator: CompactionCoordinator,
  pending: PendingCompaction
): void {
  const queueDeadline = compactionQueueDeadline({
    deadline: pending.deadline,
    reason: "completed-turn",
    signal: pending.options.signal,
  });
  const abortFromQueue = (): void => {
    if (coordinator.pending !== pending) {
      return;
    }
    coordinator.pending = undefined;
    disarmPendingDeadline(pending);
    pending.deferred.resolve(undefined);
  };
  pending.abortFromQueue = abortFromQueue;
  pending.queueDeadline = queueDeadline;
  queueDeadline.signal.addEventListener("abort", abortFromQueue, {
    once: true,
  });
  if (queueDeadline.signal.aborted) {
    abortFromQueue();
  }
}

function disarmPendingDeadline(pending: PendingCompaction): void {
  if (pending.abortFromQueue) {
    pending.queueDeadline?.signal.removeEventListener(
      "abort",
      pending.abortFromQueue
    );
  }
  pending.queueDeadline?.dispose();
  pending.abortFromQueue = undefined;
  pending.queueDeadline = undefined;
}

export async function waitForActiveCompaction(
  active: Promise<boolean>,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (!signal) {
    return await active;
  }
  if (signal.aborted) {
    throw signal.reason;
  }
  const { promise: aborted, reject: rejectAborted } = deferred<never>();
  const abortFromCaller = (): void => {
    rejectAborted(signal.reason);
  };
  signal.addEventListener("abort", abortFromCaller, { once: true });
  try {
    return await Promise.race([active, aborted]);
  } finally {
    signal.removeEventListener("abort", abortFromCaller);
  }
}
