import type { ModelMessage } from "ai";
import { expect, it } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import { compactThreadBlocking } from "./auto-compaction-runner";
import type { AgentCompaction } from "./auto-compaction-types";

it("aborts summary generation through a distinct summary signal", async () => {
  const state = new ThreadState({
    key: "summary-specific-signal",
    store: new MemoryThreadStore(),
  });
  await state.ensureLoaded();
  const history: readonly ModelMessage[] = [
    { content: "old context ".repeat(200), role: "user" },
    assistantMessage("done"),
    { content: "tail", role: "user" },
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  const providerStarted = createDeferred();
  const summaryController = new AbortController();
  const episodeController = new AbortController();
  const summaryAbortReason = new TypeError("summary cancelled");
  let providerSignal: AbortSignal | undefined;
  const compaction: AgentCompaction = async (
    context
  ): Promise<
    { endSeqExclusive: number; startSeq: number; summary: string } | undefined
  > => {
    const range = { endSeqExclusive: 2, startSeq: 0 };
    return {
      ...range,
      summary: await context.summarize(range, {
        signal: summaryController.signal,
      }),
    };
  };
  const running = compactThreadBlocking({
    compaction,
    model: {
      model: createCallbackModel(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            providerSignal = signal;
            providerStarted.resolve();
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          })
      ),
    },
    signal: episodeController.signal,
    state,
    threadKey: "summary-specific-signal",
  });

  try {
    await providerStarted.promise;
    summaryController.abort(summaryAbortReason);

    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toBe(summaryAbortReason);
    await expect(running).rejects.toBe(summaryAbortReason);
    expect(state.compactionSnapshot()).toEqual([]);
  } finally {
    episodeController.abort(new TypeError("test cleanup"));
    await Promise.allSettled([running]);
  }
});
