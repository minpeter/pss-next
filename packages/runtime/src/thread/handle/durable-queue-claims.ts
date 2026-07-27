import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import type { AgentHost } from "../../execution/host/types";
import { Fsm } from "../../internal/fsm";
import {
  createRuntimeInputState,
  type QueuedInput,
} from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import {
  claimDurableThreadInput,
  recoverDurableThreadInputs,
} from "../runtime/durable-input-claims";
import {
  cancelThreadExecutionRun,
  precreateThreadExecutionRun,
} from "../runtime/execution";

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
  executionHost,
  state,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly state: DurableInputRecoveryState;
  readonly threadKey: string;
}): Promise<void> {
  if (state.machine.state.tag !== "pending") {
    return;
  }

  state.machine.to({ tag: "recovering" });
  try {
    await recoverDurableThreadInputs({
      executionHost,
      threadKey,
    });
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

  const runId = createThreadExecutionRunId({
    threadKey: claimed.record.threadKey,
    turnId: claimed.record.messageId,
  });
  const precreated = await precreateThreadExecutionRun({
    executionHost,
    kind: "user-turn",
    runId,
    threadKey,
  });
  return {
    acceptedEvent: claimed.record.input,
    awaitBoundaries: false,
    durableInputClaim: claimed.record,
    ...(precreated
      ? { executionRun: { kind: precreated.kind, runId: precreated.runId } }
      : {}),
    initialEvents: [],
    preUserRuntimeInputs: [],
    run: new BufferedAgentTurn(precreated?.runId),
    runtimeInput: createRuntimeInputState([]),
  };
}

export async function prepareQueuedDurableInput({
  executionHost,
  item,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly item: QueuedInput;
  readonly threadKey: string;
}): Promise<QueuedInput | undefined> {
  if (!item.durableInput) {
    return item;
  }

  const claimed = await claimDurableThreadInput({
    boundary: "turn-idle",
    executionHost,
    messageId: item.durableMessageId,
    threadKey,
  });
  if (claimed.kind === "claimed" && claimed.record) {
    return { ...item, durableInputClaim: claimed.record };
  }

  await cancelThreadExecutionRun({
    executionHost,
    executionRun: item.executionRun,
  });
  item.run.close();
  return;
}
