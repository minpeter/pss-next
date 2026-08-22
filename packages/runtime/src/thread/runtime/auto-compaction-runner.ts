import { type Deferred, deferred } from "../../internal/deferred";
import {
  automaticCompactionDeadline,
  strictCompactionDeadline,
} from "./auto-compaction-deadline";
import {
  type AutoCompactionEpisodeOptions,
  CompactionDeadlineExceededError,
  runCompactionEpisode,
} from "./auto-compaction-episode";
import type {
  AgentCompaction,
  AgentCompactionReason,
  CompactionSummaryOptions,
} from "./auto-compaction-types";

type CompactionRequestOptions = Omit<
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

type RunnableCompactionRequest = CompactionRequestOptions & {
  readonly compaction: AgentCompaction;
};

interface ActiveCompaction {
  readonly promise: Promise<boolean>;
  readonly reason: AgentCompactionReason;
}

/** Per-thread scheduling state; mutation is its documented purpose. */
interface CompactionCoordinator {
  active: ActiveCompaction | undefined;
  blockingWaiters: number;
  pending: PendingCompaction | undefined;
}

/** Coalesced completed-turn request awaiting the blocking lane. */
interface PendingCompaction {
  readonly deferred: Deferred;
  options: RunnableCompactionRequest;
}

const coordinators = new WeakMap<
  AutoCompactionEpisodeOptions["state"],
  CompactionCoordinator
>();

export function scheduleThreadCompaction(
  options: CompactionRequestOptions
): Promise<void> {
  if (!options.compaction) {
    return Promise.resolve();
  }
  const runnable = { ...options, compaction: options.compaction };
  const coordinator = coordinatorFor(options.state);
  if (coordinator.active || coordinator.blockingWaiters > 0) {
    return enqueuePending(coordinator, runnable);
  }
  return startCompletedTurn(coordinator, runnable);
}

export async function compactThreadBlocking(
  options: CompactionRequestOptions
): Promise<boolean> {
  if (!options.compaction) {
    return false;
  }
  return await runBlocking({
    deadline: { kind: "automatic", compaction: options.compaction },
    options: { ...options, compaction: options.compaction },
    reason: "overflow",
  });
}

/** Force a compaction through the automatic snapshot and freshness pipeline. */
export async function compactThreadManually(
  options: Omit<CompactionRequestOptions, "compaction"> & {
    readonly deadlineMs?: () => number;
    readonly summaryOptions?: CompactionSummaryOptions;
  }
): Promise<boolean> {
  const compaction: AgentCompaction = async (context) => {
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
    deadline: { kind: "manual", deadlineMs: options.deadlineMs },
    options: { ...options, compaction },
    reason: "manual",
  });
}

function startCompletedTurn(
  coordinator: CompactionCoordinator,
  options: RunnableCompactionRequest
): Promise<void> {
  const running = activate(coordinator, "completed-turn", async () => {
    const deadline = automaticCompactionDeadline({
      compaction: options.compaction,
      diagnostics: options.model.diagnostics,
    });
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
      try {
        return await runCompactionEpisode({ ...episode, runnerAttempt: 2 });
      } catch {
        return false;
      }
    }
  });
  return running.then(() => undefined);
}

function enqueuePending(
  coordinator: CompactionCoordinator,
  options: RunnableCompactionRequest
): Promise<void> {
  const pending = coordinator.pending;
  if (pending) {
    pending.options = options;
    return pending.deferred.promise;
  }
  const queued = { deferred: deferred(), options };
  coordinator.pending = queued;
  return queued.deferred.promise;
}

async function runBlocking({
  deadline,
  options,
  reason,
}: {
  readonly deadline:
    | { readonly compaction: AgentCompaction; readonly kind: "automatic" }
    | { readonly deadlineMs?: () => number; readonly kind: "manual" };
  readonly options: RunnableCompactionRequest;
  readonly reason: "manual" | "overflow";
}): Promise<boolean> {
  const coordinator = coordinatorFor(options.state);
  coordinator.blockingWaiters += 1;
  try {
    while (coordinator.active) {
      const active = coordinator.active;
      const compacted = await waitForActiveCompaction(
        active.promise,
        options.signal
      );
      if (active.reason !== "completed-turn") {
        return compacted;
      }
      if (reason === "overflow" && compacted) {
        return true;
      }
    }
    return await activate(coordinator, reason, async () => {
      const resolvedDeadline =
        deadline.kind === "automatic"
          ? automaticCompactionDeadline({
              compaction: options.compaction,
              diagnostics: options.model.diagnostics,
            })
          : strictCompactionDeadline(deadline.deadlineMs);
      return await runCompactionEpisode({
        ...options,
        ...resolvedDeadline,
        compactionId: crypto.randomUUID(),
        reason,
        runnerAttempt: 1,
      });
    });
  } finally {
    coordinator.blockingWaiters -= 1;
    startPendingIfReady(coordinator);
  }
}

async function waitForActiveCompaction(
  active: Promise<boolean>,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (!signal) {
    return await active;
  }
  if (signal.aborted) {
    throw signal.reason;
  }
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
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
  const pending = coordinator.pending;
  coordinator.pending = undefined;
  startCompletedTurn(coordinator, pending.options).then(
    pending.deferred.resolve,
    pending.deferred.reject
  );
}

function coordinatorFor(
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
