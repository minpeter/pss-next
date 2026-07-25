import type { ThreadCompactionInput } from "@minpeter/pss-runtime";
import {
  type AgentCompactionDecision,
  type AgentHooks,
  type AgentInputDecision,
  type AgentInputEvent,
  type AgentTransformDecision,
  type AgentTurnStartEvent,
  assertCompactionDecision,
  assertInputDecision,
  assertInputEvent,
  assertToolDecision,
  assertToolResult,
  assertTransformDecision,
} from "@minpeter/pss-runtime";
import { CodingAgentExtensionError } from "./error";

export interface RegisteredAgentHooks {
  readonly extensionId: string;
  readonly hooks: AgentHooks;
}

export interface ComposeAgentHooksOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const clone = <Value>(value: Value): Value => structuredClone(value) as Value;

function assertCompactionInput(
  value: unknown
): asserts value is ThreadCompactionInput {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { readonly startSeq?: unknown }).startSeq !== "number" ||
    typeof (value as { readonly endSeqExclusive?: unknown }).endSeqExclusive !==
      "number" ||
    typeof (value as { readonly summary?: unknown }).summary !== "string"
  ) {
    throw new TypeError(
      "Agent compaction transform must return a compaction input"
    );
  }
}

export function composeAgentHooks(
  registrations: readonly RegisteredAgentHooks[],
  options: ComposeAgentHooksOptions = {}
): AgentHooks {
  const { signal, timeoutMs } = options;
  return {
    acceptInput: async (event, context) => {
      let current: AgentInputEvent = event;
      for (const registration of registrations) {
        const hook = registration.hooks.acceptInput;
        if (!hook) {
          continue;
        }
        const decision = await invoke(
          registration.extensionId,
          "hook",
          () => hook(clone(current), context),
          { signal, timeoutMs }
        );
        assertInputDecision(decision);
        if (decision?.action === "handled") {
          return decision;
        }
        if (decision?.action === "transform") {
          assertInputEvent(decision.value);
          current = decision.value;
        }
      }
      return current === event
        ? undefined
        : ({
            action: "transform",
            value: clone(current),
          } satisfies AgentInputDecision<AgentInputEvent>);
    },
    beforeCompaction: async (event, context) => {
      let current = event.input;
      for (const registration of registrations) {
        const hook = registration.hooks.beforeCompaction;
        if (!hook) {
          continue;
        }
        const decision = await invoke(
          registration.extensionId,
          "hook",
          () => hook({ input: clone(current) }, context),
          { signal, timeoutMs }
        );
        assertCompactionDecision(decision);
        if (decision?.action === "cancel") {
          return decision;
        }
        if (decision?.action === "transform") {
          assertCompactionInput(decision.input);
          current = decision.input;
        }
      }
      return current === event.input
        ? undefined
        : ({
            action: "transform",
            input: clone(current),
          } satisfies AgentCompactionDecision);
    },
    beforeToolExecution: async (checkpoint, context) => {
      let current = checkpoint;
      for (const registration of registrations) {
        const hook = registration.hooks.beforeToolExecution;
        if (!hook) {
          continue;
        }
        const decision = await invoke(
          registration.extensionId,
          "hook",
          () => hook(clone(current), context),
          { signal, timeoutMs }
        );
        assertToolDecision(decision);
        if (decision?.status === "blocked") {
          return decision;
        }
        if (decision?.status === "needs-recovery") {
          return decision;
        }
        if (decision?.status === "continue") {
          current = { ...current, input: clone(decision.input) };
        }
      }
      return current === checkpoint
        ? undefined
        : { input: clone(current.input), status: "continue" };
    },
    beforeTurnStart: async (event, context) => {
      let current: AgentTurnStartEvent = event;
      for (const registration of registrations) {
        const hook = registration.hooks.beforeTurnStart;
        if (!hook) {
          continue;
        }
        const decision = await invoke(
          registration.extensionId,
          "hook",
          () => hook(clone(current), context),
          { signal, timeoutMs }
        );
        assertTransformDecision(decision, "value");
        if (decision?.action === "transform") {
          current = decision.value;
        }
      }
      return current === event
        ? undefined
        : ({
            action: "transform",
            value: clone(current),
          } satisfies AgentTransformDecision<AgentTurnStartEvent>);
    },
    transformModelContext: async (event, context) => {
      let current = event.messages;
      for (const registration of registrations) {
        const hook = registration.hooks.transformModelContext;
        if (!hook) {
          continue;
        }
        const decision = await invoke(
          registration.extensionId,
          "hook",
          () => hook({ messages: clone(current) }, context),
          { signal, timeoutMs }
        );
        assertTransformDecision(decision, "value");
        if (decision?.action === "transform") {
          current = decision.value;
        }
      }
      return current === event.messages
        ? undefined
        : { action: "transform", value: clone(current) };
    },
    transformModelStep: async (event, context) => {
      let current = event.output;
      for (const registration of registrations) {
        const hook = registration.hooks.transformModelStep;
        if (!hook) {
          continue;
        }
        const decision = await invoke(
          registration.extensionId,
          "hook",
          () => hook({ output: clone(current) }, context),
          { signal, timeoutMs }
        );
        assertTransformDecision(decision, "value");
        if (decision?.action === "transform") {
          current = decision.value;
        }
      }
      return current === event.output
        ? undefined
        : { action: "transform", value: clone(current) };
    },
    transformToolResult: async (checkpoint, context) => {
      let current = checkpoint;
      for (const registration of registrations) {
        const hook = registration.hooks.transformToolResult;
        if (!hook) {
          continue;
        }
        const result = await invoke(
          registration.extensionId,
          "hook",
          () => hook(clone(current), context),
          { signal, timeoutMs }
        );
        assertToolResult(result);
        if (result !== undefined) {
          current = { ...current, output: clone(result.output) };
        }
      }
      return current === checkpoint
        ? undefined
        : { output: clone(current.output) };
    },
  };
}

function invoke<Result>(
  extensionId: string,
  phase: "hook",
  callback: () => Promise<Result> | Result,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number }
): Promise<Result> {
  const { signal, timeoutMs } = options;
  if (signal?.aborted) {
    return Promise.reject(
      new CodingAgentExtensionError(extensionId, phase, new Error("aborted"))
    );
  }
  const task = (async () => {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof CodingAgentExtensionError) {
        throw error;
      }
      throw new CodingAgentExtensionError(extensionId, phase, error);
    }
  })();
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return task;
  }
  return Promise.race([
    task,
    createTimeout(extensionId, phase, signal, timeoutMs),
  ]);
}

function createTimeout(
  extensionId: string,
  phase: "hook",
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        new CodingAgentExtensionError(extensionId, phase, new Error("aborted"))
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      reject(
        new CodingAgentExtensionError(
          extensionId,
          phase,
          new Error(`hook timed out after ${timeoutMs}ms`)
        )
      );
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
