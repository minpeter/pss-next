import { CodingAgentExtensionError } from "./error";

type ExtensionOperationPhase = "activate" | "configure";

export async function runExtensionOperation<Result>(options: {
  readonly callback: () => Promise<Result> | Result;
  readonly controller: AbortController;
  readonly extensionId: string;
  readonly hasInteractiveUiRequests: () => boolean;
  readonly phase: ExtensionOperationPhase;
  readonly timeoutMs: number;
}): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      options.callback(),
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
