import type { ModelMessage } from "ai";
import type { ModelStepOutput } from "../../llm/model-step-types";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionDecision,
  RuntimeToolExecutionResult,
} from "../../llm/tool-execution-types";
import type { ThreadContextMessage } from "../../thread/state/context";
import type { ThreadCompactionInput } from "../../thread/state/thread-state";
import { AgentHookError } from "./hook-error";
import {
  assertCompactionDecision,
  assertCompactionInput,
  assertInputDecision,
  assertInputEvent,
  assertModelContext,
  assertModelStep,
  assertToolDecision,
  assertToolResult,
  assertTransformDecision,
  assertTurnStartEvent,
  validateHookResult,
} from "./hook-validation";
import type {
  AgentCompactionDecision,
  AgentHooks,
  AgentInputEvent,
  AgentModelContextEvent,
  AgentTurnStartEvent,
} from "./hooks";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class AgentHookRuntime {
  readonly #hooks: AgentHooks;

  constructor(hooks: AgentHooks = {}) {
    this.#hooks = hooks;
  }

  async acceptInput(
    threadKey: string,
    event: AgentInputEvent,
    history: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<AgentInputEvent | undefined> {
    const decision = await this.#invoke(
      "acceptInput",
      this.#hooks.acceptInput,
      clone(event),
      threadKey,
      history,
      signal
    );
    return validateHookResult("acceptInput", () => {
      assertInputDecision(decision);
      if (decision?.action === "handled") {
        return;
      }
      const transformed =
        decision?.action === "transform" ? decision.value : event;
      assertInputEvent(transformed);
      if (transformed.type !== event.type) {
        throw new TypeError(
          "Agent input transform must preserve the input event kind"
        );
      }
      return clone(transformed);
    });
  }

  async beforeTurnStart(
    threadKey: string,
    event: AgentTurnStartEvent,
    history: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<AgentTurnStartEvent> {
    const decision = await this.#invoke(
      "beforeTurnStart",
      this.#hooks.beforeTurnStart,
      clone(event),
      threadKey,
      history,
      signal
    );
    return validateHookResult("beforeTurnStart", () => {
      assertTransformDecision(decision, "value");
      const transformed =
        decision?.action === "transform"
          ? (decision.value as AgentTurnStartEvent)
          : event;
      assertTurnStartEvent(transformed);
      return clone(transformed);
    });
  }

  async beforeToolExecution(
    threadKey: string,
    checkpoint: RuntimeToolExecutionCheckpoint,
    history: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<RuntimeToolExecutionDecision> {
    const decision = await this.#invoke(
      "beforeToolExecution",
      this.#hooks.beforeToolExecution,
      clone(checkpoint),
      threadKey,
      history,
      signal
    );
    return validateHookResult("beforeToolExecution", () => {
      assertToolDecision(decision);
      return decision === undefined ? undefined : clone(decision);
    });
  }

  async transformToolResult(
    threadKey: string,
    checkpoint: RuntimeToolExecutionCheckpoint & {
      readonly output: unknown;
    },
    history: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<RuntimeToolExecutionResult | undefined> {
    const result = await this.#invoke(
      "transformToolResult",
      this.#hooks.transformToolResult,
      clone(checkpoint),
      threadKey,
      history,
      signal
    );
    return validateHookResult("transformToolResult", () => {
      assertToolResult(result);
      return result === undefined ? undefined : clone(result);
    });
  }

  async transformModelContext(
    threadKey: string,
    event: AgentModelContextEvent,
    history: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<readonly ThreadContextMessage[]> {
    const decision = await this.#invoke(
      "transformModelContext",
      this.#hooks.transformModelContext,
      {
        messages: clone(event.messages),
      },
      threadKey,
      history,
      signal
    );
    return validateHookResult("transformModelContext", () => {
      assertTransformDecision(decision, "value");
      const transformed =
        decision?.action === "transform"
          ? clone(decision.value as readonly ThreadContextMessage[])
          : event.messages;
      assertModelContext(transformed);
      return clone(transformed);
    });
  }

  async transformModelStep(
    threadKey: string,
    output: ModelStepOutput,
    history: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<ModelStepOutput> {
    const decision = await this.#invoke(
      "transformModelStep",
      this.#hooks.transformModelStep,
      { output: clone(output) },
      threadKey,
      history,
      signal
    );
    return validateHookResult("transformModelStep", () => {
      assertTransformDecision(decision, "value");
      const transformed =
        decision?.action === "transform"
          ? (decision.value as ModelStepOutput)
          : output;
      assertModelStep(transformed);
      return clone(transformed);
    });
  }

  async beforeCompaction(
    threadKey: string,
    input: ThreadCompactionInput,
    history: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<AgentCompactionDecision | undefined> {
    const decision = await this.#invoke(
      "beforeCompaction",
      this.#hooks.beforeCompaction,
      { input: clone(input) },
      threadKey,
      history,
      signal
    );
    return validateHookResult("beforeCompaction", () => {
      assertCompactionDecision(decision);
      if (decision?.action === "transform") {
        assertCompactionInput(decision.input);
      }
      return decision === undefined ? undefined : clone(decision);
    });
  }

  async #invoke<Event, Result>(
    hookName: keyof AgentHooks,
    hook:
      | ((
          event: Event,
          context: {
            readonly history: readonly ModelMessage[];
            readonly signal: AbortSignal;
            readonly threadKey: string;
          }
        ) => Promise<Result | undefined> | Result | undefined)
      | undefined,
    event: Event,
    threadKey: string,
    history: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<Result | undefined> {
    if (!hook) {
      return;
    }
    try {
      return await hook(event, {
        history: clone(history),
        signal,
        threadKey,
      });
    } catch (error) {
      if (error instanceof AgentHookError) {
        throw error;
      }
      throw new AgentHookError(hookName, error);
    }
  }
}
