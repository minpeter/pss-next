import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../testing/test-fixtures";
import {
  compactThreadBlocking,
  compactThreadManually,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-deadline-support";
import type { AgentCompaction } from "./auto-compaction-types";

afterEach(() => {
  vi.useRealTimers();
});

describe("compaction deadlines", () => {
  it.each([
    {
      name: "overflow",
      run: (options: Parameters<typeof compactThreadBlocking>[0]) =>
        compactThreadBlocking(options),
    },
    {
      name: "manual",
      run: (options: Parameters<typeof compactThreadBlocking>[0]) =>
        compactThreadManually({ ...options, deadlineMs: () => 25 }),
    },
  ])(
    "includes waiting for active work in the $name deadline",
    async ({ name, run }) => {
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
      const waitingCompaction = Object.assign(vi.fn<AgentCompaction>(), {
        deadlineMs: () => 25,
      }) satisfies AgentCompaction;
      const active = scheduleThreadCompaction({
        compaction: activeCompaction,
        model,
        state,
        threadKey: `waiting-${name}`,
      });
      await activeStarted.promise;

      vi.setSystemTime(new Date(10_000));
      const waiting = run({
        compaction: waitingCompaction,
        model,
        state,
        threadKey: `waiting-${name}`,
      });
      const waitingOutcome = expect(waiting).rejects.toMatchObject({
        deadlineAt: 10_025,
        deadlineMs: 25,
        name: "CompactionDeadlineExceededError",
        reason: name,
      });
      await vi.advanceTimersByTimeAsync(25);

      await waitingOutcome;
      expect(waitingCompaction).not.toHaveBeenCalled();

      const healthyCompaction = Object.assign(vi.fn<AgentCompaction>(), {
        deadlineMs: () => 1000,
      }) satisfies AgentCompaction;
      const healthy = scheduleThreadCompaction({
        compaction: healthyCompaction,
        model,
        state,
        threadKey: `waiting-${name}`,
      });
      releaseActive.resolve();
      await Promise.all([active, healthy]);
      expect(healthyCompaction).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects shared active success after an event-loop-delayed deadline", async () => {
    // Given
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const activeCompaction = Object.assign(
      async () => {
        activeStarted.resolve();
        await releaseActive.promise;
        return { endSeqExclusive: 2, startSeq: 0, summary: "shared" };
      },
      { deadlineMs: () => 1000 }
    ) satisfies AgentCompaction;
    const waitingCompaction = Object.assign(vi.fn<AgentCompaction>(), {
      deadlineMs: () => 10,
    }) satisfies AgentCompaction;
    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "delayed-active-deadline",
    });
    await activeStarted.promise;

    // When
    const waiting = compactThreadBlocking({
      compaction: waitingCompaction,
      model,
      state,
      threadKey: "delayed-active-deadline",
    });
    vi.setSystemTime(new Date(10_050));
    releaseActive.resolve();

    // Then
    await expect(waiting).rejects.toMatchObject({
      deadlineAt: 10_010,
      deadlineMs: 10,
      name: "CompactionDeadlineExceededError",
      reason: "overflow",
    });
    await active;
    expect(waitingCompaction).not.toHaveBeenCalled();
  });
});
