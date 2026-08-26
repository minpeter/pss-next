import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { MemoryThreadStore } from "../../platform/memory";
import { createDeferred } from "../../testing/test-fixtures";
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
  it("starts the durable compaction commit after the queued write", async () => {
    vi.useFakeTimers();
    const backing = new MemoryThreadStore();
    const releaseInitialCommit = createDeferred();
    const commitOrder: string[] = [];
    const state = await stateWithHistory({
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
      commit: async (key, next, options) => {
        commitOrder.push("store.commit");
        await releaseInitialCommit.promise;
        return await backing.commit(key, next, options);
      },
    });
    state.history.appendModelMessage({ content: "queued", role: "user" });
    const queuedWrite = state.commit();
    const events = dispatcher(state, new AgentHookRuntime());
    const compaction = Object.assign(
      () => ({ endSeqExclusive: 2, startSeq: 0, summary: "boundary" }),
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    const running = compactThreadBlocking({
      compact: (input, episode) => events.compact(state, input, episode),
      compaction,
      model,
      state,
      threadKey: "dispatcher-compaction",
    });

    await Promise.resolve();
    expect(commitOrder).toEqual(["store.commit"]);
    releaseInitialCommit.resolve();
    await queuedWrite;
    await expect(running).resolves.toBe(true);
    expect(commitOrder).toEqual(["store.commit", "store.commit"]);
  });

  it("waits beyond the deadline once ThreadState.compact has started", async () => {
    vi.useFakeTimers();
    const backing = new MemoryThreadStore();
    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    const state = await stateWithHistory({
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
      commit: async (key, next, options) => {
        commitStarted.resolve();
        await releaseCommit.promise;
        return await backing.commit(key, next, options);
      },
    });
    const events = dispatcher(state, new AgentHookRuntime());
    const compaction = Object.assign(
      () => ({ endSeqExclusive: 2, startSeq: 0, summary: "atomic" }),
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    let settled = false;
    const running = compactThreadBlocking({
      compact: (input, episode) => events.compact(state, input, episode),
      compaction,
      model,
      state,
      threadKey: "dispatcher-compaction",
    });
    running.finally(() => {
      settled = true;
    });

    try {
      await commitStarted.promise;
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      releaseCommit.resolve();
      await expect(running).resolves.toBe(true);
      expect(state.compactionSnapshot()).toHaveLength(1);
    } finally {
      releaseCommit.resolve();
      await Promise.allSettled([running]);
    }
  });

  it("propagates a post-deadline commit failure after rolling back", async () => {
    vi.useFakeTimers();
    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    const commitFailure = new TypeError("injected durable commit failure");
    const state = await stateWithHistory({
      delete: () => Promise.resolve(),
      load: () => Promise.resolve(null),
      commit: async () => {
        commitStarted.resolve();
        await releaseCommit.promise;
        throw commitFailure;
      },
    });
    const before = state.modelSnapshot();
    const events = dispatcher(state, new AgentHookRuntime());
    const compaction = Object.assign(
      () => ({ endSeqExclusive: 2, startSeq: 0, summary: "rollback" }),
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    const running = compactThreadBlocking({
      compact: (input, episode) => events.compact(state, input, episode),
      compaction,
      model,
      state,
      threadKey: "dispatcher-compaction",
    });

    try {
      await commitStarted.promise;
      await vi.advanceTimersByTimeAsync(1);
      releaseCommit.resolve();
      await expect(running).rejects.toBe(commitFailure);
      expect(state.modelSnapshot()).toEqual(before);
      expect(state.compactionSnapshot()).toEqual([]);
    } finally {
      releaseCommit.resolve();
      await Promise.allSettled([running]);
    }
  });
});
