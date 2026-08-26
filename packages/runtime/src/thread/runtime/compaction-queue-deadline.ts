import { deferred } from "../../internal/deferred";
import type { CompactionDeadline } from "./auto-compaction-deadline";
import { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import type { AgentCompactionReason } from "./auto-compaction-types";

export interface CompactionQueueDeadline {
  readonly dispose: () => void;
  readonly signal: AbortSignal;
}

export async function waitForCompactionQueue<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  const aborted = deferred<never>();
  const abortFromQueue = (): void => aborted.reject(signal.reason);
  signal.addEventListener("abort", abortFromQueue, { once: true });
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abortFromQueue);
  }
}

export function compactionQueueDeadline({
  deadline,
  reason,
  signal,
}: {
  readonly deadline: CompactionDeadline;
  readonly reason: AgentCompactionReason;
  readonly signal?: AbortSignal;
}): CompactionQueueDeadline {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeoutError = new CompactionDeadlineExceededError({
    ...deadline,
    reason,
  });
  const remainingMs = deadline.deadlineAt - Date.now();
  const timeout =
    remainingMs <= 0
      ? undefined
      : setTimeout(() => controller.abort(timeoutError), remainingMs);
  if (remainingMs <= 0 && !controller.signal.aborted) {
    controller.abort(timeoutError);
  }

  return {
    dispose: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", abortFromCaller);
    },
    signal: controller.signal,
  };
}
