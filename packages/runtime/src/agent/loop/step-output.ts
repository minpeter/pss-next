import { generateModelStepResult } from "../../llm/model-step";
import type {
  ModelStepOutput,
  ModelStepResult,
} from "../../llm/model-step-types";
import type { RuntimeToolExecutionContext } from "../../llm/tool-execution-types";
import type {
  AgentEvent,
  StreamAgentEvent,
} from "../../thread/protocol/events";
import { modelMessageToAgentEvents } from "../../thread/protocol/mapping";
import type {
  CapturedModelStepOutput,
  ModelHistory,
  RunAgentLoopOptions,
  StepOutputResult,
} from "./types";

export async function readModelOutput({
  history,
  model,
  onStreamEvent,
  runtimeStepIndex,
  signal,
  threadKey,
  toolExecution,
  transformModelContext,
}: Pick<
  RunAgentLoopOptions,
  "history" | "model" | "threadKey" | "transformModelContext"
> & {
  onStreamEvent?: (event: StreamAgentEvent) => void;
  runtimeStepIndex: number;
  signal: AbortSignal;
  toolExecution?: RuntimeToolExecutionContext;
}): Promise<ModelStepResult | "aborted"> {
  try {
    const snapshot = history.modelContextSnapshot();
    return await generateModelStepResult({
      history: transformModelContext
        ? await transformModelContext(snapshot, signal)
        : snapshot,
      ...model,
      onStreamEvent,
      runtimeStepIndex,
      signal,
      threadKey,
      toolExecution,
    });
  } catch (error) {
    if (signal.aborted) {
      return "aborted";
    }

    throw error;
  }
}

export async function appendCapturedStepOutput({
  capturedOutput,
  emit,
  history,
  output,
  signal,
  transformModelStep,
}: Pick<RunAgentLoopOptions, "emit" | "transformModelStep"> & {
  history: ModelHistory;
} & {
  capturedOutput: CapturedModelStepOutput;
  output: ModelStepResult;
  signal: AbortSignal;
}): Promise<StepOutputResult> {
  try {
    await emit(output.usage);
    const transformedOutput = transformModelStep
      ? await transformModelStep(output.messages, signal)
      : output.messages;
    return await appendStepOutput({
      emit,
      history,
      observerEvents: capturedOutput.events,
      output: transformedOutput,
      signal,
    });
  } finally {
    capturedOutput.release();
  }
}

async function appendStepOutput({
  emit,
  history,
  observerEvents,
  output,
  signal,
}: Pick<RunAgentLoopOptions, "emit"> & { history: ModelHistory } & {
  observerEvents: AgentEvent[];
  output: ModelStepOutput;
  signal: AbortSignal;
}): Promise<StepOutputResult> {
  if (signal.aborted) {
    return "aborted";
  }

  let shouldContinue = false;
  const pendingObserverEvents = observerEvents;
  const flushObserverEvents = async () => {
    for (let index = 0; index < pendingObserverEvents.length; ) {
      const event = pendingObserverEvents[index];
      if (event) {
        pendingObserverEvents.splice(index, 1);
        await emit(event);
      } else {
        index += 1;
      }
    }
  };

  for (const message of output) {
    if (signal.aborted) {
      return "aborted";
    }

    history.appendModelMessage(message);
    const events = modelMessageToAgentEvents(message);
    const hasToolResult = events.some((event) => event.type === "tool-result");

    for (const event of events) {
      await emit(event);
      if (event.type === "tool-call") {
        shouldContinue = true;
        await flushObserverEvents();
      }
    }

    if (hasToolResult) {
      await flushObserverEvents();
    }
  }

  await flushObserverEvents();

  return shouldContinue ? "continue" : "completed";
}
