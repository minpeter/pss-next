import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../testing/test-fixtures";
import type { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import {
  compactThreadBlocking,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-failure-test-support";
import type { AgentCompaction } from "./auto-compaction-types";

describe("compaction runner failure recovery", () => {
  it("bounds an overflow callback that ignores cancellation and preserves history", async () => {
    vi.useFakeTimers();
    const state = await stateWithHistory();
    const before = state.modelSnapshot();
    const callbackStarted = createDeferred();
    let capturedSignal: AbortSignal | undefined;
    const compaction = Object.assign(
      (context: Parameters<AgentCompaction>[0]) => {
        capturedSignal = context.signal;
        callbackStarted.resolve();
        return new Promise<never>(() => undefined);
      },
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;

    try {
      const blocking = compactThreadBlocking({
        compaction,
        model,
        state,
        threadKey: "overflow-deadline",
      });
      const rejected = expect(blocking).rejects.toMatchObject({
        deadlineMs: 1,
        name: "CompactionDeadlineExceededError",
        reason: "overflow",
      } satisfies Partial<CompactionDeadlineExceededError>);
      await callbackStarted.promise;
      await vi.advanceTimersByTimeAsync(1);

      await rejected;
      expect(capturedSignal?.aborted).toBe(true);
      expect(state.modelSnapshot()).toEqual(before);
      expect(state.compactionSnapshot()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a background retry after its absolute deadline expires", async () => {
    vi.useFakeTimers();
    const state = await stateWithHistory();
    let attempts = 0;
    const started = createDeferred();
    const compaction = Object.assign(
      () => {
        attempts += 1;
        started.resolve();
        return new Promise<never>(() => undefined);
      },
      { deadlineMs: () => 50 }
    ) satisfies AgentCompaction;

    try {
      const scheduled = scheduleThreadCompaction({
        compaction,
        model,
        state,
        threadKey: "background-deadline",
      });
      await started.promise;
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      await scheduled;
      expect(attempts).toBe(1);
      expect(state.compactionSnapshot()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
