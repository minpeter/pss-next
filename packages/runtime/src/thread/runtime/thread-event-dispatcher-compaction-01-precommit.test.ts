import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { MemoryThreadStore } from "../../platform/memory";
import { createDeferred } from "../../testing/test-fixtures";
import { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import { compactThreadBlocking } from "./auto-compaction-runner";
import type { AgentCompaction } from "./auto-compaction-types";
import {
  dispatcher,
  model,
  stateWithHistory,
} from "./thread-event-dispatcher-compaction-support";

afterEach(() => {
  vi.useRealTimers();
});

describe("ThreadEventDispatcher compaction boundary", () => {
  it("does not cross the commit boundary when a queued compaction expires before ThreadState starts it", async () => {
    vi.useFakeTimers();
    const backing = new MemoryThreadStore();
    const releaseInitialCommit = createDeferred();
    const state = await stateWithHistory({
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
      commit: async (key, next, options) => {
        await releaseInitialCommit.promise;
        return await backing.commit(key, next, options);
      },
    });
    state.history.appendModelMessage({ content: "queued", role: "user" });
    const queuedWrite = state.commit();
    const beforeCompactions = state.compactionSnapshot();
    const events = dispatcher(state, new AgentHookRuntime());
    const compaction = Object.assign(
      () => ({ endSeqExclusive: 2, startSeq: 0, summary: "expired" }),
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    const running = compactThreadBlocking({
      compact: (input, episode) => events.compact(state, input, episode),
      compaction,
      model,
      state,
      threadKey: "dispatcher-compaction",
    });
    const observed = running.catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(1);
      await expect(observed).resolves.toBeInstanceOf(
        CompactionDeadlineExceededError
      );
      expect(state.compactionSnapshot()).toEqual(beforeCompactions);
    } finally {
      releaseInitialCommit.resolve();
      await Promise.allSettled([queuedWrite, running]);
    }
  });

  it("times out a blocked beforeCompaction hook without a late mutation", async () => {
    vi.useFakeTimers();
    const hookStarted = createDeferred();
    const releaseHook = createDeferred();
    const handlerSettled = createDeferred();
    const state = await stateWithHistory();
    const before = state.modelSnapshot();
    const events = dispatcher(
      state,
      new AgentHookRuntime({
        beforeCompaction: async () => {
          hookStarted.resolve();
          await releaseHook.promise;
          return { action: "continue" };
        },
      })
    );
    const compaction = Object.assign(
      () => ({ endSeqExclusive: 2, startSeq: 0, summary: "late" }),
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    let outcome: unknown;
    const running = compactThreadBlocking({
      compact: async (input, episode) => {
        try {
          return await events.compact(state, input, episode);
        } finally {
          handlerSettled.resolve();
        }
      },
      compaction,
      model,
      state,
      threadKey: "dispatcher-compaction",
    });
    const observed = running.then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      }
    );

    try {
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBeInstanceOf(CompactionDeadlineExceededError);
      releaseHook.resolve();
      await handlerSettled.promise;
      expect(state.modelSnapshot()).toEqual(before);
      expect(state.compactionSnapshot()).toEqual([]);
    } finally {
      releaseHook.resolve();
      await Promise.allSettled([observed, handlerSettled.promise]);
    }
  });
});
