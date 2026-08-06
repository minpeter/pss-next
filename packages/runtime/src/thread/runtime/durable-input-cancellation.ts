import type { AgentHost, TurnRecord } from "../../execution/host/types";
import type { QueuedInput } from "../input/runtime-input";
import { DurableThreadInputClaimError } from "./durable-input-acknowledgement";
import { unregisterLiveThreadInput } from "./live-input-ownership";

export async function cancelQueuedDurableThreadInputs({
  executionHost,
  items,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly items: readonly QueuedInput[];
  readonly threadKey: string;
}): Promise<void> {
  const durableItems = items.filter(
    (item): item is QueuedInput & { readonly durableMessageId: string } =>
      typeof item.durableMessageId === "string"
  );
  if (!(executionHost && durableItems.length > 0)) {
    return;
  }

  await executionHost.store.transaction(async (transaction) => {
    for (const item of durableItems) {
      const claimed = await transaction.inputs.claimNext(
        threadKey,
        "turn-idle",
        { messageId: item.durableMessageId }
      );
      if (!claimed) {
        continue;
      }
      const promoted = await transaction.inputs.markPromoted(claimed);
      if (!promoted) {
        throw new DurableThreadInputClaimError("promote", claimed);
      }
      const acked = await transaction.inputs.ack(promoted);
      if (!acked) {
        throw new DurableThreadInputClaimError("ack", claimed);
      }

      const runId = item.executionRun?.runId ?? item.run.runId;
      if (!runId) {
        continue;
      }
      const run = await transaction.turns.get(runId);
      if (run && !isTerminalTurnStatus(run.status)) {
        await transaction.turns.update({ ...run, status: "cancelled" });
      }
    }
  });
  for (const item of durableItems) {
    unregisterLiveThreadInput(
      executionHost,
      threadKey,
      item.durableMessageId,
      item.durableOwner
    );
  }
}

function isTerminalTurnStatus(status: TurnRecord["status"]): boolean {
  return (
    status === "cancelled" ||
    status === "completed" ||
    status === "error" ||
    status === "needs-recovery"
  );
}
