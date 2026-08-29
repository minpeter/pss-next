import { describe, expect, it } from "vitest";
import { createCelldSqliteTestStorage } from "./celld-sqlite-test-storage";
import { createCelldScheduler, listCelldScheduledRuns } from "./scheduler";

const ROW_COUNT = 1000;

describe("Celld scheduler deterministic ordering", () => {
  it("orders 1,000 rows by due time and applies limits without moving the minimum alarm", async () => {
    // Given
    let nowMs = 0;
    const storage = createCelldSqliteTestStorage();
    const scheduler = createCelldScheduler({ clock: () => nowMs, storage });
    for (let index = 0; index < ROW_COUNT; index += 1) {
      nowMs = (index * 37) % ROW_COUNT;
      await scheduler.enqueueRun(`run-${index}`);
    }
    const expected = Array.from({ length: ROW_COUNT }, (_, index) => index)
      .sort(
        (left, right) => ((left * 37) % ROW_COUNT) - ((right * 37) % ROW_COUNT)
      )
      .map((index) => `run-${index}`);

    // When
    const firstTwenty = await listCelldScheduledRuns(storage, {
      limit: 20,
      nowMs: ROW_COUNT - 1,
    });
    const all = await listCelldScheduledRuns(storage, {
      nowMs: ROW_COUNT - 1,
    });

    // Then
    expect(firstTwenty).toEqual(expected.slice(0, 20));
    expect(all).toEqual(expected);
    await expect(storage.getAlarm()).resolves.toBe(0);
  });

  it("keeps duplicate insertion a no-op and preserves equal-due insertion order", async () => {
    // Given
    let nowMs = 50;
    const storage = createCelldSqliteTestStorage();
    const scheduler = createCelldScheduler({ clock: () => nowMs, storage });
    await scheduler.enqueueRun("tie-first");
    await scheduler.enqueueRun("tie-second");
    nowMs = 10;
    await scheduler.enqueueRun("earliest");
    nowMs = 0;

    // When
    await scheduler.enqueueRun("tie-first");

    // Then
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 50 })
    ).resolves.toEqual(["earliest", "tie-first", "tie-second"]);
    await expect(storage.getAlarm()).resolves.toBe(10);
  });
});
