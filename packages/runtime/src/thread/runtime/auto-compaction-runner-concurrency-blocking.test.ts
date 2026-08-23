import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../testing/test-fixtures";
import type { ThreadCompactionInput } from "../state/thread-state";
import {
  compactThreadBlocking,
  compactThreadManually,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-concurrency-support";
import type { AgentCompaction } from "./auto-compaction-types";

afterEach(() => {
  vi.useRealTimers();
});

describe("compaction runner scheduling", () => {
  it.each([
    [
      "manual",
      (options: Parameters<typeof compactThreadManually>[0]) =>
        compactThreadManually(options),
    ],
    [
      "overflow",
      (options: Parameters<typeof compactThreadBlocking>[0]) =>
        compactThreadBlocking(options),
    ],
  ])(
    "cancels a %s blocking wait without disturbing the active shared flight",
    async (_name, runBlockingCompaction) => {
      const state = await stateWithHistory();
      const activeStarted = createDeferred();
      const releaseActive = createDeferred();
      const abortObserved = createDeferred();
      let observedAbortReason: unknown;
      const controller = new AbortController();
      const abortReason = new DOMException("caller cancelled", "AbortError");
      const addAbortListener = vi.spyOn(controller.signal, "addEventListener");
      const removeAbortListener = vi.spyOn(
        controller.signal,
        "removeEventListener"
      );
      let activeSignal: AbortSignal | undefined;
      let pendingStarted = false;
      const activeCompaction: AgentCompaction = async (
        context
      ): Promise<ThreadCompactionInput | undefined> => {
        activeSignal = context.signal;
        activeStarted.resolve();
        await releaseActive.promise;
        return;
      };
      const pendingCompaction: AgentCompaction = (): undefined => {
        pendingStarted = true;
        return;
      };

      const active = scheduleThreadCompaction({
        compaction: activeCompaction,
        model,
        state,
        threadKey: `blocking-abort-${_name}`,
      });
      await activeStarted.promise;
      const pending = scheduleThreadCompaction({
        compaction: pendingCompaction,
        model,
        state,
        threadKey: `blocking-abort-${_name}`,
      });
      const blocking = runBlockingCompaction({
        compaction: pendingCompaction,
        model,
        signal: controller.signal,
        state,
        threadKey: `blocking-abort-${_name}`,
      });
      blocking.catch((error: unknown) => {
        observedAbortReason = error;
        abortObserved.resolve();
      });

      controller.abort(abortReason);
      await abortObserved.promise;
      expect(observedAbortReason).toBe(abortReason);
      await expect(blocking).rejects.toBe(abortReason);
      expect(removeAbortListener).toHaveBeenCalledTimes(1);
      expect(addAbortListener).toHaveBeenCalledWith(
        "abort",
        expect.any(Function),
        { once: true }
      );
      expect(pendingStarted).toBe(false);
      expect(activeSignal?.aborted).toBe(false);

      releaseActive.resolve();
      await Promise.all([active, pending]);
      expect(pendingStarted).toBe(true);
    }
  );

  it("runs overflow before pending completed-turn work", async () => {
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const reasons: string[] = [];
    let completedTurnCalls = 0;
    const compaction: AgentCompaction = async (context) => {
      reasons.push(context.reason);
      if (context.reason === "completed-turn") {
        completedTurnCalls += 1;
        if (completedTurnCalls === 1) {
          activeStarted.resolve();
          await releaseActive.promise;
        }
        return;
      }
      return { endSeqExclusive: 2, startSeq: 0, summary: "overflow" };
    };
    const options = {
      compaction,
      model,
      state,
      threadKey: "overflow-priority",
    };

    const active = scheduleThreadCompaction(options);
    await activeStarted.promise;
    const queued = scheduleThreadCompaction(options);
    const blocking = compactThreadBlocking(options);
    releaseActive.resolve();

    await expect(blocking).resolves.toBe(true);
    await Promise.all([active, queued]);
    expect(reasons).toEqual(["completed-turn", "overflow", "completed-turn"]);
  });

  it("uses a committed active completed-turn flight for overflow", async () => {
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const reasons: string[] = [];
    const compaction: AgentCompaction = async (context) => {
      reasons.push(context.reason);
      if (context.reason === "completed-turn") {
        activeStarted.resolve();
        await releaseActive.promise;
        return { endSeqExclusive: 2, startSeq: 0, summary: "background" };
      }
      return;
    };
    const options = {
      compaction,
      model,
      state,
      threadKey: "reuse-active-commit",
    };

    const active = scheduleThreadCompaction(options);
    await activeStarted.promise;
    const blocking = compactThreadBlocking(options);
    releaseActive.resolve();

    await expect(blocking).resolves.toBe(true);
    await active;
    expect(reasons).toEqual(["completed-turn"]);
  });
});
