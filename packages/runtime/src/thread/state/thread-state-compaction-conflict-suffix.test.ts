import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import { assistantMessage, createDeferred } from "../../testing/test-fixtures";
import type { ThreadStore } from "../store/types";
import { decodeStoredThreadState, encodeThreadSnapshot } from "./snapshot";
import { ThreadCommitConflictError, ThreadState } from "./thread-state";

describe("ThreadState compaction", () => {
  it("preserves a local append made after a conflicting commit snapshot", async () => {
    const backing = new MemoryThreadStore();
    const conflictStarted = createDeferred();
    const releaseConflict = createDeferred();
    let commitCalls = 0;
    const store: ThreadStore = {
      commit: async (key, next, options) => {
        commitCalls += 1;
        if (commitCalls === 1) {
          return await backing.commit(key, next, options);
        }
        const stored = await backing.load(key);
        if (stored === null) {
          throw new TypeError("Expected committed thread");
        }
        const winner = await backing.commit(
          key,
          { state: stored.state },
          { expectedVersion: options.expectedVersion }
        );
        if (!winner.ok) {
          throw new TypeError("Expected external winner");
        }
        conflictStarted.resolve();
        await releaseConflict.promise;
        return { ok: false, reason: "conflict" };
      },
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
    };
    const state = new ThreadState({ key: "compaction-conflict-tail", store });
    const initial: readonly ModelMessage[] = [
      { content: "old", role: "user" },
      assistantMessage("done"),
      { content: "tail", role: "user" },
    ];
    for (const message of initial) {
      state.history.appendModelMessage(message);
    }
    await state.commit();

    const compacting = state.compact({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "losing compaction",
    });
    await conflictStarted.promise;
    const concurrentTail = {
      content: "concurrent local append",
      role: "user",
    } as const;
    state.history.appendModelMessage(concurrentTail);
    releaseConflict.resolve();

    await expect(compacting).rejects.toBeInstanceOf(ThreadCommitConflictError);
    expect(state.modelSnapshot()).toEqual([...initial, concurrentTail]);
    expect(state.compactionSnapshot()).toEqual([]);
    expect(state.threadCheckpointReference().threadVersion).toBe("2");
  });

  it("discards a local suffix when the remote winner diverged", async () => {
    const backing = new MemoryThreadStore();
    const conflictStarted = createDeferred();
    const releaseConflict = createDeferred();
    const remoteWinner = {
      content: "REMOTE-DIVERGED",
      role: "user",
    } as const;
    let commitCalls = 0;
    const store: ThreadStore = {
      commit: async (key, next, options) => {
        commitCalls += 1;
        if (commitCalls !== 2) {
          return await backing.commit(key, next, options);
        }
        const stored = await backing.load(key);
        const decoded = decodeStoredThreadState(stored);
        const winner = await backing.commit(
          key,
          {
            state: encodeThreadSnapshot(
              [remoteWinner, ...decoded.history.slice(1)],
              decoded.compactions,
              decoded.appliedMigrations
            ),
          },
          { expectedVersion: options.expectedVersion }
        );
        if (!winner.ok) {
          throw new TypeError("Expected divergent external winner");
        }
        conflictStarted.resolve();
        await releaseConflict.promise;
        return { ok: false, reason: "conflict" };
      },
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
    };
    const state = new ThreadState({ key: "divergent-conflict", store });
    const initial: readonly ModelMessage[] = [
      { content: "shared base", role: "user" },
      assistantMessage("done"),
      { content: "tail", role: "user" },
    ];
    for (const message of initial) {
      state.history.appendModelMessage(message);
    }
    await state.commit();

    const compacting = state.compact({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "losing compaction",
    });
    await conflictStarted.promise;
    const privateLocal = {
      content: "LOCAL-POST-SNAPSHOT-SECRET",
      role: "user",
    } as const;
    state.history.appendModelMessage(privateLocal);
    releaseConflict.resolve();

    await expect(compacting).rejects.toBeInstanceOf(ThreadCommitConflictError);
    const remoteHistory = [remoteWinner, ...initial.slice(1)];
    expect(state.modelSnapshot()).toEqual(remoteHistory);
    expect(state.modelSnapshot()).not.toContainEqual(privateLocal);
    expect(state.threadCheckpointReference().threadVersion).toBe("2");

    const laterWrite = {
      content: "later legitimate write",
      role: "user",
    } as const;
    state.history.appendModelMessage(laterWrite);
    await state.commit();
    expect(
      decodeStoredThreadState(await backing.load("divergent-conflict")).history
    ).toEqual([...remoteHistory, laterWrite]);
  });
});
