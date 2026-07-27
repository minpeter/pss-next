import type { UserInput, UserMessage, UserText } from "../input/input";
import type { InputEventMeta } from "../input/input-meta-types";

export type {
  UserInput,
  UserMessage,
  UserMessageContent,
  UserMessageContentPart,
  UserMessageFileData,
  UserMessageFilePart,
  UserMessageTextPart,
  UserText,
  UserTextContent,
} from "../input/input";
export type { InputEventMeta, InputSource } from "../input/input-meta-types";

export interface RuntimeInput {
  /**
   * Runtime/API-originated model input inserted into the current turn.
   * This is distinct from human-originated user-input.
   */
  input: UserInput;
  meta?: InputEventMeta;
  placement: "turn-start" | "step-start" | "step-end";
  type: "runtime-input";
}

export interface AssistantOutput {
  text: string;
  type: "assistant-output";
}
export interface AssistantReasoning {
  text: string;
  type: "assistant-reasoning";
}

/**
 * Normalized metadata for one successful agent-loop model attempt. Token
 * counts stay optional because not every provider reports every field.
 */
export interface ModelUsage {
  /** Opaque identifier for this runtime model-step invocation. */
  attemptId: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** AI SDK response wait time in milliseconds, excluding client tool execution. */
  durationMs?: number;
  /** Unified finish reason reported by the AI SDK. */
  finishReason?:
    | "content-filter"
    | "error"
    | "length"
    | "other"
    | "stop"
    | "tool-calls";
  inputTokens?: number;
  /** Response model identifier reported by the AI SDK. */
  modelId?: string;
  noCacheTokens?: number;
  outputTokens?: number;
  /** Provider identifier reported by the AI SDK, when available. */
  provider?: string;
  reasoningTokens?: number;
  totalTokens?: number;
  type: "model-usage";
}

export interface ToolCall {
  input: unknown;
  toolCallId: string;
  toolName: string;
  type: "tool-call";
}
export interface ToolResult {
  output: unknown;
  toolCallId: string;
  toolName: string;
  type: "tool-result";
}

export interface AssistantOutputDelta {
  text: string;
  type: "assistant-output-delta";
}
export interface AssistantReasoningDelta {
  text: string;
  type: "assistant-reasoning-delta";
}
export interface ToolCallInputStart {
  toolCallId: string;
  toolName: string;
  type: "tool-call-input-start";
}
export interface ToolCallInputDelta {
  inputTextDelta: string;
  toolCallId: string;
  type: "tool-call-input-delta";
}
export interface ToolCallInputEnd {
  toolCallId: string;
  type: "tool-call-input-end";
}

export type TurnErrorCategory =
  | "authentication"
  | "bad-request"
  | "cancelled"
  | "context-overflow"
  | "network"
  | "permission"
  | "quota"
  | "rate-limit"
  | "stream"
  | "timeout"
  | "unknown"
  | "upstream";

export interface TurnErrorCorrelationId {
  readonly source: string;
  readonly value: string;
}

export interface TurnErrorMetadataV1 {
  readonly category: TurnErrorCategory;
  readonly code?: string;
  readonly correlationIds?: readonly TurnErrorCorrelationId[];
  readonly observedRetryable?: boolean;
  readonly providerType?: string;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly version: 1;
}

export type AgentEvent =
  /** User input was accepted into the thread queue. */
  | UserText
  /** User multipart input was accepted into the thread queue. */
  | UserMessage
  /** Runtime/API-originated input inserted into the current turn, not human input. */
  | RuntimeInput
  /** A queued user input started running as a turn. */
  | { type: "turn-start" }
  /** The active turn was interrupted before normal completion. */
  | { type: "turn-abort" }
  /** The active turn hit an unrecoverable runtime failure. */
  | {
      type: "turn-error";
      message: string;
      error?: TurnErrorMetadataV1;
    }
  /** The active turn completed normally. */
  | { type: "turn-end" }
  /** One model/tool-loop iteration started within the active turn. */
  | { type: "step-start" }
  /** The model produced reasoning content. */
  | AssistantReasoning
  /** Normalized metadata and provider usage for one successful model attempt. */
  | ModelUsage
  /** The model produced visible assistant text. */
  | AssistantOutput
  /** The model requested a tool call. */
  | ToolCall
  /** A tool call returned a result. */
  | ToolResult
  /** One model/tool-loop iteration finished within the active turn. */
  | { type: "step-end" }
  /**
   * Ephemeral assistant text delta; never persisted. The committed
   * assistant-output event remains the durable record.
   */
  | AssistantOutputDelta
  /**
   * Ephemeral assistant reasoning delta; never persisted. Advisory only;
   * assistant-reasoning remains the durable record.
   */
  | AssistantReasoningDelta
  /**
   * Ephemeral signal that tool-call input streaming started; never persisted.
   * The committed tool-call event remains the durable record.
   */
  | ToolCallInputStart
  /**
   * Ephemeral tool-call input text delta; never persisted. Advisory only;
   * the committed tool-call event remains the durable record.
   */
  | ToolCallInputDelta
  /**
   * Ephemeral signal that tool-call input streaming finished; never persisted.
   * The committed tool-call event remains the durable record.
   */
  | ToolCallInputEnd;

export type AgentEventListener = (event: AgentEvent) => void;

const visibleAgentEventTypes = {
  "assistant-output": true,
  "user-input": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

const lifecycleAgentEventTypes = {
  "step-end": true,
  "step-start": true,
  "turn-abort": true,
  "turn-end": true,
  "turn-error": true,
  "turn-start": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

const toolAgentEventTypes = {
  "tool-call": true,
  "tool-result": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

const telemetryAgentEventTypes = {
  "assistant-reasoning": true,
  "model-usage": true,
  "runtime-input": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

export const streamAgentEventTypes = Object.freeze({
  "assistant-output-delta": true,
  "assistant-reasoning-delta": true,
  "tool-call-input-delta": true,
  "tool-call-input-end": true,
  "tool-call-input-start": true,
} satisfies Partial<Record<AgentEvent["type"], true>>);

export type VisibleAgentEvent = Extract<
  AgentEvent,
  { type: keyof typeof visibleAgentEventTypes }
>;
export type LifecycleAgentEvent = Extract<
  AgentEvent,
  { type: keyof typeof lifecycleAgentEventTypes }
>;
export type ToolAgentEvent = Extract<
  AgentEvent,
  { type: keyof typeof toolAgentEventTypes }
>;
export type TelemetryAgentEvent = Extract<
  AgentEvent,
  { type: keyof typeof telemetryAgentEventTypes }
>;
export type StreamAgentEvent = Extract<
  AgentEvent,
  { type: keyof typeof streamAgentEventTypes }
>;
export type ControlAgentEvent = Exclude<AgentEvent, VisibleAgentEvent>;

export function isVisibleAgentEvent(
  event: AgentEvent
): event is VisibleAgentEvent {
  return event.type in visibleAgentEventTypes;
}

export function isLifecycleAgentEvent(
  event: AgentEvent
): event is LifecycleAgentEvent {
  return event.type in lifecycleAgentEventTypes;
}

export function isToolAgentEvent(event: AgentEvent): event is ToolAgentEvent {
  return event.type in toolAgentEventTypes;
}

export function isTelemetryAgentEvent(
  event: AgentEvent
): event is TelemetryAgentEvent {
  return event.type in telemetryAgentEventTypes;
}

export function isStreamAgentEvent(
  event: AgentEvent
): event is StreamAgentEvent {
  return event.type in streamAgentEventTypes;
}

export function isControlAgentEvent(
  event: AgentEvent
): event is ControlAgentEvent {
  return !isVisibleAgentEvent(event);
}
