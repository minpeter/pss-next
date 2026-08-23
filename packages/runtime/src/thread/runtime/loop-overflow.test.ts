import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextBudgetExceededError } from "../../llm/context-gate";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import type { AgentCompaction } from "./auto-compaction-types";
import { runAgentLoopWithOverflowCompaction } from "./loop-overflow";

class ProviderOverflowError extends Error {
  readonly code = "context_length_exceeded";
  readonly providerPayload = "private provider request payload";
}

const ARRAY_INDEX = /^\d+$/;

const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

async function stateWithHistory(): Promise<ThreadState> {
  const state = new ThreadState({
    key: "overflow-privacy-test",
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

describe("overflow compaction errors", () => {
  it("propagates non-deadline compaction errors from overflow recovery", async () => {
    const state = await stateWithHistory();
    const overflow = new ContextBudgetExceededError({
      bufferTokens: 10,
      estimatedTokens: 110,
      maxInputTokens: 100,
      onOverflow: "compact",
    });
    const compactionError = new Error("durable store write failed");
    const compaction = (() => {
      throw compactionError;
    }) satisfies AgentCompaction;

    await expect(
      runAgentLoopWithOverflowCompaction({
        execution: { compaction },
        model,
        runLoop: () => Promise.reject(overflow),
        state,
        threadKey: "overflow-compaction-error-thread",
      })
    ).rejects.toBe(compactionError);
  });

  it.each(["cause", "code", "errors", "message", "name"] as const)(
    "preserves the original rejection when the %s accessor throws",
    async (property) => {
      const state = await stateWithHistory();
      const accessorFailure = new Error(`hostile ${property} accessor`);
      const hostileError = Object.defineProperty({}, property, {
        get() {
          throw accessorFailure;
        },
      });

      const observed = await runAgentLoopWithOverflowCompaction({
        execution: {},
        model,
        runLoop: () => Promise.reject(hostileError),
        state,
        threadKey: "hostile-overflow-accessor-thread",
      }).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(observed).toBe(hostileError);
    }
  );

  it("preserves the original rejection when prototype inspection throws", async () => {
    const state = await stateWithHistory();
    const prototypeFailure = new Error("hostile prototype inspection");
    const hostileError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw prototypeFailure;
        },
      }
    );

    const observed = await runAgentLoopWithOverflowCompaction({
      execution: {},
      model,
      runLoop: () => Promise.reject(hostileError),
      state,
      threadKey: "hostile-overflow-prototype-thread",
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(observed).toBe(hostileError);
  });

  it("bounds lazy aggregate child access", async () => {
    const state = await stateWithHistory();
    let childReads = 0;
    const errors = new Proxy(new Array<unknown>(150_000).fill(undefined), {
      get(target, property, receiver) {
        if (typeof property === "string" && ARRAY_INDEX.test(property)) {
          childReads += 1;
          return {};
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const aggregate = { errors };

    const observed = await runAgentLoopWithOverflowCompaction({
      execution: {},
      model,
      runLoop: () => Promise.reject(aggregate),
      state,
      threadKey: "wide-overflow-aggregate-thread",
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(observed).toBe(aggregate);
    expect(childReads).toBe(9999);
  });

  it("checks aggregate children newest-first", async () => {
    const state = await stateWithHistory();
    let childReads = 0;
    let loopRuns = 0;
    const errors = new Proxy(new Array<unknown>(150_000).fill(undefined), {
      get(target, property, receiver) {
        if (typeof property === "string" && ARRAY_INDEX.test(property)) {
          childReads += 1;
          return property === "149999"
            ? new ProviderOverflowError("context window exceeded")
            : {};
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const compaction = (() => ({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "bounded overflow recovery",
    })) satisfies AgentCompaction;

    const result = await runAgentLoopWithOverflowCompaction({
      execution: { compaction },
      model,
      runLoop: () => {
        loopRuns += 1;
        return loopRuns === 1
          ? Promise.reject({ errors })
          : Promise.resolve("completed");
      },
      state,
      threadKey: "newest-overflow-child-thread",
    });

    expect(result).toBe("completed");
    expect(childReads).toBe(1);
  });

  it("retains only sanitized trigger metadata after a deadline", async () => {
    vi.useFakeTimers();
    const state = await stateWithHistory();
    const overflow = new ProviderOverflowError("context window exceeded");
    const callbackStarted = createDeferred();
    const compaction = Object.assign(
      () => {
        callbackStarted.resolve();
        return new Promise<never>(() => undefined);
      },
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    const observed = runAgentLoopWithOverflowCompaction({
      execution: { compaction },
      model,
      runLoop: () => Promise.reject(overflow),
      state,
      threadKey: "private-overflow-thread",
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    await callbackStarted.promise;
    await vi.advanceTimersByTimeAsync(1);
    const failure = await observed;

    expect(failure).toBeInstanceOf(CompactionDeadlineExceededError);
    if (!(failure instanceof CompactionDeadlineExceededError)) {
      throw new TypeError("Expected compaction deadline failure");
    }
    expect(Object.keys(failure)).not.toContain("threadKey");
    expect(failure.cause).not.toBe(overflow);
    expect(failure.cause).toMatchObject({
      error: { category: "context-overflow", version: 1 },
    });
    const serialized = JSON.stringify({ cause: failure.cause, failure });
    expect(serialized).not.toContain("private provider request payload");
    expect(serialized).not.toContain("private-overflow-thread");
  });
});
