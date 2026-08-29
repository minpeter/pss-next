import { describe, expect, it } from "vitest";
import type { SqlStorage } from "../../sql/ports/storage-port";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectSqliteEventStore } from "./event-store";
import { DurableObjectSqliteThreadEventLog } from "./thread-event-log";

const PREFIX = "pss-runtime";

function createThrowingSql(reason: unknown): SqlStorage {
  return {
    exec: () => {
      throw reason;
    },
  };
}

async function expectAsynchronousRejection(
  operation: () => Promise<unknown>,
  reason: unknown
): Promise<void> {
  let result: Promise<unknown> | undefined;
  expect(() => {
    result = operation();
  }).not.toThrow();
  if (!result) {
    throw new Error("The storage operation did not return a Promise.");
  }
  await expect(result).rejects.toBe(reason);
}

describe("Durable Object SQLite event rejection", () => {
  it("rejects event append when SQLite throws a primitive", async () => {
    const reason = Symbol("event-sql-failure");
    const storage = new InMemoryDurableObjectStorage({
      sql: createThrowingSql(reason),
    });
    const store = new DurableObjectSqliteEventStore(storage, PREFIX);

    await expectAsynchronousRejection(
      () => store.append("run-1", { type: "turn-start" }),
      reason
    );
  });

  it("rejects thread event append when SQLite throws a primitive", async () => {
    const reason = Symbol("thread-event-sql-failure");
    const storage = new InMemoryDurableObjectStorage({
      sql: createThrowingSql(reason),
    });
    const eventLog = new DurableObjectSqliteThreadEventLog(storage, PREFIX);

    await expectAsynchronousRejection(
      () => eventLog.append("thread-1", { type: "turn-start" }),
      reason
    );
  });
});
