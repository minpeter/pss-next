import type {
  AgentHost,
  HostStoreTransaction,
  ThreadEventLog,
} from "../../execution/host/types";
import { type AgentEvent, isStreamAgentEvent } from "../protocol/events";
import type { ThreadState } from "../state/thread-state";
import type {
  ThreadExecutionRun,
  ThreadExecutionTerminalStatus,
} from "./execution";

export type DurableThreadEventBuffer = AgentEvent[];

export function createDurableThreadEventRecorder(): {
  readonly buffer: DurableThreadEventBuffer;
  readonly record: (event: AgentEvent) => void;
} {
  const buffer: DurableThreadEventBuffer = [];
  return { buffer, record: (event) => recordDurableThreadEvent(buffer, event) };
}

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
  executionRun,
  state,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly executionHost?: AgentHost;
  readonly executionRun?: ThreadExecutionRun;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const pendingEvents = takeDurableThreadEvents(buffer);
  const eventLogEnabled = executionHost?.store.threadEvents !== undefined;
  if (
    !(executionHost && executionRun) &&
    (!eventLogEnabled || pendingEvents.length === 0)
  ) {
    try {
      await state.commit();
    } catch (error) {
      restoreDurableThreadEvents(buffer, pendingEvents);
      throw error;
    }
    return;
  }

  try {
    await state.commitWith(async (commit) => {
      const persist = async (tx: HostStoreTransaction) => {
        const result = await tx.threads.commit(commit.key, commit.next, {
          expectedVersion: commit.expectedVersion,
        });
        if (!result.ok) {
          return result;
        }
        if (eventLogEnabled && pendingEvents.length > 0) {
          await appendDurableThreadEvents(
            transactionalThreadEvents(tx),
            threadKey,
            pendingEvents
          );
        }
        return result;
      };
      if (executionRun) {
        return await executionRun.commitOwned(persist);
      }
      return await executionHost.store.transaction(persist);
    });
  } catch (error) {
    restoreDurableThreadEvents(buffer, pendingEvents);
    throw error;
  }
}

export async function commitTerminalThreadStateAndEvents({
  buffer,
  executionHost,
  executionRun,
  state,
  status,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly executionHost?: AgentHost;
  readonly executionRun?: ThreadExecutionRun;
  readonly state: ThreadState;
  readonly status: ThreadExecutionTerminalStatus;
  readonly threadKey: string;
}): Promise<void> {
  if (!executionRun) {
    await commitThreadStateAndEvents({
      buffer,
      executionHost,
      state,
      threadKey,
    });
    return;
  }

  const pendingEvents = takeDurableThreadEvents(buffer);
  const eventLogEnabled = executionHost?.store.threadEvents !== undefined;
  try {
    await state.commitWith(
      async (commit) =>
        await executionRun.settle(status, async (tx) => {
          const result = await tx.threads.commit(commit.key, commit.next, {
            expectedVersion: commit.expectedVersion,
          });
          if (!result.ok) {
            return result;
          }
          if (eventLogEnabled && pendingEvents.length > 0) {
            await appendDurableThreadEvents(
              transactionalThreadEvents(tx),
              threadKey,
              pendingEvents
            );
          }
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
  executionRun,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly executionHost?: AgentHost;
  readonly executionRun?: ThreadExecutionRun;
  readonly threadKey: string;
}): Promise<void> {
  const pendingEvents = takeDurableThreadEvents(buffer);
  const eventLog = executionHost?.store.threadEvents;
  if (!eventLog || pendingEvents.length === 0) {
    return;
  }

  try {
    const append = async (tx: HostStoreTransaction) => {
      await appendDurableThreadEvents(
        transactionalThreadEvents(tx),
        threadKey,
        pendingEvents
      );
    };
    if (executionRun) {
      await executionRun.commitOwned(append);
    } else {
      await executionHost.store.transaction(append);
    }
  } catch (error) {
    restoreDurableThreadEvents(buffer, pendingEvents);
    throw error;
  }
}
