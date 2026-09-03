import type { ContextBudgetSource } from "../../llm/context-gate";

export function snapshotAgentContextGate(
  contextGate: unknown
): ContextBudgetSource {
  if (typeof contextGate !== "object" || contextGate === null) {
    throw new TypeError("Agent: options.contextGate must be an object.");
  }

  const bufferTokens: unknown = Reflect.get(contextGate, "bufferTokens");
  const estimateTokens: unknown = Reflect.get(contextGate, "estimateTokens");
  const maxInputTokens: unknown = Reflect.get(contextGate, "maxInputTokens");
  const onOverflow: unknown = Reflect.get(contextGate, "onOverflow");

  if (typeof maxInputTokens !== "function") {
    throw new TypeError(
      "Agent: options.contextGate.maxInputTokens must be a function."
    );
  }
  if (estimateTokens !== undefined && typeof estimateTokens !== "function") {
    throw new TypeError(
      "Agent: options.contextGate.estimateTokens must be a function."
    );
  }
  if (
    bufferTokens !== undefined &&
    !(
      typeof bufferTokens === "number" &&
      Number.isSafeInteger(bufferTokens) &&
      bufferTokens >= 0
    )
  ) {
    throw new TypeError(
      "Agent: options.contextGate.bufferTokens must be a non-negative integer."
    );
  }
  if (
    onOverflow !== undefined &&
    onOverflow !== "compact" &&
    onOverflow !== "error"
  ) {
    throw new TypeError(
      'Agent: options.contextGate.onOverflow must be "compact" or "error".'
    );
  }

  const snapshot: ContextBudgetSource = {
    ...(bufferTokens === undefined ? {} : { bufferTokens }),
    ...(estimateTokens === undefined
      ? {}
      : { estimateTokens: (input) => estimateTokens(input) }),
    maxInputTokens: () => maxInputTokens(),
    ...(onOverflow === undefined ? {} : { onOverflow }),
  };
  return Object.freeze(snapshot);
}
