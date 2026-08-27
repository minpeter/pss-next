import { describe, expect, it } from "vitest";
import { describeExecutionSchedulerContract } from "../../contracts/execution-scheduler/contract";
import { InMemoryCloudflareDurableObjectStorage } from "../cloudflare/host/durable-object-host";
import {
  createCelldScheduler,
  listCelldScheduledRuns,
  listCelldScheduledThreadPrompts,
} from "./scheduler";
import {
  ackCelldScheduledRun,
  ackCelldScheduledThreadPrompt,
  claimCelldScheduledRun,
  rearmCelldScheduledWork,
} from "./scheduler-claims";

describeExecutionSchedulerContract({
  createHarness: () => {
    const storage = createAlarmCapableStorage();
    return {
      ackRun: (runId) => ackCelldScheduledRun(storage, runId),
      ackThreadPrompt: (prompt) =>
        ackCelldScheduledThreadPrompt(storage, prompt),
      listRuns: (options) => listCelldScheduledRuns(storage, options),
      listThreadPrompts: (options) =>
        listCelldScheduledThreadPrompts(storage, options),
      scheduler: createCelldScheduler({ storage }),
    };
  },
  name: "Celld",
  supportsDueTimeFiltering: true,
});

describe("Celld due-aware alarm HostScheduler", () => {
  it("persists queued work before setAlarm", async () => {
    const queuedBeforeAlarm: string[][] = [];
    let storage: AlarmCapableStorage;
    storage = createAlarmCapableStorage({
      setAlarm: async () => {
        queuedBeforeAlarm.push([
          ...(await listCelldScheduledRuns(storage, { nowMs: 1000 })),
        ]);
      },
    });
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    await scheduler.enqueueRun("run-1", { runAfterMs: 10 });

    expect(queuedBeforeAlarm).toEqual([["run-1"]]);
  });

  it("leaves work queued when setAlarm rejects", async () => {
    const storage = createAlarmCapableStorage({
      setAlarm: () => Promise.reject(new Error("alarm unavailable")),
    });
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    await expect(scheduler.enqueueRun("run-1")).rejects.toThrow(
      "alarm unavailable"
    );

    expect(await listCelldScheduledRuns(storage, { nowMs: 0 })).toEqual([
      "run-1",
    ]);
    expect(await storage.getAlarm()).toBeNull();
  });

  it("computes due time with max(0, floor(runAfterMs))", async () => {
    const storage = createAlarmCapableStorage();
    const scheduler = createCelldScheduler({ clock: () => 1000, storage });

    await scheduler.enqueueRun("floored", { runAfterMs: 250.9 });
    expect(await listCelldScheduledRuns(storage, { nowMs: 1249 })).toEqual([]);
    expect(await listCelldScheduledRuns(storage, { nowMs: 1250 })).toEqual([
      "floored",
    ]);
    expect(await storage.getAlarm()).toBe(1250);

    await scheduler.enqueueRun("clamped", { runAfterMs: -7.2 });
    expect(await listCelldScheduledRuns(storage, { nowMs: 1000 })).toEqual([
      "clamped",
    ]);
    expect(await storage.getAlarm()).toBe(1000);
  });

  it("does not postpone an earlier alarm when later work is enqueued", async () => {
    const storage = createAlarmCapableStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    await scheduler.enqueueRun("early", { runAfterMs: 100 });
    expect(await storage.getAlarm()).toBe(100);

    await scheduler.enqueueRun("late", { runAfterMs: 500 });
    expect(await storage.getAlarm()).toBe(100);
  });

  it("treats resumeThread as due immediately", async () => {
    const storage = createAlarmCapableStorage();
    const scheduler = createCelldScheduler({ clock: () => 42, storage });

    await scheduler.resumeThread("thread-1", { runId: "run-1" });

    expect(
      await listCelldScheduledThreadPrompts(storage, { nowMs: 41 })
    ).toEqual([]);
    expect(
      await listCelldScheduledThreadPrompts(storage, { nowMs: 42 })
    ).toEqual([{ runId: "run-1", threadKey: "thread-1" }]);
    expect(await storage.getAlarm()).toBe(42);
  });

  it("keeps duplicate work as one row", async () => {
    const storage = createAlarmCapableStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    await scheduler.enqueueRun("run-1", { runAfterMs: 1000 });
    await scheduler.enqueueRun("run-1", { runAfterMs: 4000 });
    await scheduler.resumeThread("thread-1", { runId: "run-2" });
    await scheduler.resumeThread("thread-1", { runId: "run-2" });

    expect(await listCelldScheduledRuns(storage, { nowMs: 1000 })).toEqual([
      "run-1",
    ]);
    expect(
      await listCelldScheduledThreadPrompts(storage, { nowMs: 0 })
    ).toHaveLength(1);
    expect(await storage.getAlarm()).toBe(0);
  });

  it("rearms the next due item after ack", async () => {
    const storage = createAlarmCapableStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    await scheduler.enqueueRun("early", { runAfterMs: 100 });
    await scheduler.enqueueRun("late", { runAfterMs: 500 });
    expect(await storage.getAlarm()).toBe(100);

    await ackCelldScheduledRun(storage, "early");
    expect(await listCelldScheduledRuns(storage, { nowMs: 500 })).toEqual([
      "late",
    ]);
    expect(await storage.getAlarm()).toBe(500);

    await ackCelldScheduledRun(storage, "late");
    expect(await listCelldScheduledRuns(storage, { nowMs: 500 })).toEqual([]);
    expect(await storage.getAlarm()).toBeNull();
  });

  it("keeps a claimed run recoverable after its lease expires", async () => {
    const storage = createAlarmCapableStorage();
    const scheduler = createCelldScheduler({ clock: () => 1000, storage });

    await scheduler.enqueueRun("recoverable");
    const claim = await claimCelldScheduledRun(storage, "recoverable", {
      leaseMs: 100,
      nowMs: 1000,
    });

    expect(claim).toEqual(expect.any(String));
    expect(await listCelldScheduledRuns(storage, { nowMs: 1000 })).toEqual([]);

    await rearmCelldScheduledWork(storage, { nowMs: 1000 });
    expect(await storage.getAlarm()).toBe(1100);
    expect(await listCelldScheduledRuns(storage, { nowMs: 1100 })).toEqual([
      "recoverable",
    ]);
  });

  it("rejects malformed durable work instead of dropping its alarm", async () => {
    const storage = createAlarmCapableStorage();
    storage.sql.exec(
      "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "pss-runtime",
      "celld-run",
      "broken",
      "{",
      null,
      "broken",
      0
    );

    await expect(
      rearmCelldScheduledWork(storage, { nowMs: 0 })
    ).rejects.toThrow("Invalid Celld scheduled work payload.");
  });
});

type AlarmCapableStorage = ReturnType<typeof createAlarmCapableStorage>;

function createAlarmCapableStorage(
  options: {
    readonly setAlarm?: (scheduledTime: Date | number) => Promise<void>;
  } = {}
) {
  const inner = new InMemoryCloudflareDurableObjectStorage();
  let alarmTime: number | null = null;
  return {
    delete: (key: string) => inner.delete(key),
    deleteAlarm: () => {
      alarmTime = null;
      return Promise.resolve();
    },
    get: <T>(key: string) => inner.get<T>(key),
    getAlarm: () => Promise.resolve(alarmTime),
    put: <T>(key: string, value: T) => inner.put(key, value),
    setAlarm: async (scheduledTime: Date | number) => {
      await options.setAlarm?.(scheduledTime);
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
}
