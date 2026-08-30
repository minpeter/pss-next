import type { AgentHost } from "../../execution/host/types";
import {
  type HostAttachmentStore,
  stageAgentEventsAttachments,
  stageUserInputAttachments,
} from "../input/attachments";
import type { AgentInput, UserInput } from "../input/input";
import { attachInputMeta } from "../input/input-meta";
import { normalizeInternalAgentInput } from "../input/input-normalization";
import {
  createRuntimeInputState,
  type QueuedInput,
  type QueuedRuntimeInput,
  queueRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import { type AgentTurn, BufferedAgentTurn } from "../protocol/turn";
import { errorMessage } from "../state/thread-errors";
import {
  cancellationForExecutionRun,
  cancelThreadExecutionRun,
  precreateThreadExecutionRun,
  type QueuedThreadExecutionRun,
} from "./execution";

export interface NotifyOptions {
  readonly deferWhenUnobserved?: boolean;
  readonly executionRun?: QueuedThreadExecutionRun;
  readonly observerEvents?: readonly AgentEvent[];
  readonly overlays?: readonly (AgentInput | UserInput)[];
}

interface QueueThreadNotificationOptions {
  readonly activeRun: BufferedAgentTurn | undefined;
  readonly activeRuntimeInput: RuntimeInputState | undefined;
  readonly attachmentStore: HostAttachmentStore | undefined;
  readonly drain: () => Promise<void>;
  emitObserverEvent(
    run: BufferedAgentTurn | undefined,
    event: AgentEvent
  ): Promise<void>;
  readonly executionHost: AgentHost | undefined;
  readonly inputQueue: QueuedInput[];
  readonly pendingRuntimeInputs: QueuedRuntimeInput[];
  readonly threadKey: string;
  throwIfTerminal(): void;
}

export async function queueThreadNotification(
  input: AgentInput | UserInput,
  options: NotifyOptions,
  state: QueueThreadNotificationOptions
): Promise<AgentTurn> {
  const attachmentStore = state.attachmentStore;
  const queuedRuntimeInput: QueuedRuntimeInput = {
    input: await stageUserInputAttachments(
      attachInputMeta(normalizeInternalAgentInput(input), {
        source: "notify",
      }),
      attachmentStore,
      { trustRuntimeAttachmentRefs: true }
    ),
    placement: "turn-start",
  };
  const queuedOverlays = await createNotificationOverlays(
    options.overlays ?? [],
    attachmentStore
  );
  const observerEvents = await stageAgentEventsAttachments(
    options.observerEvents ?? [],
    attachmentStore,
    { trustRuntimeAttachmentRefs: true }
  );
  const needsDedicatedRun = options.executionRun !== undefined;
  const queuedTurn = state.inputQueue[0];
  if (queuedTurn && !needsDedicatedRun) {
    queuedTurn.initialEvents.push(...observerEvents);
    queuedTurn.preUserRuntimeInputs.push(...queuedOverlays, queuedRuntimeInput);
    return queuedTurn.run;
  }

  const activeRun = state.activeRun;
  const runtimeInput = state.activeRuntimeInput;
  if (
    runtimeInput &&
    activeRun &&
    !runtimeInput.closedReason &&
    !needsDedicatedRun
  ) {
    for (const event of observerEvents) {
      await state.emitObserverEvent(activeRun, event);
    }
    for (const overlay of queuedOverlays) {
      queueRuntimeInput(runtimeInput, { ...overlay, placement: "step-end" });
    }
    queueRuntimeInput(runtimeInput, {
      input: structuredClone(queuedRuntimeInput.input),
      placement: "step-end",
    });
    return activeRun;
  }

  if (options.deferWhenUnobserved === true && !needsDedicatedRun) {
    state.pendingRuntimeInputs.push(...queuedOverlays);
    state.pendingRuntimeInputs.push(queuedRuntimeInput);
    const deferredRun = new BufferedAgentTurn();
    deferredRun.close();
    return deferredRun;
  }

  const run = new BufferedAgentTurn();
  const precreatedRun =
    options.executionRun ??
    (await precreateThreadExecutionRun({
      executionHost: state.executionHost,
      kind: "notification",
      threadKey: state.threadKey,
    }));
  const queuedExecutionRun: QueuedThreadExecutionRun | undefined = precreatedRun
    ? {
        kind: precreatedRun.kind,
        leaseId: options.executionRun?.leaseId ?? null,
        runId: precreatedRun.runId,
      }
    : undefined;
  if (queuedExecutionRun) {
    run.bindRunId(queuedExecutionRun.runId, queuedExecutionRun.leaseId ?? null);
  }
  try {
    state.throwIfTerminal();
  } catch (error) {
    await cancelThreadExecutionRun({
      cancellation: cancellationForExecutionRun(queuedExecutionRun),
      executionHost: state.executionHost,
    });
    run.emit({ type: "turn-error", message: errorMessage(error) });
    run.close();
    throw error;
  }
  state.inputQueue.push({
    ...(queuedExecutionRun ? { executionRun: queuedExecutionRun } : {}),
    initialEvents: observerEvents,
    preUserRuntimeInputs: queuedOverlays,
    run,
    runtimeInput: createRuntimeInputState([queuedRuntimeInput]),
  });
  startThreadQueueDrain(run, state.drain);
  return run;
}

export function startThreadQueueDrain(
  run: BufferedAgentTurn,
  drain: () => Promise<void>
): void {
  drain().catch((error: unknown) => {
    run.emit({ type: "turn-error", message: errorMessage(error) });
    run.close();
  });
}

async function createNotificationOverlays(
  overlays: readonly (AgentInput | UserInput)[],
  attachmentStore: HostAttachmentStore | undefined
): Promise<QueuedRuntimeInput[]> {
  const queued: QueuedRuntimeInput[] = [];
  for (const input of overlays) {
    queued.push({
      canonical: false,
      input: await stageUserInputAttachments(
        attachInputMeta(normalizeInternalAgentInput(input), {
          source: "overlay",
        }),
        attachmentStore,
        { trustRuntimeAttachmentRefs: true }
      ),
      placement: "turn-start" as const,
    });
  }
  return queued;
}
