import type { AgentInstrumentation } from "../agent/core/instrumentation";
import type { AgentEvent } from "../thread/protocol/events";
import type { AgentTurn } from "../thread/protocol/turn";
import {
  closeTraceState,
  INCOMPLETE_SPAN_STATUS,
  recordRuntimeTraceEvent,
  SOURCE_ERROR_STATUS,
  TURN_OK_STATUS,
} from "./trace-state";
import {
  createTraceState,
  type TraceAgentTurnOptions,
  type TraceAgentTurnState,
} from "./types";

export type {
  TraceAgentTurnEventAttributes,
  TraceAgentTurnOptions,
  TraceAgentTurnSpan,
  TraceAgentTurnTracer,
} from "./types";

export function openTelemetry(
  options: TraceAgentTurnOptions = {}
): AgentInstrumentation {
  return {
    wrapTurn: (turn) => traceAgentTurn(turn, options),
  };
}

export function traceAgentTurn(
  turn: AgentTurn,
  options: TraceAgentTurnOptions = {}
): AgentTurn {
  let consumed = false;
  return Object.freeze({
    events: () => {
      if (consumed) {
        throw new Error("AgentTurn.events() can only be consumed once");
      }
      consumed = true;
      return new TracedAgentEventIterator(
        turn.events()[Symbol.asyncIterator](),
        createTraceState(options)
      );
    },
    ...(turn.runId === undefined ? {} : { runId: turn.runId }),
  });
}

class TracedAgentEventIterator implements AsyncIterableIterator<AgentEvent> {
  readonly #source: AsyncIterator<AgentEvent>;
  readonly #state: TraceAgentTurnState;
  #closed = false;
  #nextPending = false;

  constructor(source: AsyncIterator<AgentEvent>, state: TraceAgentTurnState) {
    this.#source = source;
    this.#state = state;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<AgentEvent> {
    return this;
  }

  async next(): Promise<IteratorResult<AgentEvent>> {
    if (this.#closed) {
      return { done: true, value: undefined };
    }
    if (this.#nextPending) {
      throw new Error(
        "AgentTurn.events() does not allow concurrent next() calls"
      );
    }

    this.#nextPending = true;
    try {
      const next = await this.#source.next();
      if (next.done) {
        this.#closed = true;
        closeTraceState(this.#state, {
          childStatus: INCOMPLETE_SPAN_STATUS,
          turnStatus: TURN_OK_STATUS,
        });
        return { done: true, value: undefined };
      }

      recordRuntimeTraceEvent(this.#state, next.value);
      return { done: false, value: next.value };
    } catch (error) {
      this.#closed = true;
      closeTraceState(this.#state, {
        childStatus: SOURCE_ERROR_STATUS,
        exception: new Error("Agent turn source failed"),
        turnStatus: SOURCE_ERROR_STATUS,
      });
      throw error;
    } finally {
      this.#nextPending = false;
    }
  }

  async return(): Promise<IteratorResult<AgentEvent>> {
    if (this.#closed) {
      return { done: true, value: undefined };
    }

    try {
      await this.#source.return?.();
    } finally {
      this.#closed = true;
      closeTraceState(this.#state, {
        childStatus: INCOMPLETE_SPAN_STATUS,
      });
    }

    return { done: true, value: undefined };
  }
}
