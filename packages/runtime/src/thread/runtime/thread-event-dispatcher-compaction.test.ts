import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import type { ThreadStore } from "../store/types";
import { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import { compactThreadBlocking } from "./auto-compaction-runner";
import type { AgentCompaction } from "./auto-compaction-types";
import { ThreadEventDispatcher } from "./thread-event-dispatcher";

const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

async function stateWithHistory(
  store: ThreadStore = new MemoryThreadStore()
): Promise<ThreadState> {
  const state = new ThreadState({ key: "dispatcher-compaction", store });
  await state.ensureLoaded();
  const history: readonly ModelMessage[] = [
    { content: "old", role: "user" },
    assistantMessage("done"),
    { content: "tail", role: "user" },
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  return state;
}

function dispatcher(
  state: ThreadState,
  hookRuntime: AgentHookRuntime
): ThreadEventDispatcher {
  return new ThreadEventDispatcher({
    history: () => state.modelSnapshot(),
    hookRuntime,
    signal: () => undefined,
    threadKey: "dispatcher-compaction",
  });
}

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
    const markCommitStarted = vi.fn();
    const compaction = Object.assign(
      () => ({ endSeqExclusive: 2, startSeq: 0, summary: "expired" }),
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    const running = compactThreadBlocking({
      compact: (input, episode) =>
        events.compact(state, input, {
          ...episode,
          markCommitStarted: () => {
            markCommitStarted();
            episode.markCommitStarted();
          },
        }),
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
      expect(markCommitStarted).not.toHaveBeenCalled();
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

  it("marks the commit boundary immediately before the durable compaction commit", async () => {
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
      compact: (input, episode) =>
        events.compact(state, input, {
          ...episode,
          markCommitStarted: () => {
            commitOrder.push("markCommitStarted");
            episode.markCommitStarted();
          },
        }),
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
    expect(commitOrder).toEqual([
      "store.commit",
      "markCommitStarted",
      "store.commit",
    ]);
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
