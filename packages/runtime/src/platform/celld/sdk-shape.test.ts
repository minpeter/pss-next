import { describe, expect, it } from "vitest";
import { InMemoryCloudflareDurableObjectStorage } from "../cloudflare";
import {
  type CelldDurableObjectState,
  type CelldDurableObjectStorage,
  createCelldHost,
  createCelldScheduler,
} from "./index";

const storage = new InMemoryCloudflareDurableObjectStorage();
const cloudflareStorage = {
  delete: (key: string) => storage.delete(key),
  getAlarm: async (): Promise<number | null> =>
    Promise.resolve(storage.alarmTime()?.valueOf() ?? null),
  get: <T>(key: string) => storage.get<T>(key),
  put: <T>(key: string, value: T) => storage.put(key, value),
  setAlarm: (scheduledTime: number | Date) => storage.setAlarm(scheduledTime),
  sql: storage.sql,
  transaction: storage.transaction.bind(storage),
  deleteAlarm: async (): Promise<void> => {
    await storage.setAlarm(0);
  },
} satisfies CelldDurableObjectStorage;

const state = {
  storage: cloudflareStorage,
  waitUntil: (_promise: Promise<unknown>): void => undefined,
} satisfies CelldDurableObjectState;

describe("Celld SDK structural shape", () => {
  it("accepts Durable Object storage and state without Celld or fiber SDK types", () => {
    const scheduler = createCelldScheduler({ storage: state.storage });
    const host = createCelldHost({ state });

    expect(scheduler).toBeDefined();
    expect(host).toBeDefined();
  });
});
