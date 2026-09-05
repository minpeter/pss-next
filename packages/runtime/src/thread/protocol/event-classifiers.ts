import type { AgentEvent } from "./events";

export const visibleAgentEventTypes = {
  "assistant-output": true,
  "user-input": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

export const lifecycleAgentEventTypes = {
  "step-end": true,
  "step-start": true,
  "turn-abort": true,
  "turn-end": true,
  "turn-error": true,
  "turn-start": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

export const toolAgentEventTypes = {
  "tool-call": true,
  "tool-result": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

export const telemetryAgentEventTypes = {
  "assistant-reasoning": true,
  "model-usage": true,
  "runtime-input": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

export const streamAgentEventTypes = Object.freeze({
  "context-usage": true,
  "model-attempt": true,
  "assistant-output-delta": true,
  "assistant-reasoning-delta": true,
  "tool-call-input-delta": true,
  "tool-call-input-end": true,
  "tool-call-input-start": true,
} satisfies Partial<Record<AgentEvent["type"], true>>);

export const controlAgentEventTypes = {
  ...lifecycleAgentEventTypes,
  ...streamAgentEventTypes,
  ...telemetryAgentEventTypes,
  ...toolAgentEventTypes,
} satisfies Partial<Record<AgentEvent["type"], true>>;
