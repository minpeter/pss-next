import type { ModelMessage } from "ai";
import type { ModelStepOutput } from "../../llm/model-step-types";
import type {
  RuntimeToolExecutionDecision,
  RuntimeToolExecutionResult,
} from "../../llm/tool-execution-types";
import {
  isCompactionContextMessage,
  type ThreadContextMessage,
} from "../../thread/state/context";
import type { ThreadCompactionInput } from "../../thread/state/thread-state";
import { AgentHookError } from "./hook-error";
import type {
  AgentCompactionDecision,
  AgentHooks,
  AgentInputDecision,
  AgentInputEvent,
  AgentTurnStartEvent,
} from "./hooks";

function assertRecord(
  value: unknown
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent hook must return a decision object");
  }
}

export function assertInputDecision<Event>(
  decision: AgentInputDecision<Event> | undefined
): void {
  if (decision === undefined) {
    return;
  }
  assertRecord(decision);
  if (
    decision.action !== "continue" &&
    decision.action !== "handled" &&
    decision.action !== "transform"
  ) {
    throw new TypeError("Agent input hook returned an invalid action");
  }
  if (decision.action === "transform" && !("value" in decision)) {
    throw new TypeError("Agent input transform must include value");
  }
}

export function assertInputEvent(
  value: unknown
): asserts value is AgentInputEvent {
  assertRecord(value);
  if (value.type !== "user-input" && value.type !== "runtime-input") {
    throw new TypeError(
      "Agent input transform must return a user-input or runtime-input event"
    );
  }
  if (value.type === "runtime-input") {
    assertInputPayload(
      value.input,
      "Agent input transform runtime-input must include a user-input payload"
    );
    if (
      value.placement !== "turn-start" &&
      value.placement !== "step-start" &&
      value.placement !== "step-end"
    ) {
      throw new TypeError(
        "Agent input transform runtime-input must include a placement"
      );
    }
    return;
  }
  assertInputPayload(
    value,
    "Agent input transform user-input must include text or content"
  );
}

function assertInputPayload(
  value: unknown,
  message: string
): asserts value is { readonly type: "user-input" } {
  assertRecord(value);
  if (value.type !== "user-input") {
    throw new TypeError(message);
  }
  const text = (value as { readonly text?: unknown }).text;
  const textValid =
    typeof text === "string" ||
    (Array.isArray(text) && text.every((item) => typeof item === "string"));
  if (textValid) {
    return;
  }
  if (Array.isArray((value as { readonly content?: unknown }).content)) {
    return;
  }
  throw new TypeError(message);
}

export function assertTurnStartEvent(
  value: unknown
): asserts value is AgentTurnStartEvent {
  assertRecord(value);
  if (value.type !== "turn-start") {
    throw new TypeError("Agent turn transform must return a turn-start event");
  }
}

function isModelMessage(value: unknown): value is ModelMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "role" in value &&
      (value.role === "system" ||
        value.role === "user" ||
        value.role === "assistant" ||
        value.role === "tool") &&
      "content" in value &&
      (typeof (value as { readonly content: unknown }).content === "string" ||
        Array.isArray((value as { readonly content: unknown }).content))
  );
}

export function assertModelContext(
  value: unknown
): asserts value is readonly ThreadContextMessage[] {
  if (
    !(
      Array.isArray(value) &&
      value.every(
        (message) =>
          isModelMessage(message) || isCompactionContextMessage(message)
      )
    )
  ) {
    throw new TypeError(
      "Agent model context transform must return context messages"
    );
  }
}

export function assertModelStep(
  value: unknown
): asserts value is ModelStepOutput {
  if (
    !(
      Array.isArray(value) &&
      value.every(
        (message) =>
          isModelMessage(message) &&
          (message.role === "assistant" || message.role === "tool")
      )
    )
  ) {
    throw new TypeError(
      "Agent model step transform must return assistant or tool messages"
    );
  }
}

export function assertCompactionInput(
  value: unknown
): asserts value is ThreadCompactionInput {
  assertRecord(value);
  if (
    typeof value.startSeq !== "number" ||
    typeof value.endSeqExclusive !== "number" ||
    typeof value.summary !== "string"
  ) {
    throw new TypeError(
      "Agent compaction transform must return a compaction input"
    );
  }
}

export function assertToolDecision(value: RuntimeToolExecutionDecision): void {
  if (value === undefined) {
    return;
  }
  assertRecord(value);
  if (value.status === "needs-recovery") {
    return;
  }
  if (value.status === "continue" && "input" in value) {
    return;
  }
  if (value.status === "blocked" && "output" in value) {
    return;
  }
  throw new TypeError("Agent tool hook returned an invalid decision");
}

export function assertToolResult(
  value: RuntimeToolExecutionResult | undefined
): void {
  if (value === undefined) {
    return;
  }
  assertRecord(value);
  if (!("output" in value)) {
    throw new TypeError("Agent tool result transform must include output");
  }
}

export function assertTransformDecision(
  decision: unknown,
  valueName: string
): asserts decision is
  | { readonly action: "continue" }
  | { readonly action: "transform"; readonly value: unknown }
  | undefined {
  if (decision === undefined) {
    return;
  }
  assertRecord(decision);
  if (decision.action !== "continue" && decision.action !== "transform") {
    throw new TypeError("Agent transform hook returned an invalid action");
  }
  if (decision.action === "transform" && !("value" in decision)) {
    throw new TypeError(`Agent transform must include ${valueName}`);
  }
}

export function assertCompactionDecision(
  decision: AgentCompactionDecision | undefined
): void {
  if (decision === undefined) {
    return;
  }
  assertRecord(decision);
  if (
    decision.action !== "continue" &&
    decision.action !== "cancel" &&
    decision.action !== "transform"
  ) {
    throw new TypeError("Agent compaction hook returned an invalid action");
  }
  if (decision.action === "transform" && !("input" in decision)) {
    throw new TypeError("Agent compaction transform must include input");
  }
}

export function validateHookResult<Result>(
  hookName: keyof AgentHooks,
  validate: () => Result
): Result {
  try {
    return validate();
  } catch (error) {
    if (error instanceof AgentHookError) {
      throw error;
    }
    throw new AgentHookError(hookName, error);
  }
}
