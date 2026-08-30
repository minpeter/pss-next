import type { AgentEvent } from "../../thread/protocol/events";
import type { AgentTurn } from "../../thread/protocol/turn";

export type AgentInstrumentationOperation =
  | "follow-up"
  | "resume"
  | "send"
  | "steer";

export interface AgentInstrumentationContext {
  readonly namespace?: string;
  readonly operation: AgentInstrumentationOperation;
  readonly runId?: string;
  readonly threadKey: string;
}

export interface AgentInstrumentation {
  wrapTurn(turn: AgentTurn, context: AgentInstrumentationContext): AgentTurn;
}

export function normalizeAgentInstrumentations(
  value: unknown
): readonly AgentInstrumentation[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Agent: options.instrumentations must be an array.");
  }

  const instrumentations = [...value];
  for (const instrumentation of instrumentations) {
    assertAgentInstrumentation(instrumentation);
  }
  return Object.freeze(instrumentations);
}

export function applyAgentInstrumentations(
  turn: AgentTurn,
  instrumentations: readonly AgentInstrumentation[],
  context: AgentInstrumentationContext
): AgentTurn {
  const runId = turn.runId;
  let wrapped = createPublicAgentTurn(turn, runId);
  for (const instrumentation of instrumentations) {
    wrapped = createPublicAgentTurn(
      instrumentation.wrapTurn(wrapped, context),
      runId
    );
  }
  return wrapped;
}

function assertAgentInstrumentation(
  value: unknown
): asserts value is AgentInstrumentation {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { readonly wrapTurn?: unknown }).wrapTurn !== "function"
  ) {
    throw new TypeError(
      "Agent: each options.instrumentations entry must provide wrapTurn()."
    );
  }
}

function createPublicAgentTurn(
  turn: unknown,
  runId: string | undefined
): AgentTurn {
  if (turn === null || typeof turn !== "object") {
    throw new TypeError(
      "Agent: options.instrumentations entry wrapTurn() must return an AgentTurn."
    );
  }
  const events = Reflect.get(turn, "events");
  if (typeof events !== "function") {
    throw new TypeError(
      "Agent: options.instrumentations entry wrapTurn() must return an AgentTurn."
    );
  }
  return Object.freeze({
    events: () => {
      const iterable = Reflect.apply(events, turn, []);
      if (!isAgentEventIterable(iterable)) {
        throw new TypeError(
          "Agent: options.instrumentations entry wrapTurn() must return an AgentTurn."
        );
      }
      return iterable;
    },
    ...(runId === undefined ? {} : { runId }),
  });
}

function isAgentEventIterable(
  value: unknown
): value is AsyncIterable<AgentEvent> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof Reflect.get(value, Symbol.asyncIterator) === "function"
  );
}
