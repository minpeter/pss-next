import { InMemorySqlStorage } from "../sql/node-test/node-sqlite-storage";
import type {
  SqlStorage,
  SqlStorageCursorLike,
} from "../sql/ports/storage-port";
import {
  type DurableObjectTransactionStorage,
  InMemoryDurableObjectStorage,
} from "../storage/durable-object/durable-object-storage";
import type { CelldDurableObjectStorage } from "./scheduler-support";

export interface CelldSqliteTestStorageOptions {
  readonly deleteAlarm?: () => Promise<void>;
  readonly getAlarm?: () => Promise<void>;
  readonly setAlarm?: (scheduledTime: Date | number) => Promise<void>;
  readonly sqlFailure?: (query: string) => Error | undefined;
}

export interface CelldSqliteTestStorage extends CelldDurableObjectStorage {
  readonly sql: SqlStorage;
}

class FaultInjectingSqlStorage implements SqlStorage {
  readonly #inner = new InMemorySqlStorage();
  readonly #failure: CelldSqliteTestStorageOptions["sqlFailure"];

  constructor(failure: CelldSqliteTestStorageOptions["sqlFailure"]) {
    this.#failure = failure;
  }

  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T> {
    const error = this.#failure?.(query);
    if (error !== undefined) {
      throw error;
    }
    return this.#inner.exec<T>(query, ...bindings);
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    this.#inner.exec("BEGIN");
    try {
      const result = await operation();
      this.#inner.exec("COMMIT");
      return result;
    } catch (error) {
      this.#inner.exec("ROLLBACK");
      throw error;
    }
  }

  transactionSync<T>(operation: () => T): T {
    this.#inner.exec("BEGIN");
    try {
      const result = operation();
      this.#inner.exec("COMMIT");
      return result;
    } catch (error) {
      this.#inner.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createCelldSqliteTestStorage(
  options: CelldSqliteTestStorageOptions = {}
): CelldSqliteTestStorage {
  const sql = new FaultInjectingSqlStorage(options.sqlFailure);
  const values = new InMemoryDurableObjectStorage();
  let alarm: number | null = null;
  let transactionChain = Promise.resolve();

  const storage: CelldSqliteTestStorage = {
    delete: (key) => values.delete(key),
    deleteAlarm: async () => {
      await options.deleteAlarm?.();
      alarm = null;
    },
    get: <T>(key: string) => values.get<T>(key),
    getAlarm: async () => {
      await options.getAlarm?.();
      return alarm;
    },
    put: <T>(key: string, value: T) => values.put(key, value),
    setAlarm: async (scheduledTime) => {
      await options.setAlarm?.(scheduledTime);
      alarm = alarmValue(scheduledTime);
    },
    sql,
    transaction: async <T>(
      operation: (transaction: DurableObjectTransactionStorage) => Promise<T>
    ): Promise<T> => {
      const previous = transactionChain;
      let release: () => void = () => undefined;
      transactionChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const previousAlarm = alarm;
      let nextAlarm = alarm;
      try {
        const result = await sql.transaction(() =>
          operation({
            delete: storage.delete,
            get: storage.get,
            put: storage.put,
            setAlarm: async (scheduledTime) => {
              await options.setAlarm?.(scheduledTime);
              nextAlarm = alarmValue(scheduledTime);
            },
            sql,
          })
        );
        alarm = nextAlarm;
        return result;
      } catch (error) {
        alarm = previousAlarm;
        throw error;
      } finally {
        release();
      }
    },
    transactionSync: (operation) =>
      sql.transactionSync?.(operation) ?? operation(),
  };
  return storage;
}

function alarmValue(scheduledTime: Date | number): number {
  return typeof scheduledTime === "number"
    ? scheduledTime
    : scheduledTime.getTime();
}
