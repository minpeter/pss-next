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
  if (signal?.aborted) {
    return Promise.reject(
      new CodingAgentExtensionError(extensionId, phase, new Error("aborted"))
    );
  }
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return task;
  }

  return new Promise<Result>((resolve, reject) => {
    let settled = false;
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
    const timer = setTimeout(() => {
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

    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action();
    };

    signal?.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => finish(() => resolve(value)),
      (error) =>
        finish(() => {
          if (error instanceof CodingAgentExtensionError) {
            reject(error);
            return;
          }
          reject(new CodingAgentExtensionError(extensionId, phase, error));
        })
    );
  });
}
