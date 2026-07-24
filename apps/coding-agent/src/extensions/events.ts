import {
  type AgentEvent,
  type AgentInstrumentation,
  type AgentInstrumentationContext,
  type AgentTurn,
  isStreamAgentEvent,
} from "@minpeter/pss-runtime";
import { CodingAgentExtensionError } from "./error";
import type {
  CodingAgentExtensionEventContext,
  CodingAgentExtensionServices,
} from "./types";

export interface RegisteredCodingAgentExtensionEvent {
  readonly extensionId: string;
  readonly invoke: (
    event: AgentEvent,
    context: CodingAgentExtensionEventContext
  ) => Promise<void>;
  readonly type: AgentEvent["type"];
}

export function createCodingAgentExtensionInstrumentation(
  registrations: readonly RegisteredCodingAgentExtensionEvent[],
  signal: AbortSignal,
  getServices: (extensionId: string) => CodingAgentExtensionServices
): AgentInstrumentation {
  return {
    wrapTurn: (turn, context) =>
      wrapExtensionEvents(turn, context, registrations, signal, getServices),
  };
}

function wrapExtensionEvents(
  turn: AgentTurn,
  instrumentationContext: AgentInstrumentationContext,
  registrations: readonly RegisteredCodingAgentExtensionEvent[],
  signal: AbortSignal,
  getServices: (extensionId: string) => CodingAgentExtensionServices
): AgentTurn {
  return {
    events: () =>
      observeEvents(
        turn.events(),
        instrumentationContext,
        registrations,
        signal,
        getServices,
        turn.runId
      ),
    runId: turn.runId,
  };
}

async function* observeEvents(
  source: AsyncIterable<AgentEvent>,
  instrumentationContext: AgentInstrumentationContext,
  registrations: readonly RegisteredCodingAgentExtensionEvent[],
  signal: AbortSignal,
  getServices: (extensionId: string) => CodingAgentExtensionServices,
  turnRunId: string | undefined
): AsyncIterable<AgentEvent> {
  const failures: CodingAgentExtensionError[] = [];
  for await (const event of source) {
    if (!signal.aborted) {
      for (const registration of registrations) {
        if (registration.type !== event.type) {
          continue;
        }
        try {
          const context: CodingAgentExtensionEventContext = Object.freeze({
            ...instrumentationContext,
            runId: instrumentationContext.runId ?? turnRunId,
            services: getServices(registration.extensionId),
            signal,
            stream: isStreamAgentEvent(event),
          });
          await registration.invoke(structuredClone(event), context);
        } catch (error) {
          failures.push(
            new CodingAgentExtensionError(
              registration.extensionId,
              "event",
              error
            )
          );
        }
      }
    }
    yield event;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Coding agent extension event handlers failed"
    );
  }
}
