import { GatewayError } from "@ai-sdk/gateway";
import { APICallError, RetryError } from "ai";
import type { ModelRetry } from "../thread/protocol/events";

/** Owns the wait and decision at the provider-call boundary, never an SDK step. */
export function createModelRetry({
  attemptId,
  abortSignal,
  onRetry,
}: {
  readonly attemptId: string;
  readonly abortSignal?: AbortSignal;
  readonly onRetry?: (event: ModelRetry) => void;
}) {
  let attempt = 0;
  let stopped = false;
  const stop = (
    reason: Extract<ModelRetry, { phase: "stopped" }>["reason"]
  ) => {
    if (stopped) {
      return;
    }
    stopped = true;
    onRetry?.({
      attempt,
      attemptId,
      phase: "stopped",
      reason,
      remainingRetries: 0,
      type: "model-retry",
    });
  };
  const checkAbort = () => {
    if (abortSignal?.aborted) {
      stop("cancelled");
      abortSignal.throwIfAborted();
    }
  };

  const checkFailure = (error: unknown, errors: unknown[]) => {
    checkAbort();
    if (isAbortError(error)) {
      stop("cancelled");
      throw error;
    }
    errors.push(error);
    if (errors.length === 3) {
      stop("exhausted");
      throw new RetryError({
        errors,
        message: "Provider retries exhausted.",
        reason: "maxRetriesExceeded",
      });
    }
    if (!isRetryable(error)) {
      stop("non-retryable");
      if (errors.length === 1) {
        throw error;
      }
      throw new RetryError({
        errors,
        message: "Provider retry failed with a non-retryable error.",
        reason: "errorNotRetryable",
      });
    }
    return error;
  };

  return {
    checkAbort,
    stopStream(error: unknown) {
      stop(
        abortSignal?.aborted || isAbortError(error)
          ? "cancelled"
          : "stream-ended"
      );
    },
    async execute<T>(call: () => PromiseLike<T>): Promise<T> {
      const errors: unknown[] = [];
      while (true) {
        checkAbort();
        attempt += 1;
        let error: unknown;
        try {
          return await call();
        } catch (failure) {
          error = failure;
        }
        const retryableError = checkFailure(error, errors);
        const remainingRetries = 3 - errors.length;
        const delayMs = retryDelay(
          retryableError,
          2000 * 2 ** (errors.length - 1)
        );
        const retryAt = Date.now() + delayMs;
        try {
          await waitForRetry(delayMs, abortSignal, () =>
            onRetry?.({
              attempt,
              attemptId,
              delayMs,
              phase: "scheduled",
              remainingRetries,
              retryAt,
              type: "model-retry",
            })
          );
        } catch (failure) {
          stop(abortSignal?.aborted ? "cancelled" : "non-retryable");
          throw failure;
        }
        checkAbort();
        onRetry?.({
          attempt,
          attemptId,
          phase: "started",
          remainingRetries: remainingRetries - 1,
          type: "model-retry",
        });
      }
    },
  };
}

function isRetryable(error: unknown): error is APICallError | GatewayError {
  return (
    error instanceof Error &&
    (APICallError.isInstance(error) || GatewayError.isInstance(error)) &&
    error.isRetryable === true
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      error.name === "ResponseAborted")
  );
}

/** Matches AI SDK 7's retry header precedence and bounded delay selection. */
function retryDelay(
  error: APICallError | GatewayError,
  exponentialDelay: number
): number {
  const apiError = APICallError.isInstance(error) ? error : error.cause;
  const headers = APICallError.isInstance(apiError)
    ? apiError.responseHeaders
    : undefined;
  let delay: number | undefined;
  const milliseconds = headers?.["retry-after-ms"];
  if (milliseconds) {
    const parsed = Number.parseFloat(milliseconds);
    if (!Number.isNaN(parsed)) {
      delay = parsed;
    }
  }
  const after = headers?.["retry-after"];
  if (after && delay === undefined) {
    const seconds = Number.parseFloat(after);
    delay = Number.isNaN(seconds)
      ? Date.parse(after) - Date.now()
      : seconds * 1000;
  }
  return delay !== undefined &&
    delay >= 0 &&
    (delay < 60_000 || delay < exponentialDelay)
    ? delay
    : exponentialDelay;
}

function waitForRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
  onScheduled: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    // Arm both the deadline and cancellation before publishing the schedule.
    try {
      onScheduled();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
