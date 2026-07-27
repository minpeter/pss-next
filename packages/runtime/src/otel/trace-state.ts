import { type SpanStatus, SpanStatusCode } from "@opentelemetry/api";
import type {
  AgentEvent,
  ToolCall,
  ToolResult,
} from "../thread/protocol/events";
import {
  cleanAttributes,
  defaultAgentEventAttributes,
  mergeAttributes,
} from "./attributes";
import type {
  CloseTraceStateOptions,
  TraceAgentTurnEventAttributes,
  TraceAgentTurnSpan,
  TraceAgentTurnState,
} from "./types";

export const INCOMPLETE_SPAN_STATUS = {
  code: SpanStatusCode.ERROR,
  message: "span closed before completion",
} satisfies SpanStatus;
export const SOURCE_ERROR_STATUS = {
  code: SpanStatusCode.ERROR,
  message: "source iterator failed",
} satisfies SpanStatus;
export const TURN_ABORT_STATUS = {
  code: SpanStatusCode.ERROR,
  message: "turn aborted",
} satisfies SpanStatus;
export const TURN_ERROR_STATUS = {
  code: SpanStatusCode.ERROR,
  message: "turn error",
} satisfies SpanStatus;
export const TURN_OK_STATUS = { code: SpanStatusCode.OK } satisfies SpanStatus;

export function recordRuntimeTraceEvent(
  state: TraceAgentTurnState,
  event: AgentEvent
): void {
  const attributes = traceEventAttributes(state, event);
  const turnSpan = ensureTurnSpan(state);
  turnSpan.addEvent(state.options.eventName, attributes);

  switch (event.type) {
    case "step-start":
      startStepSpan(state, attributes);
      return;
    case "step-end":
      closeStepSpan(state, TURN_OK_STATUS, attributes);
      return;
    case "tool-call":
      startToolSpan(state, event, attributes);
      return;
    case "tool-result":
      closeToolSpan(state, event, attributes);
      return;
    case "turn-end":
      closeTraceState(state, {
        childStatus: INCOMPLETE_SPAN_STATUS,
        turnStatus: TURN_OK_STATUS,
      });
      return;
    case "turn-abort":
      closeTraceState(state, {
        childStatus: TURN_ABORT_STATUS,
        turnStatus: TURN_ABORT_STATUS,
      });
      return;
    case "turn-error":
      closeTraceState(state, {
        childStatus: TURN_ERROR_STATUS,
        exception: new Error("Agent turn failed"),
        turnStatus: TURN_ERROR_STATUS,
      });
      return;
    case "assistant-output":
    case "assistant-output-delta":
    case "assistant-reasoning":
    case "assistant-reasoning-delta":
    case "model-usage":
    case "runtime-input":
    case "tool-call-input-delta":
    case "tool-call-input-end":
    case "tool-call-input-start":
    case "turn-start":
    case "user-input":
      return;
    default:
      assertNever(event, "Unexpected event variant");
  }
}

export function closeTraceState(
  state: TraceAgentTurnState,
  options: CloseTraceStateOptions = {}
): void {
  closeToolSpans(state, options.childStatus);
  closeStepSpan(state, options.childStatus);
  closeTurnSpan(state, options.turnStatus, options.exception);
}

function startStepSpan(
  state: TraceAgentTurnState,
  eventAttributes: TraceAgentTurnEventAttributes | undefined
): void {
  if (state.stepSpan) {
    closeStepSpan(state, INCOMPLETE_SPAN_STATUS);
  }

  const span = startSpan(state, state.options.stepSpanName, {
    "pss.runtime.span.kind": "step",
  });
  span.addEvent(state.options.eventName, eventAttributes);
  state.stepSpan = span;
}

function closeStepSpan(
  state: TraceAgentTurnState,
  status?: SpanStatus,
  eventAttributes?: TraceAgentTurnEventAttributes
): void {
  const span = state.stepSpan;
  if (!span) {
    return;
  }
  if (eventAttributes) {
    span.addEvent(state.options.eventName, eventAttributes);
  }
  endSpan(span, status);
  state.stepSpan = undefined;
}

function startToolSpan(
  state: TraceAgentTurnState,
  event: ToolCall,
  eventAttributes: TraceAgentTurnEventAttributes | undefined
): void {
  const existing = state.toolSpans.get(event.toolCallId);
  if (existing) {
    endSpan(existing, INCOMPLETE_SPAN_STATUS);
  }

  const span = startSpan(state, state.options.toolSpanName, {
    "pss.runtime.span.kind": "tool",
    "pss.tool.call_id": event.toolCallId,
    "pss.tool.name": event.toolName,
  });
  span.addEvent(state.options.eventName, eventAttributes);
  state.toolSpans.set(event.toolCallId, span);
}

function closeToolSpan(
  state: TraceAgentTurnState,
  event: ToolResult,
  eventAttributes: TraceAgentTurnEventAttributes | undefined
): void {
  const span = state.toolSpans.get(event.toolCallId);
  if (!span) {
    return;
  }

  span.addEvent(state.options.eventName, eventAttributes);
  endSpan(span, TURN_OK_STATUS);
  state.toolSpans.delete(event.toolCallId);
}

function closeToolSpans(
  state: TraceAgentTurnState,
  status: SpanStatus | undefined
): void {
  for (const span of state.toolSpans.values()) {
    endSpan(span, status);
  }
  state.toolSpans.clear();
}

function ensureTurnSpan(state: TraceAgentTurnState): TraceAgentTurnSpan {
  const current = state.turnSpan;
  if (current) {
    return current;
  }

  const span = startSpan(state, state.options.turnSpanName, {
    "pss.runtime.span.kind": "turn",
  });
  state.turnSpan = span;
  return span;
}

function closeTurnSpan(
  state: TraceAgentTurnState,
  status: SpanStatus | undefined,
  exception: Error | undefined
): void {
  const span = state.turnSpan;
  if (!span) {
    return;
  }
  if (exception) {
    span.recordException(exception);
  }
  endSpan(span, status);
  state.turnSpan = undefined;
}

function startSpan(
  state: TraceAgentTurnState,
  name: string,
  attributes: TraceAgentTurnEventAttributes
): TraceAgentTurnSpan {
  return state.options.tracer.startSpan(name, {
    attributes: cleanAttributes({
      ...state.options.spanAttributes,
      ...attributes,
    }),
  });
}

function traceEventAttributes(
  state: TraceAgentTurnState,
  event: AgentEvent
): TraceAgentTurnEventAttributes | undefined {
  return mergeAttributes(
    defaultAgentEventAttributes(event),
    state.options.eventAttributes?.(event)
  );
}

function endSpan(
  span: TraceAgentTurnSpan,
  status: SpanStatus | undefined
): void {
  if (status) {
    span.setStatus(status);
  }
  span.end();
}

import { assertNever } from "../internal/guards";
