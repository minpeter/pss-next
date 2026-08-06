import type { AgentHost } from "../../execution/host/types";
import {
  closeRuntimeInput,
  type QueuedInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import { cancelQueuedDurableThreadInputs } from "./durable-input-cancellation";
import { cancelThreadExecutionRun } from "./execution";

interface CloseKilledRuntimeInputsOptions {
  readonly activeRuntimeInput: RuntimeInputState | undefined;
  readonly executionHost: AgentHost | undefined;
  readonly inputQueue: QueuedInput[];
  readonly message: string;
  readonly runToClose: BufferedAgentTurn | undefined;
  readonly threadKey: string;
}

export async function closeKilledRuntimeInputs({
  activeRuntimeInput,
  executionHost,
  inputQueue,
  message,
  runToClose,
  threadKey,
}: CloseKilledRuntimeInputsOptions): Promise<void> {
  const queuedItems = [...inputQueue];
  const nonDurableRuns = queuedItems.filter(
    (item) => item.durableMessageId === undefined
  );

  // Durable cancellation must succeed before local callers are terminalized:
  // on failure kill remains retryable and live ownership continues protecting
  // the records from orphan recovery.
  await cancelQueuedDurableThreadInputs({
    executionHost,
    items: queuedItems,
    threadKey,
  });

  closeRuntimeInput(activeRuntimeInput, message);
  runToClose?.emit({ type: "turn-error", message });
  runToClose?.close();
  for (const item of inputQueue.splice(0)) {
    closeRuntimeInput(item.runtimeInput, message);
    item.run.emit({ type: "turn-error", message });
    item.run.close();
  }

  await Promise.all([
    cancelThreadExecutionRun({
      executionHost,
      runId: runToClose?.runId,
    }),
    ...nonDurableRuns.map((item) =>
      cancelThreadExecutionRun({
        executionHost,
        executionRun: item.executionRun,
      })
    ),
  ]);
}
