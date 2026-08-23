import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../testing/test-fixtures";
import { scheduleThreadCompaction } from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-concurrency-support";
import type { AgentCompaction } from "./auto-compaction-types";

afterEach(() => {
  vi.useRealTimers();
});

describe("compaction runner scheduling", () => {
  it("times out a pending completed-turn wait without releasing active work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const activeCompaction = Object.assign(
      async (): Promise<undefined> => {
        activeStarted.resolve();
        await releaseActive.promise;
      },
      { deadlineMs: () => 1000 }
    ) satisfies AgentCompaction;
    const expiredCompaction = Object.assign(vi.fn<AgentCompaction>(), {
      deadlineMs: () => 25,
    }) satisfies AgentCompaction;
    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "pending-wait-timeout",
    });
    await activeStarted.promise;
    const expired = scheduleThreadCompaction({
      compaction: expiredCompaction,
      model,
      state,
      threadKey: "pending-wait-timeout",
    });
    const expiredOutcome = expect(expired).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(25);
    await expiredOutcome;
    expect(expiredCompaction).not.toHaveBeenCalled();

    const healthyCompaction = vi.fn<AgentCompaction>();
    const healthy = scheduleThreadCompaction({
      compaction: healthyCompaction,
      model,
      state,
      threadKey: "pending-wait-timeout",
    });
    releaseActive.resolve();
    await Promise.all([active, healthy]);
    expect(healthyCompaction).toHaveBeenCalledTimes(1);
  });

  it("contains a discarded pending deadline without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const activeCompaction = Object.assign(
      async (): Promise<undefined> => {
        activeStarted.resolve();
        await releaseActive.promise;
      },
      { deadlineMs: () => 1000 }
    ) satisfies AgentCompaction;
    const pendingCompaction = Object.assign(vi.fn<AgentCompaction>(), {
      deadlineMs: () => 1,
    }) satisfies AgentCompaction;
    const unhandled: unknown[] = [];
    const observeUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", observeUnhandled);
    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "discarded-pending-deadline",
    });
    await activeStarted.promise;

    try {
      scheduleThreadCompaction({
        compaction: pendingCompaction,
        model,
        state,
        threadKey: "discarded-pending-deadline",
      });
      await vi.advanceTimersByTimeAsync(1);

      const awaited = scheduleThreadCompaction({
        compaction: pendingCompaction,
        model,
        state,
        threadKey: "discarded-pending-deadline",
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(awaited).resolves.toBeUndefined();
      expect(unhandled).toEqual([]);
      expect(pendingCompaction).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", observeUnhandled);
      releaseActive.resolve();
      await active;
    }

    const healthyCompaction = vi.fn<AgentCompaction>();
    await scheduleThreadCompaction({
      compaction: healthyCompaction,
      model,
      state,
      threadKey: "discarded-pending-deadline",
    });
    expect(healthyCompaction).toHaveBeenCalledTimes(1);
  });

  it("settles an expired pending request and accepts later schedules", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(9000));
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const activeCompaction = Object.assign(
      async (): Promise<undefined> => {
        activeStarted.resolve();
        await releaseActive.promise;
      },
      { deadlineMs: () => 1000 }
    ) satisfies AgentCompaction;
    const expiredCompaction = Object.assign(vi.fn<AgentCompaction>(), {
      deadlineMs: () => 25,
    }) satisfies AgentCompaction;
    const healthyCompaction = vi.fn<AgentCompaction>();

    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "expired-pending",
    });
    await activeStarted.promise;
    vi.setSystemTime(new Date(10_000));
    const expired = scheduleThreadCompaction({
      compaction: expiredCompaction,
      model,
      state,
      threadKey: "expired-pending",
    });
    vi.setSystemTime(new Date(10_100));
    releaseActive.resolve();
    await Promise.all([active, expired]);

    const healthy = scheduleThreadCompaction({
      compaction: healthyCompaction,
      model,
      state,
      threadKey: "expired-pending",
    });
    await healthy;

    expect(expiredCompaction).not.toHaveBeenCalled();
    expect(healthyCompaction).toHaveBeenCalledTimes(1);
  });

  it("settles a canceled pending request and accepts later schedules", async () => {
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const controller = new AbortController();
    const activeCompaction: AgentCompaction = async (): Promise<undefined> => {
      activeStarted.resolve();
      await releaseActive.promise;
      return;
    };
    const canceledCompaction = vi.fn<AgentCompaction>();
    const healthyCompaction = vi.fn<AgentCompaction>();

    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "canceled-pending",
    });
    await activeStarted.promise;
    const canceled = scheduleThreadCompaction({
      compaction: canceledCompaction,
      model,
      signal: controller.signal,
      state,
      threadKey: "canceled-pending",
    });
    const reason = new DOMException("cancel pending", "AbortError");
    const canceledOutcome = expect(canceled).resolves.toBeUndefined();
    controller.abort(reason);
    await canceledOutcome;

    const healthy = scheduleThreadCompaction({
      compaction: healthyCompaction,
      model,
      state,
      threadKey: "canceled-pending",
    });
    releaseActive.resolve();
    await Promise.all([active, healthy]);

    expect(canceledCompaction).not.toHaveBeenCalled();
    expect(healthyCompaction).toHaveBeenCalledTimes(1);
  });
});
