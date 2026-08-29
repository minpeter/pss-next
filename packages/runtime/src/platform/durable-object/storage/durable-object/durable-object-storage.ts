import { InMemoryDurableObjectSqlStorage } from "../../sql/durable-object-test/storage";
import type { SqlStorage } from "../../sql/ports/storage-port";

export interface DurableObjectTransactionStorage {
  delete(key: string): Promise<unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm?(scheduledTime: Date | number): Promise<void>;
  readonly sql?: unknown;
}

export interface DurableObjectStorage extends DurableObjectTransactionStorage {
  readonly sql: unknown;
  transaction?<T>(
    fn: (storage: DurableObjectTransactionStorage) => Promise<T>
  ): Promise<T>;
  transactionSync?<T>(fn: () => T): T;
}

export function withSqlStorage(
  storage: DurableObjectTransactionStorage,
  sql: unknown
): DurableObjectStorage {
  const withSql: DurableObjectStorage = {
    delete: (key) => storage.delete(key),
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    sql,
    transaction: (fn) => fn(withSql),
    transactionSync: (fn) => fn(),
  };
  if (storage.setAlarm) {
    withSql.setAlarm = (time) => storage.setAlarm?.(time) ?? Promise.resolve();
  }
  return withSql;
}

export class InMemoryDurableObjectStorage implements DurableObjectStorage {
  readonly sql: SqlStorage;
  #alarmTime: Date | number | undefined;
  #transactionChain: Promise<void> = Promise.resolve();
  #values = new Map<string, unknown>();

  constructor(options: { readonly sql?: SqlStorage } = {}) {
    this.sql = options.sql ?? new InMemoryDurableObjectSqlStorage();
  }

  alarmTime(): Date | number | undefined {
    return this.#alarmTime;
  }

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

  setAlarm(scheduledTime: Date | number): Promise<void> {
    this.#alarmTime = scheduledTime;
    return Promise.resolve();
  }

  async transaction<T>(
    fn: (storage: DurableObjectTransactionStorage) => Promise<T>
  ): Promise<T> {
    const previousTransaction = this.#transactionChain;
    let releaseTransaction: () => void = () => undefined;
    this.#transactionChain = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await previousTransaction;

    const transactionValues = cloneMap(this.#values);
    let transactionAlarmTime = this.#alarmTime;
    const transactionStorage = new TransactionalDurableObjectStorage({
      setAlarm: (scheduledTime) => {
        transactionAlarmTime = scheduledTime;
      },
      sql: this.sql,
      values: transactionValues,
    });

    try {
      const result = await runSqlTransaction(this.sql, () =>
        fn(transactionStorage)
      );
      this.#values = transactionValues;
      this.#alarmTime = transactionAlarmTime;
      return result;
    } finally {
      releaseTransaction();
    }
  }

  transactionSync<T>(fn: () => T): T {
    const previousValues = cloneMap(this.#values);
    const previousAlarmTime = this.#alarmTime;
    const sql = this.sql;

    if (isTransactionalSyncSqlStorage(sql)) {
      return sql.transactionSync(() => {
        try {
          return fn();
        } catch (error) {
          this.#values = previousValues;
          this.#alarmTime = previousAlarmTime;
          throw error;
        }
      });
    }

    try {
      return fn();
    } catch (error) {
      this.#values = previousValues;
      this.#alarmTime = previousAlarmTime;
      throw error;
    }
  }
}

class TransactionalDurableObjectStorage
  implements DurableObjectTransactionStorage
{
  readonly #setAlarm: (scheduledTime: Date | number) => void;
  readonly sql: SqlStorage;
  readonly #values: Map<string, unknown>;

  constructor({
    setAlarm,
    sql,
    values,
  }: {
    readonly setAlarm: (scheduledTime: Date | number) => void;
    readonly sql: SqlStorage;
    readonly values: Map<string, unknown>;
  }) {
    this.#setAlarm = setAlarm;
    this.sql = sql;
    this.#values = values;
  }

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

  setAlarm(scheduledTime: Date | number): Promise<void> {
    this.#setAlarm(scheduledTime);
    return Promise.resolve();
  }
}

function cloneMap(values: Map<string, unknown>): Map<string, unknown> {
  return new Map(
    [...values.entries()].map(([key, value]) => [key, structuredClone(value)])
  );
}

interface TransactionalSqlStorage extends SqlStorage {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

interface TransactionalSyncSqlStorage extends SqlStorage {
  transactionSync<T>(fn: () => T): T;
}

async function runSqlTransaction<T>(
  sql: unknown,
  fn: () => Promise<T>
): Promise<T> {
  if (isTransactionalSqlStorage(sql)) {
    return await sql.transaction(fn);
  }

  return await fn();
}

function isTransactionalSqlStorage(
  value: unknown
): value is TransactionalSqlStorage {
  return (
    isSqlStorage(value) &&
    "transaction" in value &&
    typeof value.transaction === "function"
  );
}

function isTransactionalSyncSqlStorage(
  value: unknown
): value is TransactionalSyncSqlStorage {
  return (
    isSqlStorage(value) &&
    "transactionSync" in value &&
    typeof value.transactionSync === "function"
  );
}

export function isSqlStorage(value: unknown): value is SqlStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    "exec" in value &&
    typeof value.exec === "function"
  );
}
