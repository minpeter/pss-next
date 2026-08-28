import { describe, expect, it } from "vitest";
import { createCelldSqliteTestStorage } from "./celld-sqlite-test-storage";
import { createCelldScheduler, listCelldScheduledRuns } from "./scheduler";
import { claimCelldScheduledRun } from "./scheduler-claims";

const INSERT_FAILURE = new Error("injected insert failure");
const ALARM_FAILURE = new Error("injected alarm failure");
const INSERT_WORK_PATTERN = /^\s*INSERT INTO pss_scheduled_work\b/iu;

function isInsert(query: string): boolean {
  return INSERT_WORK_PATTERN.test(query);
}

describe("Celld scheduler failure atomicity", () => {
  it("leaves no work or alarm when insert SQL fails", async () => {
    // Given
    const storage = createCelldSqliteTestStorage({
      sqlFailure: (query) => (isInsert(query) ? INSERT_FAILURE : undefined),
    });
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    // When
    const enqueue = scheduler.enqueueRun("run-1");

    // Then
    await expect(enqueue).rejects.toBe(INSERT_FAILURE);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 0 })
    ).resolves.toEqual([]);
    await expect(storage.getAlarm()).resolves.toBeNull();
  });

  it("rolls back a row when alarm arming rejects after insertion", async () => {
    // Given
    let insertedRowsAtAlarm = 0;
    const storage = createCelldSqliteTestStorage({
      setAlarm: () => {
        insertedRowsAtAlarm =
          storage.sql
            .exec<{ readonly count: number }>(
              "SELECT COUNT(*) AS count FROM pss_scheduled_work"
            )
            .toArray()[0]?.count ?? 0;
        return Promise.reject(ALARM_FAILURE);
      },
    });
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    // When
    const enqueue = scheduler.enqueueRun("run-1");

    // Then
    await expect(enqueue).rejects.toBe(ALARM_FAILURE);
    expect(insertedRowsAtAlarm).toBe(1);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 0 })
    ).resolves.toEqual([]);
    await expect(storage.getAlarm()).resolves.toBeNull();
  });

  it("rolls back a claim when its transaction alarm rejects", async () => {
    // Given
    let alarmFails = false;
    const storage = createCelldSqliteTestStorage({
      setAlarm: () =>
        alarmFails ? Promise.reject(ALARM_FAILURE) : Promise.resolve(),
    });
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("run-1");
    alarmFails = true;

    // When
    const claim = claimCelldScheduledRun(storage, "run-1", {
      leaseMs: 100,
      nowMs: 0,
    });

    // Then
    await expect(claim).rejects.toBe(ALARM_FAILURE);
    alarmFails = false;
    await expect(
      claimCelldScheduledRun(storage, "run-1", { leaseMs: 100, nowMs: 0 })
    ).resolves.toEqual(expect.any(String));
  });
});
