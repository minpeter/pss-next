import type { AgentHost } from "../../execution/host/types";
import { deferred } from "../../internal/deferred";

const hostAdmissionTails = new WeakMap<object, Map<string, Promise<void>>>();

export type ThreadInputAdmissionOperation = <T>(
  operation: () => Promise<T>
) => Promise<T>;

export interface ThreadInputAdmissionReservation {
  readonly abandon: () => void;
  <T>(operation: () => Promise<T>): Promise<T>;
}

/** Reserve FIFO admission position synchronously, before asynchronous loading. */
export function reserveThreadInputAdmission(
  executionHost: AgentHost,
  threadKey: string,
  signal?: AbortSignal
): ThreadInputAdmissionReservation {
  let byThread = hostAdmissionTails.get(executionHost.store);
  if (!byThread) {
    byThread = new Map();
    hostAdmissionTails.set(executionHost.store, byThread);
  }
  const previous = byThread.get(threadKey) ?? Promise.resolve();
  const released = deferred();
  const tail = previous.then(() => released.promise);
  byThread.set(threadKey, tail);
  tail.then(() => {
    if (byThread.get(threadKey) === tail) {
      byThread.delete(threadKey);
    }
  });
  let positionReleased = false;
  const release = (): void => {
    if (!positionReleased) {
      positionReleased = true;
      released.resolve();
    }
  };
  return Object.assign(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        if (signal) {
          signal.throwIfAborted();
          const aborted = deferred<never>();
          const abortFromCaller = (): void => aborted.reject(signal.reason);
          signal.addEventListener("abort", abortFromCaller, { once: true });
          try {
            await Promise.race([previous, aborted.promise]);
            signal.throwIfAborted();
          } finally {
            signal.removeEventListener("abort", abortFromCaller);
          }
        } else {
          await previous;
        }
        return await operation();
      } finally {
        release();
      }
    },
    { abandon: release }
  );
}

export async function withThreadInputAdmission<T>(
  executionHost: AgentHost,
  threadKey: string,
  operation: () => Promise<T>
): Promise<T> {
  return await reserveThreadInputAdmission(executionHost, threadKey)(operation);
}
