import type { AgentHost, ThreadInputKind } from "../../execution/host/types";
import {
  cleanupStagedRuntimeAttachments,
  cleanupUnreferencedStagedRuntimeAttachments,
  type HostAttachmentStore,
  type RuntimeAttachmentReference,
  stageUserInputAttachments,
} from "../input/attachments";
import type { AgentInput } from "../input/input";
import { attachInputMeta, userInputFromEvent } from "../input/input-meta";
import type { InputEventMeta } from "../input/input-meta-types";
import { normalizeAgentInput } from "../input/input-normalization";
import {
  createRuntimeInputState,
  type QueuedInput,
  type QueuedRuntimeInput,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import { type BufferedAgentTurn, bindTurnExecutionRun } from "../protocol/turn";
import { admitDurableThreadInput } from "../runtime/durable-input-admission";
import {
  registerLiveThreadInput,
  unregisterLiveThreadInput,
} from "../runtime/live-input-ownership";
import { startThreadQueueDrain } from "../runtime/notification";
import type { ThreadEventDispatcher } from "../runtime/thread-event-dispatcher";
import type { ThreadInputAdmissionOperation } from "../runtime/thread-input-admission-coordinator";

export async function admitThreadSendInput({
  awaitBoundaries,
  attachmentStore,
  drain,
  events,
  executionHost,
  input,
  inputQueue,
  kind = "send",
  pendingOverlays,
  pendingRuntimeInputs,
  reservation,
  run,
  threadKey,
}: {
  readonly awaitBoundaries: boolean;
  readonly attachmentStore: HostAttachmentStore | undefined;
  readonly drain: () => Promise<void>;
  readonly events: ThreadEventDispatcher;
  readonly executionHost: AgentHost | undefined;
  readonly input: AgentInput;
  readonly inputQueue: QueuedInput[];
  readonly kind?: Exclude<ThreadInputKind, "steer">;
  readonly pendingOverlays: QueuedRuntimeInput[];
  readonly pendingRuntimeInputs: QueuedRuntimeInput[];
  readonly reservation?: ThreadInputAdmissionOperation;
  readonly run: BufferedAgentTurn;
  readonly threadKey: string;
}): Promise<void> {
  const queued = await createQueuedSendInput({
    awaitBoundaries,
    attachmentStore,
    events,
    executionHost,
    input,
    kind,
    pendingOverlays,
    pendingRuntimeInputs,
    reservation,
    run,
    threadKey,
  });
  if (queued.kind === "handled") {
    return;
  }

  events.emitProcessedEvent(run, queued.processed);
  inputQueue.push(queued.item);
  startThreadQueueDrain(run, drain);
}

type QueuedSendInputResult =
  | {
      readonly kind: "queued";
      readonly item: QueuedInput;
      readonly processed: AgentEvent;
    }
  | { readonly kind: "handled" };

export async function createQueuedSendInput({
  awaitBoundaries,
  attachmentStore,
  events,
  executionHost,
  input,
  kind = "send",
  pendingOverlays,
  pendingRuntimeInputs,
  reservation,
  run,
  threadKey,
}: {
  readonly awaitBoundaries: boolean;
  readonly attachmentStore: HostAttachmentStore | undefined;
  readonly events: ThreadEventDispatcher;
  readonly executionHost: AgentHost | undefined;
  readonly input: AgentInput;
  readonly kind?: Exclude<ThreadInputKind, "steer">;
  readonly pendingOverlays: QueuedRuntimeInput[];
  readonly pendingRuntimeInputs: QueuedRuntimeInput[];
  readonly reservation?: ThreadInputAdmissionOperation;
  readonly run: BufferedAgentTurn;
  readonly threadKey: string;
}): Promise<QueuedSendInputResult> {
  const normalized = normalizeAgentInput(input);
  const acceptedInput =
    normalized.meta === undefined
      ? attachInputMeta(normalized, inputMetaForQueuedKind(kind))
      : normalized;
  const stagedRefs: RuntimeAttachmentReference[] = [];
  let keepStagedAttachments = false;
  let registeredMessageId: string | undefined;
  try {
    const stagedAcceptedInput = await stageUserInputAttachments(
      acceptedInput,
      attachmentStore,
      { stagedRefs }
    );
    const processed = await events.interceptEvent(stagedAcceptedInput, {
      stagedRefs,
    });
    if (processed === "handled") {
      run.close();
      return { kind: "handled" };
    }

    const queuedInput = await stageUserInputAttachments(
      userInputFromEvent(
        processed.type === "user-input" ? processed : stagedAcceptedInput
      ),
      attachmentStore,
      { stagedRefs, trustRuntimeAttachmentRefs: true }
    );
    const messageId = crypto.randomUUID();
    registerLiveThreadInput(executionHost, threadKey, messageId, run);
    registeredMessageId = messageId;
    const admission = await admitDurableThreadInput({
      executionHost,
      input: queuedInput,
      kind,
      messageId,
      precreateExecutionRun: true,
      reservation,
      threadKey,
    });
    if (
      admission.kind === "unavailable" ||
      (admission.kind === "admitted" && admission.receipt.duplicate)
    ) {
      unregisterLiveThreadInput(executionHost, threadKey, messageId, run);
      registeredMessageId = undefined;
    }
    let executionRun: QueuedInput["executionRun"];
    if (admission.kind === "admitted") {
      if (admission.receipt.duplicate) {
        run.close();
        return { kind: "handled" };
      }

      const precreated = admission.executionRun;
      if (precreated) {
        executionRun = { kind: precreated.kind, runId: precreated.runId };
        bindTurnExecutionRun(run, precreated.runId);
      }
    }

    const item = {
      acceptedEvent: processed,
      awaitBoundaries,
      durableInput: admission.kind === "admitted",
      durableInputKind: kind,
      durableOwner: run,
      ...(admission.kind === "admitted"
        ? { durableMessageId: admission.receipt.record.messageId }
        : {}),
      ...(executionRun ? { executionRun } : {}),
      initialEvents: [],
      ...(admission.kind === "unavailable"
        ? { input: structuredClone(queuedInput) }
        : {}),
      preUserRuntimeInputs: pendingOverlays.splice(0),
      run,
      runtimeInput: createRuntimeInputState(pendingRuntimeInputs.splice(0)),
    } satisfies QueuedInput;
    await cleanupUnreferencedStagedRuntimeAttachments(
      attachmentStore,
      stagedRefs,
      [queuedInput, processed]
    );
    keepStagedAttachments = true;
    return { kind: "queued", item, processed };
  } finally {
    if (!keepStagedAttachments) {
      if (registeredMessageId) {
        unregisterLiveThreadInput(
          executionHost,
          threadKey,
          registeredMessageId,
          run
        );
      }
      await cleanupStagedRuntimeAttachments(attachmentStore, stagedRefs);
    }
  }
}

/** @internal exported for the durable-kind/meta invariant test. */
export function inputMetaForQueuedKind(
  kind: Exclude<ThreadInputKind, "steer">
): InputEventMeta {
  return {
    source: kind,
    ...(kind === "follow-up" ? { streaming: "follow-up" } : {}),
  };
}
