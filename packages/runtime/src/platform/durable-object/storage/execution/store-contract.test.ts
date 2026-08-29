import { describe, expect, it } from "vitest";
import { describeExecutionStoreContract } from "../../../../contracts/execution-store/contract";
import type { NotificationRecord, TurnRecord } from "../../../../execution";
import {
  createDurableObjectStorageHost,
  InMemoryDurableObjectStorage as PublicInMemoryDurableObjectStorage,
} from "../../host/storage-host";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "./store";
import { TransactionalInMemorySqlStorage } from "./store-delete-thread.test-support";

describeExecutionStoreContract({
  createStore: () =>
    new DurableObjectExecutionStore({
      prefix: "contract-test",
      storage: new InMemoryDurableObjectStorage({
        sql: new TransactionalInMemorySqlStorage(),
      }),
    }),
  name: "DurableObjectExecutionStore",
});

describe("DurableObjectExecutionStore payload guards", () => {
  it("chunks notification records that exceed the serialized payload budget", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const store = new DurableObjectExecutionStore({
      maxPayloadBytes: 220,
      prefix: "notification-payload-test",
      storage,
    });
    const record = notificationRecord("notify-big", {
      input: { text: "x".repeat(300), type: "user-input" },
    });

    await expect(store.notifications.enqueue(record)).resolves.toEqual({
      ok: true,
    });
    await expect(
      store.notifications.getByIdempotencyKey("notify-big")
    ).resolves.toEqual(record);
    const chunkRows = (storage.sql as InMemorySqlStorage)
      .exec<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM pss_payload_chunk WHERE scope = ?",
        "notification"
      )
      .toArray()[0];
    expect(chunkRows?.count).toBeGreaterThan(0);
  });

  it("rejects run records on create when they exceed the serialized payload budget", async () => {
    const store = createBudgetedStore(180);

    await expect(
      store.turns.create(
        runRecord("run-create", { output: { notes: "x".repeat(240) } })
      )
    ).rejects.toMatchObject({
      byteLength: expect.any(Number),
      maxBytes: 180,
      payloadKind: "run-record",
    });
    await expect(store.turns.get("run-create")).resolves.toBeNull();
  });

  it("rejects run records on update when they exceed the serialized payload budget", async () => {
    const store = createBudgetedStore(180);
    await store.turns.create(runRecord("run-update"));

    await expect(
      store.turns.update(
        runRecord("run-update", { output: { notes: "x".repeat(240) } })
      )
    ).rejects.toMatchObject({
      byteLength: expect.any(Number),
      maxBytes: 180,
      payloadKind: "run-record",
    });
    await expect(store.turns.get("run-update")).resolves.toEqual(
      runRecord("run-update")
    );
  });

  it("stores run records in SQLite rows instead of Durable Object KV values", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const store = new DurableObjectExecutionStore({
      prefix: "run-sql-test",
      storage,
    });
    const record = runRecord("run-sql", {
      dedupeKey: "dedupe-1",
      parentRunId: "parent-1",
    });

    await store.turns.create(record);

    const rows = (storage.sql as InMemorySqlStorage)
      .exec<{ readonly record: string }>(
        "SELECT record FROM pss_run WHERE prefix = ? AND run_id = ?",
        "run-sql-test",
        "run-sql"
      )
      .toArray();
    expect(rows.map((row) => JSON.parse(row.record))).toEqual([record]);
    await expect(store.turns.getByDedupeKey("dedupe-1")).resolves.toEqual(
      record
    );
    await expect(store.turns.listByParentRunId("parent-1")).resolves.toEqual([
      record,
    ]);
  });

  it("stores notification records in SQLite rows instead of Durable Object KV values", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const store = new DurableObjectExecutionStore({
      prefix: "notification-sql-test",
      storage,
    });
    const record = notificationRecord("notify-sql");

    await expect(store.notifications.enqueue(record)).resolves.toEqual({
      ok: true,
    });

    const rows = (storage.sql as InMemorySqlStorage)
      .exec<{ readonly record: string }>(
        "SELECT record FROM pss_notification WHERE prefix = ? AND idempotency_key = ?",
        "notification-sql-test",
        "notify-sql"
      )
      .toArray();
    expect(rows.map((row) => JSON.parse(row.record))).toEqual([record]);
  });

  it("round-trips chunked thread messages with the default Durable Object SQL test storage", async () => {
    const store = new DurableObjectExecutionStore({
      maxPayloadBytes: 80,
      prefix: "default-sql-thread-chunk-test",
      storage: new InMemoryDurableObjectStorage(),
    });
    const message = { content: "x".repeat(160), role: "user" };

    await expect(
      store.threads.commit(
        "thread-1",
        {
          state: {
            appliedMigrations: { "workspace/sanitize": 2 },
            compactions: [],
            history: [message],
            schemaVersion: 3,
          },
        },
        { expectedVersion: null }
      )
    ).resolves.toEqual({ ok: true, version: "1" });
    await expect(store.threads.load("thread-1")).resolves.toEqual({
      state: {
        appliedMigrations: { "workspace/sanitize": 2 },
        compactions: [],
        history: [message],
        schemaVersion: 3,
      },
      version: "1",
    });
  });

  it("round-trips thread inputs with the public default Durable Object SQL test storage", async () => {
    const host = createDurableObjectStorageHost({
      prefix: "default-sql-thread-input-test",
      storage: new PublicInMemoryDurableObjectStorage(),
    });

    await expect(
      host.store.inputs.admit({
        admittedAtMs: 10,
        input: { text: "default storage input", type: "user-input" },
        kind: "send",
        messageId: "input-default-storage",
        threadKey: "thread-1",
      })
    ).resolves.toMatchObject({
      duplicate: false,
      record: {
        messageId: "input-default-storage",
        status: "pending",
      },
    });
    await expect(
      host.store.inputs.claimNext("thread-1", "turn-idle")
    ).resolves.toMatchObject({
      messageId: "input-default-storage",
      status: "claiming",
    });
    await host.store.deleteThread?.("thread-1");
    await expect(
      host.store.inputs.claimNext("thread-1", "turn-idle")
    ).resolves.toBeNull();
  });
});

function createBudgetedStore(
  maxPayloadBytes: number
): DurableObjectExecutionStore {
  return new DurableObjectExecutionStore({
    maxPayloadBytes,
    prefix: "payload-test",
    storage: new InMemoryDurableObjectStorage(),
  });
}

function runRecord(
  runId: string,
  overrides: Partial<TurnRecord> = {}
): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    threadKey: "thread-1",
    status: "queued",
    ...overrides,
  };
}

function notificationRecord(
  idempotencyKey: string,
  overrides: Partial<NotificationRecord> = {}
): NotificationRecord {
  return {
    idempotencyKey,
    input: { text: "wake up", type: "user-input" },
    notificationId: "notification-1",
    runId: "run-1",
    threadKey: "thread-1",
    status: "pending",
    ...overrides,
  };
}
