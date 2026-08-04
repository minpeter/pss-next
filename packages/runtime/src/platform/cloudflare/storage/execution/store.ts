import type {
  CheckpointStore,
  EventStore,
  HostStore,
  HostStoreTransaction,
  NotificationInbox,
  ThreadEventLog,
  ThreadInputInbox,
  TurnStore,
} from "../../../../execution";
import type { ThreadStore } from "../../../../index";
import type { SqlStorage } from "../../sql/ports/storage-port";
import {
  type CloudflareDurableObjectStorage,
  isSqlStorage,
  withSqlStorage,
} from "../durable-object/durable-object-storage";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import { DurableObjectSqliteCheckpointStore } from "../sqlite/checkpoint-store";
import { DurableObjectSqliteEventStore } from "../sqlite/event-store";
import { DurableObjectSqliteThreadEventLog } from "../sqlite/thread-event-log";
import { DurableObjectSqliteThreadStore } from "../sqlite/thread-store";
import { DurableObjectThreadInputInbox } from "./input-store";
import { DurableObjectNotificationInbox } from "./notification-store";
import { storeKey } from "./records";
import { DurableObjectRunStore } from "./run-store";

export class DurableObjectExecutionStore implements HostStore {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly inputs: ThreadInputInbox;
  readonly notifications: NotificationInbox;
  readonly threadEvents: ThreadEventLog;
  readonly turns: TurnStore;
  readonly threads: ThreadStore;
  readonly #maxPayloadBytes: number;
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor({
    maxPayloadBytes,
    prefix = "pss-runtime",
    storage,
  }: {
    readonly maxPayloadBytes?: StoragePayloadBudgetOptions["maxPayloadBytes"];
    readonly prefix?: string;
    readonly storage: CloudflareDurableObjectStorage;
  }) {
    this.#maxPayloadBytes = maxPayloadBytes ?? resolveStoragePayloadMaxBytes();
    this.#prefix = prefix;
    this.#storage = storage;
    const payloadBudget = { maxPayloadBytes: this.#maxPayloadBytes };
    this.checkpoints = new DurableObjectSqliteCheckpointStore(
      storage,
      prefix,
      payloadBudget
    );
    this.events = new DurableObjectSqliteEventStore(
      storage,
      prefix,
      payloadBudget
    );
    this.threadEvents = new DurableObjectSqliteThreadEventLog(
      storage,
      prefix,
      payloadBudget
    );
    this.notifications = new DurableObjectNotificationInbox(
      storage,
      prefix,
      payloadBudget
    );
    this.inputs = new DurableObjectThreadInputInbox(
      storage,
      prefix,
      payloadBudget
    );
    this.turns = new DurableObjectRunStore(storage, prefix, payloadBudget);
    this.threads = new DurableObjectSqliteThreadStore(
      storage,
      prefix,
      payloadBudget
    );
  }

  get sessions(): ThreadStore {
    return this.threads;
  }

  async deleteThread(threadKey: string): Promise<void> {
    await this.transaction((tx) => {
      const store = tx as DurableObjectExecutionStore;
      deleteThreadRows(
        store.#storage.sql as SqlStorage,
        store.#prefix,
        threadKey
      );
      return Promise.resolve();
    });
  }

  async transaction<T>(
    fn: (tx: HostStoreTransaction) => Promise<T>
  ): Promise<T> {
    if (this.#storage.transaction) {
      return await this.#storage.transaction((storage) =>
        fn(
          new DurableObjectExecutionStore({
            maxPayloadBytes: this.#maxPayloadBytes,
            prefix: this.#prefix,
            storage: withSqlStorage(storage, storage.sql ?? this.#storage.sql),
          })
        )
      );
    }

    const sql = transactionalSqlStorage(this.#storage.sql);
    if (sql) {
      return await sql.transaction(() =>
        fn(
          new DurableObjectExecutionStore({
            maxPayloadBytes: this.#maxPayloadBytes,
            prefix: this.#prefix,
            storage: withSqlStorage(this.#storage, sql),
          })
        )
      );
    }

    throw new Error(
      "DurableObjectExecutionStore requires Durable Object storage.transaction or storage.sql.transaction for atomic transactions."
    );
  }
}

interface TransactionalSqlStorage extends SqlStorage {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

function transactionalSqlStorage(
  value: unknown
): TransactionalSqlStorage | undefined {
  if (!isSqlStorage(value)) {
    return;
  }
  const transaction = value.transaction?.bind(value);
  if (!transaction) {
    return;
  }
  return {
    exec: (query, ...bindings) => value.exec(query, ...bindings),
    transaction: (fn) => transaction(fn),
    ...(value.transactionSync
      ? { transactionSync: (fn) => value.transactionSync?.(fn) ?? fn() }
      : {}),
  };
}

function deleteThreadRows(
  sql: SqlStorage,
  prefix: string,
  threadKey: string
): void {
  const threadRowKey = storeKey(prefix, "thread", threadKey);
  const threadEventKey = storeKey(prefix, "thread-events", threadKey);
  const runIds = selectThreadRunIds(sql, prefix, threadKey);
  const notificationKeys = selectThreadNotificationKeys(sql, prefix, threadKey);

  deleteThreadPayloadChunks(
    sql,
    prefix,
    threadKey,
    threadEventKey,
    runIds,
    notificationKeys
  );
  deleteRowsByKey(sql, threadRowKey, [
    ["pss_thread_message_chunk", "thread_key"],
    ["pss_thread_message", "thread_key"],
    ["pss_thread_compaction", "thread_key"],
    ["pss_thread_meta", "thread_key"],
  ]);
  deleteRowsByKey(sql, threadEventKey, [
    ["pss_thread_event", "thread_key"],
    ["pss_thread_event_meta", "thread_key"],
  ]);
  deleteRunRows(sql, prefix, runIds);
  deleteDirectThreadRows(sql, prefix, threadKey, runIds);
}

function selectThreadRunIds(
  sql: SqlStorage,
  prefix: string,
  threadKey: string
): string[] {
  if (!hasTable(sql, "pss_run")) {
    return [];
  }
  return sql
    .exec<{ readonly run_id: string }>(
      "SELECT run_id FROM pss_run WHERE prefix = ? AND thread_key = ?",
      prefix,
      threadKey
    )
    .toArray()
    .map((row) => row.run_id);
}

function selectThreadNotificationKeys(
  sql: SqlStorage,
  prefix: string,
  threadKey: string
): string[] {
  if (!hasTable(sql, "pss_notification")) {
    return [];
  }
  return sql
    .exec<{ readonly idempotency_key: string }>(
      "SELECT idempotency_key FROM pss_notification WHERE prefix = ? AND thread_key = ?",
      prefix,
      threadKey
    )
    .toArray()
    .map((row) => row.idempotency_key);
}

function deleteThreadPayloadChunks(
  sql: SqlStorage,
  prefix: string,
  threadKey: string,
  threadEventKey: string,
  runIds: readonly string[],
  notificationKeys: readonly string[]
): void {
  if (!hasTable(sql, "pss_payload_chunk")) {
    return;
  }
  deletePayloadChunks(sql, "thread-input", `${prefix}:${threadKey}`);
  deletePayloadChunks(sql, "thread-event", threadEventKey);
  for (const runId of runIds) {
    deletePayloadChunks(sql, "event", storeKey(prefix, "events", runId));
    deletePayloadChunks(
      sql,
      "checkpoint",
      storeKey(prefix, "checkpoints", runId)
    );
  }
  for (const key of notificationKeys) {
    sql.exec(
      "DELETE FROM pss_payload_chunk WHERE scope = ? AND owner_key = ? AND payload_key = ?",
      "notification",
      prefix,
      key
    );
  }
}

function deletePayloadChunks(
  sql: SqlStorage,
  scope: string,
  ownerKey: string
): void {
  sql.exec(
    "DELETE FROM pss_payload_chunk WHERE scope = ? AND owner_key = ?",
    scope,
    ownerKey
  );
}

function deleteRowsByKey(
  sql: SqlStorage,
  key: string,
  tables: readonly (readonly [string, string])[]
): void {
  for (const [table, column] of tables) {
    if (hasTable(sql, table)) {
      sql.exec(`DELETE FROM ${table} WHERE ${column} = ?`, key);
    }
  }
}

function deleteRunRows(
  sql: SqlStorage,
  prefix: string,
  runIds: readonly string[]
): void {
  for (const runId of runIds) {
    deleteRowsByKey(sql, storeKey(prefix, "events", runId), [
      ["pss_event", "run_key"],
      ["pss_event_meta", "run_key"],
    ]);
    deleteRowsByKey(sql, storeKey(prefix, "checkpoints", runId), [
      ["pss_checkpoint", "run_key"],
    ]);
  }
}

function deleteDirectThreadRows(
  sql: SqlStorage,
  prefix: string,
  threadKey: string,
  runIds: readonly string[]
): void {
  if (hasTable(sql, "pss_scheduled_work")) {
    sql.exec(
      "DELETE FROM pss_scheduled_work WHERE prefix = ? AND thread_key = ?",
      prefix,
      threadKey
    );
    for (const runId of runIds) {
      sql.exec(
        "DELETE FROM pss_scheduled_work WHERE prefix = ? AND run_id = ?",
        prefix,
        runId
      );
    }
  }
  for (const table of ["pss_notification", "pss_thread_input", "pss_run"]) {
    if (hasTable(sql, table)) {
      sql.exec(
        `DELETE FROM ${table} WHERE prefix = ? AND thread_key = ?`,
        prefix,
        threadKey
      );
    }
  }
}

function hasTable(sql: SqlStorage, table: string): boolean {
  return sql.exec(`PRAGMA table_info(${table})`).toArray().length > 0;
}
