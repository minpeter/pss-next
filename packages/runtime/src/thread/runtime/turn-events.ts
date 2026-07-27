import type { AgentHost } from "../../execution/host/types";
import type { HostAttachmentStore } from "../input/attachments";
import {
  type RuntimeInputState,
  withRuntimeInputWindow,
} from "../input/runtime-input";
import { type AgentEvent, isStreamAgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadState } from "../state/thread-state";
import { drainRuntimeInput } from "./drain";
import type { ThreadEventDispatcher } from "./thread-event-dispatcher";
import {
  type DurableThreadEventBuffer,
  flushDurableThreadEvents,
} from "./thread-event-log";

export async function emitTurnEvent({
  durableEvents,
  event,
  events,
  executionHost,
  attachmentStore,
  awaitBoundaries,
  run,
  runtimeInput,
  recordEvent,
  state,
  threadKey,
}: {
  readonly durableEvents: DurableThreadEventBuffer;
  readonly event: AgentEvent;
  readonly attachmentStore: HostAttachmentStore | undefined;
  readonly awaitBoundaries: boolean;
  readonly events: ThreadEventDispatcher;
  readonly executionHost: AgentHost | undefined;
  readonly recordEvent?: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<{ readonly runtimeInputAdded: boolean } | undefined> {
  if (event.type === "model-usage") {
    await events.emitModelUsageEvent(run, event, async (usage) => {
      recordEvent?.(usage);
      await flushDurableThreadEvents({
        buffer: durableEvents,
        executionHost,
        threadKey,
      });
    });
    return;
  }

  if (isStreamAgentEvent(event)) {
    events.emitStreamEvent(run, event);
    return;
  }

  if (event.type !== "step-start" && event.type !== "step-end") {
    const processed = await events.emitRunEvent(run, event);
    if (processed !== "handled") {
      recordEvent?.(processed);
    }
    return;
  }

  await withRuntimeInputWindow(runtimeInput, event.type, async () => {
    await events.emitRunBoundaryEvent(run, event, {
      awaitAck: awaitBoundaries,
    });
  });
  recordEvent?.(event);
  const runtimeInputAdded = await drainRuntimeInput({
    attachmentStore,
    durableEvents,
    events,
    executionHost,
    placement: event.type,
    recordEvent,
    run,
    runtimeInput,
    state,
    threadKey,
  });
  return event.type === "step-end" ? { runtimeInputAdded } : undefined;
}
