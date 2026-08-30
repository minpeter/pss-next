import type { AgentHost } from "../../execution/host/types";
import {
  closeRuntimeInput,
  type QueuedInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import { cancelQueuedDurableThreadInputs } from "./durable-input-cancellation";
import {
  cancellationForExecutionRun,
  cancelThreadExecutionRun,
} from "./execution";

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
  closeRuntimeInput(activeRuntimeInput, message);
  runToClose?.emit({ type: "turn-error", message });
  runToClose?.close();

  const queuedItems = [...inputQueue];
  const nonDurableRuns = queuedItems.filter(
    (item) => item.durableMessageId === undefined
  );

  // Durable cancellation must succeed before queued callers are terminalized.
  // The active run settles its abort status, thread state, and terminal event
  // atomically in its processor; only queued runs cancel directly here.
  await cancelQueuedDurableThreadInputs({
    executionHost,
    items: queuedItems,
    threadKey,
  });

  for (const item of inputQueue.splice(0)) {
    closeRuntimeInput(item.runtimeInput, message);
    item.run.emit({ type: "turn-error", message });
    item.run.close();
  }

  await Promise.all(
    nonDurableRuns.map((item) => {
      const executionCancellation = cancellationForExecutionRun(
        item.executionRun
      );
      const cancellation =
        executionCancellation ??
        (item.run.runId
          ? { kind: "unleased" as const, runId: item.run.runId }
          : undefined);
      return cancelThreadExecutionRun({ cancellation, executionHost });
    })
  );
}
