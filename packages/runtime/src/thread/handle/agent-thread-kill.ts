import { deferred } from "../../internal/deferred";
import { closeKilledRuntimeInputs } from "../runtime/kill";
import { threadKilledError } from "../state/thread-errors";
import type { AgentThreadContext } from "./agent-thread-context";
import {
  activeTurnRuntimeInput,
  turnAbort,
  turnRunToClose,
} from "./agent-thread-machines";
import { withThreadDrainOwnership } from "./thread-drain-coordinator";

export function killAgentThread(context: AgentThreadContext): Promise<void> {
  const current = context.terminal.state;
  if (current.tag !== "open") {
    return current.killPromise;
  }

  const settled = deferred();
  const killPromise = settled.promise;
  killPromise.catch(() => undefined);
  // Transition before any teardown work: aborting the active turn runs
  // synchronous abort listeners, and re-entrant kill()/#assertOpen() calls
  // from those listeners must already observe the thread as killed.
  context.terminal.to({ tag: "killed", killPromise });

  const killedError = threadKilledError();
  context.pendingOverlays.length = 0;
  context.pendingRuntimeInputs.length = 0;
  turnAbort(context.turn)?.abort();
  const close = async (): Promise<void> => {
    await withThreadDrainOwnership(
      context.execution.executionHost,
      context.threadKey,
      context,
      async () => {
        await closeKilledRuntimeInputs({
          activeRuntimeInput: activeTurnRuntimeInput(context.turn),
          executionHost: context.execution.executionHost,
          inputQueue: context.inputQueue,
          message: killedError.message,
          runToClose: turnRunToClose(context.turn),
          threadKey: context.threadKey,
        });
        await context.inputAdmissionQueue;
        await closeKilledRuntimeInputs({
          activeRuntimeInput: undefined,
          executionHost: context.execution.executionHost,
          inputQueue: context.inputQueue,
          message: killedError.message,
          runToClose: undefined,
          threadKey: context.threadKey,
        });
      }
    );
  };
  close().then(
    () => settled.resolve(),
    (error: unknown) => {
      try {
        context.terminal.toIf("killed", { tag: "open" });
      } finally {
        settled.reject(error);
      }
    }
  );
  return killPromise;
}
