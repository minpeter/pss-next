import type { ModelMessage } from "ai";
import type { ModelStepOutput } from "../../llm/model-step-types";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionDecision,
  RuntimeToolExecutionResult,
} from "../../llm/tool-execution-types";
import type { AgentEvent } from "../../thread/protocol/events";
import type { ThreadContextMessage } from "../../thread/state/context";
import type { ThreadCompactionInput } from "../../thread/state/thread-state";

export type AgentInputEvent = Extract<
  AgentEvent,
  { readonly type: "runtime-input" | "user-input" }
>;

export type AgentTurnStartEvent = Extract<
  AgentEvent,
  { readonly type: "turn-start" }
>;

export type AgentInputDecision<Event> =
  | { readonly action: "continue" }
  | { readonly action: "handled" }
  | { readonly action: "transform"; readonly value: Event };

export type AgentTransformDecision<Value> =
  | { readonly action: "continue" }
  | { readonly action: "transform"; readonly value: Value };

export type AgentCompactionDecision =
  | { readonly action: "cancel" }
  | { readonly action: "continue" }
  | {
      readonly action: "transform";
      readonly input: ThreadCompactionInput;
    };

export interface AgentHookContext {
  readonly history: readonly ModelMessage[];
  readonly signal: AbortSignal;
  readonly threadKey: string;
}

export interface AgentModelContextEvent {
  readonly messages: readonly ThreadContextMessage[];
}

export interface AgentModelStepEvent {
  readonly output: ModelStepOutput;
}

export interface AgentCompactionEvent {
  readonly input: ThreadCompactionInput;
}

export type AgentHook<Event, Result> = (
  event: Event,
  context: AgentHookContext
) => Promise<Result | undefined> | Result | undefined;

export interface AgentHooks {
  readonly acceptInput?: AgentHook<
    AgentInputEvent,
    AgentInputDecision<AgentInputEvent>
  >;
  readonly beforeCompaction?: AgentHook<
    AgentCompactionEvent,
    AgentCompactionDecision
  >;
  readonly beforeToolExecution?: AgentHook<
    RuntimeToolExecutionCheckpoint,
    RuntimeToolExecutionDecision
  >;
  readonly beforeTurnStart?: AgentHook<
    AgentTurnStartEvent,
    AgentTransformDecision<AgentTurnStartEvent>
  >;
  readonly transformModelContext?: AgentHook<
    AgentModelContextEvent,
    AgentTransformDecision<readonly ThreadContextMessage[]>
  >;
  readonly transformModelStep?: AgentHook<
    AgentModelStepEvent,
    AgentTransformDecision<ModelStepOutput>
  >;
  readonly transformToolResult?: AgentHook<
    RuntimeToolExecutionCheckpoint & { readonly output: unknown },
    RuntimeToolExecutionResult
  >;
}
