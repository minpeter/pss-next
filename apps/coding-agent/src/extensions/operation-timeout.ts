import { CodingAgentExtensionError } from "./error";

export type ExtensionTimeoutPhase = "event" | "hook";

/**
 * Race `task` against a host timeout and optional abort signal.
 * Always clears the timer and abort listener when either side settles.
 */
export function raceWithExtensionTimeout<Result>(
  extensionId: string,
  phase: ExtensionTimeoutPhase,
  task: Promise<Result>,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }
): Promise<Result> {
  const { signal, timeoutMs } = options;
  const timerEnabled =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0;

  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = () => {
      finish(() =>
        reject(
          new CodingAgentExtensionError(
            extensionId,
            phase,
            new Error("aborted")
          )
        )
      );
    };

    signal?.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => finish(() => resolve(value)),
      (error) =>
        finish(() => {
          try {
            if (error instanceof CodingAgentExtensionError) {
              reject(error);
              return;
            }
          } catch {
            reject(
              new CodingAgentExtensionError(
                extensionId,
                phase,
                new Error("Extension operation rejected with an unsafe value")
              )
            );
            return;
          }
          reject(new CodingAgentExtensionError(extensionId, phase, error));
        })
    );
    if (signal?.aborted) {
      abort();
    } else if (timerEnabled) {
      timer = setTimeout(() => {
        finish(() =>
          reject(
            new CodingAgentExtensionError(
              extensionId,
              phase,
              new Error(`${phase} timed out after ${timeoutMs}ms`)
            )
          )
        );
      }, timeoutMs);
    }
  });
}
