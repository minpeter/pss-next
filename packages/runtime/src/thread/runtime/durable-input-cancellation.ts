import type { AgentHost, TurnRecord } from "../../execution/host/types";
import type { QueuedInput } from "../input/runtime-input";
import { DurableThreadInputClaimError } from "./durable-input-acknowledgement";
import { unregisterLiveThreadInput } from "./live-input-ownership";

type TransactionStore = Parameters<
  Parameters<AgentHost["store"]["transaction"]>[0]
>[0];

export class DurableThreadInputCancellationError extends Error {
  constructor(messageId: string, threadKey: string) {
    super(
      `Could not claim queued input ${messageId} for cancellation on ${threadKey}.`
    );
    this.name = "DurableThreadInputCancellationError";
  }
}

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

  await executionHost.store.transaction((transaction) =>
    cancelDurableItems(transaction, durableItems, threadKey)
  );
  for (const item of durableItems) {
    unregisterLiveThreadInput(
      executionHost,
      threadKey,
      item.durableMessageId,
      item.durableOwner
    );
  }
}

async function cancelDurableItems(
  transaction: TransactionStore,
  items: readonly (QueuedInput & { readonly durableMessageId: string })[],
  threadKey: string
): Promise<void> {
  for (const item of items) {
    await cancelDurableItem(transaction, item, threadKey);
  }
}

async function cancelDurableItem(
  transaction: TransactionStore,
  item: QueuedInput & { readonly durableMessageId: string },
  threadKey: string
): Promise<void> {
  const claimed = await transaction.inputs.claimNext(threadKey, "turn-idle", {
    messageId: item.durableMessageId,
  });
  if (!claimed) {
    throw new DurableThreadInputCancellationError(
      item.durableMessageId,
      threadKey
    );
  }
  const promoted = await transaction.inputs.markPromoted(claimed);
  if (!promoted) {
    throw new DurableThreadInputClaimError("promote", claimed);
  }
  if (!(await transaction.inputs.ack(promoted))) {
    throw new DurableThreadInputClaimError("ack", claimed);
  }
  const runId = item.executionRun?.runId ?? item.run.runId;
  if (!runId) {
    return;
  }
  const run = await transaction.turns.get(runId);
  if (!(run && !isTerminalTurnStatus(run.status))) {
    return;
  }
  const transition = await transaction.turns.transition(
    runId,
    { leaseId: run.lease?.leaseId, status: run.status },
    { ...run, status: "cancelled" }
  );
  if (!transition.ok) {
    throw new Error(
      `Durable input run ${runId} cancellation failed: ${transition.reason}.`
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
