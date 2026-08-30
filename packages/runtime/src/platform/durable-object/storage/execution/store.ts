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
import type { ThreadStore } from "../../../../thread/store/types";
import type { SqlStorage } from "../../sql/ports/storage-port";
import {
  type DurableObjectStorage,
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
import { DurableObjectRunStore } from "./run-store";
import { deleteThreadRows } from "./store-thread-cleanup";
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
  readonly #storage: DurableObjectStorage;

  constructor({
    maxPayloadBytes,
    prefix = "pss-runtime",
    storage,
  }: {
    readonly maxPayloadBytes?: StoragePayloadBudgetOptions["maxPayloadBytes"];
    readonly prefix?: string;
    readonly storage: DurableObjectStorage;
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
