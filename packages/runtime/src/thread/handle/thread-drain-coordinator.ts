import type { AgentHost } from "../../execution/host/types";
import { deferred } from "../../internal/deferred";

interface DrainLock {
  readonly owner: object;
  readonly settled: Promise<void>;
}

interface ThreadDrainOwnershipState {
  active?: DrainLock;
  lastOwner?: object;
}

export interface ThreadDrainOwnership {
  /** Another owner completed work since this owner last held the thread. */
  readonly refreshRequired: boolean;
}

interface ThreadDrainOwnershipOptions<T> {
  readonly executionHost: AgentHost | undefined;
  readonly operation: (ownership: ThreadDrainOwnership) => Promise<T>;
  readonly owner: object;
  readonly signal?: AbortSignal;
  readonly threadKey: string;
}

const hostDrainStates = new WeakMap<
  object,
  Map<string, ThreadDrainOwnershipState>
>();

export function isThreadDrainOwned(
  executionHost: AgentHost,
  threadKey: string
): boolean {
  return (
    hostDrainStates.get(executionHost.store)?.get(threadKey)?.active !==
    undefined
  );
}

/**
 * Serializes drain loops that share a host/store object and thread key.
 * Durable inbox records remain the source of truth; this coordinator prevents
 * two live handles in the same host isolate from claiming successive records
 * while either model turn is still running.
 */
export async function withThreadDrainOwnership<T>(
  executionHost: AgentHost | undefined,
  threadKey: string,
  owner: object,
  operation: (ownership: ThreadDrainOwnership) => Promise<T>
): Promise<T> {
  return await runWithThreadDrainOwnership({
    executionHost,
    operation,
    owner,
    threadKey,
  });
}

export async function withAbortableThreadDrainOwnership<T>(
  options: ThreadDrainOwnershipOptions<T> & { readonly signal: AbortSignal }
): Promise<T> {
  return await runWithThreadDrainOwnership(options);
}

async function runWithThreadDrainOwnership<T>({
  executionHost,
  operation,
  owner,
  signal,
  threadKey,
}: ThreadDrainOwnershipOptions<T>): Promise<T> {
  if (!executionHost) {
    signal?.throwIfAborted();
    const running = operation({ refreshRequired: false });
    return signal ? await waitForDrainSignal(running, signal) : await running;
  }

  const identity = executionHost.store;
  let threads = hostDrainStates.get(identity);
  if (!threads) {
    threads = new Map();
    hostDrainStates.set(identity, threads);
  }
  let state = threads.get(threadKey);
  if (!state) {
    state = {};
    threads.set(threadKey, state);
  }

  for (;;) {
    const active = state.active;
    if (!active) {
      break;
    }
    if (!signal) {
      await active.settled;
      continue;
    }
    await waitForDrainSignal(active.settled, signal);
  }

  signal?.throwIfAborted();
  const released = deferred();
  const lock = { owner, settled: released.promise } satisfies DrainLock;
  // There is no await between observing the empty slot and installing it, so
  // JavaScript's run-to-completion semantics make acquisition atomic.
  state.active = lock;
  const refreshRequired =
    state.lastOwner !== undefined && state.lastOwner !== owner;
  let completed = false;
  try {
    const running = operation({ refreshRequired });
    const result = signal
      ? await waitForDrainSignal(running, signal)
      : await running;
    completed = true;
    return result;
  } finally {
    if (state.active === lock) {
      state.active = undefined;
      if (completed) {
        state.lastOwner = owner;
      }
    }
    released.resolve();
  }
}

async function waitForDrainSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  const aborted = deferred<never>();
  const abortFromCaller = (): void => aborted.reject(signal.reason);
  signal.addEventListener("abort", abortFromCaller, { once: true });
  try {
    // Promise.race observes later operation rejection after abort wins.
    return await Promise.race([operation, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abortFromCaller);
  }
}
