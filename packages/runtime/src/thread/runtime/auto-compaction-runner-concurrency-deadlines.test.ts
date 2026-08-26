import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../testing/test-fixtures";
import type { ThreadCompactionInput } from "../state/thread-state";
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
  it("retains the first pending deadline while using latest coalesced options", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(9000));
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    let pendingDeadlineAt: number | undefined;
    const activeCompaction = Object.assign(
      async (): Promise<undefined> => {
        activeStarted.resolve();
        await releaseActive.promise;
      },
      { deadlineMs: () => 1000 }
    ) satisfies AgentCompaction;
    const firstPending = Object.assign(vi.fn<AgentCompaction>(), {
      deadlineMs: () => 25,
    }) satisfies AgentCompaction;
    const latestPending = Object.assign(
      (context: Parameters<AgentCompaction>[0]): undefined => {
        pendingDeadlineAt = context.deadlineAt;
      },
      { deadlineMs: () => 500 }
    ) satisfies AgentCompaction;

    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "pending-deadline",
    });
    await activeStarted.promise;
    vi.setSystemTime(new Date(10_000));
    const pending = scheduleThreadCompaction({
      compaction: firstPending,
      model,
      state,
      threadKey: "pending-deadline",
    });
    vi.setSystemTime(new Date(10_010));
    const coalesced = scheduleThreadCompaction({
      compaction: latestPending,
      model,
      state,
      threadKey: "pending-deadline",
    });
    vi.setSystemTime(new Date(10_020));
    releaseActive.resolve();
    await Promise.all([active, pending, coalesced]);

    expect(coalesced).toBe(pending);
    expect(firstPending).not.toHaveBeenCalled();
    expect(pendingDeadlineAt).toBe(10_025);
  });

  it("keeps a completed-turn retry under the active admission deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const state = await stateWithHistory();
    const retryDeadlines: number[] = [];
    let attempts = 0;
    const compaction = Object.assign(
      (context: Parameters<AgentCompaction>[0]): undefined => {
        attempts += 1;
        retryDeadlines.push(context.deadlineAt ?? 0);
        if (attempts === 1) {
          vi.setSystemTime(new Date(10_010));
          throw new TypeError("retry once");
        }
      },
      { deadlineMs: () => 25 }
    ) satisfies AgentCompaction;

    await scheduleThreadCompaction({
      compaction,
      model,
      state,
      threadKey: "retry-deadline",
    });

    expect(retryDeadlines).toEqual([10_025, 10_025]);
  });

  it("bounds a covered pending retry by its earlier absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const retryStarted = createDeferred();
    const releaseRetry = createDeferred();
    const retryReturned = createDeferred();
    let retrySignal: AbortSignal | undefined;
    let retryDeadlineAt: number | undefined;
    const activeCompaction = Object.assign(
      async (): Promise<undefined> => {
        activeStarted.resolve();
        await releaseActive.promise;
        throw new TypeError("active attempt failed");
      },
      { deadlineMs: () => 100 }
    ) satisfies AgentCompaction;
    const pendingCompaction = Object.assign(
      async (
        context: Parameters<AgentCompaction>[0]
      ): Promise<ThreadCompactionInput> => {
        retrySignal = context.signal;
        retryDeadlineAt = context.deadlineAt;
        retryStarted.resolve();
        await releaseRetry.promise;
        retryReturned.resolve();
        return { endSeqExclusive: 2, startSeq: 0, summary: "too late" };
      },
      { deadlineMs: () => 25 }
    ) satisfies AgentCompaction;

    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "covered-pending-deadline",
    });
    await activeStarted.promise;
    vi.setSystemTime(new Date(10_010));
    const pending = scheduleThreadCompaction({
      compaction: pendingCompaction,
      model,
      state,
      threadKey: "covered-pending-deadline",
    });
    vi.setSystemTime(new Date(10_020));
    releaseActive.resolve();

    try {
      await retryStarted.promise;
      expect(retryDeadlineAt).toBe(10_035);
      const pendingOutcome = expect(pending).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(15);

      await Promise.all([active, pendingOutcome]);
      expect(retrySignal?.reason).toMatchObject({
        deadlineAt: 10_035,
        deadlineMs: 25,
        name: "CompactionDeadlineExceededError",
        reason: "completed-turn",
      });
      expect(state.compactionSnapshot()).toEqual([]);
    } finally {
      releaseActive.resolve();
      releaseRetry.resolve();
      await retryReturned.promise;
      await vi.runAllTimersAsync();
      await Promise.allSettled([active, pending]);
    }

    expect(state.compactionSnapshot()).toEqual([]);
  });
});
