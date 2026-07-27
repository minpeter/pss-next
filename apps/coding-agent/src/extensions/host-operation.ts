import { CodingAgentExtensionError } from "./error";

type ExtensionOperationPhase = "activate" | "configure";

export async function runExtensionOperation<Result>(options: {
  readonly callback: () => Promise<Result> | Result;
  readonly controller: AbortController;
  readonly extensionId: string;
  readonly hasInteractiveUiRequests: () => boolean;
  /** Invoked if `callback` settles after a timeout/abort race loss (e.g. late cleanup). */
  readonly onLateResult?: (result: Result) => void | Promise<void>;
  readonly phase: ExtensionOperationPhase;
  readonly timeoutMs: number;
}): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const task = Promise.resolve().then(() => options.callback());

  try {
    return await Promise.race([
      task.then((result) => {
        settled = true;
        return result;
      }),
      new Promise<never>((_resolve, reject) => {
        const onTimeout = () => {
          if (
            options.phase === "activate" &&
            options.hasInteractiveUiRequests()
          ) {
            timeout = setTimeout(onTimeout, options.timeoutMs);
            return;
          }
          options.controller.abort();
          reject(
            new Error(
              `Coding agent extension timed out after ${options.timeoutMs}ms`
            )
          );
        };
        timeout = setTimeout(onTimeout, options.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (!settled && options.onLateResult !== undefined) {
      // Fire-and-forget: late activation cleanups after timeout/abort.
      task
        .then(async (result) => {
          try {
            await options.onLateResult?.(result);
          } catch {
            // Late cleanup failures are best-effort after the host already timed out.
          }
        })
        .catch(() => undefined);
    }
    throw new CodingAgentExtensionError(
      options.extensionId,
      options.phase,
      error
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
