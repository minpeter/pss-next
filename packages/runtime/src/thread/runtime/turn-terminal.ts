import type { AgentHost } from "../../execution/host/types";
import {
  closeRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadState } from "../state/thread-state";
import type { ThreadExecutionRun } from "./execution";
import type { ThreadEventDispatcher } from "./thread-event-dispatcher";
import {
  commitTerminalThreadStateAndEvents,
  type DurableThreadEventBuffer,
} from "./thread-event-log";

export async function closeTurnWithDurableTerminalEvent({
  buffer,
  executionRun,
  deactivateRun,
  events,
  executionHost,
  recordEvent,
  result,
  run,
  runtimeInput,
  state,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly deactivateRun: () => void;
  readonly executionRun?: ThreadExecutionRun;
  readonly events: ThreadEventDispatcher;
  readonly executionHost?: AgentHost;
  readonly recordEvent: (event: AgentEvent) => void;
  readonly result: "aborted" | "completed";
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const terminalEvent = terminalEventForResult(result);
  closeRuntimeInput(runtimeInput, terminalEvent.type);
  deactivateRun();
  recordEvent(terminalEvent);
  await commitTerminalThreadStateAndEvents({
    buffer,
    executionHost,
    executionRun,
    state,
    status: result === "aborted" ? "cancelled" : "completed",
    threadKey,
  });
  events.emitProcessedEvent(run, terminalEvent);
}

function terminalEventForResult(result: "aborted" | "completed"): AgentEvent {
  return { type: result === "aborted" ? "turn-abort" : "turn-end" };
}
