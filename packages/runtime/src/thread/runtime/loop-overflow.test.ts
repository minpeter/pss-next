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
      message: "The request exceeded the context limit.",
    });
    const serialized = JSON.stringify({ cause: failure.cause, failure });
    expect(serialized).not.toContain("private provider request payload");
    expect(serialized).not.toContain("private-overflow-thread");
  });
});
