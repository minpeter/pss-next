export async function withTaskUtilityAttemptTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const attempt = new AbortController();
  const timeout = setTimeout(
    () =>
      attempt.abort(
        new TaskUtilityAttemptTimeoutError(
          `task arm exceeded ${timeoutMs}ms wall timeout`
        )
      ),
    timeoutMs
  );
  try {
    return await run(attempt.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export async function abortableTaskUtilityWork<T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const listener = () => rejectAbort?.(signal.reason);
  signal.addEventListener("abort", listener, { once: true });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

export async function withValidFullControl<
  T extends { readonly fullPassed: boolean },
>(maxAttempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result: T;
    try {
      result = await run();
      lastError = undefined;
    } catch (cause) {
      lastError = cause;
      continue;
    }
    if (result.fullPassed) {
      return result;
    }
  }
  if (lastError !== undefined) {
    throw new Error(`task pair failed after ${maxAttempts} attempts`, {
      cause: lastError,
    });
  }
  throw new TypeError(
    `full-context control failed after ${maxAttempts} attempts`
  );
}

class TaskUtilityAttemptTimeoutError extends Error {}
