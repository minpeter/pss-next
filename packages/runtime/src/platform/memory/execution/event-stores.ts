import {
  createEventCursor,
  createThreadEventCursor,
  normalizeEventCursor,
  normalizeThreadEventReadOptions,
} from "../../../execution/host/event-cursors";
import type {
  EventCursor,
  EventStore,
  StoredAgentEvent,
  StoredThreadEvent,
  ThreadEventCursor,
  ThreadEventLog,
  ThreadEventReadOptions,
} from "../../../execution/host/types";
import type { AgentEvent } from "../../../thread/protocol/events";
import type { ExecutionState } from "./state";

export class InMemoryEventStore implements EventStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  append(runId: string, event: AgentEvent): Promise<EventCursor> {
    const events = this.#state().events.get(runId) ?? [];
    const cursor = createEventCursor(events.length + 1);
    events.push({
      cursor,
      event: structuredClone(event),
      runId,
    });
    this.#state().events.set(runId, events);
    return Promise.resolve(cursor);
  }

  async *read(
    runId: string,
    cursor?: EventCursor
  ): AsyncIterable<StoredAgentEvent> {
    await Promise.resolve();
    const events = this.#state().events.get(runId) ?? [];
    const start = normalizeEventCursor(cursor);
    for (const event of events.slice(start)) {
      yield structuredClone(event);
    }
  }
}

export class InMemoryThreadEventLog implements ThreadEventLog {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  append(threadKey: string, event: AgentEvent): Promise<ThreadEventCursor> {
    const events = this.#state().threadEvents.get(threadKey) ?? [];
    const cursor = createThreadEventCursor(events.length + 1);
    events.push({
      cursor,
      event: structuredClone(event),
      threadKey,
    });
    this.#state().threadEvents.set(threadKey, events);
    return Promise.resolve(cursor);
  }

  async *read(
    threadKey: string,
    options: ThreadEventReadOptions = {}
  ): AsyncIterable<StoredThreadEvent> {
    await Promise.resolve();
    const events = this.#state().threadEvents.get(threadKey) ?? [];
    const { limit, start } = normalizeThreadEventReadOptions(options);
    const end = limit === undefined ? undefined : start + limit;
    for (const event of events.slice(start, end)) {
      yield structuredClone(event);
    }
  }
}
