export async function withProductionOverlapAttemptTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const attempt = new AbortController();
  const timeout = setTimeout(
    () =>
      attempt.abort(
        new ProductionOverlapAttemptTimeoutError(
          `paired attempt exceeded ${timeoutMs}ms wall timeout`
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

class ProductionOverlapAttemptTimeoutError extends Error {}
