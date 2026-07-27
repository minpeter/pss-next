import { type AgentEvent, isStreamAgentEvent } from "../thread/protocol/events";

export const committedEvents = (events: AgentEvent[]) =>
  events.filter((event) => !isStreamAgentEvent(event));

/** Committed event types for assertions that predate ephemeral stream events. */
export const eventTypes = (events: AgentEvent[]) =>
  committedEvents(events).map((event) => event.type);
