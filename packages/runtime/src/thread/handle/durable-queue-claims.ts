import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import type { AgentHost } from "../../execution/host/types";
import { Fsm } from "../../fsm";
import { attachInputMeta } from "../input/input-meta";
import {
  createRuntimeInputState,
  type QueuedInput,
} from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import {
  claimDurableThreadInput,
  recoverDurableThreadInputs,
  releaseDurableThreadInputClaim,
} from "../runtime/durable-input-claims";
import {
  cancelThreadExecutionRun,
  precreateThreadExecutionRun,
} from "../runtime/execution";
import { inputMetaForQueuedKind } from "./durable-queue-send";
import { isThreadDrainOwned } from "./thread-drain-coordinator";

const sharedRecoveries = new WeakMap<object, Map<string, Promise<void>>>();

async function recoverAfterLiveDrain(
  executionHost: AgentHost,
  threadKey: string
): Promise<void> {
  let byThread = sharedRecoveries.get(executionHost.store);
  if (!byThread) {
    byThread = new Map();
    sharedRecoveries.set(executionHost.store, byThread);
  }
  const existing = byThread.get(threadKey);
  if (existing) {
    return await existing;
  }
  const recovery = (async () => {
    await recoverDurableThreadInputs({ executionHost, threadKey });
  })();
  byThread.set(threadKey, recovery);
  try {
    await recovery;
  } finally {
    if (byThread.get(threadKey) === recovery) {
      byThread.delete(threadKey);
    }
  }
}

/**
 * One-shot recovery of orphaned durable input claims:
 * `pending -> recovering -> recovered`, rolling back to `pending` when the
 * recovery fails so the next admission retries it.
 */
type DurableInputRecoveryPhase =
  | { readonly tag: "pending" }
  | { readonly tag: "recovering" }
  | { readonly tag: "recovered" };

export class DurableInputRecoveryState {
  readonly machine = new Fsm<DurableInputRecoveryPhase>({
    initial: { tag: "pending" },
    name: "durable-input-recovery",
    transitions: {
      pending: ["recovering"],
      recovering: ["recovered", "pending"],
      recovered: [],
    },
  });
}

export async function recoverThreadDurableInputClaims({
  allowOwned = false,
  executionHost,
  state,
  threadKey,
}: {
  readonly allowOwned?: boolean;
  readonly executionHost: AgentHost | undefined;
  readonly state: DurableInputRecoveryState;
  readonly threadKey: string;
}): Promise<void> {
  if (state.machine.state.tag !== "pending") {
    return;
  }
  if (
    executionHost &&
    !allowOwned &&
    isThreadDrainOwned(executionHost, threadKey)
  ) {
    return;
  }

  state.machine.to({ tag: "recovering" });
  try {
    if (executionHost) {
      await recoverAfterLiveDrain(executionHost, threadKey);
    } else {
      await recoverDurableThreadInputs({ executionHost, threadKey });
    }
    state.machine.to({ tag: "recovered" });
  } catch (error) {
    state.machine.to({ tag: "pending" });
    throw error;
  }
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
  return await queuedInputFromClaim(claimed.record, executionHost);
}

export type QueuedDurableInputPreparation =
  | { readonly kind: "prepared"; readonly item: QueuedInput }
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
      return {
        item: await queuedInputFromClaim(claimed.record, executionHost),
        kind: "preceding",
      };
    }
    return {
      item: { ...item, durableInputClaim: claimed.record },
      kind: "prepared",
    };
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
