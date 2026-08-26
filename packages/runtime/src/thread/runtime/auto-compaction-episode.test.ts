import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../internal/deferred";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { ThreadCommitConflictError, ThreadState } from "../state/thread-state";
import type { ThreadStore } from "../store/types";
import { compactThreadBlocking } from "./auto-compaction-runner";
import type { ThreadCompactionHandlerContext } from "./auto-compaction-types";

const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};
const candidate = {
  endSeqExclusive: 2,
  startSeq: 0,
  summary: "durable summary",
};

async function stateWithHistory(
  store: ThreadStore = new MemoryThreadStore()
): Promise<ThreadState> {
  const state = new ThreadState({ key: "episode-test", store });
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

function runWithDeadline(
  state: ThreadState,
  compact: (
    input: typeof candidate,
    context: ThreadCompactionHandlerContext
  ) => Promise<boolean>
): Promise<boolean> {
  return compactThreadBlocking({
    compact,
    compaction: Object.assign(() => candidate, { deadlineMs: () => 20 }),
    model,
    state,
    threadKey: "episode-test",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("compaction episode commit outcome", () => {
  it("settles from a successful durable commit when the handler tail hangs", async () => {
    // Given
    const state = await stateWithHistory();
    const handlerTailStarted = createDeferred();
    const handlerAborted = createDeferred();

    // When
    const running = runWithDeadline(state, async (input, context) => {
      context.signal.addEventListener("abort", handlerAborted.resolve, {
        once: true,
      });
      await context.commit(input);
      handlerTailStarted.resolve();
      return await new Promise<boolean>(() => undefined);
    });
    await handlerTailStarted.promise;

    // Then
    await expect(running).resolves.toBe(true);
    await handlerAborted.promise;
    expect(state.compactionSnapshot()).toHaveLength(1);
  });

  it("settles from a commit conflict after rollback when the handler tail hangs", async () => {
    // Given
    const backing = new MemoryThreadStore();
    let acceptCommits = true;
    const state = await stateWithHistory({
      commit: (key, next, options) =>
        acceptCommits
          ? backing.commit(key, next, options)
          : Promise.resolve({ ok: false, reason: "conflict" }),
      delete: (key) => backing.delete(key),
      load: (key) => backing.load(key),
    });
    await state.commit();
    acceptCommits = false;
    const before = state.modelSnapshot();
    const handlerTailStarted = createDeferred();

    // When
    const running = runWithDeadline(state, (input, context) => {
      context
        .commit(input)
        .then(handlerTailStarted.resolve, handlerTailStarted.resolve);
      return new Promise<boolean>(() => undefined);
    });
    await handlerTailStarted.promise;

    // Then
    await expect(running).rejects.toBeInstanceOf(ThreadCommitConflictError);
    expect(state.modelSnapshot()).toEqual(before);
    expect(state.compactionSnapshot()).toEqual([]);
  });

  it("settles from a failed commit after rollback when the handler tail hangs", async () => {
    // Given
    const commitFailure = new TypeError("durable commit failed");
    const state = await stateWithHistory({
      commit: () => Promise.reject(commitFailure),
      delete: () => Promise.resolve(),
      load: () => Promise.resolve(null),
    });
    const before = state.modelSnapshot();
    const handlerTailStarted = createDeferred();

    // When
    const running = runWithDeadline(state, (input, context) => {
      context
        .commit(input)
        .then(handlerTailStarted.resolve, handlerTailStarted.resolve);
      return new Promise<boolean>(() => undefined);
    });
    await handlerTailStarted.promise;

    // Then
    await expect(running).rejects.toBe(commitFailure);
    expect(state.modelSnapshot()).toEqual(before);
    expect(state.compactionSnapshot()).toEqual([]);
  });

  it("contains a late handler rejection after the durable commit succeeds", async () => {
    // Given
    const state = await stateWithHistory();
    const handlerTailStarted = createDeferred();
    const rejectHandlerTail = deferred();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // When
      const running = runWithDeadline(state, async (input, context) => {
        await context.commit(input);
        handlerTailStarted.resolve();
        await rejectHandlerTail.promise;
        return true;
      });
      await handlerTailStarted.promise;
      await expect(running).resolves.toBe(true);
      rejectHandlerTail.reject(new TypeError("late handler failure"));
      await vi.advanceTimersByTimeAsync(0);

      // Then
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      rejectHandlerTail.resolve();
    }
  });

  it("allows only the first commit call while its handler tail hangs", async () => {
    // Given
    const state = await stateWithHistory();
    const capturedCommit = deferred<ThreadCompactionHandlerContext["commit"]>();
    const duplicateResult = deferred<boolean>();

    // When
    const running = runWithDeadline(state, async (input, context) => {
      capturedCommit.resolve(context.commit);
      const first = context.commit(input);
      duplicateResult.resolve(await context.commit(input));
      await first;
      return await new Promise<boolean>(() => undefined);
    });

    // Then
    await expect(duplicateResult.promise).resolves.toBe(false);
    await expect(running).resolves.toBe(true);
    await expect((await capturedCommit.promise)(candidate)).resolves.toBe(
      false
    );
    expect(state.compactionSnapshot()).toHaveLength(1);
  });

  it("closes the commit capability when a handler returns without committing", async () => {
    // Given
    const state = await stateWithHistory();
    let lateCommit: ThreadCompactionHandlerContext["commit"] | undefined;

    // When
    await expect(
      runWithDeadline(state, (_input, context) => {
        lateCommit = context.commit;
        return Promise.resolve(false);
      })
    ).resolves.toBe(false);
    const closedCommit = lateCommit;
    if (closedCommit === undefined) {
      throw new TypeError("Expected the handler commit capability");
    }

    // Then
    await expect(closedCommit(candidate)).resolves.toBe(false);
    expect(state.compactionSnapshot()).toEqual([]);
  });
});
