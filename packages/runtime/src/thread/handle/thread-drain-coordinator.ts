import type { AgentHost } from "../../execution/host/types";
import { deferred } from "../../internal/deferred";

interface DrainLock {
  readonly settled: Promise<void>;
}

const hostDrainLocks = new WeakMap<object, Map<string, DrainLock>>();

export function isThreadDrainOwned(
  executionHost: AgentHost,
  threadKey: string
): boolean {
  return hostDrainLocks.get(executionHost.store)?.has(threadKey) ?? false;
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
  operation: (ownership: { readonly contended: boolean }) => Promise<T>
): Promise<T> {
  if (!executionHost) {
    return await operation({ contended: false });
  }

  const identity = executionHost.store;
  let locks = hostDrainLocks.get(identity);
  if (!locks) {
    locks = new Map();
    hostDrainLocks.set(identity, locks);
  }

  let contended = false;
  for (;;) {
    const active = locks.get(threadKey);
    if (!active) {
      break;
    }
    contended = true;
    await active.settled;
  }

  const released = deferred();
  const lock = { settled: released.promise } satisfies DrainLock;
  // There is no await between observing the empty slot and installing it, so
  // JavaScript's run-to-completion semantics make acquisition atomic.
  locks.set(threadKey, lock);
  try {
    return await operation({ contended });
  } finally {
    if (locks.get(threadKey) === lock) {
      locks.delete(threadKey);
    }
    released.resolve();
  }
}
