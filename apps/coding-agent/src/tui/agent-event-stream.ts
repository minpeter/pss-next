import type { AgentEvent, ModelUsage } from "@minpeter/pss-runtime";
import { createTuiErrorPresentation } from "./error-presentation";
import type { TuiStreamPart } from "./stream-handlers";

/**
 * Options accepted by the agent-event to stream-part adapter.
 */
export interface AgentEventStreamOptions {
  /** Receives every normalized model-usage event for footer/telemetry. */
  onModelUsage?: (usage: ModelUsage) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * AI SDK tool outputs use `{ type: "error-text" | "error-json", value }` for
 * failed executions. Those are rendered through the error path so they show
 * up with the error block styling instead of as normal output.
 */
const isErrorToolOutput = (
  output: unknown
): output is { type: "error-json" | "error-text"; value: unknown } =>
  isRecord(output) &&
  (output.type === "error-text" || output.type === "error-json");

const isExecutionDeniedToolOutput = (
  output: unknown
): output is { type: "execution-denied"; reason?: string } =>
  isRecord(output) && output.type === "execution-denied";

/**
 * ai v7 wraps tool results in typed output envelopes
 * (`{ type: "text" | "json", value }`). The TUI renderers — like the
 * plugsuits ones they are ported from — expect the semantic raw value, so
 * unwrap the envelope here at the event boundary.
 */
const unwrapToolOutput = (output: unknown): unknown => {
  if (
    isRecord(output) &&
    (output.type === "text" || output.type === "json") &&
    "value" in output
  ) {
    return output.value;
  }
  return output;
};

type AssistantContentKind = "reasoning" | "text";

function* assistantDeltaParts(
  kind: AssistantContentKind,
  text: string,
  sawDelta: boolean
): Generator<TuiStreamPart> {
  if (!sawDelta) {
    yield { type: `${kind}-start` };
  }
  yield { type: `${kind}-delta`, text };
}

function* committedAssistantContentParts(
  kind: AssistantContentKind,
  text: string,
  sawDelta: boolean
): Generator<TuiStreamPart> {
  if (!sawDelta) {
    yield* assistantDeltaParts(kind, text, false);
  }
  yield { type: `${kind}-end` };
}

/**
 * Translates a pss-runtime `AgentEvent` stream into the finer-grained stream
 * parts the TUI dispatch table renders. Live text, reasoning, and tool-input
 * deltas are forwarded incrementally. The committed per-step events provide
 * closing boundaries and remain the fallback for providers without deltas.
 */
export async function* agentEventStreamParts(
  events: AsyncIterable<AgentEvent>,
  options: AgentEventStreamOptions = {}
): AsyncGenerator<TuiStreamPart> {
  let lastFinishReason: string | undefined;
  let sawReasoningDelta = false;
  let sawTextDelta = false;

  for await (const event of events) {
    switch (event.type) {
      case "turn-start":
        yield { type: "start" };
        break;
      case "step-start":
        sawReasoningDelta = false;
        sawTextDelta = false;
        yield { type: "start-step" };
        break;
      case "assistant-reasoning-delta":
        yield* assistantDeltaParts("reasoning", event.text, sawReasoningDelta);
        sawReasoningDelta = true;
        break;
      case "assistant-reasoning":
        yield* committedAssistantContentParts(
          "reasoning",
          event.text,
          sawReasoningDelta
        );
        break;
      case "assistant-output-delta":
        yield* assistantDeltaParts("text", event.text, sawTextDelta);
        sawTextDelta = true;
        break;
      case "assistant-output":
        yield* committedAssistantContentParts("text", event.text, sawTextDelta);
        break;
      case "tool-call-input-start":
        yield {
          type: "tool-input-start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        };
        break;
      case "tool-call-input-delta":
        yield {
          type: "tool-input-delta",
          inputTextDelta: event.inputTextDelta,
          toolCallId: event.toolCallId,
        };
        break;
      case "tool-call-input-end":
        yield {
          type: "tool-input-end",
          toolCallId: event.toolCallId,
        };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          input: event.input,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        };
        break;
      case "tool-result":
        if (isErrorToolOutput(event.output)) {
          yield {
            type: "tool-error",
            error: event.output.value,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          };
        } else if (isExecutionDeniedToolOutput(event.output)) {
          yield {
            ...(event.output.reason === undefined
              ? {}
              : { reason: event.output.reason }),
            type: "tool-output-denied",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          };
        } else {
          yield {
            type: "tool-result",
            output: unwrapToolOutput(event.output),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          };
        }
        break;
      case "model-usage":
        lastFinishReason = event.finishReason;
        options.onModelUsage?.(event);
        break;
      case "step-end":
        yield { type: "finish-step", finishReason: lastFinishReason };
        break;
      case "turn-end":
        yield { type: "finish", finishReason: lastFinishReason ?? "stop" };
        break;
      case "turn-abort":
        yield { type: "abort", reason: "interrupted" };
        break;
      case "turn-error":
        yield {
          type: "error",
          error: createTuiErrorPresentation(event.message, event.error),
        };
        break;
      default:
        // user-input / runtime-input echoes are rendered by the TUI itself.
        break;
    }
  }
}
