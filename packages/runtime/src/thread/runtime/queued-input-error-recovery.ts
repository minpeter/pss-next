import type { ModelMessage } from "ai";
import { restoreContextTokenMeter } from "./context-token-meter-rollback";
import { releasePendingDurableThreadInputClaim } from "./durable-input-claims";
import type { ThreadExecutionRun } from "./execution";
import type { DurableThreadEventBuffer } from "./thread-event-log";
import { recoverTurnProcessingError } from "./turn-error";
import type { ProcessQueuedInputOptions } from "./turn-processor-options";

export async function recoverQueuedInputFailure({
  durableEvents,
  error,
  execution,
  executionRun,
  historySnapshot,
  item,
  meterCheckpoint,
  model,
  pendingDurableInputClaim,
  recordEvent,
  state,
  threadKey,
}: {
  readonly durableEvents: DurableThreadEventBuffer;
  readonly error: unknown;
  readonly execution: ProcessQueuedInputOptions["execution"];
  readonly executionRun?: ThreadExecutionRun;
  readonly historySnapshot: ModelMessage[];
  readonly item: ProcessQueuedInputOptions["item"];
  readonly meterCheckpoint:
    | ReturnType<
        NonNullable<
          ProcessQueuedInputOptions["model"]["contextTokenMeter"]
        >["checkpoint"]
      >
    | undefined;
  readonly model: ProcessQueuedInputOptions["model"];
  readonly pendingDurableInputClaim: ProcessQueuedInputOptions["item"]["durableInputClaim"];
  readonly recordEvent: Parameters<
    typeof recoverTurnProcessingError
  >[0]["recordEvent"];
  readonly state: ProcessQueuedInputOptions["state"];
  readonly threadKey: string;
}): Promise<ProcessQueuedInputOptions["item"]["durableInputClaim"]> {
  const pendingClaim = await releasePendingDurableThreadInputClaim({
    executionHost: execution.executionHost,
    record: pendingDurableInputClaim,
  });
  restoreContextTokenMeter(model.contextTokenMeter, meterCheckpoint, item.run);
  try {
    await recoverTurnProcessingError({
      durableEvents,
      error,
      executionHost: execution.executionHost,
      executionRun,
      historySnapshot,
      recordEvent,
      run: item.run,
      runtimeInput: item.runtimeInput,
      state,
      threadKey,
    });
  } catch (recoveryError) {
    if (item.executionRun?.kind === "notification") {
      item.run.closeWithError(recoveryError);
    }
    throw recoveryError;
  }
  return pendingClaim;
}
