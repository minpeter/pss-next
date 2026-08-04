import { describe, expect, it } from "vitest";
import { describeExecutionStoreContract } from "../../../../contracts/execution-store/contract";
import type { NotificationRecord, TurnRecord } from "../../../../execution";
import {
  createCloudflareStorageHost,
  InMemoryCloudflareDurableObjectStorage as PublicInMemoryCloudflareDurableObjectStorage,
} from "../../host/durable-object-host";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import type {
  SqlStorage,
  SqlStorageCursorLike,
} from "../../sql/ports/storage-port";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "./store";

describeExecutionStoreContract({
  createStore: () =>
    new DurableObjectExecutionStore({
      prefix: "contract-test",
      storage: new InMemoryCloudflareDurableObjectStorage({
        sql: new TransactionalInMemorySqlStorage(),
      }),
    }),
  name: "DurableObjectExecutionStore",
});

describe("DurableObjectExecutionStore payload guards", () => {
  it("chunks notification records that exceed the serialized payload budget", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
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
    const storage = new InMemoryCloudflareDurableObjectStorage({
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
    const storage = new InMemoryCloudflareDurableObjectStorage({
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
      storage: new InMemoryCloudflareDurableObjectStorage(),
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
    const host = createCloudflareStorageHost({
      prefix: "default-sql-thread-input-test",
      storage: new PublicInMemoryCloudflareDurableObjectStorage(),
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

  it("deletes every SQLite row and payload chunk owned by a thread", async () => {
    const prefix = "aggregate-delete-test";
    const threadKey = "thread-1";
    const runId = "run-delete";
    const sql = new TransactionalInMemorySqlStorage();
    const storage = new InMemoryCloudflareDurableObjectStorage({ sql });
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
    const storage = new InMemoryCloudflareDurableObjectStorage({ sql });
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

const aggregateTables = [
  "pss_thread_input",
  "pss_thread_event",
  "pss_thread_event_meta",
  "pss_payload_chunk",
  "pss_event",
  "pss_event_meta",
  "pss_checkpoint",
  "pss_run",
  "pss_notification",
  "pss_scheduled_work",
  "pss_thread_message",
  "pss_thread_message_chunk",
  "pss_thread_compaction",
  "pss_thread_meta",
] as const;

type AggregateTable = (typeof aggregateTables)[number];

async function seedThreadAggregate(
  storage: InMemoryCloudflareDurableObjectStorage,
  sql: SqlStorage,
  prefix: string,
  threadKey: string,
  runId: string,
  suffix: string
): Promise<DurableObjectExecutionStore> {
  const store = new DurableObjectExecutionStore({
    maxPayloadBytes: 180,
    prefix,
    storage,
  });
  const largeText = `${suffix}:${"x".repeat(400)}`;
  await store.threads.commit(
    threadKey,
    {
      state: {
        appliedMigrations: { "workspace/sanitize": 2 },
        compactions: [
          {
            endSeqExclusive: 1,
            schemaVersion: 1,
            startSeq: 0,
            summary: { content: `${suffix} summary`, role: "system" },
          },
        ],
        history: [{ content: largeText, role: "user" }],
        schemaVersion: 3,
      },
    },
    { expectedVersion: null }
  );
  await store.inputs.admit({
    input: { text: largeText, type: "user-input" },
    kind: "send",
    messageId: `input-${suffix}`,
    threadKey,
  });
  await store.threadEvents.append(threadKey, {
    text: largeText,
    type: "assistant-output",
  });
  await store.turns.create(runRecord(runId, { threadKey }));
  await store.events.append(runId, {
    text: largeText,
    type: "assistant-output",
  });
  await store.checkpoints.append(
    {
      checkpointId: `checkpoint-${suffix}`,
      phase: "after-model",
      runId,
      runtimeState: { text: largeText },
      threadSnapshot: { threadKey },
      version: 1,
    },
    { expectedVersion: 0 }
  );
  await store.notifications.enqueue(
    notificationRecord(`notification-${suffix}`, {
      input: { text: largeText, type: "user-input" },
      runId,
      threadKey,
    })
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_scheduled_work (prefix TEXT NOT NULL, kind TEXT NOT NULL, work_id TEXT NOT NULL, payload TEXT NOT NULL, thread_key TEXT, run_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (prefix, kind, work_id))"
  );
  sql.exec(
    "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    prefix,
    "thread-prompt",
    `work-${suffix}`,
    "{}",
    threadKey,
    runId,
    1
  );
  return store;
}

function rowCounts(sql: SqlStorage): Record<AggregateTable, number> {
  return Object.fromEntries(
    aggregateTables.map((table) => [table, rowCount(sql, table)])
  ) as Record<AggregateTable, number>;
}

function payloadScopeCounts(sql: SqlStorage): Record<string, number> {
  return Object.fromEntries(
    sql
      .exec<{ readonly count: number; readonly scope: string }>(
        "SELECT scope, COUNT(*) AS count FROM pss_payload_chunk GROUP BY scope"
      )
      .toArray()
      .map((row) => [row.scope, row.count])
  );
}

function rowCount(sql: SqlStorage, table: string): number {
  return (
    sql
      .exec<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM ${table}`
      )
      .toArray()[0]?.count ?? 0
  );
}

function createBudgetedStore(
  maxPayloadBytes: number
): DurableObjectExecutionStore {
  return new DurableObjectExecutionStore({
    maxPayloadBytes,
    prefix: "payload-test",
    storage: new InMemoryCloudflareDurableObjectStorage(),
  });
}

class TransactionalInMemorySqlStorage implements SqlStorage {
  #failureFragment: string | undefined;
  readonly #storage = new InMemorySqlStorage();

  failNext(queryFragment: string): void {
    this.#failureFragment = queryFragment.toLowerCase();
  }

  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T> {
    if (
      this.#failureFragment &&
      query.toLowerCase().includes(this.#failureFragment)
    ) {
      this.#failureFragment = undefined;
      throw new Error("injected SQL failure");
    }
    return this.#storage.exec<T>(query, ...bindings);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#storage.exec("BEGIN");
    try {
      const result = await fn();
      this.#storage.exec("COMMIT");
      return result;
    } catch (error) {
      this.#storage.exec("ROLLBACK");
      throw error;
    }
  }
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
