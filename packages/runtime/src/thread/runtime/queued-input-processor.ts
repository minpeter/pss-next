import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { runAgentLoop } from "../../agent/loop/run";
import { stageUserInputAttachments } from "../input/attachments";
import {
  closeRuntimeInput,
  withRuntimeInputWindow,
} from "../input/runtime-input";
import {
  commitPreUserRuntimeInputs,
  emitCommittedRuntimeInputs,
} from "../input/runtime-input-emit";
import type { AgentEvent } from "../protocol/events";
import { scheduleThreadAutoCompaction } from "./auto-compaction-runner";
import { drainRuntimeInput } from "./drain";
import { commitAndAckDurableThreadInput } from "./durable-input-acknowledgement";
import { releaseDurableThreadInputClaim } from "./durable-input-claims";
import { startThreadExecutionRun, type ThreadExecutionRun } from "./execution";
import { runAgentLoopWithOverflowCompaction } from "./loop-overflow";
import {
  commitThreadStateAndEvents,
  type DurableThreadEventBuffer,
  recordDurableThreadEvent,
} from "./thread-event-log";
import { recoverTurnProcessingError } from "./turn-error";
import { emitTurnEvent } from "./turn-events";
import { createTurnModelTransforms } from "./turn-model-transforms";
import type { ProcessQueuedInputOptions } from "./turn-processor-options";
import { closeTurnWithDurableTerminalEvent } from "./turn-terminal";

export async function processQueuedInput({
  activate,
  deactivateRun,
  events,
  execution,
  item,
  model,
  release,
  threadKey,
  state,
}: ProcessQueuedInputOptions): Promise<void> {
  const activeAbort = new AbortController();
  const {
    durableInputClaim,
    executionRun: queuedExecutionRun,
    awaitBoundaries = true,
    initialEvents,
    input: queuedInput,
    preUserRuntimeInputs,
    run,
    runtimeInput,
  } = item;
  const input = durableInputClaim?.input ?? queuedInput;
  const turnId = crypto.randomUUID();
  activate({
    abort: activeAbort,
    run,
    runtimeInput,
    turnId,
  });
  const historySnapshot = state.modelSnapshot();
  let executionRun: ThreadExecutionRun | undefined;
  let pendingDurableInputClaim = durableInputClaim;
  const durableEvents: DurableThreadEventBuffer = [];
  const recordEvent = (event: AgentEvent) =>
    recordDurableThreadEvent(durableEvents, event);
  const { transformModelContext, transformModelStep } =
    createTurnModelTransforms({
      hookRuntime: execution.hookRuntime ?? new AgentHookRuntime(),
      state,
      threadKey,
    });
  const agentLoopRuntimeState = { runtimeStepIndex: 0 };

  try {
    executionRun = await startThreadExecutionRun({
      executionRun: queuedExecutionRun,
      executionHost: execution.executionHost,
      interceptToolCall: (checkpoint) =>
        events.interceptBeforeToolCall(checkpoint),
      interceptToolResult: (checkpoint) =>
        events.interceptAfterToolCall(checkpoint),
      threadKey,
      state,
      turnId,
    });
    for (const event of initialEvents) {
      const processed = await events.emitRunEvent(run, event);
      if (processed !== "handled") {
        recordEvent(processed);
      }
    }
    const committedPreUser = await commitPreUserRuntimeInputs(
      events,
      state,
      preUserRuntimeInputs,
      model.attachmentStore,
      {
        commitRecordedEvents: () =>
          commitThreadStateAndEvents({
            buffer: durableEvents,
            executionHost: execution.executionHost,
            state,
            threadKey,
          }),
        recordEvent,
      }
    );
    if (input) {
      state.appendUserInput(
        await stageUserInputAttachments(input, model.attachmentStore, {
          trustRuntimeAttachmentRefs: true,
        })
      );
      if (pendingDurableInputClaim) {
        recordEvent(item.acceptedEvent ?? input);
        await commitAndAckDurableThreadInput({
          buffer: durableEvents,
          executionHost: execution.executionHost,
          record: pendingDurableInputClaim,
          state,
          threadKey,
        });
        pendingDurableInputClaim = undefined;
      } else {
        recordEvent(item.acceptedEvent ?? input);
        await commitThreadStateAndEvents({
          buffer: durableEvents,
          executionHost: execution.executionHost,
          state,
          threadKey,
        });
      }
    }
    await withRuntimeInputWindow(runtimeInput, "turn-start", async () => {
      await events.emitRunBoundaryEvent(
        run,
        { type: "turn-start" },
        { awaitAck: awaitBoundaries }
      );
    });
    recordEvent({ type: "turn-start" });
    await emitCommittedRuntimeInputs(events, run, committedPreUser);
    await drainRuntimeInput({
      attachmentStore: model.attachmentStore,
      durableEvents,
      events,
      executionHost: execution.executionHost,
      placement: "turn-start",
      recordEvent,
      run,
      runtimeInput,
      state,
      threadKey,
    });

    const result = await runAgentLoopWithOverflowCompaction({
      compact: (input) => events.compact(state, input),
      execution,
      model,
      runLoop: () =>
        runAgentLoop({
          emit: async (event) =>
            emitTurnEvent({
              attachmentStore: model.attachmentStore,
              durableEvents,
              event,
              events,
              executionHost: execution.executionHost,
              awaitBoundaries,
              recordEvent,
              run,
              runtimeInput,
              state,
              threadKey,
            }),
          history: state.history,
          model,
          runtimeState: agentLoopRuntimeState,
          captureObserverEvents: (callback) =>
            events.captureObserverEvents(run, callback),
          signal: activeAbort.signal,
          threadKey,
          toolExecution: executionRun?.toolExecution,
          transformModelContext,
          transformModelStep,
        }),
      state,
      transformModelContext,
    });

    state.clearTransientInputs();
    await closeTurnWithDurableTerminalEvent({
      buffer: durableEvents,
      completeExecution: async (status) => await executionRun?.complete(status),
      deactivateRun,
      events,
      executionHost: execution.executionHost,
      recordEvent,
      result,
      run,
      runtimeInput,
      state,
      threadKey,
    });
    if (result === "completed" && input) {
      scheduleThreadAutoCompaction({
        compact: (compactionInput) => events.compact(state, compactionInput),
        model,
        policy: execution.autoCompaction,
        state,
        transformModelContext,
      });
    }
  } catch (error) {
    if (pendingDurableInputClaim) {
      await releaseDurableThreadInputClaim({
        executionHost: execution.executionHost,
        record: pendingDurableInputClaim,
      });
      pendingDurableInputClaim = undefined;
    }
    await recoverTurnProcessingError({
      durableEvents,
      error,
      executionHost: execution.executionHost,
      executionRun,
      historySnapshot,
      recordEvent,
      run,
      runtimeInput,
      state,
      threadKey,
    });
  } finally {
    if (pendingDurableInputClaim) {
      await releaseDurableThreadInputClaim({
        executionHost: execution.executionHost,
        record: pendingDurableInputClaim,
      });
    }
    closeRuntimeInput(runtimeInput);
    release();
    run.close();
  }
}
