import { describe, expect, it, vi } from "vitest";
import type { RuntimeDiagnostic } from "../../diagnostics";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import {
  compactThreadBlocking,
  compactThreadManually,
} from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-concurrency-support";
import {
  type AgentCompaction,
  DEFAULT_COMPACTION_DEADLINE_MS,
  type ThreadCompactionHandler,
} from "./auto-compaction-types";
import { runAgentLoopWithOverflowCompaction } from "./loop-overflow";

describe("compaction runner concurrency", () => {
  it("applies the shared episode bound to manual compaction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(54_321));
    const diagnostics: RuntimeDiagnostic[] = [];
    const diagnosticReported = createDeferred();
    const state = new ThreadState({
      key: "runner-test",
      store: new MemoryThreadStore(),
    });
    await state.ensureLoaded();
    const paragraph = "lorem ipsum dolor sit amet ".repeat(12);
    for (let index = 0; index < 4; index += 1) {
      state.history.appendModelMessage({ content: paragraph, role: "user" });
    }
    const localModel = {
      diagnostics: {
        report(diagnostic: RuntimeDiagnostic): void {
          diagnostics.push(diagnostic);
          diagnosticReported.resolve();
        },
      },
      model: createCallbackModel(() => [assistantMessage("s")]),
    };

    try {
      const compacted = await compactThreadManually({
        model: localModel,
        state,
        threadKey: "thread",
      });
      await diagnosticReported.promise;

      expect(compacted).toBe(true);
      expect(diagnostics[0]?.compaction?.deadlineAt).toBe(
        54_321 + DEFAULT_COMPACTION_DEADLINE_MS
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches sanitized overflow metadata when overflow compaction times out", async () => {
    vi.useFakeTimers();
    const state = await stateWithHistory();
    const overflow = new Error("context_length_exceeded: too many tokens");
    const callbackStarted = createDeferred();
    const compaction = Object.assign(
      () => {
        callbackStarted.resolve();
        return new Promise<never>(() => undefined);
      },
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;

    try {
      const observed = runAgentLoopWithOverflowCompaction({
        execution: { compaction },
        model,
        runLoop: () => Promise.reject(overflow),
        state,
        threadKey: "overflow-cause",
      }).then(
        () => undefined,
        (error: unknown) => error
      );
      await callbackStarted.promise;
      await vi.advanceTimersByTimeAsync(1);

      const failure = await observed;
      if (!(failure instanceof CompactionDeadlineExceededError)) {
        throw new Error("Expected a CompactionDeadlineExceededError.");
      }
      expect(failure.reason).toBe("overflow");
      expect(failure.cause).toEqual({
        error: { category: "context-overflow", version: 1 },
        message: "The request exceeded the context limit.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates a rejecting diagnostics sink from compaction", async () => {
    const state = await stateWithHistory();
    const localModel = {
      ...model,
      diagnostics: {
        report(): Promise<never> {
          return Promise.reject(new Error("sink failed"));
        },
      },
    };

    await expect(
      compactThreadBlocking({
        compaction: async () => ({
          endSeqExclusive: 2,
          startSeq: 0,
          summary: "summary",
        }),
        model: localModel,
        state,
        threadKey: "thread",
      })
    ).resolves.toBe(true);
  });

  it("waits for an already-started custom commit after the deadline", async () => {
    vi.useFakeTimers();
    const backing = new MemoryThreadStore();
    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    const state = await stateWithHistory({
      commit: async (key, next, options) => {
        commitStarted.resolve();
        await releaseCommit.promise;
        return await backing.commit(key, next, options);
      },
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
    });
    const compaction = Object.assign(
      async () => ({
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "summary",
      }),
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    const compact: ThreadCompactionHandler = async (input, context) =>
      await context.commit(input);

    try {
      const result = compactThreadBlocking({
        compact,
        compaction,
        model,
        state,
        threadKey: "commit-deadline",
      });
      await commitStarted.promise;
      await vi.advanceTimersByTimeAsync(1);
      releaseCommit.resolve();

      await expect(result).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
