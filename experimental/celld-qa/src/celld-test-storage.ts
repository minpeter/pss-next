import type { CelldDurableObjectStorage } from "@minpeter/pss-runtime/platform/celld";
import {
  type CloudflareDurableObjectStorage,
  InMemoryCloudflareDurableObjectStorage,
  type SqlStorage,
} from "@minpeter/pss-runtime/platform/cloudflare";

export function createCelldTestStorage(): CelldDurableObjectStorage & {
  readonly sql: SqlStorage;
} {
  const inner = new InMemoryCloudflareDurableObjectStorage();
  let alarmTime: number | null = null;
  const storage: CelldDurableObjectStorage & { readonly sql: SqlStorage } = {
    delete: (key) => inner.delete(key),
    deleteAlarm: () => {
      alarmTime = null;
      return Promise.resolve();
    },
    get: (key) => inner.get(key),
    getAlarm: () => Promise.resolve(alarmTime),
    put: (key, value) => inner.put(key, value),
    setAlarm: async (scheduledTime) => {
      alarmTime = toMilliseconds(scheduledTime);
      await inner.setAlarm(scheduledTime);
    },
    sql: inner.sql,
    transaction: async (operation) => {
      const previousAlarm = alarmTime;
      try {
        return await inner.transaction((transaction) =>
          operation({
            delete: (key) => transaction.delete(key),
            get: (key) => transaction.get(key),
            put: (key, value) => transaction.put(key, value),
            setAlarm: async (scheduledTime) => {
              alarmTime = toMilliseconds(scheduledTime);
              await transaction.setAlarm?.(scheduledTime);
            },
            sql: transaction.sql ?? inner.sql,
          } satisfies CloudflareDurableObjectStorage)
        );
      } catch (error) {
        alarmTime = previousAlarm;
        throw error;
      }
    },
    transactionSync: inner.transactionSync.bind(inner),
  };
  return storage;
}

function toMilliseconds(scheduledTime: Date | number): number {
  return typeof scheduledTime === "number"
    ? scheduledTime
    : scheduledTime.getTime();
}
