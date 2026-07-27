import { closeKilledRuntimeInputs } from "../runtime/kill";
import { threadKilledError } from "../state/thread-errors";
import type { AgentThreadContext } from "./agent-thread-context";
import {
  activeTurnRuntimeInput,
  turnAbort,
  turnRunToClose,
} from "./agent-thread-machines";

export function killAgentThread(context: AgentThreadContext): Promise<void> {
  const current = context.terminal.state;
  if (current.tag !== "open") {
    return current.killPromise;
  }

  const killedError = threadKilledError();
  context.pendingOverlays.length = 0;
  context.pendingRuntimeInputs.length = 0;
  turnAbort(context.turn)?.abort();
  const immediateClose = closeKilledRuntimeInputs({
    activeRuntimeInput: activeTurnRuntimeInput(context.turn),
    executionHost: context.execution.executionHost,
    inputQueue: context.inputQueue,
    message: killedError.message,
    runToClose: turnRunToClose(context.turn),
    threadKey: context.threadKey,
  });
  const admissionClose = context.inputAdmissionQueue.then(() =>
    closeKilledRuntimeInputs({
      activeRuntimeInput: undefined,
      executionHost: context.execution.executionHost,
      inputQueue: context.inputQueue,
      message: killedError.message,
      runToClose: undefined,
      threadKey: context.threadKey,
    })
  );
  const killPromise = Promise.all([immediateClose, admissionClose]).then(
    () => undefined
  );
  killPromise.catch(() => undefined);
  context.terminal.to({ tag: "killed", killPromise });
  return killPromise;
}
