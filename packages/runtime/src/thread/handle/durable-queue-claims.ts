import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import type { AgentHost } from "../../execution/host/types";
import { attachInputMeta } from "../input/input-meta";
import {
  createRuntimeInputState,
  type QueuedInput,
} from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import {
  claimDurableThreadInput,
  releaseDurableThreadInputClaim,
} from "../runtime/durable-input-claims";
import {
  cancelThreadExecutionRun,
  precreateThreadExecutionRun,
} from "../runtime/execution";
import {
  isLiveThreadInputOwnedByOther,
  liveThreadInputOwnedByOther,
  unregisterLiveThreadInput,
} from "../runtime/live-input-ownership";
import {
  DurableInputRecoveryState as RecoveryState,
  recoverThreadDurableInputClaims as recoverClaims,
} from "./durable-queue-claim-recovery";
import { inputMetaForQueuedKind } from "./durable-queue-send";

export class DurableInputRecoveryState extends RecoveryState {}

export function recoverThreadDurableInputClaims(options: {
  readonly allowOwned?: boolean;
  readonly executionHost: AgentHost | undefined;
  readonly state: DurableInputRecoveryState;
  readonly threadKey: string;
}): Promise<void> {
  return recoverClaims(options);
}

export async function claimOrphanDurableThreadInput({
  executionHost,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly threadKey: string;
}): Promise<QueuedInput | undefined> {
  const claimed = await claimDurableThreadInput({
    boundary: "turn-idle",
    executionHost,
    threadKey,
  });
  if (claimed.kind === "unavailable" || !claimed.record) {
    return;
  }
  if (
    isLiveThreadInputOwnedByOther(
      executionHost,
      threadKey,
      claimed.record.messageId
    )
  ) {
    await releaseDurableThreadInputClaim({
      executionHost,
      record: claimed.record,
    });
    return;
  }
  return await queuedInputFromClaim(claimed.record, executionHost);
}

export type QueuedDurableInputPreparation =
  | { readonly kind: "prepared"; readonly item: QueuedInput }
  | { readonly kind: "blocked"; readonly released: Promise<void> }
  | { readonly kind: "preceding"; readonly item: QueuedInput }
  | { readonly kind: "unavailable" };

export async function prepareQueuedDurableInput({
  executionHost,
  item,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly item: QueuedInput;
  readonly threadKey: string;
}): Promise<QueuedDurableInputPreparation> {
  if (!item.durableInput) {
    return { item, kind: "prepared" };
  }

  const claimed = await claimDurableThreadInput({
    boundary: "turn-idle",
    executionHost,
    threadKey,
  });
  if (claimed.kind === "claimed" && claimed.record) {
    if (claimed.record.messageId !== item.durableMessageId) {
      const released = liveThreadInputOwnedByOther(
        executionHost,
        threadKey,
        claimed.record.messageId,
        item.durableOwner
      );
      if (released) {
        await releaseDurableThreadInputClaim({
          executionHost,
          record: claimed.record,
        });
        return { kind: "blocked", released };
      }
      return {
        item: await queuedInputFromClaim(claimed.record, executionHost),
        kind: "preceding",
      };
    }
    if (item.durableMessageId) {
      unregisterLiveThreadInput(
        executionHost,
        threadKey,
        item.durableMessageId,
        item.durableOwner
      );
    }
    return {
      item: { ...item, durableInputClaim: claimed.record },
      kind: "prepared",
    };
  }

  if (item.durableMessageId) {
    unregisterLiveThreadInput(
      executionHost,
      threadKey,
      item.durableMessageId,
      item.durableOwner
    );
  }
  await cancelThreadExecutionRun({
    executionHost,
    executionRun: item.executionRun,
  });
  item.run.close();
  return { kind: "unavailable" };
}

async function queuedInputFromClaim(
  record: import("../../execution/host/types").ClaimedThreadInput,
  executionHost: AgentHost | undefined
): Promise<QueuedInput> {
  const runId = createThreadExecutionRunId({
    threadKey: record.threadKey,
    turnId: record.messageId,
  });
  let precreated: Awaited<ReturnType<typeof precreateThreadExecutionRun>>;
  try {
    precreated = await precreateThreadExecutionRun({
      executionHost,
      kind: "user-turn",
      runId,
      threadKey: record.threadKey,
    });
  } catch (error) {
    await releaseDurableThreadInputClaim({ executionHost, record });
    throw error;
  }
  if (record.kind === "steer") {
    await releaseDurableThreadInputClaim({ executionHost, record });
    throw new Error("A steering input cannot be claimed at turn-idle.");
  }
  return {
    acceptedEvent: attachInputMeta(
      record.input,
      inputMetaForQueuedKind(record.kind)
    ),
    awaitBoundaries: false,
    durableInputClaim: record,
    durableInputKind: record.kind === "follow-up" ? "follow-up" : "send",
    ...(precreated
      ? { executionRun: { kind: precreated.kind, runId: precreated.runId } }
      : {}),
    initialEvents: [],
    preUserRuntimeInputs: [],
    run: new BufferedAgentTurn(precreated?.runId),
    runtimeInput: createRuntimeInputState([]),
  };
}
