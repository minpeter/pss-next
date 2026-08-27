import { describe, expect, it } from "vitest";
import { describeAgentHostFaultContract } from "../../contracts/agent-host-fault-contract";
import { InMemoryCloudflareDurableObjectStorage } from "../cloudflare/host/durable-object-host";
import { createCelldHost } from "./host";

let hostPrefix = 0;

describeAgentHostFaultContract({
  createHost: () => ({
    host: createCelldHost({
      prefix: `celld-host-contract-${hostPrefix++}`,
      state: createState(),
    }),
  }),
  name: "Celld",
});

describe("createCelldHost", () => {
  it("composes Cloudflare storage ports with the Celld scheduler", async () => {
    const state = createState();
    const host = createCelldHost({ state });

    expect(host.store).toBeDefined();
    expect(host.attachmentStore).toBeDefined();
    expect(host.diagnostics).toBeDefined();
    expect(host.scheduler).toBeDefined();

    await host.scheduler.enqueueRun("celld-run");

    await expect(state.storage.getAlarm()).resolves.toBeDefined();
  });

  it("requires no Cloudflare Agents SDK object or fiber", () => {
    const host = createCelldHost({ state: createState() });

    expect(host.scheduler).toBeDefined();
  });
});

function createState() {
  const inner = new InMemoryCloudflareDurableObjectStorage();
  let alarmTime: number | null = null;
  const storage = {
    delete: (key: string) => inner.delete(key),
    deleteAlarm: () => {
      alarmTime = null;
      return Promise.resolve();
    },
    get: <T>(key: string) => inner.get<T>(key),
    getAlarm: () => Promise.resolve(alarmTime),
    put: <T>(key: string, value: T) => inner.put(key, value),
    setAlarm: async (scheduledTime: Date | number) => {
      alarmTime =
        typeof scheduledTime === "number"
          ? scheduledTime
          : scheduledTime.getTime();
      await inner.setAlarm(scheduledTime);
    },
    sql: inner.sql,
    transaction: inner.transaction.bind(inner),
    transactionSync: inner.transactionSync.bind(inner),
  };
  return {
    storage,
    waitUntil: (_promise: Promise<unknown>): void => undefined,
  };
}
