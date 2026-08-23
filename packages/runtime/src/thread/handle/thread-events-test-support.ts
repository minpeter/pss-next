import type { AgentHost, HostStoreTransaction } from "../../execution";

export async function collectThreadEvents<T>(
  events: AsyncIterable<T>
): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

export function hostWithOneUsageAppendFailure(
  base: AgentHost,
  onFailure: () => void
): AgentHost {
  let shouldFail = true;
  return {
    ...base,
    store: {
      checkpoints: base.store.checkpoints,
      events: base.store.events,
      inputs: base.store.inputs,
      notifications: base.store.notifications,
      threadEvents: base.store.threadEvents,
      threads: base.store.threads,
      transaction: (fn) =>
        base.store.transaction(async (tx) =>
          fn(transactionWithOneUsageAppendFailure(tx))
        ),
      turns: base.store.turns,
    },
  };

  function transactionWithOneUsageAppendFailure(
    tx: HostStoreTransaction
  ): HostStoreTransaction {
    const threadEvents = tx.threadEvents;
    if (!threadEvents) {
      return tx;
    }
    return {
      ...tx,
      threadEvents: {
        append: async (threadKey, event) => {
          if (shouldFail && event.type === "model-usage") {
            shouldFail = false;
            onFailure();
            throw new Error("transient usage event append failure");
          }
          return await threadEvents.append(threadKey, event);
        },
        read: (threadKey, options) => threadEvents.read(threadKey, options),
      },
    };
  }
}

export function hostWithTurnErrorAppendFailure(base: AgentHost): AgentHost {
  return {
    ...base,
    store: {
      checkpoints: base.store.checkpoints,
      events: base.store.events,
      inputs: base.store.inputs,
      notifications: base.store.notifications,
      threadEvents: base.store.threadEvents,
      threads: base.store.threads,
      transaction: (fn) =>
        base.store.transaction(async (tx) =>
          fn(transactionWithTurnErrorAppendFailure(tx))
        ),
      turns: base.store.turns,
    },
  };

  function transactionWithTurnErrorAppendFailure(
    tx: HostStoreTransaction
  ): HostStoreTransaction {
    const threadEvents = tx.threadEvents;
    if (!threadEvents) {
      return tx;
    }
    return {
      ...tx,
      threadEvents: {
        append: async (threadKey, event) => {
          if (event.type === "turn-error") {
            throw new Error("turn error append failure");
          }
          return await threadEvents.append(threadKey, event);
        },
        read: (threadKey, options) => threadEvents.read(threadKey, options),
      },
    };
  }
}
