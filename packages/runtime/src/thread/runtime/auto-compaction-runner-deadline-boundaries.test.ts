import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import { assistantMessage, createDeferred } from "../../testing/test-fixtures";
import {
  decodeStoredThreadState,
  encodeThreadSnapshot,
} from "../state/snapshot";
import { ThreadCommitConflictError } from "../state/thread-state";
import type { ThreadStore } from "../store/types";
import { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import {
  compactThreadBlocking,
  compactThreadManually,
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
  it("rejects at the store boundary when absolute time expires before timer delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const backing = new MemoryThreadStore();
    const storeCommit = vi.fn(
      (
        key: Parameters<ThreadStore["commit"]>[0],
        next: Parameters<ThreadStore["commit"]>[1],
        options: Parameters<ThreadStore["commit"]>[2]
      ) => backing.commit(key, next, options)
    );
    const state = await stateWithHistory({
      commit: storeCommit,
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
    });
    const compaction = Object.assign(
      (
        context: Parameters<AgentCompaction>[0]
      ): { endSeqExclusive: number; startSeq: number; summary: string } => {
        if (context.deadlineAt === undefined) {
          throw new TypeError("Expected automatic compaction deadline");
        }
        vi.setSystemTime(context.deadlineAt);
        return { endSeqExclusive: 2, startSeq: 0, summary: "expired" };
      },
      { deadlineMs: () => 50 }
    ) satisfies AgentCompaction;

    await expect(
      compactThreadBlocking({
        compaction,
        model,
        state,
        threadKey: "absolute-boundary",
      })
    ).rejects.toBeInstanceOf(CompactionDeadlineExceededError);
    expect(storeCommit).not.toHaveBeenCalled();
    expect(state.compactionSnapshot()).toEqual([]);
  });

  it("rejects a stale compaction after a queued conflict reloads divergent history", async () => {
    const backing = new MemoryThreadStore();
    const state = await stateWithHistory(backing);
    await state.commit();
    const winnerInstalled = createDeferred();
    const releaseConflict = createDeferred();
    const commitQueued = createDeferred();
    const divergent: readonly ModelMessage[] = [
      { content: "REMOTE-DIVERGED", role: "user" },
      assistantMessage("remote done"),
      { content: "remote tail", role: "user" },
    ];
    const precedingWrite = state.commitWith(async (prepared) => {
      const winner = await backing.commit(
        prepared.key,
        { state: encodeThreadSnapshot(divergent) },
        { expectedVersion: prepared.expectedVersion }
      );
      if (!winner.ok) {
        throw new Error("Failed to install the divergent winner.");
      }
      winnerInstalled.resolve();
      await releaseConflict.promise;
      return { ok: false, reason: "conflict" };
    });
    await winnerInstalled.promise;

    const compacting = compactThreadBlocking({
      compact: async (input, context) => {
        const committed = context.commit(input);
        commitQueued.resolve();
        return await committed;
      },
      compaction: () => ({
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "SUMMARY OF ORIGINAL HISTORY",
      }),
      model,
      state,
      threadKey: "queued-conflict-freshness",
    });
    await commitQueued.promise;
    releaseConflict.resolve();

    await expect(precedingWrite).rejects.toBeInstanceOf(
      ThreadCommitConflictError
    );
    await expect(compacting).resolves.toBe(false);
    expect(state.modelSnapshot()).toEqual(divergent);
    expect(state.compactionSnapshot()).toEqual([]);
    expect(
      decodeStoredThreadState(await backing.load("runner-deadline-test"))
        .compactions
    ).toEqual([]);
  });

  it("keeps invalid manual deadline configuration throwing", async () => {
    const state = await stateWithHistory();

    await expect(
      compactThreadManually({
        deadlineMs: () => 0,
        model,
        state,
        threadKey: "manual-invalid",
      })
    ).rejects.toThrow(
      "Agent compaction deadlineMs() must return a positive safe integer"
    );
  });
});
