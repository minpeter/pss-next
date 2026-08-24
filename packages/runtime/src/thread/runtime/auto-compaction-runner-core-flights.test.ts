import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../testing/test-fixtures";
import type { ThreadCompactionInput } from "../state/thread-state";
import { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import {
  compactThreadBlocking,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-concurrency-support";
import type {
  AgentCompaction,
  ThreadCompactionHandler,
} from "./auto-compaction-types";

describe("compaction runner concurrency", () => {
  it("reserves a background flight synchronously", async () => {
    const state = await stateWithHistory();
    const started = createDeferred();
    const release = createDeferred();
    const compaction = vi.fn<AgentCompaction>(
      async (): Promise<ThreadCompactionInput | undefined> => {
        started.resolve();
        await release.promise;
        return;
      }
    );
    const options = { compaction, model, state, threadKey: "same-key" };

    const first = scheduleThreadCompaction(options);
    const second = scheduleThreadCompaction(options);
    await started.promise;

    expect(compaction).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(compaction).toHaveBeenCalledTimes(2);
  });

  it("waits for background preparation then performs overflow fallback", async () => {
    const state = await stateWithHistory();
    const started = createDeferred();
    const release = createDeferred();
    const reasons: string[] = [];
    const compaction: AgentCompaction = async (context) => {
      reasons.push(context.reason);
      if (context.reason === "completed-turn") {
        started.resolve();
        await release.promise;
        return;
      }
      return { endSeqExclusive: 2, startSeq: 0, summary: "summary" };
    };
    const compact = vi.fn<ThreadCompactionHandler>(
      async (input, context) => await context.commit(input)
    );
    const options = { compact, compaction, model, state, threadKey: "thread" };

    scheduleThreadCompaction(options);
    await started.promise;
    const blocking = compactThreadBlocking(options);
    release.resolve();

    await expect(blocking).resolves.toBe(true);
    expect(reasons).toEqual(["completed-turn", "overflow"]);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("includes the background wait in the overflow deadline", async () => {
    vi.useFakeTimers();
    const state = await stateWithHistory();
    const backgroundStarted = createDeferred();
    const releaseBackground = createDeferred();
    const reasons: string[] = [];
    const compaction = Object.assign(
      async (
        context: Parameters<AgentCompaction>[0]
      ): Promise<Awaited<ReturnType<AgentCompaction>>> => {
        reasons.push(context.reason);
        if (context.reason === "completed-turn") {
          backgroundStarted.resolve();
          await releaseBackground.promise;
        }
        return;
      },
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    const options = { compaction, model, state, threadKey: "wait-deadline" };

    try {
      scheduleThreadCompaction(options);
      await backgroundStarted.promise;
      const blocking = compactThreadBlocking(options);
      const rejected = expect(blocking).rejects.toBeInstanceOf(
        CompactionDeadlineExceededError
      );
      await vi.advanceTimersByTimeAsync(1);
      releaseBackground.resolve();

      await rejected;
      expect(reasons).toEqual(["completed-turn"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a committed completed-turn flight for overflow", async () => {
    const state = await stateWithHistory();
    const started = createDeferred();
    const release = createDeferred();
    const reasons: string[] = [];
    const compaction: AgentCompaction = async (context) => {
      reasons.push(context.reason);
      if (context.reason === "completed-turn") {
        started.resolve();
        await release.promise;
        return { endSeqExclusive: 2, startSeq: 0, summary: "background" };
      }
      return;
    };
    const compact: ThreadCompactionHandler = async (input, context) =>
      await context.commit(input);
    const options = { compact, compaction, model, state, threadKey: "thread" };

    scheduleThreadCompaction(options);
    await started.promise;
    const blocking = compactThreadBlocking(options);
    release.resolve();

    await expect(blocking).resolves.toBe(true);
    expect(reasons).toEqual(["completed-turn"]);
  });

  it("rejects a callback result when the compaction baseline changes before commit", async () => {
    const state = await stateWithHistory();
    const compaction: AgentCompaction = () => ({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "candidate",
    });
    const compact: ThreadCompactionHandler = async (input, context) => {
      await state.compact({ ...input, summary: "newer baseline" });
      return await context.commit(input);
    };

    await expect(
      compactThreadBlocking({
        compact,
        compaction,
        model,
        state,
        threadKey: "thread",
      })
    ).resolves.toBe(false);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "newer baseline", role: "system" } },
    ]);
  });
});
