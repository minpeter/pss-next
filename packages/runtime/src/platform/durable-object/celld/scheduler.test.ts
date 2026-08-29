import { describe, expect, it } from "vitest";
import { describeExecutionSchedulerContract } from "../../../contracts/execution-scheduler/contract";
import { createCelldTestStorage } from "./celld-test-storage";
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

  it("rolls back queued work when setAlarm rejects", async () => {
    const storage = createAlarmCapableStorage({
      setAlarm: () => Promise.reject(new Error("alarm unavailable")),
    });
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    await expect(scheduler.enqueueRun("run-1")).rejects.toThrow(
      "alarm unavailable"
    );

    expect(await listCelldScheduledRuns(storage, { nowMs: 0 })).toEqual([]);
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

  it("restores an earlier persisted alarm on duplicate enqueue", async () => {
    const storage = createAlarmCapableStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    await scheduler.enqueueRun("run-1", { runAfterMs: 1000 });
    await storage.deleteAlarm();
    await scheduler.enqueueRun("run-1", { runAfterMs: 4000 });

    expect(await storage.getAlarm()).toBe(1000);
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
    await storage.deleteAlarm();
    const claim = await claimCelldScheduledRun(storage, "recoverable", {
      leaseMs: 100,
      nowMs: 1000,
    });

    expect(claim).toEqual(expect.any(String));
    expect(await listCelldScheduledRuns(storage, { nowMs: 1000 })).toEqual([]);
    expect(await storage.getAlarm()).toBe(1100);

    await rearmCelldScheduledWork(storage, { nowMs: 1000 });
    expect(await storage.getAlarm()).toBe(1100);
    expect(await listCelldScheduledRuns(storage, { nowMs: 1100 })).toEqual([
      "recoverable",
    ]);
  });

  it("rejects malformed durable work before draining it", async () => {
    const storage = createAlarmCapableStorage();
    storage.sql.exec(
      "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "pss-runtime",
      "celld-run",
      "broken",
      "{",
      null,
      "broken",
      0,
      0
    );

    await expect(listCelldScheduledRuns(storage, { nowMs: 0 })).rejects.toThrow(
      "Invalid Celld scheduled work payload."
    );
  });

  it("rejects kind-invalid durable work instead of hot-looping", async () => {
    const storage = createAlarmCapableStorage();
    storage.sql.exec(
      "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "pss-runtime",
      "celld-run",
      "wrong-kind",
      JSON.stringify({ dueAtMs: 0, value: 42 }),
      null,
      "wrong-kind",
      0,
      0
    );

    await expect(listCelldScheduledRuns(storage, { nowMs: 0 })).rejects.toThrow(
      "Invalid Celld scheduled work value."
    );
  });
});

type AlarmCapableStorage = ReturnType<typeof createAlarmCapableStorage>;

function createAlarmCapableStorage(
  options: {
    readonly setAlarm?: (scheduledTime: Date | number) => Promise<void>;
  } = {}
) {
  return createCelldTestStorage(options);
}
