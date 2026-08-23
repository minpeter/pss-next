import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../testing/test-fixtures";
import type { ThreadCompactionInput } from "../state/thread-state";
import { scheduleThreadCompaction } from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-concurrency-support";
import {
  type CompactionCoordinator,
  enqueuePending,
  restorePendingAfterFailedRetry,
  takePendingForRetry,
} from "./auto-compaction-scheduler";
import type { AgentCompaction } from "./auto-compaction-types";

afterEach(() => {
  vi.useRealTimers();
});

describe("compaction runner scheduling", () => {
  it("shares a queued schedule promise through its coalesced retry", async () => {
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const retryStarted = createDeferred();
    const releaseRetry = createDeferred();
    let attempts = 0;
    const compaction: AgentCompaction = async (): Promise<
      ThreadCompactionInput | undefined
    > => {
      attempts += 1;
      if (attempts === 1) {
        activeStarted.resolve();
        await releaseActive.promise;
        return;
      }
      if (attempts === 2) {
        throw new TypeError("queued first attempt failed");
      }
      retryStarted.resolve();
      await releaseRetry.promise;
      return;
    };
    const options = {
      compaction,
      model,
      state,
      threadKey: "queued-shared",
    };

    const active = scheduleThreadCompaction(options);
    await activeStarted.promise;
    const queued = scheduleThreadCompaction(options);
    const coalesced = scheduleThreadCompaction(options);
    let queuedSettled = false;
    queued.then(() => {
      queuedSettled = true;
    });

    try {
      expect(coalesced).toBe(queued);
      expect(queuedSettled).toBe(false);
      releaseActive.resolve();
      await active;
      await retryStarted.promise;
      expect(queuedSettled).toBe(false);
      releaseRetry.resolve();
      await queued;

      expect(attempts).toBe(3);
      expect(queuedSettled).toBe(true);
    } finally {
      releaseActive.resolve();
      releaseRetry.resolve();
      await Promise.allSettled([active, queued, coalesced]);
    }
  });

  it("restores the covered deadline with newer pending options", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const state = await stateWithHistory();
    const coordinator: CompactionCoordinator = {
      active: undefined,
      blockingWaiters: 0,
      pending: undefined,
    };
    const coveredCompaction: AgentCompaction = (): undefined => undefined;
    const newerCompaction: AgentCompaction = (): undefined => undefined;
    const coveredPromise = enqueuePending(coordinator, {
      deadline: { deadlineAt: 100, deadlineMs: 100 },
      options: {
        compaction: coveredCompaction,
        model,
        state,
        threadKey: "restore-covered-deadline",
      },
    });
    const covered = takePendingForRetry(coordinator);
    const newerPromise = enqueuePending(coordinator, {
      deadline: { deadlineAt: 200, deadlineMs: 100 },
      options: {
        compaction: newerCompaction,
        model,
        state,
        threadKey: "restore-covered-deadline",
      },
    });

    restorePendingAfterFailedRetry(coordinator, covered);

    expect(coordinator.pending?.deadline.deadlineAt).toBe(100);
    expect(coordinator.pending?.options.compaction).toBe(newerCompaction);
    const restored = takePendingForRetry(coordinator);
    restored?.deferred.resolve(undefined);
    await Promise.all([coveredPromise, newerPromise]);
  });
});
