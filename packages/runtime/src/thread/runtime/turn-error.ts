import type { ModelMessage } from "ai";
import type { AgentHost } from "../../execution/host/types";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import {
  closeRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import { errorMessage } from "../state/thread-errors";
import {
  ThreadCommitConflictError,
  type ThreadState,
} from "../state/thread-state";
import type {
  ThreadExecutionRun,
  ThreadExecutionTerminalStatus,
} from "./execution";
import {
  commitThreadStateAndEvents,
  type DurableThreadEventBuffer,
} from "./thread-event-log";
import { normalizeTurnError } from "./turn-error-metadata";

type TurnErrorEvent = Extract<AgentEvent, { type: "turn-error" }>;

export async function emitTurnErrorAfterRecovery({
  error,
  historySnapshot,
  persistEvent,
  observeEvent,
  run,
  runtimeInput,
  state,
}: {
  readonly error: unknown;
  readonly historySnapshot: ModelMessage[];
  readonly observeEvent?: (event: AgentEvent) => Promise<void>;
  readonly persistEvent?: (event: AgentEvent) => Promise<void>;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
}): Promise<void> {
  if (error instanceof ThreadCommitConflictError) {
    let event: TurnErrorEvent = { type: "turn-error", message: error.message };
    event = await observeTurnError(event, observeEvent);
    try {
      await persistEvent?.(event);
    } finally {
      run.emit(event);
    }
    closeRuntimeInput(runtimeInput, "a thread commit conflict");
    return;
  }

  state.rollback(historySnapshot);
  const normalizedError = normalizeTurnError(error);
  let event: TurnErrorEvent = {
    ...(normalizedError.error === undefined
      ? {}
      : { error: normalizedError.error }),
    type: "turn-error",
    message: normalizedError.message ?? errorMessage(error),
  };
  event = await observeTurnError(event, observeEvent);
  try {
    if (persistEvent) {
      await persistEvent(event);
    } else {
      await state.commit();
    }
  } catch {
    run.emit({
      ...(event.error === undefined ? {} : { error: event.error }),
      type: "turn-error",
      message: `${event.message} History rollback persistence failed.`,
    });
    closeRuntimeInput(runtimeInput, "turn-error");
    return;
  }

  run.emit(event);
  closeRuntimeInput(runtimeInput, "turn-error");
}

export async function recoverTurnProcessingError({
  durableEvents,
  error,
  executionHost,
  executionRun,
  historySnapshot,
  recordEvent,
  run,
  runtimeInput,
  state,
  threadKey,
}: {
  readonly durableEvents: DurableThreadEventBuffer;
  readonly error: unknown;
  readonly executionHost?: AgentHost;
  readonly executionRun?: ThreadExecutionRun;
  readonly historySnapshot: ModelMessage[];
  readonly recordEvent: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const turnError = error instanceof Error ? error : new Error(String(error));
  await executionRun?.complete(executionStatusForError(turnError));
  await emitTurnErrorAfterRecovery({
    error: turnError,
    historySnapshot,
    observeEvent: undefined,
    persistEvent: async (event) => {
      recordEvent(event);
      await commitThreadStateAndEvents({
        buffer: durableEvents,
        executionHost,
        state,
        threadKey,
      });
    },
    run,
    runtimeInput,
    state,
  });
}

async function observeTurnError(
  event: TurnErrorEvent,
  observeEvent: ((event: AgentEvent) => Promise<void>) | undefined
): Promise<TurnErrorEvent> {
  if (!observeEvent) {
    return event;
  }
  try {
    await observeEvent(event);
    return event;
  } catch (hookError) {
    return {
      message: `${"message" in event ? event.message : "Turn failed"}; turn.error plugin failed: ${errorMessage(hookError)}`,
      type: "turn-error",
    };
  }
}

function executionStatusForError(error: Error): ThreadExecutionTerminalStatus {
  return error instanceof ToolExecutionNeedsRecoveryError
    ? "needs-recovery"
    : "error";
}
