import type { AgentHost } from "../../execution/host/types";
import type { HostAttachmentStore } from "../input/attachments";
import {
  type RuntimeInputPlacement,
  type RuntimeInputState,
  shiftRuntimeInput,
} from "../input/runtime-input";
import { emitRuntimeInputEvent } from "../input/runtime-input-emit";
import type { AgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadState } from "../state/thread-state";
import {
  ackDurableThreadInput,
  commitAndAckDurableThreadInput,
} from "./durable-input-acknowledgement";
import {
  claimDurableThreadInput,
  releaseDurableThreadInputClaim,
} from "./durable-input-claims";
import type { ThreadExecutionRun } from "./execution";
import type { ThreadEventDispatcher } from "./thread-event-dispatcher";
import {
  commitThreadStateAndEvents,
  type DurableThreadEventBuffer,
} from "./thread-event-log";

export async function drainRuntimeInput({
  durableEvents,
  events,
  executionHost,
  executionRun,
  placement,
  run,
  runtimeInput,
  state,
  threadKey,
  attachmentStore,
  recordEvent,
}: {
  readonly attachmentStore: HostAttachmentStore | undefined;
  readonly durableEvents: DurableThreadEventBuffer;
  readonly events: ThreadEventDispatcher;
  readonly executionHost?: AgentHost;
  readonly executionRun?: ThreadExecutionRun;
  readonly placement: RuntimeInputPlacement;
  readonly recordEvent?: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<boolean> {
  let added = false;
  let next = shiftRuntimeInput(runtimeInput, placement);
  while (next) {
    if (
      await emitRuntimeInputEvent(events, run, state, next, {
        attachmentStore,
        commit: () =>
          commitThreadStateAndEvents({
            buffer: durableEvents,
            executionHost,
            executionRun,
            state,
            threadKey,
          }),
        recordEvent,
      })
    ) {
      added = true;
    }
    next = shiftRuntimeInput(runtimeInput, placement);
  }

  return (
    (await drainDurableRuntimeInput({
      events,
      executionHost,
      executionRun,
      durableEvents,
      attachmentStore,
      placement,
      recordEvent,
      run,
      state,
      threadKey,
    })) || added
  );
}

async function drainDurableRuntimeInput({
  durableEvents,
  events,
  executionHost,
  executionRun,
  attachmentStore,
  placement,
  run,
  state,
  threadKey,
  recordEvent,
}: {
  readonly durableEvents: DurableThreadEventBuffer;
  readonly events: ThreadEventDispatcher;
  readonly executionHost?: AgentHost;
  readonly executionRun?: ThreadExecutionRun;
  readonly attachmentStore: HostAttachmentStore | undefined;
  readonly placement: RuntimeInputPlacement;
  readonly recordEvent?: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<boolean> {
  let added = false;
  for (;;) {
    const claimed = await claimDurableThreadInput({
      boundary: placement,
      executionHost,
      threadKey,
    });
    if (claimed.kind === "unavailable" || !claimed.record) {
      return added;
    }

    const record = claimed.record;
    try {
      const inputAdded = await emitRuntimeInputEvent(
        events,
        run,
        state,
        {
          input: record.input,
          placement,
        },
        {
          attachmentStore,
          commit: () =>
            commitAndAckDurableThreadInput({
              buffer: durableEvents,
              executionHost,
              executionRun,
              record,
              state,
              threadKey,
            }),
          onHandled: () =>
            ackDurableThreadInput({
              executionHost,
              record,
            }),
          recordEvent,
        }
      );
      added = inputAdded || added;
    } catch (error) {
      await releaseDurableThreadInputClaim({
        executionHost,
        record,
      });
      throw error;
    }
  }
}
