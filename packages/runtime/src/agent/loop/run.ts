import type { AgentEvent } from "../../thread/protocol/events";
import { appendCapturedStepOutput, readModelOutput } from "./step-output";
import type {
  AgentLoopBoundaryDecision,
  AgentLoopResult,
  ObserverEventCaptureResult,
  RunAgentLoopOptions,
} from "./types";

type AgentLoopBoundaryEvent = Extract<
  AgentEvent,
  { type: "step-end" } | { type: "step-start" }
>;

export async function runAgentLoop({
  captureObserverEvents = captureNoObserverEvents,
  emit,
  history,
  model,
  runtimeState = { runtimeStepIndex: 0 },
  signal = new AbortController().signal,
  threadKey,
  toolExecution,
  transformModelContext,
  transformModelStep,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  while (true) {
    if (signal.aborted) {
      return "aborted";
    }

    const stepStartDecision = await emitBoundary({
      emit,
      event: { type: "step-start" },
      signal,
    });

    if (stepStartDecision === "aborted") {
      return "aborted";
    }

    const capturedOutput = await captureObserverEvents(() =>
      readModelOutput({
        history,
        model,
        onStreamEvent: (event) => {
          Promise.resolve(emit(event)).catch(() => undefined);
        },
        runtimeStepIndex: runtimeState.runtimeStepIndex,
        signal,
        threadKey,
        toolExecution,
        transformModelContext,
      })
    );
    const output = capturedOutput.value;

    if (output === "aborted") {
      capturedOutput.release();
      return "aborted";
    }

    const result = await appendCapturedStepOutput({
      capturedOutput,
      emit,
      history,
      output,
      signal,
      transformModelStep,
    });

    if (result === "aborted") {
      return "aborted";
    }

    const stepEndDecision = await emitBoundary({
      emit,
      event: { type: "step-end" },
      signal,
    });

    if (stepEndDecision === "aborted") {
      return "aborted";
    }
    runtimeState.runtimeStepIndex += 1;

    // Runtime input after step-end intentionally forces another inference step,
    // even after final-looking assistant text. Unconditional insertion on every
    // step-end can create an unbounded loop.
    if (result === "completed" && !stepEndDecision?.runtimeInputAdded) {
      return "completed";
    }
  }
}

async function emitBoundary({
  emit,
  event,
  signal,
}: Pick<RunAgentLoopOptions, "emit"> & {
  event: AgentLoopBoundaryEvent;
  signal: AbortSignal;
}): Promise<AgentLoopBoundaryDecision | "aborted" | undefined> {
  if (signal.aborted) {
    return "aborted";
  }

  const abort = createAbortBoundary(signal);
  try {
    return await Promise.race([Promise.resolve(emit(event)), abort.promise]);
  } catch (error) {
    if (signal.aborted) {
      return "aborted";
    }

    throw error;
  } finally {
    abort.dispose();
  }
}

function createAbortBoundary(signal: AbortSignal): {
  dispose: () => void;
  promise: Promise<"aborted">;
} {
  let dispose: () => void = () => undefined;

  const promise = new Promise<"aborted">((resolve) => {
    const onAbort = () => resolve("aborted");
    dispose = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  return { dispose, promise };
}

async function captureNoObserverEvents<T>(
  callback: () => Promise<T>
): Promise<ObserverEventCaptureResult<T>> {
  return {
    events: [],
    release: releaseNoObserverEvents,
    value: await callback(),
  };
}

function releaseNoObserverEvents(): void {
  return;
}
