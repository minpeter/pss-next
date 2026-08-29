import { describe, expect, it } from "vitest";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import {
  aggregateTables,
  payloadScopeCounts,
  rowCount,
  rowCounts,
  seedThreadAggregate,
  TransactionalInMemorySqlStorage,
} from "./store-delete-thread.test-support";

describe("DurableObjectExecutionStore aggregate deletion", () => {
  it("deletes every SQLite row and payload chunk owned by a thread", async () => {
    const prefix = "aggregate-delete-test";
    const threadKey = "thread-1";
    const runId = "run-delete";
    const sql = new TransactionalInMemorySqlStorage();
    const storage = new InMemoryDurableObjectStorage({ sql });
    const store = await seedThreadAggregate(
      storage,
      sql,
      prefix,
      threadKey,
      runId,
      "delete"
    );
    const deletedCounts = rowCounts(sql);
    expect(payloadScopeCounts(sql)).toEqual({
      checkpoint: expect.any(Number),
      event: expect.any(Number),
      notification: expect.any(Number),
      "thread-event": expect.any(Number),
      "thread-input": expect.any(Number),
    });
    expect(
      Object.values(payloadScopeCounts(sql)).every((count) => count > 0)
    ).toBe(true);
    await seedThreadAggregate(
      storage,
      sql,
      prefix,
      "thread-2",
      "run-keep-thread",
      "keep-thread"
    );
    const otherPrefixStore = await seedThreadAggregate(
      storage,
      sql,
      "aggregate-delete-other-prefix",
      threadKey,
      "run-keep-prefix",
      "keep-prefix"
    );
    const beforeDelete = rowCounts(sql);

    await store.deleteThread(threadKey);
    await store.deleteThread(threadKey);

    for (const table of aggregateTables) {
      expect(rowCount(sql, table), table).toBe(
        beforeDelete[table] - deletedCounts[table]
      );
    }
    await expect(store.threads.load("thread-2")).resolves.not.toBeNull();
    await expect(store.turns.get("run-keep-thread")).resolves.not.toBeNull();
    await expect(
      otherPrefixStore.threads.load(threadKey)
    ).resolves.not.toBeNull();
    await expect(
      otherPrefixStore.turns.get("run-keep-prefix")
    ).resolves.not.toBeNull();
  });

  it("rolls back aggregate deletion when SQL fails mid-transaction", async () => {
    const prefix = "aggregate-delete-rollback";
    const threadKey = "thread-rollback";
    const runId = "run-rollback";
    const sql = new TransactionalInMemorySqlStorage();
    const storage = new InMemoryDurableObjectStorage({ sql });
    const store = await seedThreadAggregate(
      storage,
      sql,
      prefix,
      threadKey,
      runId,
      "rollback"
    );
    const beforeDelete = rowCounts(sql);
    sql.failNext("delete from pss_checkpoint");

    await expect(store.deleteThread(threadKey)).rejects.toThrow(
      "injected SQL failure"
    );

    expect(rowCounts(sql)).toEqual(beforeDelete);
    await expect(store.threads.load(threadKey)).resolves.not.toBeNull();
    await expect(store.turns.get(runId)).resolves.not.toBeNull();
    await expect(store.checkpoints.latest(runId)).resolves.not.toBeNull();
    await expect(
      store.notifications.getByIdempotencyKey("notification-rollback")
    ).resolves.not.toBeNull();
  });
});
