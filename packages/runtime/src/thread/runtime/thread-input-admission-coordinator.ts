import type { AgentHost } from "../../execution/host/types";
import { deferred } from "../../internal/deferred";

const hostAdmissionTails = new WeakMap<object, Map<string, Promise<void>>>();

export async function withThreadInputAdmission<T>(
  executionHost: AgentHost,
  threadKey: string,
  operation: () => Promise<T>
): Promise<T> {
  let byThread = hostAdmissionTails.get(executionHost.store);
  if (!byThread) {
    byThread = new Map();
    hostAdmissionTails.set(executionHost.store, byThread);
  }
  const previous = byThread.get(threadKey) ?? Promise.resolve();
  const released = deferred();
  const tail = previous.then(() => released.promise);
  byThread.set(threadKey, tail);
  await previous;
  try {
    return await operation();
  } finally {
    released.resolve();
    if (byThread.get(threadKey) === tail) {
      byThread.delete(threadKey);
    }
  }
}
