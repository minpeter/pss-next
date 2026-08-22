import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import {
  compactThreadBlocking,
  compactThreadManually,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import type { AgentCompaction } from "./auto-compaction-types";

const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

async function stateWithHistory(): Promise<ThreadState> {
  const state = new ThreadState({
    key: "runner-concurrency-test",
    store: new MemoryThreadStore(),
  });
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
      const activeCompaction: AgentCompaction = async (context) => {
        activeSignal = context.signal;
        activeStarted.resolve();
        await releaseActive.promise;
        return;
      };
      const pendingCompaction: AgentCompaction = () => {
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

  it("shares a queued schedule promise through its coalesced retry", async () => {
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    const retryStarted = createDeferred();
    const releaseRetry = createDeferred();
    let attempts = 0;
    const compaction: AgentCompaction = async () => {
      attempts += 1;
      if (attempts === 1) {
        activeStarted.resolve();
        await releaseActive.promise;
        return;
      }
      if (attempts === 2) {
        throw new TypeError("queued first attempt failed");
      }
      retryStarted.resolve();
      await releaseRetry.promise;
      return;
    };
    const options = {
      compaction,
      model,
      state,
      threadKey: "queued-shared",
    };

    const active = scheduleThreadCompaction(options);
    await activeStarted.promise;
    const queued = scheduleThreadCompaction(options);
    const coalesced = scheduleThreadCompaction(options);
    let queuedSettled = false;
    queued.then(() => {
      queuedSettled = true;
    });

    try {
      expect(coalesced).toBe(queued);
      expect(queuedSettled).toBe(false);
      releaseActive.resolve();
      await active;
      await retryStarted.promise;
      expect(queuedSettled).toBe(false);
      releaseRetry.resolve();
      await queued;

      expect(attempts).toBe(3);
      expect(queuedSettled).toBe(true);
    } finally {
      releaseActive.resolve();
      releaseRetry.resolve();
      await Promise.allSettled([active, queued, coalesced]);
    }
  });

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

  it("creates a pending completed-turn deadline when that episode starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const state = await stateWithHistory();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    let pendingDeadlineAt: number | undefined;
    let pendingStartedAt: number | undefined;
    const activeCompaction = Object.assign(
      async (): Promise<undefined> => {
        activeStarted.resolve();
        await releaseActive.promise;
        return;
      },
      { deadlineMs: () => 1000 }
    ) satisfies AgentCompaction;
    const pendingCompaction = Object.assign(
      (context: Parameters<AgentCompaction>[0]): undefined => {
        pendingDeadlineAt = context.deadlineAt;
        pendingStartedAt = Date.now();
        return;
      },
      { deadlineMs: () => 25 }
    ) satisfies AgentCompaction;

    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "pending-deadline",
    });
    await activeStarted.promise;
    const pending = scheduleThreadCompaction({
      compaction: pendingCompaction,
      model,
      state,
      threadKey: "pending-deadline",
    });
    await vi.advanceTimersByTimeAsync(100);
    releaseActive.resolve();
    await Promise.all([active, pending]);

    expect(pendingDeadlineAt).toBe((pendingStartedAt ?? 0) + 25);
  });
});
