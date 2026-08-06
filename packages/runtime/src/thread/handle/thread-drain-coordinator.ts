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
  if (!executionHost) {
    return await operation({ refreshRequired: false });
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
    await active.settled;
  }

  const released = deferred();
  const lock = { owner, settled: released.promise } satisfies DrainLock;
  // There is no await between observing the empty slot and installing it, so
  // JavaScript's run-to-completion semantics make acquisition atomic.
  state.active = lock;
  const refreshRequired =
    state.lastOwner !== undefined && state.lastOwner !== owner;
  let completed = false;
  try {
    const result = await operation({ refreshRequired });
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
