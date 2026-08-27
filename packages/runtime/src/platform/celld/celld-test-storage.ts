import { InMemoryCloudflareDurableObjectStorage } from "../cloudflare/host/durable-object-host";
import type { SqlStorage } from "../cloudflare/sql/ports/storage-port";
import type { CloudflareDurableObjectTransactionStorage } from "../cloudflare/storage/durable-object/durable-object-storage";
import type { CelldDurableObjectStorage } from "./scheduler-support";

interface TestStorageOptions {
  readonly setAlarm?: (scheduledTime: Date | number) => Promise<void>;
}

export function createCelldTestStorage(
  options: TestStorageOptions = {}
): CelldDurableObjectStorage & { readonly sql: SqlStorage } {
  const inner = new InMemoryCloudflareDurableObjectStorage();
  let alarmTime: number | null = null;
  const setAlarm = async (
    scheduledTime: Date | number,
    delegate: CloudflareDurableObjectTransactionStorage["setAlarm"]
  ): Promise<void> => {
    await options.setAlarm?.(scheduledTime);
    alarmTime =
      typeof scheduledTime === "number"
        ? scheduledTime
        : scheduledTime.getTime();
    await delegate?.(scheduledTime);
  };
  return {
    delete: (key) => inner.delete(key),
    deleteAlarm: () => {
      alarmTime = null;
      return Promise.resolve();
    },
    get: (key) => inner.get(key),
    getAlarm: () => Promise.resolve(alarmTime),
    put: (key, value) => inner.put(key, value),
    setAlarm: (scheduledTime) =>
      setAlarm(scheduledTime, inner.setAlarm.bind(inner)),
    sql: inner.sql,
    transaction: async <T>(
      operation: (
        storage: CloudflareDurableObjectTransactionStorage
      ) => Promise<T>
    ): Promise<T> => {
      const previousAlarm = alarmTime;
      try {
        return await inner.transaction((transaction) =>
          operation({
            delete: (key) => transaction.delete(key),
            get: (key) => transaction.get(key),
            put: (key, value) => transaction.put(key, value),
            setAlarm: (scheduledTime) =>
              setAlarm(
                scheduledTime,
                (time) => transaction.setAlarm?.(time) ?? Promise.resolve()
              ),
            sql: transaction.sql ?? inner.sql,
          })
        );
      } catch (error) {
        alarmTime = previousAlarm;
        throw error;
      }
    },
    transactionSync: inner.transactionSync.bind(inner),
  };
}
