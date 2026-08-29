import { describe, expect, it } from "vitest";
import type { StoredThreadEvent } from "../../../../execution";
import { InMemoryDurableObjectSqlStorage } from "../../sql/durable-object-test/storage";
import type { DurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "./store";

describe("DurableObjectExecutionStore transactions", () => {
  it("uses SQL transactions when Durable Object storage transactions are unavailable", async () => {
    const store = new DurableObjectExecutionStore({
      prefix: "sql-only-transaction-test",
      storage: new SqlOnlyStorage(),
    });

    await expect(
      store.transaction(async (tx) => {
        await tx.threads.commit(
          "thread-1",
          { state: { messages: ["inside transaction"] } },
          { expectedVersion: null }
        );
        const threadEvents = tx.threadEvents;
        if (!threadEvents) {
          throw new Error("expected thread event log");
        }
        await threadEvents.append("thread-1", { type: "turn-start" });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");

    await expect(store.threads.load("thread-1")).resolves.toBeNull();
    await expect(
      collectThreadEvents(store.threadEvents.read("thread-1"))
    ).resolves.toEqual([]);
  });
});

class SqlOnlyStorage implements DurableObjectStorage {
  readonly sql = new InMemoryDurableObjectSqlStorage();
  readonly #values = new Map<string, unknown>();

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#values.delete(key));
  }

  get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return Promise.resolve(
      value === undefined ? undefined : (structuredClone(value) as T)
    );
  }

  put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

async function collectThreadEvents(
  events: AsyncIterable<StoredThreadEvent>
): Promise<StoredThreadEvent[]> {
  const collected: StoredThreadEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
