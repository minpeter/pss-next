import type {
  AgentHost,
  HostStoreTransaction,
  ThreadEventLog,
} from "../../execution/host/types";
import { type AgentEvent, isStreamAgentEvent } from "../protocol/events";
import type { ThreadState } from "../state/thread-state";

export type DurableThreadEventBuffer = AgentEvent[];

export function recordDurableThreadEvent(
  buffer: DurableThreadEventBuffer,
  event: AgentEvent
): void {
  if (isStreamAgentEvent(event)) {
    throw new TypeError("Stream agent events cannot be recorded durably.");
  }
  buffer.push(structuredClone(event));
}

export class ThreadEventTransactionUnsupportedError extends Error {
  readonly name = "ThreadEventTransactionUnsupportedError";

  constructor() {
    super(
      "HostStore.transaction() must provide threadEvents when the store enables durable thread event replay."
    );
  }
}

export function takeDurableThreadEvents(
  buffer: DurableThreadEventBuffer
): AgentEvent[] {
  return buffer.splice(0);
}

export function restoreDurableThreadEvents(
  buffer: DurableThreadEventBuffer,
  events: readonly AgentEvent[]
): void {
  buffer.unshift(...events);
}

export async function appendDurableThreadEvents(
  eventLog: ThreadEventLog,
  threadKey: string,
  events: readonly AgentEvent[]
): Promise<void> {
  for (const event of events) {
    await eventLog.append(threadKey, event);
  }
}

export function transactionalThreadEvents(
  tx: HostStoreTransaction
): ThreadEventLog {
  if (!tx.threadEvents) {
    throw new ThreadEventTransactionUnsupportedError();
  }
  return tx.threadEvents;
}

export async function commitThreadStateAndEvents({
  buffer,
  executionHost,
  state,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly executionHost?: AgentHost;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const pendingEvents = takeDurableThreadEvents(buffer);
  const eventLog = executionHost?.store.threadEvents;
  if (!eventLog || pendingEvents.length === 0) {
    try {
      await state.commit();
    } catch (error) {
      restoreDurableThreadEvents(buffer, pendingEvents);
      throw error;
    }
    return;
  }

  try {
    await state.commitWith(
      async (commit) =>
        await executionHost.store.transaction(async (tx) => {
          const result = await tx.threads.commit(commit.key, commit.next, {
            expectedVersion: commit.expectedVersion,
          });
          if (!result.ok) {
            return result;
          }

          await appendDurableThreadEvents(
            transactionalThreadEvents(tx),
            threadKey,
            pendingEvents
          );
          return result;
        })
    );
  } catch (error) {
    restoreDurableThreadEvents(buffer, pendingEvents);
    throw error;
  }
}

export async function flushDurableThreadEvents({
  buffer,
  executionHost,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly executionHost?: AgentHost;
  readonly threadKey: string;
}): Promise<void> {
  const pendingEvents = takeDurableThreadEvents(buffer);
  const eventLog = executionHost?.store.threadEvents;
  if (!eventLog || pendingEvents.length === 0) {
    return;
  }

  try {
    await executionHost.store.transaction(async (tx) => {
      await appendDurableThreadEvents(
        transactionalThreadEvents(tx),
        threadKey,
        pendingEvents
      );
    });
  } catch (error) {
    restoreDurableThreadEvents(buffer, pendingEvents);
    throw error;
  }
}
