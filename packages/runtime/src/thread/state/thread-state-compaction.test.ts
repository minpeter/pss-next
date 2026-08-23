import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import { assistantMessage, createDeferred } from "../../testing/test-fixtures";
import type { ThreadStore } from "../store/types";
import { decodeStoredThreadState, encodeThreadSnapshot } from "./snapshot";
import { ThreadCommitConflictError, ThreadState } from "./thread-state";

describe("ThreadState compaction", () => {
  it("does not duplicate an extended remote prefix while preserving a later local tail", async () => {
    const backing = new MemoryThreadStore();
    const conflictStarted = createDeferred();
    const releaseConflict = createDeferred();
    const remoteAppend = {
      content: "remote append",
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
              [...decoded.history, remoteAppend],
              decoded.compactions,
              decoded.appliedMigrations
            ),
          },
          { expectedVersion: options.expectedVersion }
        );
        if (!winner.ok) {
          throw new TypeError("Expected extended external winner");
        }
        conflictStarted.resolve();
        await releaseConflict.promise;
        return { ok: false, reason: "conflict" };
      },
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
    };
    const state = new ThreadState({ key: "extended-conflict", store });
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
    const localTail = { content: "local tail", role: "user" } as const;
    state.history.appendModelMessage(remoteAppend);
    state.history.appendModelMessage(localTail);
    releaseConflict.resolve();

    await expect(compacting).rejects.toBeInstanceOf(ThreadCommitConflictError);
    const expected = [...initial, remoteAppend, localTail];
    expect(state.modelSnapshot()).toEqual(expected);
    expect(
      state
        .modelSnapshot()
        .filter((message) => message.content === remoteAppend.content)
    ).toHaveLength(1);

    await state.commit();
    expect(
      decodeStoredThreadState(await backing.load("extended-conflict")).history
    ).toEqual(expected);
  });

  it("does not resurrect a local suffix after remote deletion", async () => {
    const backing = new MemoryThreadStore();
    const conflictStarted = createDeferred();
    const releaseConflict = createDeferred();
    let commitCalls = 0;
    const store: ThreadStore = {
      commit: async (key, next, options) => {
        commitCalls += 1;
        if (commitCalls !== 2) {
          return await backing.commit(key, next, options);
        }
        await backing.delete(key);
        conflictStarted.resolve();
        await releaseConflict.promise;
        return { ok: false, reason: "conflict" };
      },
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
    };
    const state = new ThreadState({ key: "deleted-conflict", store });
    const base = { content: "base", role: "user" } as const;
    state.history.appendModelMessage(base);
    state.history.appendModelMessage(assistantMessage("done"));
    await state.commit();

    const compacting = state.compact({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "losing compaction",
    });
    await conflictStarted.promise;
    state.history.appendModelMessage({
      content: "stale local suffix",
      role: "user",
    });
    releaseConflict.resolve();

    await expect(compacting).rejects.toBeInstanceOf(ThreadCommitConflictError);
    expect(state.modelSnapshot()).toEqual([]);
    expect(state.compactionSnapshot()).toEqual([]);
    expect(state.threadCheckpointReference().threadVersion).toBeNull();

    const laterWrite = { content: "later write", role: "user" } as const;
    state.history.appendModelMessage(laterWrite);
    await state.commit();
    expect(
      decodeStoredThreadState(await backing.load("deleted-conflict")).history
    ).toEqual([laterWrite]);
  });
});
