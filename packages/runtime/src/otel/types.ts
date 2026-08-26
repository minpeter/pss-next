import {
  type Attributes,
  type SpanOptions,
  type SpanStatus,
  trace,
} from "@opentelemetry/api";
import type { AgentEvent } from "../thread/protocol/events";

export const DEFAULT_EVENT_NAME = "pss.runtime.event";
export const DEFAULT_STEP_SPAN_NAME = "pss.runtime.step";
export const DEFAULT_TOOL_SPAN_NAME = "pss.runtime.tool";
export const DEFAULT_TURN_SPAN_NAME = "pss.runtime.turn";
export const RUNTIME_COMPONENT = "@minpeter/pss-runtime";

export type TraceAgentTurnEventAttributes = Attributes;

export interface TraceAgentTurnSpan {
  addEvent(
    name: string,
    attributes?: TraceAgentTurnEventAttributes
  ): TraceAgentTurnSpan;
  end(): void;
  recordException(exception: Error): void;
  setStatus(status: SpanStatus): TraceAgentTurnSpan;
}

export interface TraceAgentTurnTracer {
  startSpan(name: string, options?: SpanOptions): TraceAgentTurnSpan;
}

export interface TraceAgentTurnOptions {
  readonly eventAttributes?: (
    event: AgentEvent
  ) => TraceAgentTurnEventAttributes | undefined;
  readonly eventName?: string;
  readonly spanAttributes?: TraceAgentTurnEventAttributes;
  readonly stepSpanName?: string;
  readonly toolSpanName?: string;
  readonly tracer?: TraceAgentTurnTracer;
  readonly tracerName?: string;
  readonly tracerVersion?: string;
  readonly turnSpanName?: string;
}

export interface ResolvedTraceAgentTurnOptions {
  readonly eventAttributes?: (
    event: AgentEvent
  ) => TraceAgentTurnEventAttributes | undefined;
  readonly eventName: string;
  readonly spanAttributes: TraceAgentTurnEventAttributes;
  readonly stepSpanName: string;
  readonly toolSpanName: string;
  readonly tracer: TraceAgentTurnTracer;
  readonly turnSpanName: string;
}

export interface TraceAgentTurnState {
  readonly options: ResolvedTraceAgentTurnOptions;
  stepSpan: TraceAgentTurnSpan | undefined;
  readonly toolSpans: Map<string, TraceAgentTurnSpan>;
  turnSpan: TraceAgentTurnSpan | undefined;
}

export interface CloseTraceStateOptions {
  readonly childStatus?: SpanStatus;
  readonly exception?: Error;
  readonly turnStatus?: SpanStatus;
}

export function createTraceState(
  options: TraceAgentTurnOptions
): TraceAgentTurnState {
  return {
    options: resolveOptions(options),
    stepSpan: undefined,
    toolSpans: new Map(),
    turnSpan: undefined,
  };
}

function resolveOptions(
  options: TraceAgentTurnOptions
): ResolvedTraceAgentTurnOptions {
  return {
    ...(options.eventAttributes === undefined
      ? {}
      : { eventAttributes: options.eventAttributes }),
    eventName: options.eventName ?? DEFAULT_EVENT_NAME,
    spanAttributes: {
      "pss.runtime.component": RUNTIME_COMPONENT,
      ...options.spanAttributes,
    },
    stepSpanName: options.stepSpanName ?? DEFAULT_STEP_SPAN_NAME,
    toolSpanName: options.toolSpanName ?? DEFAULT_TOOL_SPAN_NAME,
    tracer:
      options.tracer ??
      trace.getTracer(
        options.tracerName ?? RUNTIME_COMPONENT,
        options.tracerVersion
      ),
    turnSpanName: options.turnSpanName ?? DEFAULT_TURN_SPAN_NAME,
  };
}
